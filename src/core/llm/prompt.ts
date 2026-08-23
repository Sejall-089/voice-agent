import type { ActionLogEntry, CapturedContext } from "../types.ts";

// Vendor-neutral prompt shaping shared by every LLMClient implementation, so the
// tool-routing framing and correction/previous-turn wording stay in sync across
// providers instead of forking per vendor.

// System prompt for the tool-choice call. The registry's descriptions/schemas do the
// real routing work; this just frames the job.
export const CHOOSE_SYSTEM = [
  "You are the planner for a desktop assistant.",
  "Pick exactly one tool from the provided tools that best fulfills the user's instruction,",
  "given the on-screen context. Never invent a tool that is not in the list.",
  "If no tool fits: when you have something genuinely useful to tell the user — a clarifying",
  "question needed before you could act, or a specific reason this particular request can't be",
  "done — reply with that, in one or two plain sentences. If the request simply does not match",
  "anything this assistant can do and there is nothing more useful to say, reply with nothing",
  "at all. Do not write a placeholder like 'I can't' or 'I don't have a tool for that' — the",
  "application already shows an appropriate message on its own when you reply with nothing.",
  "You may also be shown the previous turn (the last instruction, tool, and result). Use it",
  "ONLY to resolve a correction or a pronoun reference in the CURRENT instruction ('no, I",
  "meant...', 'actually...', 'that's wrong'). Otherwise ignore it and treat the current",
  "instruction as an independent request.",
  "You are told the current local time. When a tool asks for an exact time, use it to turn what",
  "the user said ('tomorrow at 3', 'next Tuesday') into a concrete one — never guess a date.",
].join(" ");

// The user's local zone, resolved from the runtime. Reading it here rather than in `/core`'s
// callers keeps it a defaulted argument everywhere it is used, so tests stay deterministic.
function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// "2026-08-23T15:18:29+05:30 (Sunday, Asia/Kolkata)".
//
// M13. Until now the prompt carried no clock at all, which was fine while every tool operated
// on text the user had already selected — nothing needed to know what day it was. A calendar
// tool takes an exact instant, and the model is the thing that turns "tomorrow at 3" into one,
// so it has to be told. The OFFSET is the load-bearing part: without it "15:00" is not a point
// in time, and the zone name alone would make the model do timezone arithmetic in its head.
//
// This is the user's LOCAL zone — what they mean when they say "3pm" — which is not necessarily
// the calendar's own zone (that one is read from the calendar and used for DISPLAY; see
// CalendarSurface.calendarTimeZone).
export function renderNow(now: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(now));

  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  // "GMT+05:30" → "+05:30"; plain "GMT" (i.e. UTC) → "+00:00".
  const offset = get("timeZoneName").replace(/^GMT/, "") || "+00:00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}:${get("second")}`;

  return `${date}T${time}${offset} (${get("weekday")}, ${zone})`;
}

// Serialize the instruction + captured context (+ previous turn, if any) into the user message.
//
// `now` and `zone` are DEFAULTED arguments rather than reads inside the body, following
// `DraftStore.get(now = Date.now())`: production passes nothing and gets the real clock, tests
// pass a fixed instant and get a deterministic prompt.
export function renderRequest(
  instruction: string,
  context: CapturedContext,
  previousTurn: ActionLogEntry | null,
  now: number = Date.now(),
  zone: string = localZone(),
): string {
  const parts: string[] = [];
  // First, as a standing fact about the world rather than as part of the request.
  parts.push(`Current time: ${renderNow(now, zone)}\n`);
  if (previousTurn) {
    parts.push(`${renderPreviousTurn(previousTurn)}\n`);
  }
  parts.push(`Instruction: ${instruction}`);
  if (context.selectedText) {
    parts.push(`\nSelected text (clipboard):\n${context.selectedText}`);
  }
  if (context.activeWindowTitle) {
    parts.push(`\nActive window: ${context.activeWindowTitle}`);
  }
  return parts.join("\n");
}

// A short, bounded description of the previous turn — enough to resolve a correction,
// not so much that one verbose prior result balloons every subsequent prompt.
function renderPreviousTurn(entry: ActionLogEntry): string {
  const toolPart = entry.tool
    ? `called \`${entry.tool}\``
    : "found no matching tool";
  const argsPart = entry.arguments
    ? ` with ${JSON.stringify(entry.arguments)}`
    : "";
  const resultPart = entry.result ? ` → ${preview(entry.result)}` : "";
  return (
    `Previous turn (for resolving corrections/pronouns only — otherwise ignore):\n` +
    `Instruction: "${entry.instruction}" — ${toolPart}${argsPart}${resultPart}`
  );
}

export function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
