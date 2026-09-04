import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { MIN_PREVIEW_HOLD_MS } from "../src/core/chain.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { InMemoryChainState } from "../src/core/chainState.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { UserFixableError } from "../src/core/errors.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeCalendar } from "./FakeCalendar.ts";
import { FakeNotion } from "./FakeNotion.ts";
import { buildRegistry } from "../src/core/registry.ts";
import type {
  CapturedContext,
  PlannedStep,
  Tool,
  ToolDeps,
  ToolInput,
} from "../src/core/types.ts";

// M17. The chain machinery, against purpose-built tools for the mechanics and against the REAL
// registry for the one case that proves a real result crosses a real step boundary.
//
// The tools below are deliberately trivial. What is under test is the PLANNER — ordering, the
// per-step gates, stop-on-refusal, the accounting — and a tool that does anything interesting
// would only make a failure harder to attribute. The real-registry test at the bottom is what
// stops that being a closed loop.

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// A step that fails must throw the type the REAL tools throw. Every tool in this codebase
// reports a fixable state of the world with UserFixableError, and `failOrRefuse` discriminates
// on exactly that — a bare Error would take the `error` path instead and this suite would be
// asserting on something the running app cannot produce (CLAUDE.md, the M16.7 lesson).
const NOT_CONNECTED = "Your calendar isn't connected yet.";

function text(input: ToolInput, key = "text"): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

const readThing: Tool = {
  name: "readThing",
  description: "Read a thing.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  handler: (): Promise<string> => Promise.resolve("THING ONE"),
};

const readOther: Tool = {
  name: "readOther",
  description: "Read another thing.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  handler: (): Promise<string> => Promise.resolve("THING TWO"),
};

const noteThing: Tool = {
  name: "noteThing",
  description: "Note a thing.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "What to note." } },
    required: ["text"],
  },
  risk: "caution",
  narrate: (input: ToolInput): string => `Noting "${text(input)}"…`,
  handler: (input: ToolInput): Promise<string> => Promise.resolve(`Noted: ${text(input)}`),
};

const sendThing: Tool = {
  name: "sendThing",
  description: "Send a thing.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "What to send." } },
    required: ["text"],
  },
  risk: "dangerous",
  confirmSummary: (input: ToolInput): string => `Send "${text(input)}"?`,
  handler: (input: ToolInput): Promise<string> => Promise.resolve(`Sent: ${text(input)}`),
};

const brokenThing: Tool = {
  name: "brokenThing",
  description: "A thing that can't run right now.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  handler: (): Promise<string> => Promise.reject(new UserFixableError(NOT_CONNECTED)),
};

const emptyThing: Tool = {
  name: "emptyThing",
  description: "A thing that produces nothing.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  handler: (): Promise<string> => Promise.resolve("   "),
};

// Records the arguments each handler actually saw, which is the only way to prove a placeholder
// was resolved with the REAL earlier result rather than with something pre-computed.
function spyOn(tool: Tool, seen: ToolInput[]): Tool {
  return {
    ...tool,
    handler: (input: ToolInput, deps: ToolDeps): Promise<string> => {
      seen.push({ ...input });
      return tool.handler(input, deps);
    },
  };
}

const TOOLS = [readThing, readOther, noteThing, sendThing, brokenThing, emptyThing];

function step(tool: string, args: ToolInput = {}, describe = ""): PlannedStep {
  return { tool, arguments: args, describe };
}

