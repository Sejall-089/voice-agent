import { formatSchedule } from "../calendar/format.ts";
import { optionalString } from "./calendarSupport.ts";
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
};
