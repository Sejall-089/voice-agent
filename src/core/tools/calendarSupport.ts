import { UserFixableError } from "../errors.ts";
import { describeEvent } from "../calendar/format.ts";
import type { CalendarEvent, ToolDeps, ToolInput } from "../types.ts";

// Shared plumbing for the three calendar tools (M13) — the counterpart of replySupport.ts.
//
// Most of this file is about REFUSING well. A calendar tool that guesses is worse than one that
// declines: the wrong meeting moved is not something an undo exists for, and the person it
// inconveniences is not the person who gave the instruction.

const DAY_MS = 86_400_000;

// How far around today `moveEvent` looks for the event the user named. Wide enough for "the
// review next month", bounded so a vague word cannot match something a year out that the user
// has long forgotten. Yesterday is included because "move this morning's standup" is a real
// thing to say at 9am about a 8:30 event.
export const SEARCH_BACK_MS = DAY_MS;
export const SEARCH_FORWARD_MS = 90 * DAY_MS;

export function requiredString(input: ToolInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UserFixableError(`I need to know the ${key}.`);
  }
  return value.trim();
}

export function optionalString(input: ToolInput, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Attendee addresses out of whatever the model proposed. Anything that is not a plausible
// address is DROPPED rather than passed through — but see `attendees()` below for why dropping
// is not the end of the story.
function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// The guest list for a create. This is the number that decides the risk tier, so it refuses
// rather than silently narrowing: a model that proposes "the design team" instead of an address
// must not have that quietly dropped, because dropping it would turn a `dangerous` call into a
// `caution` one and skip the confirm dialog entirely. The unsendable entry is the whole reason
// to stop.
export function attendees(input: ToolInput): string[] {
  const raw = addressList(input["attendees"]);
  const unsendable = raw.filter((entry) => !entry.includes("@"));
  if (unsendable.length > 0) {
    throw new UserFixableError(
      `I don't know the email address for ${unsendable.join(", ")} — ` +
        "give me the address and I'll invite them.",
    );
  }
  return raw;
}

// An ISO instant, or a refusal that says which limitation was hit.
//
// This is also where ALL-DAY requests are declined. A bare "2026-08-26" parses as a real moment
// in most date libraries, so without this check "block out Thursday" would quietly become a
// midnight-to-midnight timed event in whatever zone happened to apply — a plausible-looking
// wrong answer, which is the worst kind. M13 reads all-day events and does not write them
// (spec §6c).
export function requiredInstant(input: ToolInput, key: string): string {
  const value = requiredString(input, key);

  if (!value.includes("T")) {
    throw new UserFixableError(
      "I can only create and move events that have a start and end time — " +
        "I can't make an all-day event yet.",
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new UserFixableError(`I couldn't read "${value}" as a date and time.`);
  }
  return value;
}

// The one place `moveEvent` decides WHICH event is meant — used by the risk policy, the
// narration, the confirm summary and the handler, so all four are talking about the same event.
//
// DEFAULT-DENY, carried straight up from gmailScript.ts's rule for buttons: zero matches or
// more than one is not an answer, and the tool declines instead of picking. Moving the wrong
// meeting is the failure this exists to prevent.
export async function resolveTargetEvent(
  input: ToolInput,
  deps: ToolDeps,
): Promise<CalendarEvent> {
  const query = requiredString(input, "event");
  const now = Date.now();
  const from = new Date(now - SEARCH_BACK_MS).toISOString();
  const to = new Date(now + SEARCH_FORWARD_MS).toISOString();

  const matches = await deps.calendar.findEvent(query, from, to);

  if (matches.length === 0) {
    throw new UserFixableError(
      `I couldn't find an event matching "${query}" in the next 90 days.`,
    );
  }
  if (matches.length > 1) {
    const zone = await deps.calendar.calendarTimeZone();
    const listed = matches
      .slice(0, 5)
      .map((event) => `• ${describeEvent(event, zone)}`)
      .join("\n");
    throw new UserFixableError(
      `"${query}" matches ${matches.length} events — tell me which one:\n${listed}`,
    );
  }

  const event = matches[0];
  if (!event) {
    throw new UserFixableError(`I couldn't find an event matching "${query}".`);
  }

  // Two kinds of event this milestone declines to move, both because the right behaviour is a
  // real choice rather than an obvious default.
  if (event.recurring) {
    throw new UserFixableError(
      `"${event.title}" repeats, and I can't tell whether you mean just this one or the whole ` +
        "series — move it in Google Calendar and it'll ask you.",
    );
  }
  if (event.allDay) {
    throw new UserFixableError(
      `"${event.title}" is an all-day event, and I can only move events that have a time.`,
    );
  }

  return event;
}

// Where the moved event should land. `newEnd` is optional because the ordinary way to say this
// is "move the review to 4" — nobody restates how long their own meeting is, so the duration
// carries over unchanged.
export function movedTimes(
  input: ToolInput,
  event: CalendarEvent,
): { start: string; end: string } {
  const start = requiredInstant(input, "newStart");
  const explicitEnd = optionalString(input, "newEnd");

  if (explicitEnd !== null) {
    const end = requiredInstant(input, "newEnd");
    if (Date.parse(end) <= Date.parse(start)) {
      throw new UserFixableError("The new end time has to be after the new start time.");
    }
    return { start, end };
  }

  const durationMs = Date.parse(event.end) - Date.parse(event.start);
  const end = atSameOffset(Date.parse(start) + durationMs, start);
  return { start, end };
}

// Render an instant at the SAME UTC offset as another timestamp.
//
// `toISOString()` would be correct and unreadable: a move to 4pm IST would come back as
// "...T11:30:00.000Z", pairing a +05:30 start with a Z end on one event. Both name the same
// moment, so nothing would break — which is exactly why it is worth fixing now rather than
// after it has hidden something. Times that describe one event should read the same way, and
// the way they should read is the way the user said them.
export function atSameOffset(instantMs: number, like: string): string {
  const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(like)?.[1] ?? "Z";
  if (offset === "Z") return new Date(instantMs).toISOString();

  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  const offsetMs = sign * (hours * 60 + minutes) * 60_000;

  // Shift into the target offset, then read the wall-clock fields back out of the UTC
  // rendering and re-label them with the offset they actually belong to.
  return `${new Date(instantMs + offsetMs).toISOString().slice(0, 19)}${offset}`;
}