function harness(
  steps: PlannedStep[],
  options: { confirms?: boolean[]; holdConfirm?: boolean; registry?: Tool[] } = {},
) {
  const shell = new MockShell({
    context: NO_CONTEXT,
    confirms: options.confirms ?? [],
    holdConfirm: options.holdConfirm ?? false,
  });
  const log = new InMemoryActionLog();
  const chain = new InMemoryChainState();
  // Every duration `this.sleep(ms)` was called with, in order — recorded rather than dropped, so
  // the one test that cares can see the preview hold fired.
  //
  // NEVER the real setTimeout-based default. `runChain` now calls `this.sleep()` to hold the
  // plan preview on screen for a minimum read time (M17 live-testing fix, MIN_PREVIEW_HOLD_MS in
  // core/chain.ts) — a real sleep here would make every multi-step test in this file actually
  // wait out that many real seconds.
  const sleepCalls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };
  const planner = new Planner(
    new FakeLLM({ kind: "plan", steps }),
    shell,
    options.registry ?? TOOLS,
    new NoopMemoryResolver(),
    log,
    undefined, // sender
    undefined, // gmail
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech
    undefined, // screen
    undefined, // elements
    undefined, // chooser
    sleep,
    chain,
  );
  return { planner, shell, log, chain, sleepCalls };
}

describe("a chain runs its steps in order", () => {
  it("runs every step and reports the last one's result", async () => {
    const { planner, shell } = harness([
      step("readThing", {}, "read the thing"),
      step("noteThing", { text: "hello" }, "note it"),
    ]);

    const outcome = await planner.run("read it and note it");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("noteThing");
    expect(outcome.result).toBe("Noted: hello");
    expect(outcome.chain).toEqual({ completed: 2, total: 2 });
    expect(shell.results).toEqual(["THING ONE", "Noted: hello"]);
  });

  it("logs one row per executed step, so getLast() names the step that actually ended", async () => {
    const { planner, log } = harness([
      step("readThing"),
      step("noteThing", { text: "hello" }),
    ]);

    await planner.run("read it and note it");

    expect(log.entries.map((e) => e.tool)).toEqual(["readThing", "noteThing"]);
    expect(log.entries.every((e) => e.status === "ok")).toBe(true);
    expect(log.getLast()?.tool).toBe("noteThing");
  });

  it("narrates the whole plan before any of it runs", async () => {
    // Decision 2: transparency, up front. The preview has to be the FIRST thing out, or it is
    // describing something that has already started happening.
    const { planner, shell } = harness([
      step("readThing", {}, "read the thing"),
      step("noteThing", { text: "hello" }, "note it"),
    ]);

    await planner.run("read it and note it");

    const notifies = shell.actions.filter((a) => a.kind === "notify").map((a) => a.payload);
    expect(notifies[0]).toBe("Two steps:\n1. Read the thing\n2. Note it");
    expect(shell.spoken[0]).toBe("Two steps. First, read the thing. Then, note it.");
  });

  it("prefixes each step's narration with where it sits in the plan", async () => {
    const { planner, shell } = harness([
      step("readThing", {}, "read the thing"),
      step("noteThing", { text: "hello" }, "note it"),
    ]);

    await planner.run("read it and note it");

    const notifies = shell.actions.filter((a) => a.kind === "notify").map((a) => a.payload);
    expect(notifies).toContain('Step 2 of 2: Noting "hello"…');
  });
});

describe("cross-step data", () => {
  it("hands a step the REAL result of the step it referenced", async () => {
    const seen: ToolInput[] = [];
    const { planner } = harness(
      [step("readThing"), step("noteThing", { text: "{step1}" })],
      { registry: [readThing, spyOn(noteThing, seen)] },
    );

    await planner.run("read it and note it");

    expect(seen[0]).toEqual({ text: "THING ONE" });
  });

  it("resolves a reference that skips a step", async () => {
    // The decision pinned in tests/chain.test.ts, proven end to end through the planner: step 3
    // gets step 1's result, not step 2's.
    const seen: ToolInput[] = [];
    const { planner } = harness(
      [step("readThing"), step("readOther"), step("noteThing", { text: "{step1}" })],
      { registry: [readThing, readOther, spyOn(noteThing, seen)] },
    );

    await planner.run("read both and note the first");

    expect(seen[0]).toEqual({ text: "THING ONE" });
  });

  it("resolves the placeholder BEFORE the gate, so the dialog names the real argument", async () => {
    // The whole safety property of the template approach. A confirm dialog showing "{step1}"
    // would be asking the user to approve something nobody can read.
    const { planner, shell } = harness(
      [step("readThing"), step("sendThing", { text: "{step1}" })],
      { confirms: [true] },
    );

    await planner.run("read it and send it");

    expect(shell.confirmMessages).toEqual(['Step 2 of 2: Send "THING ONE"?']);
  });

  it("stops when the referenced step produced nothing to pass on", async () => {
    const { planner, shell, log } = harness([
      step("emptyThing", {}, "read the empty thing"),
      step("noteThing", { text: "{step1}" }, "note it"),
    ]);

    const outcome = await planner.run("read it and note it");

    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 1, total: 2 });
    // The step never ran, so it logs its own row rather than vanishing from the record.
    expect(log.entries.map((e) => e.tool)).toEqual(["emptyThing", "noteThing"]);
    expect(shell.results.at(-1)).toContain("didn't produce anything to pass on");
  });
});

