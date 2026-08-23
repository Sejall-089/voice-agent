import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry, calendarTools } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { UnavailableCalendar } from "../src/core/calendar/UnavailableCalendar.ts";
import { CalendarAuthError } from "../src/core/errors.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeCalendar, sampleEvent } from "./FakeCalendar.ts";
import type { CalendarEvent, CapturedContext, ToolInput } from "../src/core/types.ts";

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// M13's counterpart to gmail.test.ts and notion.test.ts. Every test runs the REAL planner and
// the REAL tools; only the calendar itself is a double.
//
// What this proves: the decisions. Confirm before anyone is emailed, refuse rather than guess
// which event was meant, never move a series instance, keep the duration, and treat "not
// connected" as something to fix rather than something broken.
//
// What it does NOT prove: that a real Google request is shaped correctly, or that a real token
// refresh works. Only a live run shows that — the same honest limit FakeGmail and FakeNotion
// carry, and the reason every milestone so far has found a bug the fixtures could not.

function planner(
  calendar: FakeCalendar | UnavailableCalendar,
  choice: { name: string; input: ToolInput },
  confirms: boolean[] = [],
  timeline?: string[],
) {
  const shell = new MockShell({ context: NO_CONTEXT, confirms });
  if (timeline) {
    const original = shell.executeAction.bind(shell);
    shell.executeAction = async (action) => {
      timeline.push(`shell:${action.kind}`);
      return original(action);
    };
  }
  const log = new InMemoryActionLog();
  const instance = new Planner(
    new FakeLLM({ kind: "tool", ...choice }),
    shell,
    buildRegistry({ gmail: false, calendar: true }),
    new NoopMemoryResolver(),
    log,
    undefined,
    undefined,
    undefined,
    undefined,
    calendar,
  );
  return { planner: instance, shell, log };
}

const GUESTS = ["alex@example.com", "sam@example.com"];

describe("readSchedule", () => {
  it("lists what's coming up, with no dialog and no narration", async () => {
    const calendar = new FakeCalendar({
      events: [
        sampleEvent(),
        sampleEvent({
          id: "evt2",
          title: "1:1",
          start: "2026-08-26T17:00:00+05:30",
          end: "2026-08-26T17:30:00+05:30",
          attendees: ["alex@example.com"],
        }),
      ],
    });
    const { planner: p, shell } = planner(calendar, {
      name: "readSchedule",
      input: { from: "2026-08-26T00:00:00+05:30", to: "2026-08-27T00:00:00+05:30" },
    });

    const outcome = await p.run("what's on tomorrow");

    expect(outcome.status).toBe("ok");
    expect(outcome.result).toContain("Design review");
    expect(outcome.result).toContain("1:1 — with alex@example.com");
    // `safe`: it reads, so it neither asks nor announces.
    expect(shell.confirmMessages).toHaveLength(0);
    expect(shell.actions).toHaveLength(0);
  });

  it("says an empty calendar is empty rather than failing", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p } = planner(calendar, { name: "readSchedule", input: {} });

    const outcome = await p.run("what's on today");

    // "Nothing" is an ANSWER to the question that was asked.
    expect(outcome.status).toBe("ok");
    expect(outcome.result).toBe("Nothing on your calendar in that window.");
  });
});

