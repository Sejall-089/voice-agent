import { UserFixableError } from "../errors.ts";
import { describeEvent, formatAttendees } from "../calendar/format.ts";
import { attendees, requiredInstant, requiredString } from "./calendarSupport.ts";
import type { CalendarEvent, Risk, Tool, ToolDeps, ToolInput } from "../types.ts";

// M13, task 13: put something on the calendar.
//
// THE FIRST TOOL WHOSE TIER DEPENDS ON ITS ARGUMENTS (core/risk.ts). Gmail could gate on
// `sendReply` alone because drafting and sending were separate moments. There is no equivalent
// second step here: the instant this returns, every attendee has been emailed an invitation
// under the user's name. So the same tool is routine for "block out an hour to write the deck"
// and high-stakes for "set up a call with Alex and Sam" — and the only thing that tells them
// apart is whether anyone else is on it.
//
// A note on what is NOT gated: putting a private event on your own calendar reaches nobody, is
// visible the moment you look, and is deleted in one click. Confirming it would be the kind of
// dialog people learn to click through without reading — which would make the confirm that DOES
// matter weaker. It narrates instead.

function draftFrom(input: ToolInput): {
  title: string;
  start: string;
  end: string;
  attendees: string[];
} {
  const title = requiredString(input, "title");
  const start = requiredInstant(input, "start");
  const end = requiredInstant(input, "end");

  if (Date.parse(end) <= Date.parse(start)) {
    throw new UserFixableError("The end time has to be after the start time.");
  }

  return { title, start, end, attendees: attendees(input) };
}

// Args-only, no reads: everything that decides this is already in the call. Note that it can
// still THROW — an unusable guest list refuses here — and a throw escalates to `dangerous`,
// where `confirmSummary` refuses on the same problem. Fail-closed at both steps.
function tierFor(input: ToolInput): Risk {
  return attendees(input).length > 0 ? "dangerous" : "caution";
}

// What the event will look like once made — built from the args, so narration and the confirm
// dialog describe the same thing the handler is about to do.
function preview(input: ToolInput): CalendarEvent {
  const draft = draftFrom(input);
  return {
    id: "(new)",
    title: draft.title,
    start: draft.start,
    end: draft.end,
    allDay: false,
    attendees: draft.attendees,
    recurring: false,
  };
}

export const createEventTool: Tool = {
  name: "createEvent",
  description:
    "Create an event on the user's calendar. Use this when they ask to schedule, book, set up, " +
    "add, or block out something. Pass `start` and `end` as exact ISO 8601 timestamps with an " +
    "offset, worked out from the current time you were given. Only pass `attendees` if the " +
    "user actually named people to invite, with their email addresses — everyone listed there " +
    "is emailed an invitation, and the user is asked to confirm before that happens. This " +
    "creates timed events only: if they ask for an all-day event, say you can't do that yet " +
    "rather than inventing a start and end time.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the event is called." },
      start: {
        type: "string",
        description: "Start, ISO 8601 with offset (e.g. 2026-08-26T15:00:00+05:30).",
      },
      end: { type: "string", description: "End, ISO 8601 with offset." },
      attendees: {
        type: "array",
        description:
          "Email addresses to invite. Omit entirely unless the user named people to invite.",
        items: { type: "string" },
      },
    },
    required: ["title", "start", "end"],
  },
  risk: {
    tiers: ["caution", "dangerous"],
    resolve: (input: ToolInput): Risk => tierFor(input),
  },
  // The `caution` path: nobody else is affected, so it announces rather than asks.
  narrate: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const zone = await deps.calendar.calendarTimeZone();
    return `Adding ${describeEvent(preview(input), zone)} to your calendar…`;
  },
  // The `dangerous` path. Names the event, the time, and every person who will be emailed —
  // in full, never "and 2 others", because this is the last moment anyone can stop it.
  confirmSummary: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const zone = await deps.calendar.calendarTimeZone();
    const event = preview(input);
    return (
      `Create ${describeEvent(event, zone)} and email an invitation to ` +
      `${formatAttendees(event.attendees)}?`
    );
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const draft = draftFrom(input);
    const zone = await deps.calendar.calendarTimeZone();

    const created = await deps.calendar.createEvent(draft);

    const invited =
      created.attendees.length > 0
        ? `\nInvited: ${formatAttendees(created.attendees)}.`
        : "";
    return `Added ${describeEvent(created, zone)} to your calendar.${invited}`;
  },
};