describe("each step keeps its own gate", () => {
  it("confirms a dangerous step inside a chain exactly as it would alone", async () => {
    // Chaining does not change any step's tier. A `dangerous` tool is still dangerous at
    // position 2 of 2, and the gate fires with the resolved arguments.
    const { planner, shell } = harness(
      [step("readThing"), step("sendThing", { text: "hello" })],
      { confirms: [true] },
    );

    const outcome = await planner.run("read it and send hello");

    expect(shell.confirmMessages).toHaveLength(1);
    expect(outcome.status).toBe("ok");
  });

  it("does not confirm a chain of safe steps", async () => {
    // The other half: three safe steps do not become risky by being chained.
    const { planner, shell } = harness([
      step("readThing"),
      step("readOther"),
      step("readThing"),
    ]);

    await planner.run("read them all");

    expect(shell.confirmMessages).toEqual([]);
  });

  it("stops the chain when the user says no, and says how much ran", async () => {
    const { planner, shell, log } = harness(
      [step("readThing", {}, "read it"), step("sendThing", { text: "hello" }, "send it")],
      { confirms: [false] },
    );

    const outcome = await planner.run("read it and send hello");

    expect(outcome.status).toBe("cancelled");
    expect(outcome.chain).toEqual({ completed: 1, total: 2 });
    expect(log.entries.at(-1)?.status).toBe("cancelled");
    expect(shell.results.at(-1)).toContain("didn't approve");
    expect(shell.results.at(-1)).toContain("already done step 1 of 2");
  });
});

describe("stop on refusal", () => {
  it("runs nothing after the step that refused", async () => {
    const seen: ToolInput[] = [];
    const { planner, shell } = harness(
      [
        step("readThing", {}, "read it"),
        step("brokenThing", {}, "check the calendar"),
        step("noteThing", { text: "hello" }, "note it"),
      ],
      { registry: [readThing, brokenThing, spyOn(noteThing, seen)] },
    );

    const outcome = await planner.run("do all three");

    expect(seen).toEqual([]); // step 3 never ran
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 1, total: 3 });
    expect(shell.confirmMessages).toEqual([]);
  });

  it("says the tool's own words AND the accounting, as one message", async () => {
    // Not two: the step runs with `report: false` inside a chain precisely so the refusal and
    // the bookkeeping do not arrive as separate announcements about the same event.
    const { planner, shell } = harness([
      step("readThing", {}, "read it"),
      step("brokenThing", {}, "check the calendar"),
      step("noteThing", { text: "hello" }, "note it"),
    ]);

    await planner.run("do all three");

    const shown = shell.results.filter((r) => r.includes(NOT_CONNECTED));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe(
      `${NOT_CONNECTED} I'd already done step 1 of 3, but steps 2 and 3 didn't run.`,
    );
  });

  it("still logs the step that refused", async () => {
    const { planner, log } = harness([step("readThing"), step("brokenThing")]);

    await planner.run("do both");

    expect(log.entries.map((e) => `${e.tool}:${e.status}`)).toEqual([
      "readThing:ok",
      "brokenThing:refused",
    ]);
  });
});

