import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry, findTool } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { InMemorySpeechStore } from "../src/core/speechStore.ts";
import { readScheduleTool } from "../src/core/tools/readSchedule.ts";
import { formatSchedule } from "../src/core/calendar/format.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import type { SpeechStore } from "../src/core/speechStore.ts";
import type { CalendarEvent, CapturedContext, ToolInput } from "../src/core/types.ts";

// Both speakResult hooks below derive from the result string alone. `deps` is in the signature
// for tools that would need to read the world, not because these do.
const NO_DEPS = {} as never;

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// M14 task 2. The half of voice output that has nothing to do with audio: what gets held back
// when the app speaks a summary, how it is asked for, and the one tool that writes its own
// spoken form because the generic derivation would embarrass it.
//
// `elaborate` runs through the REAL planner, like every other tool test in this repo — the
// thing worth proving is not that a function returns a string, it is that "there's nothing
// more" reaches the user as an honest refusal rather than as "Something went wrong".

function planner(input: ToolInput, speech: SpeechStore) {
  const shell = new MockShell({ context: NO_CONTEXT });
  const log = new InMemoryActionLog();
  const instance = new Planner(
    new FakeLLM({ kind: "tool", name: "elaborate", input }),
    shell,
    buildRegistry({ gmail: false, speech: true }),
    new NoopMemoryResolver(),
    log,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    speech,
  );
  return { planner: instance, shell, log };
}

describe("SpeechStore", () => {
  it("hands back what was held, once", () => {
    const store = new InMemorySpeechStore();
    store.hold("Event two. Event three.");

    expect(store.take()).toBe("Event two. Event three.");
    // Delivered once: asking twice must mean "there's nothing more", not a repeat.
    expect(store.take()).toBeNull();
  });

  it("keeps only the most recent remainder — a new answer supersedes an older one", () => {
    const store = new InMemorySpeechStore();
    store.hold("the old rest");
    store.hold("the new rest");

    expect(store.take()).toBe("the new rest");
  });

  it("holds nothing when there was nothing withheld", () => {
    const store = new InMemorySpeechStore();
    store.hold("   ");

    expect(store.take()).toBeNull();
  });

  it("goes stale, and a stale hold is indistinguishable from an empty one", () => {
    const store = new InMemorySpeechStore(1000);
    store.hold("yesterday's schedule");

    expect(store.take(Date.now() + 1001)).toBeNull();
  });

  it("clears", () => {
    const store = new InMemorySpeechStore();
    store.hold("something");
    store.clear();

    expect(store.take()).toBeNull();
  });
});

describe("elaborate", () => {
  it("reads out what was held back", async () => {
    const store = new InMemorySpeechStore();
    store.hold("Event two. Event three.");
    const { planner: p, shell, log } = planner({}, store);

    const outcome = await p.run("read them out");

    expect(outcome.status).toBe("ok");
    expect(outcome.result).toBe("Event two. Event three.");
    expect(shell.results).toEqual(["Event two. Event three."]);
    expect(log.getLast()?.tool).toBe("elaborate");
  });

  it("refuses honestly when nothing was held back", async () => {
    const { planner: p, shell, log } = planner({}, new InMemorySpeechStore());

    const outcome = await p.run("read them out");

    // `refused`, not `error`: the request was understood and "there is nothing more" is the
    // true answer to it. The tool's own wording reaches the user verbatim.
    expect(outcome.status).toBe("refused");
    expect(shell.results).toEqual(["There's nothing more to read out."]);
    expect(log.getLast()?.status).toBe("refused");
  });

  it("empties the store, so asking twice refuses the second time", async () => {
    const store = new InMemorySpeechStore();
    store.hold("Event two.");
    const { planner: p } = planner({}, store);

    expect((await p.run("read them out")).status).toBe("ok");

    const { planner: again, shell } = planner({}, store);
    expect((await again.run("read them out")).status).toBe("refused");
    expect(shell.results).toEqual(["There's nothing more to read out."]);
  });

  it("says the remainder verbatim — a re-shortened remainder would be absurd", () => {
    // The held text is ALREADY what was cut from a summary. If the generic derivation ran over
    // it again, "read me the rest" could answer with another "want me to read the rest?".
    const long = "Event. ".repeat(60);
    const tool = findTool("elaborate");

    expect(tool?.speakResult).toBeDefined();
    expect(tool?.speakResult?.(long, {}, NO_DEPS)).toEqual({ text: long, remainder: null });
  });

  it("is off the menu when the app cannot speak", () => {
    const silent = buildRegistry({ gmail: false }).map((tool) => tool.name);
    const speaking = buildRegistry({ gmail: false, speech: true }).map((tool) => tool.name);

    expect(silent).not.toContain("elaborate");
    expect(speaking).toContain("elaborate");
  });
});

