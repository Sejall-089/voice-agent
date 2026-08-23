import { describe, it, expect } from "vitest";
import {
  MAX_SPOKEN_CHARS,
  MAX_SPOKEN_ITEMS,
  toSpokenConfirm,
  toSpokenLine,
  toSpokenNarration,
  toSpokenResult,
} from "../src/core/speech.ts";
import { formatSchedule, formatWhen } from "../src/core/calendar/format.ts";
import { FakeSynthesizer, unspeakable } from "./FakeSynthesizer.ts";
import type { CalendarEvent } from "../src/core/types.ts";

// M14 task 1. The transform between what the screen shows and what the app says.
//
// Tested this hard for the reason M13 wrote down: the half of a voice feature that is ordinary
// logic gets fixtures from day one, and only the audio itself waits for a live run. The inputs
// below are REAL producer output wherever possible (formatSchedule, the actual confirm-summary
// and result shapes the tools emit) rather than strings invented to suit the assertions.

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

const TITLES = [
  "Event one",
  "Event two",
  "Event three",
  "Event four",
  "Event five",
  "Event six",
  "Event seven",
  "Event eight",
  "Event nine",
  "Event ten",
];

function schedule(count: number): string {
  return formatSchedule(
    TITLES.slice(0, count).map((title) => event({ title })),
    ZONE,
  );
}

describe("toSpokenResult — plain prose", () => {
  it("says a short result as it stands, holding nothing back", () => {
    expect(toSpokenResult("Remembered: tone = concise, warm, and direct")).toEqual({
      text: "Remembered: tone = concise, warm, and direct.",
      remainder: null,
    });
  });

  it("says a URL as its host, not character by character", () => {
    // openTarget returns `Opened ${url}`. "h t t p s colon slash slash" is unbearable aloud.
    expect(toSpokenResult("Opened https://github.com/dashboard").text).toBe(
      "Opened github.com.",
    );
  });

  it("turns a stray dash into a comma rather than letting it reach the engine", () => {
    // Recon's most expensive finding. This was originally the opposite rule — unspaced dashes
    // were KEPT, on the theory that "3:00–4:00 PM" would be voiced as "3 to 4". It is not:
    // Piper receives U+2013 as mojibake (bytes E2 80 93, read as Windows-1252: "â" + "€") and
    // says the pieces. A range that means "to" now says so at the producer, where the meaning
    // is known (calendar/format.ts's speakableWhen); everywhere else a comma is the safe read.
    expect(toSpokenResult("Standup 9:00–9:15 AM").text).toBe("Standup 9 to 9 15 AM.");
    expect(toSpokenResult("A — B").text).toBe("A, B.");
  });

  it("leaves letters alone, accents included", () => {
    // Deliberately NOT stripped: mangling a real name is worse than risking its pronunciation,
    // and the actual fix for non-ASCII is the synthesizer's encoding (spawn with PYTHONUTF8=1
    // and prove it), not silent deletion here.
    expect(toSpokenResult("Remembered: manager = José").text).toBe(
      "Remembered: manager = José.",
    );
  });

  it("never speaks an empty utterance for empty input", () => {
    expect(toSpokenResult("   \n\n  ")).toEqual({ text: "", remainder: null });
  });

  it("caps long prose and holds the rest", () => {
    const long = `${"word ".repeat(80)}end`;
    const spoken = toSpokenResult(long);

    expect(spoken.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 50);
    expect(spoken.text).toContain("There's more. Want me to read the rest?");
    expect(spoken.remainder).not.toBeNull();
    expect(spoken.remainder).toContain("end");
  });
});

describe("toSpokenResult — a headline with a body", () => {
  // This codebase already uses a blank line to mean "headline, then the bulk":
  // sendMessage returns `Sent to #design-team.\n\n<the whole message>`, sendReply
  // `Sent.\n\n<the whole reply>`. Reading the message back at the person who just sent it is
  // noise, so only the headline is spoken.
  const sent = "Sent to #design-team.\n\nMeeting notes\nWe agreed to ship on Friday.";

  it("speaks only the first paragraph", () => {
    const spoken = toSpokenResult(sent);
    expect(spoken.text).toBe(
      "Sent to design-team. There's more. Want me to read the rest?",
    );
  });

  it("holds the body for an elaborate-on-request follow-up", () => {
    const spoken = toSpokenResult(sent);
    expect(spoken.remainder).toBe("Meeting notes. We agreed to ship on Friday.");
  });
});

