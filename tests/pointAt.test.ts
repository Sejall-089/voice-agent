import { describe, expect, it } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeScreen } from "./FakeScreen.ts";
import { FakeElements, TREES } from "./FakeElements.ts";
import { FakeChooser } from "./FakeChooser.ts";
import { chooserError } from "../src/core/errors.ts";
import type {
  CapturedContext,
  ElementChooser,
  WindowElements,
} from "../src/core/types.ts";

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// THE WHOLE PIPELINE, END TO END, against fakes (M16.7).
//
// Every layer below has its own unit tests — enumeration and filtering (elements.test.ts), the
// settle decision (settle.test.ts), the choose contract (choosePrompt.test.ts), the geometry
// (screenGeometry.test.ts). This file exists because a wiring bug BETWEEN correctly-tested
// layers is exactly what those miss: a refusal thrown in one and swallowed in another, a rect
// converted with the wrong display, a step skipped entirely.
//
// So the assertions here are deliberately about the SEAMS. The three regression targets are
// checked as final DIP rectangles rather than as candidate numbers, and every refusal path is
// driven from the planner rather than from the function that raises it.

const TARGET = "the thing";

interface Wiring {
  trees?: WindowElements[];
  probeCounts?: number[];
  chooser?: ElementChooser;
  switchedAway?: boolean;
  movedTo?: { x: number; y: number; width: number; height: number };
}

function setup(wiring: Wiring = {}) {
  const shell = new MockShell({ context: NO_CONTEXT });
  const log = new InMemoryActionLog();
  const screen = new FakeScreen();
  const elements = new FakeElements({
    trees: wiring.trees ?? [TREES["notepad"]!],
    ...(wiring.probeCounts ? { probeCounts: wiring.probeCounts } : {}),
    ...(wiring.switchedAway ? { switchedAway: true } : {}),
    ...(wiring.movedTo ? { movedTo: wiring.movedTo } : {}),
  });
  const chooser = wiring.chooser ?? FakeChooser.picking("File");

  const llm = new FakeLLM({
    kind: "tool",
    name: "pointAt",
    input: { target: TARGET },
  });

  // Twelve `undefined`s to reach the M16 surfaces. The comment this replaces called six of
  // them "the clearest argument in the codebase for making Planner take an options object" —
  // M16 has now doubled it. Left positional deliberately rather than refactored mid-milestone:
  // 33 construction sites across 17 files is not a change to make while wiring a pipeline.
  // Logged as the next cleanup instead.
  const sleeps: number[] = [];
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: false, pointing: true }),
    new NoopMemoryResolver(),
    log,
    undefined, // sender
    undefined, // gmail
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech store
    screen,
    elements,
    chooser,
    async (ms: number) => {
      // Time is a dependency here, not a wall clock: the settle loop's delays are recorded and
      // returned instantly, so a test covering a cold Chromium tree costs nothing to run.
      sleeps.push(ms);
    },
  );

  return { shell, log, screen, elements, chooser, planner, sleeps };
}

// ---------------------------------------------------------------------------
// THE THREE REGRESSION TARGETS, THROUGH THE FULL PIPELINE.
//
// M16.3 proved these resolve to one candidate at the right NATIVE rect. M16.5 proved the model
// picks them. Neither says the two halves are joined correctly, or that the native → DIP
// conversion is handed the right display on the way out. These do.
//
// The expected values are the DIP rectangles hand-computed in tests/screenGeometry.test.ts
// against the 1.5x display, repeated here as literals so a regression anywhere along the chain
// fails in the flow test too, not only in the unit that owns one link of it.
// ---------------------------------------------------------------------------
describe("the three controls M15 pointed at wrongly", () => {
  it("points at Notepad's File menu — native 4,49 62x48 -> DIP 3,33 41x32", async () => {
    const { screen, outcome } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.picking("File"),
    });

    expect(outcome.status).toBe("ok");
    expect(screen.pointed).toEqual([
      { rect: { x: 3, y: 33, width: 41, height: 32 }, label: "File" },
    ]);
  });

  it("points at Notepad's Advice.txt TAB — native 454,1 120x48 -> DIP 303,1 80x32", async () => {
    const { screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.picking("Advice.txt"),
    });

    // The 120x48 hit area, not the 79x23 label UIA nests inside it. That the label never even
    // reaches the chooser is the dedup rule working three layers down.
    expect(screen.pointed).toEqual([
      { rect: { x: 303, y: 1, width: 80, height: 32 }, label: "Advice.txt. Unmodified." },
    ]);
  });

  it("points at Explorer's New button — native 9,123 129x67 -> DIP 6,82 86x45", async () => {
    const { screen } = await run({
      trees: [TREES["explorer"]!],
      chooser: FakeChooser.picking("New"),
    });

    expect(screen.pointed).toEqual([
      { rect: { x: 6, y: 82, width: 86, height: 45 }, label: "New" },
    ]);
  });

  it("converts through the display the WINDOW is on, not a guessed one", async () => {
    const { screen } = await run({
      trees: [TREES["explorer"]!],
      chooser: FakeChooser.picking("New"),
    });
    // The lookup is driven by the window's own rect — the seam that would silently put a marker
    // on the wrong monitor if it were skipped or fed the wrong rectangle.
    expect(screen.displayLookups).toEqual([TREES["explorer"]!.windowRect]);
  });
});

