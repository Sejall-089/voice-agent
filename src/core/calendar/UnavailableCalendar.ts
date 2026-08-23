import { calendarAuthError } from "../errors.ts";
import type { CalendarEvent, CalendarSurface } from "../types.ts";

// The default `CalendarSurface` (M13) — the exact counterpart of `UnavailableSender`,
// `UnavailableGmail` and `UnavailableNotion`.
//
// A Planner built without a connected calendar gets this, so "not connected" is a missing
// capability that explains itself rather than a null that blows up somewhere deeper. In the
// running app the calendar tools are not even offered to the model when there is no token (see
// registry.buildRegistry), so this is the second line of defence, not the first.
//
// One difference from its three predecessors, and it is the point of the class: it rejects with
// a `CalendarAuthError`, not a bare `Error`. "I was never connected to your calendar" is
// something the user can fix in a minute, and the planner shows it verbatim and logs it as
// `refused` rather than dressing it up as a malfunction.
export class UnavailableCalendar implements CalendarSurface {
  calendarTimeZone(): Promise<string> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
  listUpcoming(): Promise<CalendarEvent[]> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
  findEvent(): Promise<CalendarEvent[]> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
  getEvent(): Promise<CalendarEvent> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
  createEvent(): Promise<CalendarEvent> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
  moveEvent(): Promise<CalendarEvent> {
    return Promise.reject(calendarAuthError("not-connected"));
  }
}
