import { UserFixableError } from "../errors.ts";
import { describeEvent, formatAttendees, formatWhen } from "../calendar/format.ts";
import { movedTimes, resolveTargetEvent } from "./calendarSupport.ts";
import type { Risk, Tool, ToolDeps, ToolInput } from "../types.ts";

// M13, task 14: move something already on the calendar.
//
// The tier depends on the arguments here too, but with a difference that is the whole reason
// `RiskPolicy.resolve` gets `deps` at all: `createEvent` knows its guest list from the model's
// own arguments, while this one has to LOOK IT UP. The user says "push the review to 4"; whether
// that emails three people is a fact about the event, not about the sentence.
//
// Everything below routes through one `resolveTargetEvent` call, so the classification, the
// narration, the confirm dialog and the act are all talking about the same event. It costs
// several reads per move — all SAFE, all idempotent — and that is the deliberate trade: the
// alternative is caching a lookup across a confirm dialog the user might sit on for a minute.
export const moveEventTool: Tool = {
  name: "moveEvent",
  description:
    "Change the date or time of an event already on the user's calendar. Use this when they " +
    "ask to move, reschedule, push, or shift something. Pass `event` as the user described it " +
    "('the design review', 'my 3pm') and `newStart` as an exact ISO 8601 timestamp with an " +
    "offset, worked out from the current time you were given. Leave `newEnd` out unless they " +
    "said the event should also become longer or shorter — its current length is kept " +
    "otherwise. If the event has guests they are emailed about the change, and the user is " +
    "asked to confirm first.",
  inputSchema: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Which event to move, in the user's own words (e.g. 'the design review').",
      },
      newStart: {
        type: "string",
        description: "New start, ISO 8601 with offset (e.g. 2026-08-26T16:00:00+05:30).",
      },
      newEnd: {
        type: "string",
        description:
          "New end, ISO 8601 with offset. Omit to keep the event the same length as it is now.",
      },
    },
    required: ["event", "newStart"],
  },
  risk: {
    tiers: ["caution", "dangerous"],
    // READS the world to classify — the case this whole mechanism exists for. SAFE work only:
    // it runs before any gate has fired. If the lookup is ambiguous or the event is one this
    // milestone declines to move, it throws, and `resolveRisk` escalates rather than letting a
    // broken classifier wave the call through.
    resolve: async (input: ToolInput, deps: ToolDeps): Promise<Risk> => {
      const event = await resolveTargetEvent(input, deps);
      return event.attendees.length > 0 ? "dangerous" : "caution";
    },
  },
  narrate: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const event = await resolveTargetEvent(input, deps);
    const zone = await deps.calendar.calendarTimeZone();
    const { start, end } = movedTimes(input, event);
    return `Moving "${event.title}" to ${formatWhen({ ...event, start, end }, zone)}…`;
  },
  confirmSummary: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const event = await resolveTargetEvent(input, deps);
    const zone = await deps.calendar.calendarTimeZone();
    const { start, end } = movedTimes(input, event);
    return (
      `Move "${event.title}" from ${formatWhen(event, zone)} to ` +
      `${formatWhen({ ...event, start, end }, zone)}, and email ` +
      `${formatAttendees(event.attendees)} about the change?`
    );
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    // Re-read rather than trust the copy the gates saw. This is the last read before the act,
    // and it is the one whose answer is true.
    const event = await resolveTargetEvent(input, deps);

    // TIME-OF-CHECK / TIME-OF-USE. The tier was decided by reading a guest list; someone else
    // can add a guest between that read and this one. Without this, a call classified as
    // "yours alone" — and therefore never confirmed — would email a person the user was never
    // asked about. The window is seconds and the check is one comparison; the cost of being
    // wrong is a meeting notification nobody approved.
    if (event.attendees.length > 0 && deps.tier !== "dangerous") {
      throw new UserFixableError(
        `"${event.title}" has guests on it now — it didn't when I checked a moment ago, so I ` +
          "haven't moved it. Ask me again and I'll confirm the invitations with you first.",
      );
    }

    const zone = await deps.calendar.calendarTimeZone();
    const { start, end } = movedTimes(input, event);

    const moved = await deps.calendar.moveEvent(event.id, start, end);

    const notified =
      moved.attendees.length > 0
        ? `\n${formatAttendees(moved.attendees)} ${
            moved.attendees.length === 1 ? "was" : "were"
          } emailed about the change.`
        : "";
    return `Moved ${describeEvent(moved, zone)}.${notified}`;
  },
};