describe("a plan that cannot run is refused before anything is announced", () => {
  it("refuses more steps than the cap without narrating a plan", async () => {
    const { planner, shell, log } = harness([
      step("readThing"),
      step("readOther"),
      step("readThing"),
      step("noteThing", { text: "hello" }),
    ]);

    const outcome = await planner.run("do four things");

    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 4 });
    expect(shell.actions.filter((a) => a.kind === "notify")).toEqual([]);
    expect(shell.results[0]).toMatch(/only run up to 3/i);
    // Logged as refused, NOT as a miss: spec §8's miss list is a backlog of tools worth
    // building, and "that was four steps" is not a missing tool.
    expect(log.misses).toEqual([]);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ tool: null, status: "refused" });
  });

  it("refuses a step naming a tool that is not on the menu", async () => {
    const { planner, shell } = harness([step("readThing"), step("deleteEverything")]);

    const outcome = await planner.run("read it and delete everything");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toContain("deleteEverything");
    expect(shell.actions.filter((a) => a.kind === "notify")).toEqual([]);
  });

  it("refuses a forward reference before running step 1", async () => {
    const { planner, shell } = harness([
      step("noteThing", { text: "{step2}" }),
      step("readThing"),
    ]);

    const outcome = await planner.run("note the thing you're about to read");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toMatch(/hasn't happened/i);
  });
});

describe("a one-step plan collapses to an ordinary single call", () => {
  it("does not narrate a plan for it", async () => {
    // The model is told twice not to do this. If it does anyway, running it as a plain call is
    // better than reading "One step:" at someone.
    const { planner, shell, chain } = harness([step("readThing", {}, "read the thing")]);

    const outcome = await planner.run("read the thing");

    expect(outcome.status).toBe("ok");
    expect(outcome.result).toBe("THING ONE");
    expect(outcome.chain).toBeUndefined();
    expect(shell.actions.filter((a) => a.kind === "notify")).toEqual([]);
    expect(chain.isRunning()).toBe(false);
  });

  it("holds no preview read-time delay — there is no preview to hold", async () => {
    // The collapse path returns before runChain ever reaches the preview/hold logic; this is
    // what proves it, rather than assuming the early return does what it says.
    const { planner, sleepCalls } = harness([step("readThing", {}, "read the thing")]);

    await planner.run("read the thing");

    expect(sleepCalls).toEqual([]);
  });
});

// M17 LIVE-TESTING FIX. Confirmed reproducible: on a 3-step chain where every step's own work
// finishes fast, the plan-preview text on screen was replaced by step 1's result in well under
// a second — not enough time to read it, though the spoken narration for every step was fully
// audible both times (speech plays out at its own pace regardless of planner speed). See
// tests/chain.test.ts's `previewHoldRemaining` suite for the pure decision; this proves the
// planner actually calls into it.
describe("the plan-preview read-time hold", () => {
  it("holds the preview for a minimum read time before step 1 begins", async () => {
    const { planner, sleepCalls } = harness([
      step("readThing", {}, "read it"),
      step("readOther", {}, "read the other"),
    ]);

    await planner.run("read both");

    // One call, for approximately the full hold — the fake tools resolve in microseconds, so
    // almost none of MIN_PREVIEW_HOLD_MS was consumed by real work before this fired.
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThan(2000);
    expect(sleepCalls[0]).toBeLessThanOrEqual(MIN_PREVIEW_HOLD_MS);
  });

  it("holds only once per chain, not once per step", async () => {
    // The hold protects the PREVIEW specifically — it must not re-trigger at every step
    // boundary, which would turn a 3-step chain into a multi-second wait rather than one.
    const { planner, sleepCalls } = harness([
      step("readThing"),
      step("readOther"),
      step("readThing"),
    ]);

    await planner.run("read three things");

    expect(sleepCalls).toHaveLength(1);
  });

  it("does not delay a step's own gate — the hold happens before step 1, not inside it", async () => {
    // The confirm dialog for a dangerous step 1 must still appear promptly once the hold has
    // already elapsed; nothing here should make individual steps sluggish.
    const { planner, shell } = harness(
      [step("sendThing", { text: "hello" }, "send it"), step("readThing", {}, "read it")],
      { confirms: [true] },
    );

    const outcome = await planner.run("send hello then read it");

    expect(outcome.status).toBe("ok");
    expect(shell.confirmMessages).toEqual(['Step 1 of 2: Send "hello"?']);
  });
});