describe("toSpokenResult — a list", () => {
  it("reads the first few events and offers the count of the rest", () => {
    const spoken = toSpokenResult(schedule(10));

    expect(spoken.text).toContain("Wednesday 26 August, 3 to 4 PM, Event one.");
    expect(spoken.text).toContain(`Plus ${10 - MAX_SPOKEN_ITEMS} more. Want me to read them?`);
  });

  it("never reads half an event — the offer replaces whole items, not a truncated one", () => {
    const spoken = toSpokenResult(schedule(10));

    expect(spoken.text).toContain("Event three.");
    expect(spoken.text).not.toContain("Event four");
    expect(spoken.remainder).toContain("Event four");
    expect(spoken.remainder).toContain("Event ten");
  });

  it("offers nothing when the whole list fits", () => {
    const spoken = toSpokenResult(schedule(2));

    expect(spoken.text).not.toContain("Plus");
    expect(spoken.remainder).toBeNull();
  });

  it("strips the bullet that formatSchedule writes for the screen", () => {
    expect(schedule(3)).toContain("•"); // the real producer does emit them
    expect(toSpokenResult(schedule(3)).text).not.toContain("•");
  });
});

describe("toSpokenNarration", () => {
  it("says what is about to happen, with the screen's ellipsis and quotes removed", () => {
    // createEvent's actual narrate output.
    const narration = 'Adding "Design review" on Wed 26 Aug, 3:00–4:00 PM to your calendar…';

    expect(toSpokenNarration(narration)).toEqual({
      text: "Adding Design review on Wednesday 26 August, 3 to 4 PM to your calendar.",
      remainder: null,
    });
  });

  it("never offers to read more — by the time anyone could ask, the action has happened", () => {
    const spoken = toSpokenNarration(`${"word ".repeat(80)}end`);

    expect(spoken.remainder).toBeNull();
    expect(spoken.text).not.toContain("Want me to read");
    expect(spoken.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 50);
  });
});

describe("toSpokenConfirm", () => {
  // sendReply's real summary shape: the decisive question, a blank line, then the WHOLE draft.
  const summary =
    "Send this reply to alex@example.com?\n\n" +
    "Hi Alex,\n\nThursday works for me. Shall we say 2pm?\n\nSejal";

  it("speaks the question and points at the dialog", () => {
    expect(toSpokenConfirm(summary).text).toBe(
      "Send this reply to alex@example.com? Check the dialog.",
    );
  });

  it("NEVER speaks the draft body — the dialog is where that is read", () => {
    const spoken = toSpokenConfirm(summary);

    expect(spoken.text).not.toContain("Thursday");
    expect(spoken.text).not.toContain("Sejal");
  });

  it("never offers to read the rest — that would duplicate what is on screen, aloud", () => {
    expect(toSpokenConfirm(summary).remainder).toBeNull();
  });

  it("still caps a one-paragraph summary that has no body to split off", () => {
    // createEvent's summary is a single sentence naming every guest, and a dozen guests make it
    // long. There is no blank line to cut at, so the character cap has to do the work.
    const guests = TITLES.map((name) => `${name.replace(" ", ".")}@example.com`).join(", ");
    const long = `Create "Design review" on Wed 26 Aug, 3:00–4:00 PM and email an invitation to ${guests}?`;

    const spoken = toSpokenConfirm(long);
    expect(long.length).toBeGreaterThan(MAX_SPOKEN_CHARS);
    expect(spoken.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 50);
    expect(spoken.text).toContain("Check the dialog.");
  });

  it("says the question plainly when there is nothing else to see", () => {
    expect(toSpokenConfirm("Send to design-team?")).toEqual({
      text: "Send to design-team?",
      remainder: null,
    });
  });
});

