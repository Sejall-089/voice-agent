import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  isChromeOnly,
  MAX_NAME_CHARS,
  MAX_WINDOW_FRACTION,
  WINDOW_EDGE_SLACK,
} from "../src/core/screen/elements.ts";
import { positionIn } from "../src/core/screen/geometry.ts";
import { GIANT_NAME, TREE_WITH_GIANT_NAME, TREES } from "./FakeElements.ts";
import type { Candidate, NativeRect, UiElement, WindowElements } from "../src/core/types.ts";

const named = (candidates: Candidate[], name: string): Candidate[] =>
  candidates.filter((c) => c.name === name);

// ---------------------------------------------------------------------------
// THE REGRESSION TARGETS.
//
// These three controls are the whole reason M16 exists. On a live desktop, M15's vision
// grounding localized every one of them wrongly — not imprecisely, but onto a DIFFERENT control:
// one tab over on the tab strip, ~208px onto a neighbouring icon on the toolbar.
//
// Each assertion below pins the exact rect UI Automation reported for that control at the moment
// the failure was measured, and requires that EXACTLY ONE candidate carries it. "Exactly one"
// is doing as much work as the rect: two candidates for one control means the model gets to pick
// between a hit area and its own label, which is a coin flip this design is supposed to have
// removed.
// ---------------------------------------------------------------------------
describe("the three controls M15 pointed at wrongly", () => {
  it("finds Notepad's File menu at 4,49 62x48 — and only there", () => {
    const file = named(buildCandidates(TREES["notepad"]!), "File");

    expect(file).toHaveLength(1);
    expect(file[0]!.rect).toEqual({ x: 4, y: 49, width: 62, height: 48 });
    expect(file[0]!.controlType).toBe("MenuItem");
  });

  it("finds Notepad's Advice.txt TAB at 454,1 120x48, not its 79x23 label", () => {
    const candidates = buildCandidates(TREES["notepad"]!);
    const matches = candidates.filter((c) => c.name.startsWith("Advice.txt"));

    expect(matches).toHaveLength(1);
    // The 120x48 TabItem — the area a person actually clicks.
    expect(matches[0]!.rect).toEqual({ x: 454, y: 1, width: 120, height: 48 });
    expect(matches[0]!.controlType).toBe("TabItem");

    // And the label that UIA nests inside it is gone. This is the dedup rule's whole job: both
    // rows are named, enabled, on-screen and sensibly sized, so every other rule keeps both.
    expect(candidates.some((c) => c.rect.width === 79 && c.rect.height === 23)).toBe(false);
  });

  it("finds Explorer's New button at 9,123 129x67 — and only there", () => {
    const newButton = named(buildCandidates(TREES["explorer"]!), "New");

    expect(newButton).toHaveLength(1);
    expect(newButton[0]!.rect).toEqual({ x: 9, y: 123, width: 129, height: 67 });
    expect(newButton[0]!.controlType).toBe("Button");
  });

  it("keeps all three well inside a promptable list", () => {
    // Recon's measured counts, pinned. A regression that quietly stopped filtering would show up
    // here long before it showed up as a blown prompt.
    expect(buildCandidates(TREES["notepad"]!)).toHaveLength(26);
    expect(buildCandidates(TREES["explorer"]!)).toHaveLength(48);
  });
});

