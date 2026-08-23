import { calendarAuthError } from "../errors.ts";
import { mapEvent, mapEvents, toGoogleEvent, toGoogleMove } from "./googleCalendarMap.ts";
import type { CalendarAuth } from "./CalendarAuth.ts";
import type { GoogleEvent } from "./googleCalendarMap.ts";
import type { CalendarEvent, CalendarSurface, EventDraft } from "../types.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
// M13 acts on the primary calendar only (spec §6c). Named as a constant rather than inlined
// four times, so the day this becomes a choice there is one place to change.
const CALENDAR_ID = "primary";

// The real `CalendarSurface` (M13): Google Calendar over its own HTTP API.
//
// Deliberately THIN, the same way `ChromeGmail` is thin — every judgement call lives either in
// `googleCalendarMap.ts` (which is pure and exhaustively tested) or in the tools (which are
// tested against a fake). What is left here is request-shaping and error classification, and it
// is the one part of this milestone that only a live run can verify.

export interface GoogleCalendarOptions {
  auth: CalendarAuth;
  fetchFn?: typeof globalThis.fetch;
}

export class GoogleCalendar implements CalendarSurface {
  private readonly auth: CalendarAuth;
  private readonly fetchFn: typeof globalThis.fetch;
  // The calendar's timezone changes about never, and it is read on nearly every call — for
  // narration, for the confirm dialog, for the result text. Fetched once per app run.
  private timeZone: string | null = null;

  constructor(options: GoogleCalendarOptions) {
    this.auth = options.auth;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async calendarTimeZone(): Promise<string> {
    if (this.timeZone !== null) return this.timeZone;
    const calendar = await this.request<{ timeZone?: string }>("GET", `/calendars/${CALENDAR_ID}`);
    // A calendar with no timezone shouldn't happen; UTC is the one fallback that is wrong in a
    // visible, obvious way rather than a plausible one.
    this.timeZone = calendar.timeZone ?? "UTC";
    return this.timeZone;
  }

  async listUpcoming(from: string, to: string, limit: number): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      maxResults: String(limit),
      // Expand recurring series into individual occurrences, ordered by when they happen.
      // Without this a weekly standup comes back once, as a rule, with a start date months ago.
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
    });
    const page = await this.request<{ items?: GoogleEvent[] }>(
      "GET",
      `/calendars/${CALENDAR_ID}/events?${query.toString()}`,
    );
    return mapEvents(page.items ?? []);
  }

  async findEvent(query: string, from: string, to: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      q: query,
      timeMin: from,
      timeMax: to,
      // Deliberately more than the caller can use: the tool refuses on more than one match, so
      // it needs to SEE the extras. Capping at 1 would turn an ambiguous request into a
      // confident wrong answer, which is the exact failure the default-deny rule exists for.
      maxResults: "10",
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
    });
    const page = await this.request<{ items?: GoogleEvent[] }>(
      "GET",
      `/calendars/${CALENDAR_ID}/events?${params.toString()}`,
    );
    return mapEvents(page.items ?? []);
  }

  async getEvent(id: string): Promise<CalendarEvent> {
    const raw = await this.request<GoogleEvent>(
      "GET",
      `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(id)}`,
    );
    return mapEvent(raw);
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    const timeZone = await this.calendarTimeZone();
    const created = await this.request<GoogleEvent>(
      "POST",
      `/calendars/${CALENDAR_ID}/events?sendUpdates=all`,
      toGoogleEvent(draft, timeZone),
    );
    return mapEvent(created);
  }

  async moveEvent(id: string, start: string, end: string): Promise<CalendarEvent> {
    const timeZone = await this.calendarTimeZone();
    // PATCH, not PUT: a move changes the times and must not be able to erase a description, a
    // guest list, or a meeting link this app never modelled.
    const moved = await this.request<GoogleEvent>(
      "PATCH",
      `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(id)}?sendUpdates=all`,
      toGoogleMove(start, end, timeZone),
    );
    return mapEvent(moved);
  }

  // `sendUpdates=all` on both writes above is explicit rather than left to Google's default,
  // and it is the honest setting: the confirm dialog told the user their guests would be
  // emailed, so the request has to actually do that. On an event with no guests it notifies
  // nobody, which is why one value is correct for both cases.

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.auth.getAccessToken();

    let response: Response;
    try {
      response = await this.fetchFn(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach Google Calendar: ${message}`);
    }

    if (response.status === 401) {
      // The token was accepted when we got it and is being refused now. Drop it so the next
      // instruction fetches a fresh one instead of confidently reusing something Google has
      // already said no to — and tell the user in the one word that fits: expired.
      this.auth.invalidate();
      throw calendarAuthError("expired");
    }
    if (response.status === 403) {
      // Distinct from 401 on purpose: the token is fine, the app is not allowed. Almost always
      // a missing scope, which reconnecting genuinely does fix.
      throw calendarAuthError("revoked");
    }
    if (!response.ok) {
      // Status only — never the response body, which can echo event content back.
      throw new Error(`Google Calendar refused the request (HTTP ${response.status}).`);
    }

    return (await response.json()) as T;
  }
}