describe("createEvent", () => {
  const SOLO: ToolInput = {
    title: "Write the deck",
    start: "2026-08-26T15:00:00+05:30",
    end: "2026-08-26T16:00:00+05:30",
  };

  it("narrates and creates an event with no guests, without asking", async () => {
    const timeline: string[] = [];
    const calendar = new FakeCalendar({ events: [], timeline });
    const { planner: p, shell } = planner(
      calendar,
      { name: "createEvent", input: SOLO },
      [],
      timeline,
    );

    const outcome = await p.run("block out an hour tomorrow to write the deck");

    expect(outcome.status).toBe("ok");
    expect(shell.confirmMessages).toHaveLength(0);
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0]?.title).toBe("Write the deck");
    // Announced BEFORE it happened — narration is what stands in for the undo.
    expect(timeline.indexOf("shell:notify")).toBeLessThan(timeline.indexOf("calendar:createEvent"));
    expect(shell.actions[0]).toEqual({
      kind: "notify",
      payload: 'Adding "Write the deck" on Wed 26 Aug, 3:00–4:00 PM to your calendar…',
    });
  });

  it("asks first when anyone else is invited, and creates NOTHING on no", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p, log } = planner(
      calendar,
      { name: "createEvent", input: { ...SOLO, title: "Design sync", attendees: GUESTS } },
      [false],
    );

    const outcome = await p.run("set up a design sync with alex and sam");

    expect(outcome.status).toBe("cancelled");
    // The assertion that matters: nobody was emailed.
    expect(calendar.created).toHaveLength(0);
    expect(calendar.calls).not.toContain("createEvent");
    expect(log.getLast()?.status).toBe("cancelled");
  });

  it("names the event, the time and every single guest in the dialog", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p, shell } = planner(
      calendar,
      { name: "createEvent", input: { ...SOLO, title: "Design sync", attendees: GUESTS } },
      [true],
    );

    await p.run("set up a design sync with alex and sam");

    expect(shell.confirmMessages).toEqual([
      'Create "Design sync" on Wed 26 Aug, 3:00–4:00 PM and email an invitation to ' +
        "alex@example.com and sam@example.com?",
    ]);
    expect(calendar.created).toHaveLength(1);
  });

  it("never narrates on the asking path — it is one gate or the other, not both", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p, shell } = planner(
      calendar,
      { name: "createEvent", input: { ...SOLO, attendees: GUESTS } },
      [true],
    );

    await p.run("set it up");

    expect(shell.actions).toHaveLength(0);
    expect(shell.confirmMessages).toHaveLength(1);
  });

  it("refuses a guest it has no address for instead of quietly dropping them", async () => {
    // The failure this prevents: dropping "the design team" would take the attendee count to
    // zero, downgrade the call from dangerous to caution, and skip the confirm gate entirely.
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p } = planner(calendar, {
      name: "createEvent",
      input: { ...SOLO, attendees: ["the design team"] },
    });

    const outcome = await p.run("set up a sync with the design team");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("the design team");
    expect(calendar.created).toHaveLength(0);
  });

  it("declines an all-day request rather than inventing a start and end time", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p } = planner(calendar, {
      name: "createEvent",
      input: { title: "Offsite", start: "2026-08-26", end: "2026-08-27" },
    });

    const outcome = await p.run("block out thursday");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("all-day");
    expect(calendar.created).toHaveLength(0);
  });

  it("refuses an event that ends before it starts", async () => {
    const calendar = new FakeCalendar({ events: [] });
    const { planner: p } = planner(calendar, {
      name: "createEvent",
      input: {
        title: "Backwards",
        start: "2026-08-26T16:00:00+05:30",
        end: "2026-08-26T15:00:00+05:30",
      },
    });

    const outcome = await p.run("book it");

    expect(outcome.status).toBe("refused");
    expect(calendar.created).toHaveLength(0);
  });
});