describe("readSchedule.speakResult", () => {
  const ZONE = "Asia/Kolkata";

  function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
      id: "evt",
      title: "Design review",
      start: "2026-08-26T15:00:00+05:30",
      end: "2026-08-26T16:00:00+05:30",
      allDay: false,
      attendees: [],
      recurring: false,
      ...overrides,
    };
  }

  function speak(events: CalendarEvent[]) {
    const result = formatSchedule(events, ZONE);
    const spoken = readScheduleTool.speakResult?.(result, {}, NO_DEPS);
    if (spoken === undefined || spoken instanceof Promise) throw new Error("expected sync");
    return spoken;
  }

  it("gives a count and the first event, not the whole list", () => {
    const spoken = speak(
      ["One", "Two", "Three", "Four", "Five"].map((title) => event({ title })),
    );

    expect(spoken.text).toBe(
      "You have 5 things coming up. First up, Wednesday 26 August, 3 to 4 PM, One. " +
        "Want me to read the rest?",
    );
  });

  it("NEVER reads an email address aloud — guests become a count, in the summary AND the rest", () => {
    const guests = ["alex@example.com", "sam@example.com"];
    const spoken = speak([
      event({ title: "One", attendees: guests }),
      event({ title: "Two", attendees: ["kim@example.com"] }),
    ]);

    expect(spoken.text).toContain("One, with 2 guests.");
    expect(spoken.remainder).toContain("Two, with one guest.");
    for (const address of [...guests, "kim@example.com"]) {
      expect(spoken.text).not.toContain(address);
      expect(spoken.remainder).not.toContain(address);
    }
    // The screen still names every one of them — this is the derived version, not a rewrite
    // of what is shown.
    expect(formatSchedule([event({ title: "One", attendees: guests })], ZONE)).toContain(
      "alex@example.com",
    );
  });

  it("says the time instead of reading it, and lets no dash reach the engine", () => {
    // The recon finding this exists for: the en dash in "3:00–4:00 PM" did not become "to",
    // it arrived at Piper as mojibake and came back as garbled non-English sounds.
    const spoken = speak(["One", "Two"].map((title) => event({ title })));
    const said = `${spoken.text} ${spoken.remainder ?? ""}`;

    expect(said).toContain("3 to 4 PM");
    expect(said).not.toContain("–");
    expect(said).not.toContain("—");
    // And the abbreviations, which are read as words: "wed", "aug".
    expect(said).toContain("Wednesday 26 August");
    expect(said).not.toContain("Wed 26 Aug");
  });

  it("holds every event except the one it read", () => {
    const spoken = speak(["One", "Two", "Three"].map((title) => event({ title })));

    expect(spoken.text).not.toContain("Two");
    expect(spoken.remainder).toContain("Two");
    expect(spoken.remainder).toContain("Three");
  });

  it("does not offer a rest that does not exist", () => {
    const spoken = speak([event({ title: "Only one" })]);

    expect(spoken.text).toBe("One thing coming up. Wednesday 26 August, 3 to 4 PM, Only one.");
    expect(spoken.remainder).toBeNull();
  });

  it("speaks the empty-calendar answer as the plain sentence it already is", () => {
    const result = "Nothing on your calendar in that window.";
    const spoken = readScheduleTool.speakResult?.(result, {}, NO_DEPS);

    expect(spoken).toEqual({ text: result, remainder: null });
  });

  it("speaks an event whole when its title merely resembles the guest tail", () => {
    // The one pattern this parse matches is " — with <addresses>", and it is only believed
    // when the tail actually contains an address. A title that reads like one must not be
    // chopped into a guest count.
    const spoken = speak([event({ title: "Catch up — with the design team" })]);

    expect(spoken.text).toContain("Catch up, with the design team");
    expect(spoken.text).not.toContain("guests");
  });
});
