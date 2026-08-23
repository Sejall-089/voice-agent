import { formatSchedule } from "../calendar/format.ts";
import { toSpokenLine, toSpokenResult } from "../speech.ts";
import { optionalString } from "./calendarSupport.ts";
import type { SpokenText } from "../speech.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// M13, task 12: what's coming up.
//
// `safe` — it reads and nothing else, so it runs with no dialog and no narration. The whole
// output is the formatted list; there is no LLM call in the handler at all, because there is
// nothing to write. A schedule is already words.
export const readScheduleTool: Tool = {
  name: "readSchedule",
  description:
    "List upcoming events from the user's calendar. Use this when they ask what's on, what " +
    "their day or week looks like, whether they're free, or when something is. Pass `from` " +
    "and `to` as exact ISO 8601 timestamps with an offset, worked out from the current time " +
    "you were given — e.g. for 'what's on tomorrow', the start and end of tomorrow. Leave them " +
    "out to get the next 7 days.",
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description:
          "Start of the window, ISO 8601 with offset (e.g. 2026-08-26T00:00:00+05:30). " +
          "Defaults to now.",
      },
      to: {
        type: "string",
        description: "End of the window, ISO 8601 with offset. Defaults to 7 days from now.",
      },
      limit: {
        type: "number",
        description: "Most events to list. Defaults to 10.",
      },
    },
    required: [],
  },
  risk: "safe",
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const now = Date.now();
    const from = optionalString(input, "from") ?? new Date(now).toISOString();
    const to = optionalString(input, "to") ?? new Date(now + DEFAULT_WINDOW_MS).toISOString();

    const requested = input["limit"];
    const limit =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const zone = await deps.calendar.calendarTimeZone();
    const events = await deps.calendar.listUpcoming(from, to, limit);

    // An empty calendar is an ANSWER, not a failure — the user asked a question and "nothing"
    // is the true reply. Throwing here would surface it as though something had gone wrong.
    if (events.length === 0) {
      return "Nothing on your calendar in that window.";
    }

    return formatSchedule(events, zone);
  },
  // The one tool in M14 that writes its own spoken form, and the case that justified the hook
  // existing at all (core/types.ts's `Tool.speakResult`).
  //
  // The generic derivation would read the head of the list, which means reading attendees'
  // email addresses out loud — "with alex at example dot com and sam at example dot com" — and
  // nothing outside this tool knows those are addresses rather than words. Here they become a
  // count, which is what a person would say, and the count survives into the remainder too, so
  // "read them out" doesn't reintroduce what the summary carefully avoided.
  speakResult: (result: string): SpokenText => {
    const lines = result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Not a listing — this is the "Nothing on your calendar in that window." answer, which is
    // already one plain sentence. The generic derivation is exactly right for it.
    if (lines[0] === undefined || !lines[0].startsWith("•")) return toSpokenResult(result);

    const spoken = lines.map(spokenEvent);
    const first = spoken[0] ?? "";
    if (spoken.length === 1) return { text: `One thing coming up. ${first}`, remainder: null };

    return {
      text: `You have ${spoken.length} things coming up. First up, ${first} Want me to read the rest?`,
      remainder: spoken.slice(1).join(" "),
    };
  },
};

// One formatSchedule line as a person would say it: "Wed 26 Aug, 3:00–4:00 PM, Design review,
// with 2 guests."
//
// This parses output produced a few lines above it, which is a coupling worth naming. It is
// kept to ONE pattern — the " — with " tail — and that tail is only believed when it actually
// contains an address, so a meeting whose TITLE happens to contain the same words is spoken
// whole rather than mangled.
function spokenEvent(line: string): string {
  const tail = / — with (.+)$/.exec(line);
  if (tail === null || tail[1] === undefined || !tail[1].includes("@")) {
    return toSpokenLine(line);
  }

  const guests = tail[1]
    .split(/,\s*|\s+and\s+/)
    .filter((guest) => guest.trim().length > 0).length;

  return toSpokenLine(
    `${line.slice(0, tail.index)}${guests === 1 ? ", with one guest" : `, with ${guests} guests`}`,
  );
}