describe("what a chain says out loud", () => {
  it("speaks the plan and the final answer, but not the steps in between", async () => {
    // Mid-chain the app is working, not answering — and toSpokenResult's "want me to read the
    // rest?" offer would be a lie while the hotkey that would answer it is blocked.
    const { planner, shell } = harness([
      step("readThing", {}, "read the thing"),
      step("readOther", {}, "read the other"),
    ]);

    await planner.run("read both");

    expect(shell.spoken).toEqual([
      "Two steps. First, read the thing. Then, read the other.",
      "THING TWO.",
    ]);
  });

  it("still speaks a caution step's narration, because that one is the protection", async () => {
    const { planner, shell } = harness([
      step("readThing", {}, "read the thing"),
      step("noteThing", { text: "hello" }, "note it"),
    ]);

    await planner.run("read it and note it");

    // Quotes stripped and the trailing "…" turned into a stop by core/speech.ts's cleaner —
    // the prefix rides through it like any other narration, which is the point.
    expect(shell.spoken).toContain("Step 2 of 2: Noting hello.");
  });
});

describe("the chain-running flag", () => {
  it("is set for the whole chain and cleared afterwards", async () => {
    // The flag has to be true for EVERY step, not just the first — the hotkey guards read it at
    // whatever moment someone happens to press the key.
    const chain = new InMemoryChainState();
    const seenWhileRunning: boolean[] = [];
    const watching = (tool: Tool, result: string): Tool => ({
      ...tool,
      handler: (): Promise<string> => {
        seenWhileRunning.push(chain.isRunning());
        return Promise.resolve(result);
      },
    });

    const shell = new MockShell({ context: NO_CONTEXT });
    const planner = new Planner(
      new FakeLLM({ kind: "plan", steps: [step("readThing"), step("readOther")] }),
      shell,
      [watching(readThing, "THING ONE"), watching(readOther, "THING TWO")],
      new NoopMemoryResolver(),
      new InMemoryActionLog(),
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      // NEVER the real setTimeout-based default — this chain holds its plan preview on screen
      // via `this.sleep()` (M17 live-testing fix); the real one would make this test wait it out.
      (): Promise<void> => Promise.resolve(),
      chain,
    );

    await planner.run("read both");

    expect(seenWhileRunning).toEqual([true, true]);
    expect(chain.isRunning()).toBe(false);
  });

  it("is cleared even when the chain stops partway", async () => {
    const { planner, chain } = harness([step("readThing"), step("brokenThing")]);

    await planner.run("do both");

    expect(chain.isRunning()).toBe(false);
  });
});

