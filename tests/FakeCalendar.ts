import { calendarAuthError, type CalendarAuthReason } from "../src/core/errors.ts";
import type { CalendarEvent, CalendarSurface, EventDraft } from "../src/core/types.ts";

// A calendar that exists only in memory (M13) — the same role FakeGmail and FakeNotion play.
// The tools and the planner run their real code; the thing with real-world consequences (a real
// Google account, real invitation emails) is swapped for something a test can inspect.
//
// No test in this repo ever calls the Google API or runs an OAuth flow. What that buys is that
// the *decisions* — confirm before inviting anyone, refuse rather than guess which event was
// meant, never move a series instance, preserve the duration — are proven deterministically.
// What it does NOT buy is any evidence that GoogleCalendar's real requests are shaped right, or
// that a real token refresh works; only a live run shows that.

export interface FakeCalendarOptions {
  events?: CalendarEvent[];
  timeZone?: string;
  // When set, EVERY operation rejects with this — a calendar that isn't reachable.
  failWith?: string;
  // When set, every operation rejects with the NAMED auth failure. Separate from `failWith`
  // because the whole point of CalendarAuthError is that it is not an ordinary breakage.
  authFailure?: CalendarAuthReason;
  // Optional shared ordering log, same role as FakeGmail's and FakeNotion's — lets a test
  // compare the order of events across doubles ("narration went out before anything was
  // created").
  timeline?: string[];
}

export class FakeCalendar implements CalendarSurface {
  public readonly calls: string[] = [];
  public created: EventDraft[] = [];
  public moved: { id: string; start: string; end: string }[] = [];

  private events: CalendarEvent[];
  private readonly zone: string;
  private readonly failWith: string | undefined;
  private readonly authFailure: CalendarAuthReason | undefined;
  private readonly timeline: string[] | undefined;
  private nextId = 1;

  // Lets a test change the world BETWEEN the risk gate and the handler, which is the only way
  // to prove the time-of-check/time-of-use guard actually guards anything.
  public onGetEvent: ((event: CalendarEvent) => CalendarEvent) | undefined;

  constructor(options: FakeCalendarOptions = {}) {
    this.events = options.events ?? [sampleEvent()];
    this.zone = options.timeZone ?? "Asia/Kolkata";
    this.failWith = options.failWith;
    this.authFailure = options.authFailure;
    this.timeline = options.timeline;
  }

  private note(call: string): void {
    this.calls.push(call);
    this.timeline?.push(`calendar:${call}`);
  }

  private guard(): void {
    if (this.authFailure !== undefined) throw calendarAuthError(this.authFailure);
    if (this.failWith !== undefined) throw new Error(this.failWith);
  }

  calendarTimeZone(): Promise<string> {
    this.note("calendarTimeZone");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.zone);
  }

  listUpcoming(from: string, to: string, limit: number): Promise<CalendarEvent[]> {
    this.note("listUpcoming");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    const fromAt = Date.parse(from);
    const toAt = Date.parse(to);
    const within = this.events.filter((event) => {
      const at = Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start);
      return at >= fromAt && at <= toAt;
    });
    return Promise.resolve(within.slice(0, limit));
  }

  findEvent(query: string, _from: string, _to: string): Promise<CalendarEvent[]> {
    this.note("findEvent");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    // Deliberately dumb substring matching. The real implementation asks Google to search; what
    // matters for the tools is only how many came back, never how they were found.
    const needle = query.trim().toLowerCase();
    return Promise.resolve(
      this.events.filter((event) => event.title.toLowerCase().includes(needle)),
    );
  }

  getEvent(id: string): Promise<CalendarEvent> {
    this.note("getEvent");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    const found = this.events.find((event) => event.id === id);
    if (!found) return Promise.reject(new Error(`No event with id ${id}.`));
    return Promise.resolve(this.onGetEvent ? this.onGetEvent(found) : found);
  }

  createEvent(draft: EventDraft): Promise<CalendarEvent> {
    this.note("createEvent");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    this.created.push(draft);
    const event: CalendarEvent = {
      id: `new${this.nextId++}`,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      allDay: false,
      attendees: [...draft.attendees],
      recurring: false,
    };
    this.events = [...this.events, event];
    return Promise.resolve(event);
  }

  moveEvent(id: string, start: string, end: string): Promise<CalendarEvent> {
    this.note("moveEvent");
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    const found = this.events.find((event) => event.id === id);
    if (!found) return Promise.reject(new Error(`No event with id ${id}.`));
    this.moved.push({ id, start, end });
    const updated: CalendarEvent = { ...found, start, end };
    this.events = this.events.map((event) => (event.id === id ? updated : event));
    return Promise.resolve(updated);
  }
}

export function sampleEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt1",
    title: "Design review",
    start: "2026-08-26T15:00:00+05:30",
    end: "2026-08-26T16:00:00+05:30",
    allDay: false,
    attendees: [],
    recurring: false,
    ...overrides,
  };
}