describe("every output is speakable", () => {
  // The invariant a strict FakeSynthesizer will enforce independently in task 2. Asserted here
  // too, over real producer output, because this is the file whose job it is to guarantee it.
  const fixtures = [
    schedule(10),
    schedule(1),
    "Sent to #design-team.\n\nA note with **bold** and `code` in it.",
    "Opened https://www.github.com/dashboard",
    'Adding "Design review" on Wed 26 Aug, 3:00–4:00 PM to your calendar…',
    "# A heading\n\n- one\n- two\n- three",
    "Nothing on your calendar in that window.",
    "Updated \"team\": #design → #design-team (v2).",
    "Sent. 🎉\n\nThanks!",
  ];

  const forbidden = ["\n", "•", "*", "_", "`", "#", '"', "…", "http"];

  for (const fixture of fixtures) {
    const label = fixture.split("\n")[0]?.slice(0, 40) ?? "";

    it(`produces one clean line for: ${label}`, () => {
      for (const spoken of [
        toSpokenResult(fixture),
        toSpokenNarration(fixture),
        toSpokenConfirm(fixture),
      ]) {
        expect(spoken.text.length).toBeGreaterThan(0);
        expect(spoken.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 50);
        for (const char of forbidden) {
          expect(spoken.text).not.toContain(char);
          if (spoken.remainder !== null) expect(spoken.remainder).not.toContain(char);
        }
      }
    });
  }
});

// The dates and times, said rather than written. Every input is REAL formatWhen output, so this
// cannot drift from what the screen actually shows.
//
// This lives here rather than beside formatWhen for a reason worth keeping: it was written there
// first, as a calendar-specific `speakableWhen`, and that was wrong. `createEvent`'s narration
// and its confirm dialog carry the same written date through the same engine, so fixing only the
// schedule listing would have left the two places that matter MOST still garbled. One cleaner,
// every path.
describe("dates and times, spoken", () => {
  it("says a same-day range as a range", () => {
    expect(toSpokenLine(formatWhen(event(), ZONE))).toBe("Wednesday 26 August, 3 to 4 PM.");
  });

  it("keeps both meridiems when they differ", () => {
    const lunch = event({
      start: "2026-08-26T11:00:00+05:30",
      end: "2026-08-26T13:00:00+05:30",
    });

    expect(toSpokenLine(formatWhen(lunch, ZONE))).toBe("Wednesday 26 August, 11 AM to 1 PM.");
  });

  it("keeps the minutes when there are any, across midnight", () => {
    const late = event({
      start: "2026-08-26T23:30:00+05:30",
      end: "2026-08-27T00:30:00+05:30",
    });

    // No colon: confirmed by ear that the engine reads one digit by digit ("3:00" came back as
    // "three zero zero"), so "11:30" would have been "eleven three zero".
    expect(toSpokenLine(formatWhen(late, ZONE))).toBe(
      "Wednesday 26 August, 11 30 PM to Thursday 27 August, 12 30 AM.",
    );
  });

  it("says a leading-zero minute as 'oh', the way a person does", () => {
    const late = event({
      start: "2026-08-26T15:05:00+05:30",
      end: "2026-08-26T16:00:00+05:30",
    });

    expect(toSpokenLine(formatWhen(late, ZONE))).toBe("Wednesday 26 August, 3 oh 5 to 4 PM.");
  });

  it("never lets a colon reach the engine from a time", () => {
    for (const time of ["3:00 PM", "3:05 PM", "3:30 PM", "11:45 AM", "12:00 AM"]) {
      expect(toSpokenLine(time)).not.toContain(":");
    }
  });

  it("says an all-day event without the parentheses", () => {
    const allDay = event({ allDay: true, start: "2026-08-26", end: "2026-08-26" });

    expect(toSpokenLine(formatWhen(allDay, ZONE))).toBe("Wednesday 26 August, all day.");
  });

  it("says a multi-day all-day event as a range", () => {
    const holiday = event({ allDay: true, start: "2026-08-26", end: "2026-08-27" });

    expect(toSpokenLine(formatWhen(holiday, ZONE))).toBe(
      "Wednesday 26 August to Thursday 27 August, all day.",
    );
  });

  it("expands the abbreviation only in a real date, never in a sentence", () => {
    // The rule is anchored to the whole weekday-day-month shape formatDay emits. A bare "Sun"
    // or "Mar" in ordinary text is a word, and turning "the Sun is out" into "the Sunday is
    // out" would be a worse bug than the one this fixes.
    expect(toSpokenLine("The Sun is out and Mar is here")).toBe("The Sun is out and Mar is here.");
    expect(toSpokenLine("Sat 1 Mar")).toBe("Saturday 1 March.");
  });

  it("leaves what the SCREEN shows completely alone", () => {
    // Two representations, one source: this is a derivation, not a rewrite.
    expect(formatWhen(event(), ZONE)).toBe("Wed 26 Aug, 3:00–4:00 PM");
  });
});