// THE REQUIRED REGRESSION TEST (plan, "Verification"). M14 §8's guard, at step N of N.
//
// This is the one place a regression in M17 would reproduce the exact shape of the M14
// near-miss: a `dangerous` action sitting on screen unanswered while a second planner run
// starts over the top of it. The chain makes it likelier, not less likely — a chain is on
// screen for far longer than a single call, so the window in which someone reaches for the
// hotkey is much wider.
//
// It needs `holdConfirm`. With a fake that answers instantly there is no moment DURING the
// dialog to assert on, and the test could only prove the guard was consulted — never that it
// held (CLAUDE.md: a fake that is synchronous where the real thing blocks tests a weaker
// property than the one that matters).
describe("the pending-confirm guard at the last step of a chain", () => {
  it("reports both a pending confirm and a running chain while the dialog is up", async () => {
    const { planner, shell, chain } = harness(
      [
        step("readThing", {}, "read it"),
        step("readOther", {}, "read the other"),
        step("sendThing", { text: "{step1}" }, "send it"),
      ],
      { holdConfirm: true },
    );

    const running = planner.run("read both and send the first");
    await settle();

    // Both facts the hotkey handlers read, true at the same moment — which is what makes the
    // guard ORDERING in instructionHotkey.ts matter.
    expect(shell.isConfirmPending()).toBe(true);
    expect(chain.isRunning()).toBe(true);
    expect(chain.position()).toEqual({ step: 3, total: 3 });
    expect(shell.confirmMessages).toEqual(['Step 3 of 3: Send "THING ONE"?']);

    shell.answerConfirm(false);
    const outcome = await running;

    expect(outcome.status).toBe("cancelled");
    expect(outcome.chain).toEqual({ completed: 2, total: 3 });
  });

  it("clears both flags once the dialog is answered", async () => {
    const { planner, shell, chain } = harness(
      [step("readThing"), step("sendThing", { text: "hello" })],
      { holdConfirm: true },
    );

    const running = planner.run("read it and send hello");
    await settle();
    shell.answerConfirm(true);
    await running;

    expect(shell.isConfirmPending()).toBe(false);
    expect(chain.isRunning()).toBe(false);
  });

  it("nothing after the parked step has run while the dialog waits", async () => {
    const seen: ToolInput[] = [];
    const { planner, shell } = harness(
      [
        step("readThing", {}, "read it"),
        step("sendThing", { text: "hello" }, "send it"),
        step("noteThing", { text: "after" }, "note it"),
      ],
      { holdConfirm: true, registry: [readThing, sendThing, spyOn(noteThing, seen)] },
    );

    const running = planner.run("all three");
    await settle();

    expect(seen).toEqual([]);

    shell.answerConfirm(true);
    await running;

    expect(seen).toEqual([{ text: "after" }]);
  });
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The closed loop broken: real tools, real surfaces behind fakes, a real formatted result
// crossing a real step boundary. Everything above proves the machinery; this proves the
// machinery is wired to the thing the user actually has.
describe("a chain of REAL registry tools", () => {
  it("carries a real schedule listing into a real Notion append", async () => {
    const calendar = new FakeCalendar();
    const notion = new FakeNotion();
    const shell = new MockShell({ context: NO_CONTEXT });
    const log = new InMemoryActionLog();
    const planner = new Planner(
      new FakeLLM(
        {
          kind: "plan",
          steps: [
            step(
              "readSchedule",
              { from: "2026-08-26T00:00:00+05:30", to: "2026-08-27T00:00:00+05:30" },
              "read tomorrow's schedule",
            ),
            step("addToPage", { instruction: "{step1}" }, "add it to your Notion page"),
          ],
        },
        "A NOTE FOR THE PAGE",
      ),
      shell,
      buildRegistry({ gmail: false, notion: true, calendar: true }),
      new NoopMemoryResolver(),
      log,
      undefined, // sender
      undefined, // gmail
      undefined, // draft
      notion,
      calendar,
      undefined, // speech
      undefined, // screen
      undefined, // elements
      undefined, // chooser
      // NEVER the real setTimeout-based default — this chain runs `this.sleep()` to hold its
      // plan preview on screen, and the real one would make this test wait out that duration.
      (): Promise<void> => Promise.resolve(),
    );

    const outcome = await planner.run("check tomorrow's schedule and put it in my Notion page");

    expect(outcome.status).toBe("ok");
    expect(outcome.chain).toEqual({ completed: 2, total: 2 });
    // The schedule really was read, and really did reach Notion.
    expect(calendar.calls).toContain("listUpcoming");
    expect(notion.appended).toHaveLength(1);
    expect(log.entries.map((e) => e.tool)).toEqual(["readSchedule", "addToPage"]);
    // THE ASSERTION THAT MATTERS. `addToPage` was called with the real formatted listing that
    // `readSchedule` produced — the event title from the fake calendar, carried across the step
    // boundary by the placeholder. Nothing here was pre-computed or hand-fed.
    const appendArgs = log.entries[1]?.arguments;
    expect(String(appendArgs?.["instruction"])).toContain("Design review");
  });
});
