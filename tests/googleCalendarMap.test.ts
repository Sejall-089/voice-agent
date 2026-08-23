import { describe, it, expect } from "vitest";
import {
  mapEvent,
  mapEvents,
  toGoogleEvent,
  toGoogleMove,
  type GoogleEvent,
} from "../src/core/calendar/googleCalendarMap.ts";

// M13's counterpart to gmailScript.test.ts: the vendor-shaped layer, tested exhaustively and
// without a network, because it is the part most likely to be quietly wrong.
//
// The single most load-bearing test in this file is "counts only OTHER people as guests". The
// risk tier of every create and every move is decided by `attendees.length`, so if that number
// is wrong the gate is wrong — and wrong in the direction that is hardest to notice, because
// over-gating looks exactly like the safety model working.

function timed(overrides: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id: "evt1",
    summary: "Design review",
    start: { dateTime: "2026-08-26T15:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-08-26T16:00:00+05:30", timeZone: "Asia/Kolkata" },
    ...overrides,
  };
}

describe("mapEvent", () => {
  it("maps a timed event", () => {
    expect(mapEvent(timed())).toEqual({
      id: "evt1",
      title: "Design review",
      start: "2026-08-26T15:00:00+05:30",
      end: "2026-08-26T16:00:00+05:30",
      allDay: false,
      attendees: [],
      recurring: false,
    });
  });

  it("turns Google's exclusive all-day end into the inclusive last day", () => {
    // Google says a one-day event on the 26th ends on the 27th. Passed through raw, every
    // single-day event would render as spanning two days.
    const oneDay = mapEvent({
      id: "evt2",
      summary: "Public holiday",
      start: { date: "2026-08-26" },
      end: { date: "2026-08-27" },
    });
    expect(oneDay.allDay).toBe(true);
    expect(oneDay.start).toBe("2026-08-26");
    expect(oneDay.end).toBe("2026-08-26");

    const threeDays = mapEvent({
      id: "evt3",
      summary: "Offsite",
      start: { date: "2026-08-26" },
      end: { date: "2026-08-29" },
    });
    expect(threeDays.end).toBe("2026-08-28");
  });

  it("crosses a month boundary without drifting", () => {
    const event = mapEvent({
      id: "evt4",
      start: { date: "2026-08-31" },
      end: { date: "2026-09-01" },
    });
    expect(event.end).toBe("2026-08-31");
  });

  // THE tier-deciding test.
  it("counts only OTHER people as guests, never the user themself", () => {
    const solo = mapEvent(
      timed({
        attendees: [{ email: "me@example.com", self: true, responseStatus: "accepted" }],
      }),
    );
    // Google lists the organizer on their own event. If this were 1, every solo event the user
    // created would be classified `dangerous` and stop for a confirm dialog nobody needs.
    expect(solo.attendees).toEqual([]);

    const withGuests = mapEvent(
      timed({
        attendees: [
          { email: "me@example.com", self: true },
          { email: "alex@example.com" },
          { email: "sam@example.com" },
        ],
      }),
    );
    expect(withGuests.attendees).toEqual(["alex@example.com", "sam@example.com"]);
  });

  it("ignores attendee entries with no email at all", () => {
    const event = mapEvent(timed({ attendees: [{ responseStatus: "needsAction" }, { email: "" }] }));
    expect(event.attendees).toEqual([]);
  });

  it("flags an instance of a series and a series master alike", () => {
    expect(mapEvent(timed({ recurringEventId: "series1" })).recurring).toBe(true);
    expect(mapEvent(timed({ recurrence: ["RRULE:FREQ=WEEKLY"] })).recurring).toBe(true);
    expect(mapEvent(timed({ recurrence: [] })).recurring).toBe(false);
    expect(mapEvent(timed()).recurring).toBe(false);
  });

  it("uses the same placeholder for an untitled event that Google's own UI does", () => {
    expect(mapEvent(timed({ summary: undefined })).title).toBe("(no title)");
    expect(mapEvent(timed({ summary: "   " })).title).toBe("(no title)");
    expect(mapEvent(timed({ summary: "  Standup  " })).title).toBe("Standup");
  });

  // Loud, not silent. An event that vanished from someone's schedule because the API changed
  // shape is the worst possible failure for a calendar tool.
  it("throws on a malformed event rather than dropping it", () => {
    expect(() => mapEvent({ summary: "no id" })).toThrow(/no id/i);
    expect(() => mapEvent({ id: "evt5", summary: "no times" })).toThrow(/no start or end/i);
  });
});

describe("mapEvents", () => {
  it("drops cancelled events", () => {
    const mapped = mapEvents([
      timed(),
      timed({ id: "gone", status: "cancelled" }),
    ]);
    expect(mapped.map((event) => event.id)).toEqual(["evt1"]);
  });

  it("drops events the user themself declined, but not ones others declined", () => {
    const mapped = mapEvents([
      timed({
        id: "declined-by-me",
        attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }],
      }),
      timed({
        id: "declined-by-them",
        attendees: [
          { email: "me@example.com", self: true, responseStatus: "accepted" },
          { email: "alex@example.com", responseStatus: "declined" },
        ],
      }),
    ]);

    // "What's on today" means the user's day. Someone else saying no does not remove the
    // meeting from it; the user saying no does.
    expect(mapped.map((event) => event.id)).toEqual(["declined-by-them"]);
  });

  it("keeps an empty feed empty rather than inventing anything", () => {
    expect(mapEvents([])).toEqual([]);
  });
});

describe("writing back", () => {
  it("sends the calendar's timezone alongside the instants", () => {
    const body = toGoogleEvent(
      {
        title: "Design review",
        start: "2026-08-26T15:00:00+05:30",
        end: "2026-08-26T16:00:00+05:30",
        attendees: ["alex@example.com"],
      },
      "Asia/Kolkata",
    );

    expect(body).toEqual({
      summary: "Design review",
      start: { dateTime: "2026-08-26T15:00:00+05:30", timeZone: "Asia/Kolkata" },
      end: { dateTime: "2026-08-26T16:00:00+05:30", timeZone: "Asia/Kolkata" },
      attendees: [{ email: "alex@example.com" }],
    });
  });

  it("sends only the times when moving — nothing else about the event", () => {
    const body = toGoogleMove("2026-08-26T16:00:00+05:30", "2026-08-26T17:00:00+05:30", "Asia/Kolkata");

    // A move must not be able to erase a description, a guest list, or a meeting link that this
    // app never modelled in the first place.
    expect(Object.keys(body).sort()).toEqual(["end", "start"]);
  });
});