// The pair of contracts meeting: what the transform GUARANTEES, checked against what the engine
// stand-in REFUSES.
//
// This is the test that makes both worth having. `unspeakable` is written out independently in
// tests/FakeSynthesizer.ts — it does not call the cleaner — so if the cleaner grows a hole, this
// fails instead of the two agreeing with each other and both being wrong. It is the check that
// FakeCalendar's substring matching could not perform for M13.
describe("the transform satisfies the engine's contract", () => {
  const everything = [
    schedule(10),
    schedule(1),
    "Sent to #design-team.\n\nA note with **bold** and `code` in it.",
    "Opened https://www.github.com/dashboard",
    'Adding "Design review" on Wed 26 Aug, 3:00–4:00 PM to your calendar…',
    "# A heading\n\n- one\n- two\n- three",
    "Nothing on your calendar in that window.",
    'Updated "team": #design → #design-team (v2).',
    "Sent. 🎉\n\nThanks!",
    "Send this reply to alex@example.com?\n\nHi Alex,\n\nThursday works.\n\nSejal",
    "Standup 9:00–9:15 AM — “quoted” and ‘curly’",
  ];

  for (const fixture of everything) {
    const label = fixture.split("\n")[0]?.slice(0, 36) ?? "";

    it(`is speakable, and its remainder is too: ${label}`, () => {
      for (const spoken of [
        toSpokenResult(fixture),
        toSpokenNarration(fixture),
        toSpokenConfirm(fixture),
      ]) {
        expect(unspeakable(spoken.text)).toBeNull();
        // The remainder is spoken verbatim by `elaborate`, so it has to clear the same bar.
        if (spoken.remainder !== null) expect(unspeakable(spoken.remainder)).toBeNull();
      }
    });
  }
});

describe("FakeSynthesizer refuses what the real engine cannot take", () => {
  it("rejects empty text — the engine exits 1 rather than making silence", () => {
    expect(unspeakable("")).toContain("empty");
    expect(unspeakable("   ")).toContain("empty");
  });

  it("rejects a line break — one call is one utterance", () => {
    expect(unspeakable("one\ntwo")).toContain("line break");
  });

  it("rejects the typographic characters the engine mis-decodes", () => {
    for (const bad of ["3–4", "a — b", "“hi”", "it’s", "one…"]) {
      expect(unspeakable(bad)).not.toBeNull();
    }
  });

  it("rejects markup the cleaner is supposed to have removed", () => {
    for (const bad of ["• one", "**bold**", "# heading", "`code`"]) {
      expect(unspeakable(bad)).not.toBeNull();
    }
  });

  it("allows accented letters, matching what the cleaner deliberately keeps", () => {
    // The transform leaves "José" alone rather than mangling a name; a fake that rejected it
    // would be enforcing a rule the code does not have, and would fail honest text.
    expect(unspeakable("Remembered: manager = José.")).toBeNull();
  });

  it("rejects an over-long utterance", () => {
    expect(unspeakable("word ".repeat(200))).toContain("over the");
  });

  it("names the offending text, so a failure points at the transform not the engine", async () => {
    const fake = new FakeSynthesizer();

    await expect(fake.synthesize("3–4 PM")).rejects.toThrow(/refused: .*"3–4 PM"/);
    expect(fake.spoken).toEqual([]);
  });

  it("hands back a real, parseable WAV for text it accepts", async () => {
    const fake = new FakeSynthesizer();
    const wav = await fake.synthesize("Done.");

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(22_050); // not AudioClip's 16 kHz
    expect(fake.spoken).toEqual(["Done."]);
  });
});
