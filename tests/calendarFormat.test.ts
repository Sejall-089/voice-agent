import { describe, it, expect } from "vitest";
import {
  describeEvent,
  formatAttendees,
  formatSchedule,
  formatWhen,
} from "../src/core/calendar/format.ts";
import type { CalendarEvent } from "../src/core/types.ts";

// The exact words a human is shown. Worth testing precisely, because one of these strings is
// the confirm dialog — the last thing between an instruction and an invite in someone's inbox.

const ZONE = "Asia/Kolkata";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
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

describe("formatWhen", () => {
  it("writes a timed event as one day and a time range", () => {
    expect(formatWhen(event(), ZONE)).toBe("Wed 26 Aug, 3:00–4:00 PM");
  });

  it("renders in the calendar's zone, not the machine's", () => {
    // Same instant, a calendar living somewhere else. The times a schedule shows should match
    // what the user sees in Google Calendar.
    expect(formatWhen(event(), "America/New_York")).toBe("Wed 26 Aug, 5:30–6:30 AM");
  });

  it("writes the meridiem once within a range, but twice when the range crosses noon", () => {
    // "11:00–1:00 PM" would read as ending two hours before it started.
    const lunch = event({
      start: "2026-08-26T11:00:00+05:30",
      end: "2026-08-26T13:00:00+05:30",
    });
    expect(formatWhen(lunch, ZONE)).toBe("Wed 26 Aug, 11:00 AM–1:00 PM");
  });

  it("names the second day when a meeting crosses midnight", () => {
    const late = event({
      start: "2026-08-26T23:30:00+05:30",
      end: "2026-08-27T00:30:00+05:30",
    });
    // "11:30 PM–12:30 AM" alone would read as an hour that already happened.
    expect(formatWhen(late, ZONE)).toBe("Wed 26 Aug, 11:30 PM – Thu 27 Aug, 12:30 AM");
  });

  it("writes a one-day all-day event as a single day", () => {
    const holiday = event({ start: "2026-08-26", end: "2026-08-26", allDay: true });
    expect(formatWhen(holiday, ZONE)).toBe("Wed 26 Aug (all day)");
  });

  it("writes a multi-day all-day event as an inclusive range", () => {
    const offsite = event({ start: "2026-08-26", end: "2026-08-28", allDay: true });
    expect(formatWhen(offsite, ZONE)).toBe("Wed 26 Aug – Fri 28 Aug (all day)");
  });

  it("keeps an all-day event on its own date regardless of the calendar's offset", () => {
    // An all-day value has no time and no zone. Formatting it through a real offset is how an
    // all-day event drifts a day — westward or eastward depending on the sign.
    for (const zone of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      const holiday = event({ start: "2026-08-26", end: "2026-08-26", allDay: true });
      expect(formatWhen(holiday, zone)).toBe("Wed 26 Aug (all day)");
    }
  });
});

describe("formatAttendees", () => {
  it("names every single person, never a count", () => {
    // A truncated list is exactly where the wrong recipient hides. Same reasoning as sendReply
    // showing the whole draft rather than a preview.
    expect(formatAttendees(["alex@example.com"])).toBe("alex@example.com");
    expect(formatAttendees(["alex@example.com", "sam@example.com"])).toBe(
      "alex@example.com and sam@example.com",
    );
    expect(formatAttendees(["a@x.com", "b@x.com", "c@x.com"])).toBe(
      "a@x.com, b@x.com and c@x.com",
    );
  });

  it("says nothing at all for nobody", () => {
    expect(formatAttendees([])).toBe("");
  });
});

describe("describeEvent", () => {
  it("quotes the title so an odd one cannot blend into the sentence", () => {
    expect(describeEvent(event({ title: "on Thursday" }), ZONE)).toBe(
      '"on Thursday" on Wed 26 Aug, 3:00–4:00 PM',
    );
  });
});

describe("formatSchedule", () => {
  it("lists events one per line, naming who is on each", () => {
    const rendered = formatSchedule(
      [
        event(),
        event({
          id: "evt2",
          title: "1:1",
          start: "2026-08-26T17:00:00+05:30",
          end: "2026-08-26T17:30:00+05:30",
          attendees: ["alex@example.com"],
        }),
      ],
      ZONE,
    );

    expect(rendered).toBe(
      "• Wed 26 Aug, 3:00–4:00 PM — Design review\n" +
        "• Wed 26 Aug, 5:00–5:30 PM — 1:1 — with alex@example.com",
    );
  });

  it("renders an empty schedule as empty text, leaving the wording to the tool", () => {
    expect(formatSchedule([], ZONE)).toBe("");
  });
});

describe("formatDay is the same shape on every runtime", () => {
  it("never puts a comma after the weekday", () => {
    // node's ICU renders "Wed 26 Aug" and electron's renders "Wed, 26 Aug" for the same
    // instant. Everything downstream is written against a shape — the schedule line's " — "
    // joins, the speech transform's date expansion — so letting it vary by runtime means the
    // tests describe node while the user gets electron. That is exactly how "Wed" and "Aug"
    // came to be read aloud as words in M14's live pass.
    for (const written of [
      formatWhen(event(), ZONE),
      formatWhen(event({ allDay: true, start: "2026-08-26", end: "2026-08-26" }), ZONE),
    ]) {
      expect(written).not.toMatch(/^\w{3,4},/);
    }
  });
});