describe("moveEvent", () => {
  const TO_FOUR: ToolInput = { event: "design review", newStart: "2026-08-26T16:00:00+05:30" };

  it("narrates and moves an event that is yours alone", async () => {
    const calendar = new FakeCalendar({ events: [sampleEvent()] });
    const { planner: p, shell } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    const outcome = await p.run("push the design review to 4");

    expect(outcome.status).toBe("ok");
    expect(shell.confirmMessages).toHaveLength(0);
    expect(calendar.moved).toEqual([
      { id: "evt1", start: "2026-08-26T16:00:00+05:30", end: "2026-08-26T17:00:00+05:30" },
    ]);
  });

  it("writes the derived end in the same offset the start was given in", async () => {
    // Not cosmetic-only: an event whose start says +05:30 and whose end says Z describes the
    // right instant while looking like a timezone bug, which is how a real one hides.
    const calendar = new FakeCalendar({ events: [sampleEvent()] });
    const { planner: p } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    await p.run("push the design review to 4");

    expect(calendar.moved[0]?.end).toBe("2026-08-26T17:00:00+05:30");
  });

  it("derives the end correctly across a negative offset too", async () => {
    const inNewYork = sampleEvent({
      start: "2026-08-26T15:00:00-04:00",
      end: "2026-08-26T16:00:00-04:00",
    });
    const calendar = new FakeCalendar({ events: [inNewYork] });
    const { planner: p } = planner(calendar, {
      name: "moveEvent",
      input: { event: "design review", newStart: "2026-08-26T16:00:00-04:00" },
    });

    await p.run("push it an hour");

    expect(calendar.moved[0]?.end).toBe("2026-08-26T17:00:00-04:00");
  });

  it("keeps the event the same length when only a new start is given", async () => {
    // Nobody restates how long their own meeting is. A 90-minute event moved to 4 ends at 5:30.
    const ninetyMinutes = sampleEvent({ end: "2026-08-26T16:30:00+05:30" });
    const calendar = new FakeCalendar({ events: [ninetyMinutes] });
    const { planner: p } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    await p.run("push it to 4");

    const moved = calendar.moved[0];
    const durationMs = Date.parse(moved?.end ?? "") - Date.parse(moved?.start ?? "");
    expect(durationMs).toBe(90 * 60_000);
  });

  it("asks before moving an event with guests, and moves NOTHING on no", async () => {
    const calendar = new FakeCalendar({ events: [sampleEvent({ attendees: GUESTS })] });
    const { planner: p, shell } = planner(
      calendar,
      { name: "moveEvent", input: TO_FOUR },
      [false],
    );

    const outcome = await p.run("push the design review to 4");

    expect(outcome.status).toBe("cancelled");
    expect(calendar.moved).toHaveLength(0);
    expect(calendar.calls).not.toContain("moveEvent");
    expect(shell.confirmMessages[0]).toContain("alex@example.com and sam@example.com");
    // The dialog shows where it is now AND where it would land.
    expect(shell.confirmMessages[0]).toContain("3:00–4:00 PM");
    expect(shell.confirmMessages[0]).toContain("4:00–5:00 PM");
  });

  it("refuses when nothing matches, rather than picking something", async () => {
    const calendar = new FakeCalendar({ events: [sampleEvent()] });
    const { planner: p } = planner(calendar, {
      name: "moveEvent",
      input: { event: "the retro", newStart: "2026-08-26T16:00:00+05:30" },
    });

    const outcome = await p.run("move the retro to 4");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("the retro");
    expect(calendar.moved).toHaveLength(0);
  });

  it("refuses when more than one matches, and lists them", async () => {
    // Default-deny, carried up from gmailScript's rule for buttons: if we cannot say WHICH one,
    // we do not touch any of them.
    const calendar = new FakeCalendar({
      events: [
        sampleEvent({ id: "a", title: "Design review" }),
        sampleEvent({
          id: "b",
          title: "Design review (part 2)",
          start: "2026-08-27T15:00:00+05:30",
          end: "2026-08-27T16:00:00+05:30",
        }),
      ],
    });
    const { planner: p } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    const outcome = await p.run("push the design review to 4");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("matches 2 events");
    expect(outcome.result).toContain("Wed 26 Aug");
    expect(outcome.result).toContain("Thu 27 Aug");
    expect(calendar.moved).toHaveLength(0);
  });

  it("refuses to move an instance of a repeating event", async () => {
    // Instance-or-series is a real choice with a real wrong answer. Google's own UI asks;
    // guessing on someone's behalf is worse than declining.
    const calendar = new FakeCalendar({ events: [sampleEvent({ recurring: true })] });
    const { planner: p } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    const outcome = await p.run("push the design review to 4");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("repeats");
    expect(calendar.moved).toHaveLength(0);
  });

  it("refuses to move an all-day event", async () => {
    const calendar = new FakeCalendar({
      events: [sampleEvent({ allDay: true, start: "2026-08-26", end: "2026-08-26" })],
    });
    const { planner: p } = planner(calendar, { name: "moveEvent", input: TO_FOUR });

    const outcome = await p.run("push the design review to 4");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("all-day");
    expect(calendar.moved).toHaveLength(0);
  });

  // The time-of-check/time-of-use guard.
  it("refuses if the event gained guests after the tier was decided", async () => {
    const calendar = new FakeCalendar({ events: [sampleEvent()] });
    // Guest-free when classified and when narrated; someone adds a guest before the act.
    let reads = 0;
    calendar.onGetEvent = (event): CalendarEvent => event;
    const original = calendar.findEvent.bind(calendar);
    calendar.findEvent = async (query, from, to): Promise<CalendarEvent[]> => {
      const found = await original(query, from, to);
      reads += 1;
      // The classification and narration reads see a solo event; the handler's read does not.
      return reads >= 3 ? found.map((event) => ({ ...event, attendees: GUESTS })) : found;
    };

    const { planner: p, shell } = planner(calendar, { name: "moveEvent", input: TO_FOUR });
    const outcome = await p.run("push the design review to 4");

    // It was never confirmed, because when it was classified there was nobody to confirm about.
    expect(shell.confirmMessages).toHaveLength(0);
    // So it must not act — two people would have been emailed about a change nobody approved.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("has guests on it now");
    expect(calendar.moved).toHaveLength(0);
  });
});