// ---------------------------------------------------------------------------
describe("what reaches the chooser", () => {
  it("passes the filtered candidates, the user's words and the window title", async () => {
    const chooser = FakeChooser.picking("File");
    await run({ trees: [TREES["notepad"]!], chooser });

    const asked = (chooser as FakeChooser).asked;
    expect(asked).toHaveLength(1);
    expect(asked[0]!.target).toBe(TARGET);
    expect(asked[0]!.windowTitle).toBe("Advice.txt - Notepad");
    // 26, not 39: the filter and dedup ran before the model was asked.
    expect(asked[0]!.candidates).toHaveLength(26);
  });

  it("announces the check BEFORE reading the window, and no longer claims to look at a screen", async () => {
    const { shell } = await run({ chooser: FakeChooser.picking("File") });
    // M16 takes no screenshot at all, so "Looking at your screen…" would now be a false
    // statement about what the app just did.
    expect(shell.actions).toEqual([
      { kind: "notify", payload: `Checking the controls on screen for ${TARGET}…` },
    ]);
  });
});

// ---------------------------------------------------------------------------
// EVERY REFUSAL PATH, DRIVEN FROM THE PLANNER.
//
// Each was built and unit-tested where it is raised. What that cannot show is whether it
// SURVIVES the trip: a `UserFixableError` caught and rewrapped somewhere, an exception swallowed
// by an intermediate `try`, or a path the pipeline simply never reaches. So each is re-proven
// from the outside, and each asserts `screen.pointed` is EMPTY — the milestone's safety property
// is that an answer we do not trust never becomes a marker.
// ---------------------------------------------------------------------------
describe("refusals reach the user, and never draw", () => {
  it("unreadable: a bare tree (Claude desktop, chrome only)", async () => {
    const { outcome, screen } = await run({
      trees: [TREES["claudeBare"]!],
      probeCounts: [14, 14, 14, 14],
      chooser: FakeChooser.picking("Close"),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("can't read the controls");
    // Present tense, and it names the window rather than the application.
    expect(outcome.result).toContain("Claude");
    expect(outcome.result).toContain("right now");
    expect(screen.pointed).toEqual([]);
  });

  it("unreadable: a minimized window, which IsOffscreen does not catch", async () => {
    const { outcome, screen } = await run({
      trees: [TREES["notepadMinimized"]!],
      probeCounts: [49, 49, 49],
      chooser: FakeChooser.picking("File"),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("can't read the controls");
    expect(screen.pointed).toEqual([]);
  });

  it("unsettled: a tree still growing when the budget runs out", async () => {
    const { outcome, screen, elements } = await run({
      trees: [TREES["claudeWoke"]!],
      probeCounts: [13, 40, 88, 141, 197, 260, 322, 400],
      chooser: FakeChooser.picking("Close"),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("still loading");
    expect(screen.pointed).toEqual([]);
    // It never read the tree, because there was never a moment worth reading.
    expect(elements.enumerations).toBe(0);
  });

  it("not-found: the model says none of these", async () => {
    const { outcome, screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.saying_none(),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    // The claim vision could never make: it can say how many it looked at.
    expect(outcome.result).toContain("26 controls");
    expect(outcome.result).toContain("Advice.txt - Notepad");
    expect(screen.pointed).toEqual([]);
  });

  it("ambiguous: the model volunteers several", async () => {
    const { outcome, screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.saying_ambiguous("Advice.txt", "Imp.txt"),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("2 things that could be");
    expect(screen.pointed).toEqual([]);
  });

  it("ambiguous: CODE catches indistinguishable twins the model picked between", async () => {
    // Explorer's four "Filter dropdown" buttons — identical name, type and position. The model
    // answered a confident PICK; the gate refuses anyway.
    const { outcome, screen } = await run({
      trees: [TREES["explorer"]!],
      chooser: FakeChooser.picking("Filter dropdown"),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("Filter dropdown");
    expect(outcome.result).toContain("from the left");
    expect(screen.pointed).toEqual([]);
  });

  it("stale: the user switched to another app while we were working", async () => {
    // A DECIDED behaviour, not an accident. ~1.9s passes on a real Chromium window between the
    // snapshot and the marker (M16.8), so alt-tabbing inside that is ordinary. The overlay is
    // always-on-top, so drawing anyway would put a marker labelled "File" over whatever app is
    // now in front, at coordinates that meant something in a window behind it.
    const { outcome, screen, elements } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.picking("File"),
      switchedAway: true,
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("switched away");
    expect(screen.pointed).toEqual([]);
    // Checked AFTER the choice, immediately before drawing — the latest possible moment.
    expect(elements.verifications).toBe(1);
  });

  it("stale: the window moved while we were working", async () => {
    // A window dragged between the enumerate and the draw invalidates every rect that came out
    // of it just as thoroughly as a focus change does.
    const { outcome, screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.picking("File"),
      movedTo: { x: 300, y: 200, width: 1920, height: 1008 },
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("moved while I was looking");
    expect(screen.pointed).toEqual([]);
  });

  it("untrustworthy: an index that does not exist", async () => {
    const { outcome, screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.picking_number(999),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain("doesn't match anything I can see");
    expect(screen.pointed).toEqual([]);
  });

  it("a chooser that cannot be reached at all", async () => {
    // Throws what the REAL chooser would throw, not a bare Error: ModelElementClassifier turns a
    // network failure into a ChooserError before it leaves that class, and the thing worth
    // checking here is that the classified error survives the trip out as a refusal rather than
    // surfacing as a malfunction. A fake throwing a raw Error would be testing the fake.
    const { outcome, screen } = await run({
      trees: [TREES["notepad"]!],
      chooser: FakeChooser.failing(chooserError("unreachable", "ECONNREFUSED")),
    });

    // "refused", not "error": every one of these is a UserFixableError, so the planner reports
    // it as something the person can act on rather than as a malfunction. That classification
    // surviving the trip out is itself part of what this file is checking.
    expect(outcome.status).toBe("refused");
    expect(screen.pointed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the settle cost, through the pipeline", () => {
  it("a native window pays no delay at all", async () => {
    const { sleeps, elements } = await run({
      trees: [TREES["notepad"]!],
      probeCounts: [49],
      chooser: FakeChooser.picking("File"),
    });

    expect(sleeps).toEqual([]);
    expect(elements.probes).toBe(1);
    expect(elements.enumerations).toBe(1);
  });

  it("a cold Chromium window waits, then answers from the SETTLED list", async () => {
    const { screen, sleeps } = await run({
      trees: [TREES["claudeWoke"]!],
      probeCounts: [13, 613, 613],
      chooser: FakeChooser.picking("Close"),
    });

    // Two settle rounds at 350ms, exactly as settle.test.ts predicts for 13 -> 613 -> 613.
    expect(sleeps).toEqual([350, 350]);
    expect(screen.pointed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("the registry gate", () => {
  it("does not offer pointAt when pointing is off", () => {
    expect(buildRegistry({ gmail: false }).map((t) => t.name)).not.toContain("pointAt");
    expect(buildRegistry({ gmail: false, pointing: true }).map((t) => t.name)).toContain("pointAt");
  });
});

// A tiny runner so each test reads as a scenario rather than as setup.
async function run(wiring: Wiring) {
  const parts = setup(wiring);
  const outcome = await parts.planner.run("where is it?");
  return { ...parts, outcome };
}
