import { localZone } from "../llm/prompt.ts";
import type { Tool, ToolInput } from "../types.ts";

// "What's the time?" (M25). Before this there was no tool for it: the model answered in its own
// words through the no-tool path, read off the planning prompt's machine-readable clock line —
// long ("It's 14:51 on Thursday, 22 October 2026, India Standard Time"), different every time,
// and logged as a miss. Now the clock is read in code and the answer is one short sentence.
//
// The answer is BUILT FROM PARTS, never taken whole from Intl. A formatted time string differs
// between ICU versions — some put a narrow no-break space (U+202F) before "PM", and node (the
// tests) and electron (the app) ship different ICU (CLAUDE.md, M14). Only the hour, minute, day
// period, weekday, day and month are taken from Intl; every separator is written here.
//
// Where the parts come from is a parameter so a test can hand in the ICU it cannot get from the
// runtime it runs on: this machine's node puts a plain space before "PM", so a leak could not
// fail any test that only ever asked node (found by the M25 mutation pass).
export type DateParts = (
  locale: string,
  options: Intl.DateTimeFormatOptions,
  at: Date,
) => Intl.DateTimeFormatPart[];

const intlParts: DateParts = (locale, options, at) =>
  new Intl.DateTimeFormat(locale, options).formatToParts(at);

export function formatTimeAnswer(
  what: "time" | "date",
  now: number,
  zone: string,
  partsOf: DateParts = intlParts,
): string {
  const at = new Date(now);
  if (what === "date") {
    const parts = partsOf("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }, at);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `It's ${get("weekday")}, ${get("day")} ${get("month")}.`;
  }
  const parts = partsOf("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hourCycle: "h12" }, at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `It's ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}.`;
}

// `safe`: it reads the machine's clock and says it. `statusOnly`: like jobStatus it is answered
// at once — never queued behind running jobs for a slot — and never listed as a job of its own.
export const tellTimeTool: Tool = {
  name: "tellTime",
  description:
    "Tell the user the current local time, or today's date. Use it when the user ASKS what time " +
    "it is ('what's the time?', 'what time is it?') with what='time', or what day or date it is " +
    "('what's the date?', 'what day is it today?') with what='date'. It answers with the time " +
    "only, or the date only. Do NOT use it to work out a time for something else (a meeting, a " +
    "reminder): those tools take the time themselves.",
  inputSchema: {
    type: "object",
    properties: {
      what: {
        type: "string",
        enum: ["time", "date"],
        description: "'time' for the time of day, 'date' for today's date.",
      },
    },
    required: ["what"],
  },
  risk: "safe",
  background: "ok",
  planPhrase: "tell the time or date",
  statusOnly: true,
  // Nothing to look up: the answer is the clock.
  resolvesReferences: false,
  handler: (input: ToolInput): Promise<string> =>
    Promise.resolve(formatTimeAnswer(input["what"] === "date" ? "date" : "time", Date.now(), localZone())),
};