describe("when the calendar is not connected", () => {
  it("says so verbatim, and logs a refusal rather than an error", async () => {
    const calendar = new FakeCalendar({ authFailure: "not-connected" });
    const { planner: p, log } = planner(calendar, { name: "readSchedule", input: {} });

    const outcome = await p.run("what's on today");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("not connected to your Google Calendar");
    expect(outcome.result).toContain("npm run calendar:connect");
    // NOT wrapped in "Something went wrong" — this is a thing to fix, not a malfunction.
    expect(outcome.result).not.toContain("Something went wrong");
    expect(log.getLast()?.status).toBe("refused");
  });

  it("distinguishes an expired token from a revoked one", async () => {
    for (const [reason, phrase] of [
      ["expired", "expired"],
      ["revoked", "revoked this app's access"],
    ] as const) {
      const calendar = new FakeCalendar({ authFailure: reason });
      const { planner: p } = planner(calendar, { name: "readSchedule", input: {} });

      const outcome = await p.run("what's on today");

      // Same remedy, different explanation — which is the point of naming them separately.
      expect(outcome.status).toBe("refused");
      expect(outcome.result).toContain(phrase);
      expect(outcome.result).toContain("npm run calendar:connect");
    }
  });

  // Narration happens BEFORE any handler runs, so this failure surfaces from a different place
  // in the planner than the readSchedule case above — and must read the same to the user.
  it("surfaces the same message when it fails at narration, before the handler", async () => {
    const calendar = new FakeCalendar({ authFailure: "expired", events: [] });
    const { planner: p, shell } = planner(calendar, {
      name: "createEvent",
      input: {
        title: "Write the deck",
        start: "2026-08-26T15:00:00+05:30",
        end: "2026-08-26T16:00:00+05:30",
      },
    });

    const outcome = await p.run("block out an hour");

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("expired");
    expect(outcome.result).not.toContain("Something went wrong");
    expect(shell.actions).toHaveLength(0); // it never got as far as announcing anything
    expect(calendar.created).toHaveLength(0);
  });

  it("gives UnavailableCalendar a named auth failure, not a bare error", async () => {
    // Its methods take no parameters at all — like UnavailableGmail's, they exist to refuse,
    // and a signature that accepted arguments would imply it might use them.
    const calendar = new UnavailableCalendar();
    await expect(calendar.listUpcoming()).rejects.toBeInstanceOf(CalendarAuthError);
    await expect(calendar.calendarTimeZone()).rejects.toThrow(/not connected/i);
    await expect(calendar.createEvent()).rejects.toThrow(/npm run calendar:connect/);
  });
});

describe("the menu", () => {
  it("does not offer calendar tools at all when there is no calendar", async () => {
    const names = buildRegistry({ gmail: false }).map((tool) => tool.name);
    for (const tool of calendarTools) {
      expect(names).not.toContain(tool.name);
    }
  });

  it("offers all three when there is one", () => {
    const names = buildRegistry({ gmail: false, calendar: true }).map((tool) => tool.name);
    expect(names).toContain("readSchedule");
    expect(names).toContain("createEvent");
    expect(names).toContain("moveEvent");
  });
});