// ---------------------------------------------------------------------------
describe("buildCandidates — the filter", () => {
  const base: UiElement = {
    controlType: "Button",
    name: "Send",
    rect: { x: 100, y: 100, width: 80, height: 30 },
    enabled: true,
    offscreen: false,
    focusable: true,
    automationId: "",
  };
  const win = (...elements: UiElement[]): WindowElements => ({
    windowTitle: "Test",
    windowClass: "Test",
    windowRect: { x: 0, y: 0, width: 1000, height: 800 },
    elements,
  });

  it("keeps an ordinary named, enabled, on-screen control", () => {
    expect(buildCandidates(win(base))).toHaveLength(1);
  });

  it("drops an unnamed control — it cannot be asked for by name", () => {
    expect(buildCandidates(win({ ...base, name: "   " }))).toHaveLength(0);
  });

  it("drops a control UIA gave no real rect", () => {
    const noRect = { ...base, rect: { x: -Infinity, y: -Infinity, width: 0, height: 0 } };
    expect(buildCandidates(win(noRect))).toHaveLength(0);
  });

  it("drops a zero-area control", () => {
    expect(buildCandidates(win({ ...base, rect: { ...base.rect, width: 0 } }))).toHaveLength(0);
  });

  it("drops a disabled control — not a place to send someone", () => {
    expect(buildCandidates(win({ ...base, enabled: false }))).toHaveLength(0);
  });

  it("drops a scrolled-out control", () => {
    expect(buildCandidates(win({ ...base, offscreen: true }))).toHaveLength(0);
  });

  it("drops a container covering half the window or more", () => {
    const half = { ...base, name: "Body", rect: { x: 0, y: 0, width: 1000, height: 400 } };
    expect(1000 * 400).toBe(1000 * 800 * MAX_WINDOW_FRACTION);
    expect(buildCandidates(win(half))).toHaveLength(0);
  });

  it("keeps a large-but-not-huge control", () => {
    const big = { ...base, rect: { x: 0, y: 0, width: 1000, height: 399 } };
    expect(buildCandidates(win(big))).toHaveLength(1);
  });

  it("tolerates a control a few pixels past the window edge (the DWM shadow)", () => {
    // Notepad's Document really is 1924px wide inside a 1920px window.
    const overhang = { ...base, rect: { x: 995, y: 100, width: 20, height: 30 } };
    expect(WINDOW_EDGE_SLACK).toBe(24);
    expect(buildCandidates(win(overhang))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The single most valuable filter rule, because `IsOffscreen` looks like it already covers this
// and does not. Measured, not imagined: a minimized Notepad reports IsOffscreen=false on all of
// its elements while they sit 32,000 pixels off the left of the screen.
// ---------------------------------------------------------------------------
describe("a minimized window", () => {
  it("yields no candidates, even though every element claims to be on-screen", () => {
    const tree = TREES["notepadMinimized"]!;

    // THE TRAP, stated as assertions so it cannot quietly stop being true.
    //
    // Note the precise shape of it: the rows that carry a real-looking rect — a plausible width
    // and height, at roughly (-31991, -31890) — ALL report `IsOffscreen = false`. (The window's
    // other rows report offscreen correctly, but they are the ones with no rect at all, which
    // the size check already handles. The dangerous rows are exactly the plausible-looking
    // ones.)
    const plausible = tree.elements.filter(
      (e) => e.name.trim().length > 0 && e.rect.width > 0 && e.rect.height > 0,
    );
    expect(plausible.length).toBe(39);
    expect(plausible.every((e) => !e.offscreen)).toBe(true);
    expect(plausible.every((e) => e.rect.x < -30_000)).toBe(true);

    expect(buildCandidates(tree)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("isChromeOnly — trigger B of the settle check", () => {
  it("is true for Claude desktop's bare tree", () => {
    const candidates = buildCandidates(TREES["claudeBare"]!);

    expect(candidates.length).toBeGreaterThan(0); // it is not EMPTY, it is only chrome
    expect(isChromeOnly(candidates)).toBe(true);
    expect(candidates.map((c) => c.name).sort()).toEqual(["Close", "Minimize", "Restore"]);
  });

  it("is false for the SAME APP once its tree woke up", () => {
    // The fixture that stops "Claude desktop is unsupported" from being encoded anywhere.
    const candidates = buildCandidates(TREES["claudeWoke"]!);

    expect(isChromeOnly(candidates)).toBe(false);
    expect(candidates.length).toBeGreaterThan(50);
  });

  it("is true for an empty list — nothing to point at is nothing to point at", () => {
    // Vacuous truth, relied on deliberately: a minimized window filters down to zero candidates
    // and must refuse for the same reason a chrome-only window does. Asserted so it cannot
    // change silently underneath the branch that reads it.
    expect(isChromeOnly([])).toBe(true);
    expect(buildCandidates(TREES["notepadMinimized"]!)).toHaveLength(0);
    expect(isChromeOnly(buildCandidates(TREES["notepadMinimized"]!))).toBe(true);
  });

  it("is false for a small dialog that is short but perfectly real", () => {
    // The counterweight: short does not mean broken, and this window must be answered from.
    const candidates = buildCandidates(TREES["smallDialog"]!);

    expect(candidates.length).toBeLessThan(10);
    expect(isChromeOnly(candidates)).toBe(false);
    expect(candidates.map((c) => c.name)).toContain("Don't Save");
  });
});

// ---------------------------------------------------------------------------
// THE TWO-POINT TIMING. Trigger A is read from the cheap probe (window class); trigger B is read
// from the first real enumerate (the candidates). A fixture that fires BOTH proves nothing about
// which fires when, because either alone gives the same outcome. This one fires ONLY B.
// ---------------------------------------------------------------------------
describe("the trigger-A / trigger-B split", () => {
  const tree = TREES["lazyNativeChromeOnly"]!;

  it("looks entirely healthy to everything available at probe time", () => {
    // Trigger A reads the window class. This is not a Chromium shell, so A stays silent...
    expect(tree.windowClass).not.toBe("Chrome_WidgetWin_1");

    // ...and the raw count is 31, so the magnitude heuristic M16.3's design deleted would have
    // stayed silent too. Both of the cheap signals say "fine".
    expect(tree.elements).toHaveLength(31);
    expect(tree.elements.length).toBeGreaterThan(20);
  });

  it("is only caught once real candidates exist — which needs the enumerate", () => {
    const candidates = buildCandidates(tree);

    expect(candidates).toHaveLength(3);
    expect(isChromeOnly(candidates)).toBe(true);
  });

  it("is exactly the case a Chromium-class check alone would miss", () => {
    // Same verdict as Claude's bare tree, reached by a different route: there, trigger A would
    // have fired first on the class. Here nothing but B can catch it.
    expect(isChromeOnly(buildCandidates(TREES["claudeBare"]!))).toBe(true);
    expect(TREES["claudeBare"]!.windowClass).toBe("Chrome_WidgetWin_1");
    expect(tree.windowClass).toBe("SunAwtFrame");
  });
});

// ---------------------------------------------------------------------------
// The identical-twin duplication, which reasoning missed and the fixtures caught: VS Code
// exposes every activity-bar icon 2-3 times at the SAME rect under different control types.
describe("identical twins collapse", () => {
  it("offers VS Code's Source Control icon exactly once, not three times", () => {
    const raw = TREES["vscode"]!.elements.filter((e) =>
      e.name.startsWith("Source Control (Ctrl+Shift+G)"),
    );
    // Three rows in, at one identical rect.
    expect(raw).toHaveLength(3);
    expect(new Set(raw.map((e) => JSON.stringify(e.rect))).size).toBe(1);

    const candidates = buildCandidates(TREES["vscode"]!).filter((c) =>
      c.name.startsWith("Source Control (Ctrl+Shift+G)"),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rect).toEqual({ x: 9, y: 177, width: 54, height: 54 });
  });

  // WHY TIE-BREAKING ON TREE ORDER IS SAFE, stated structurally rather than empirically.
  //
  // Enumeration order was measured stable across three separate processes (2306 elements,
  // byte-identical sequence, twins at identical indices). But that is a claim about one window
  // on one machine, and "UIA happens to be consistent" is a thin thing to rest on. The real
  // guarantee is stronger and does not depend on order at all: a tie only ever happens between
  // rects that are EQUAL, so whichever member wins resolves to the same coordinates. The
  // tiebreak decides which control-type LABEL is shown, never where the marker goes.
  it("only ever breaks ties between candidates that share an identical rect", () => {
    const tree = TREES["vscode"]!;
    const byKey = new Map<string, typeof tree.elements>();
    for (const element of tree.elements) {
      const key = `${element.name}|${JSON.stringify(element.rect)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), element]);
    }

    const tied = [...byKey.values()].filter((group) => group.length > 1);
    expect(tied.length).toBeGreaterThan(0);

    // Every group that the equal-area branch can collapse is a group of identical rects, so the
    // resolved coordinate is invariant under any reordering of the tree.
    for (const group of tied) {
      const rects = new Set(group.map((e) => JSON.stringify(e.rect)));
      expect(rects.size).toBe(1);
    }
  });

  it("leaves no two candidates sharing a rect AND a name anywhere in the tree", () => {
    const candidates = buildCandidates(TREES["vscode"]!);
    const keys = candidates.map((c) => `${c.name}|${JSON.stringify(c.rect)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("no control-type allowlist", () => {
  it("keeps container-shaped regions a person can still ask for", () => {
    // The REAL cost of an allowlist, measured against the dumps. Not the activity-bar icons —
    // those have TabItem twins and survive one. These have no twin of any allowed type, so an
    // "interactive types only" rule would remove them outright.
    const explorer = buildCandidates(TREES["explorer"]!).map((c) => c.name);
    expect(explorer).toContain("Navigation Pane"); // Pane, 231x776
    expect(explorer).toContain("View Modes"); // Group, 78x39
    expect(explorer).toContain("Status bar"); // StatusBar, 1920x39
  });

  it("still drops a region so large that pointing at it says nothing", () => {
    // Notepad's "Text editor" Document is 1924x863 — 86% of the window. It is a Document, so an
    // allowlist would drop it too, but the container rule gets there first and for a better
    // reason: a marker covering 86% of the screen is not pointing at anything.
    expect(buildCandidates(TREES["notepad"]!).map((c) => c.name)).not.toContain("Text editor");
  });

  it("still lands well inside a promptable list", () => {
    // The permissive rule's real cost on the densest window measured. There is no size problem
    // here to trade accuracy against, which is the whole argument for staying permissive.
    expect(buildCandidates(TREES["vscode"]!).length).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
describe("MAX_NAME_CHARS", () => {
  it("truncates a control name that is really a whole source file", () => {
    expect(GIANT_NAME).toHaveLength(10_973);

    const candidates = buildCandidates(TREE_WITH_GIANT_NAME);
    const giant = candidates.find((c) => c.name.startsWith("xxx"));

    expect(giant).toBeDefined();
    expect(giant!.name.length).toBeLessThanOrEqual(MAX_NAME_CHARS + 3);
  });

  it("truncates rather than drops — the rect is still exact", () => {
    const candidates = buildCandidates(TREE_WITH_GIANT_NAME);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.name.startsWith("xxx"))!.rect).toEqual({
      x: 10,
      y: 60,
      width: 600,
      height: 300,
    });
  });

  it("leaves an ordinary label alone", () => {
    const candidates = buildCandidates(TREE_WITH_GIANT_NAME);
    expect(candidates.find((c) => c.name === "Save")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe("numbering", () => {
  it("is 1-based and contiguous", () => {
    const candidates = buildCandidates(TREES["explorer"]!);
    expect(candidates.map((c) => c.number)).toEqual(
      candidates.map((_, index) => index + 1),
    );
  });

  it("is stable across repeated builds of the same tree", () => {
    const first = buildCandidates(TREES["vscode"]!);
    const second = buildCandidates(TREES["vscode"]!);
    expect(second.map((c) => `${c.number}:${c.name}`)).toEqual(
      first.map((c) => `${c.number}:${c.name}`),
    );
  });
});

// ---------------------------------------------------------------------------
describe("positionIn", () => {
  const win: NativeRect = { x: 0, y: 0, width: 900, height: 900 };

  // Literal expected values, never derived by re-running the transform. M14's ICU lesson: a test
  // that asks the code to produce its own expectation only proves it agrees with itself.
  it.each([
    ["top left", { x: 10, y: 10, width: 50, height: 50 }],
    ["top right", { x: 800, y: 10, width: 50, height: 50 }],
    ["bottom left", { x: 10, y: 800, width: 50, height: 50 }],
    ["middle", { x: 425, y: 425, width: 50, height: 50 }],
    ["top", { x: 425, y: 10, width: 50, height: 50 }],
    ["left", { x: 10, y: 425, width: 50, height: 50 }],
  ])("describes %s", (expected, rect) => {
    expect(positionIn(rect as NativeRect, win)).toBe(expected);
  });

  it("is relative to the WINDOW, not the screen", () => {
    // A small dialog sitting in the bottom-right of a big screen. A control at its top-left is
    // "top left" of the dialog — which is the frame of reference the user shares with the app.
    const dialog: NativeRect = { x: 1400, y: 800, width: 300, height: 200 };
    expect(positionIn({ x: 1410, y: 810, width: 40, height: 20 }, dialog)).toBe("top left");
  });

  it("gives Notepad's File menu a sensible phrase", () => {
    const file = named(buildCandidates(TREES["notepad"]!), "File")[0]!;
    expect(file.position).toBe("top left");
  });
});
