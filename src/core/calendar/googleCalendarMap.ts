import type { CalendarEvent, EventDraft } from "../types.ts";

// Google's wire format in, this app's `CalendarEvent` out — and back again for writes.
//
// THIS IS M13's `gmailScript.ts`: the one file that knows a vendor's quirks, kept pure so it can
// be tested exhaustively without a network. The lesson it encodes is M10's and M11's, learned
// twice the expensive way — the fragile, guessable part of an integration must be the part that
// is provably tested, because it is the part that will be wrong.
//
// Everything above this file works in one vocabulary. Three Google-specific facts stop here:
//
//   1. Google includes the ORGANIZER in `attendees`. Left alone, a solo event looks like it has
//      a guest — which would silently gate every single create/move behind a confirm dialog and
//      look, from the outside, exactly like the risk model working correctly.
//   2. An all-day event's `end.date` is EXCLUSIVE. A one-day event on the 26th ends on the
//      27th. Rendered raw that reads as a two-day event.
//   3. `dateTime` and `date` are different fields, not one field with two formats.

// One event as Google sends it. Typed structurally rather than pulled from a vendor SDK: this
// is the only place that shape exists, and `unknown` at the edge keeps `/core` free of `any`.
export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: GoogleAttendee[];
  recurringEventId?: string;
  recurrence?: string[];
}

export interface GoogleEventTime {
  date?: string; // all-day: YYYY-MM-DD
  dateTime?: string; // timed: ISO 8601 with offset
  timeZone?: string;
}

export interface GoogleAttendee {
  email?: string;
  self?: boolean;
  responseStatus?: string;
}

const DAY_MS = 86_400_000;

// A malformed event is a bug or an API change, not a user problem — it throws rather than
// being skipped, so it surfaces instead of an event quietly vanishing from someone's schedule.
export function mapEvent(raw: GoogleEvent): CalendarEvent {
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("The calendar returned an event with no id.");
  }

  const start = raw.start ?? {};
  const end = raw.end ?? {};
  const allDay = typeof start.date === "string";

  if (allDay) {
    return {
      id,
      title: title(raw),
      start: start.date ?? "",
      // Quirk 2: Google's exclusive end date becomes the inclusive last day, once, here.
      end: previousDay(end.date ?? start.date ?? ""),
      allDay: true,
      attendees: guests(raw),
      recurring: isRecurring(raw),
    };
  }

  const startAt = start.dateTime;
  const endAt = end.dateTime;
  if (typeof startAt !== "string" || typeof endAt !== "string") {
    throw new Error(`The calendar returned an event with no start or end time (${id}).`);
  }

  return {
    id,
    title: title(raw),
    start: startAt,
    end: endAt,
    allDay: false,
    attendees: guests(raw),
    recurring: isRecurring(raw),
  };
}

// A whole feed. Two kinds of event are dropped rather than shown, and both are deliberate:
//
//   - `cancelled` — the event is gone. Google can still return one (a deleted instance of a
//     series comes back as a cancelled stub), and listing it would be reporting something that
//     is not on the calendar.
//   - one the USER has declined — "what's on today" means what is on the user's day. An event
//     they said no to is not on it. Their own response is the only one that matters here;
//     someone else declining does not remove the meeting.
export function mapEvents(items: readonly GoogleEvent[]): CalendarEvent[] {
  return items.filter((raw) => !isCancelled(raw) && !userDeclined(raw)).map(mapEvent);
}

// --- Writing ---

// `EventDraft` out to Google's shape. The timezone rides along even though the instants already
// carry offsets: Google uses it for how the event behaves later (DST, edits made in its own UI),
// not for locating this instant, and omitting it makes a calendar guess.
export function toGoogleEvent(draft: EventDraft, timeZone: string): GoogleEvent {
  return {
    summary: draft.title,
    start: { dateTime: draft.start, timeZone },
    end: { dateTime: draft.end, timeZone },
    attendees: draft.attendees.map((email) => ({ email })),
  };
}

// A move touches the times and NOTHING else. Sent as a patch rather than a full update so an
// event's description, guests, conferencing link and everything else this app never modelled
// survive untouched — the same append-only instinct notionScript.ts enforces for a page.
export function toGoogleMove(start: string, end: string, timeZone: string): GoogleEvent {
  return {
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  };
}

// --- Shared helpers ---

// Google omits `summary` entirely for an untitled event. The placeholder is what its own UI
// shows, so a schedule listing reads the way the calendar does.
function title(raw: GoogleEvent): string {
  const summary = raw.summary;
  return typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : "(no title)";
}

// Quirk 1. `self` is Google's own marker for "this is the signed-in user", so this is not
// string-matching an address — it is asking the API which entry is the user's.
//
// Resource attendees (meeting rooms) are deliberately NOT filtered out. A room is not a person,
// but counting it errs toward asking rather than acting, and that is the direction to be wrong
// in when the question is "does this reach someone else?".
function guests(raw: GoogleEvent): string[] {
  const attendees = raw.attendees;
  if (!Array.isArray(attendees)) return [];
  return attendees
    .filter((attendee) => attendee.self !== true)
    .map((attendee) => attendee.email)
    .filter((email): email is string => typeof email === "string" && email.length > 0);
}

// An instance of a series has `recurringEventId`; the series master itself has `recurrence`.
// Either way, moving it is the choice M13 declines to make on the user's behalf.
function isRecurring(raw: GoogleEvent): boolean {
  return (
    typeof raw.recurringEventId === "string" ||
    (Array.isArray(raw.recurrence) && raw.recurrence.length > 0)
  );
}

function isCancelled(raw: GoogleEvent): boolean {
  return raw.status === "cancelled";
}

function userDeclined(raw: GoogleEvent): boolean {
  const attendees = raw.attendees;
  if (!Array.isArray(attendees)) return false;
  return attendees.some(
    (attendee) => attendee.self === true && attendee.responseStatus === "declined",
  );
}

// YYYY-MM-DD, one day earlier. Done in UTC on purpose: an all-day date has no time and no zone,
// so any local-time arithmetic here would introduce a timezone into a value that does not have
// one — the classic way an all-day event drifts a day.
function previousDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return date;
  return new Date(parsed - DAY_MS).toISOString().slice(0, 10);
}
