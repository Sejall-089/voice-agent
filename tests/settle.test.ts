import { describe, expect, it } from "vitest";
import { buildCandidates } from "../src/core/screen/elements.ts";
import {
  afterEnumerate,
  afterProbe,
  afterWait,
  classify,
  decide,
  initialState,
  isLazyShell,
  isStable,
  SETTLE_BUDGET_MS,
  SETTLE_MS,
  SPARSE_CANDIDATES,
} from "../src/core/screen/settle.ts";
import { TREES } from "./FakeElements.ts";
import type { SettleStep } from "../src/core/screen/settle.ts";
import type { Candidate, WindowElements } from "../src/core/types.ts";

// A scripted run of the loop the caller will write in /main — no clock, no PowerShell, no
// desktop. `probeCounts` is what successive probe() calls return; `trees` is what successive
// enumerate() calls return. Returns the full trace, so a test asserts the SHAPE of the run and
// not just its verdict: how many waits were paid, and in what order the two triggers fired.
function run(options: {
  windowClass: string;
  probeCounts: number[];
  trees: WindowElements[];
  budgetMs?: number;
}): { steps: SettleStep[]; waits: number; probes: number; enumerations: number } {
  const limits = { budgetMs: options.budgetMs ?? SETTLE_BUDGET_MS };
  let state = initialState();
  const steps: SettleStep[] = [];
  let probes = 0;
  let enumerations = 0;
  let waits = 0;

  for (let guard = 0; guard < 40; guard += 1) {
    const step = decide(state, limits);
    steps.push(step);

    if (step.do === "accept" || step.do === "refuse") {
      return { steps, waits, probes, enumerations };
    }
    if (step.do === "probe") {
      const count = options.probeCounts[Math.min(probes, options.probeCounts.length - 1)]!;
      probes += 1;
      state = afterProbe(state, count, options.windowClass);
      continue;
    }
    if (step.do === "wait") {
      waits += 1;
      state = afterWait(state);
      // A wait is always followed by a fresh probe — that is what makes it a settle CHECK
      // rather than a sleep.
      const count = options.probeCounts[Math.min(probes, options.probeCounts.length - 1)]!;
      probes += 1;
      state = afterProbe(state, count, options.windowClass);
      continue;
    }
    const tree = options.trees[Math.min(enumerations, options.trees.length - 1)]!;
    enumerations += 1;
    state = afterEnumerate(state, buildCandidates(tree));
  }
  throw new Error("settle loop did not terminate");
}

const verdict = (r: { steps: SettleStep[] }): SettleStep => r.steps[r.steps.length - 1]!;

const cands = (key: string): Candidate[] => buildCandidates(TREES[key]!);

// ---------------------------------------------------------------------------
// THE THREE THINNESS SIGNALS. This is the first place all of them meet one decision, and the
// risk being guarded against is that the output collapses any two of them together.
// ---------------------------------------------------------------------------
describe("the three signals stay distinguishable", () => {
  it("tells lazy-shell (trigger A) from chrome-only (trigger B) from sparse-but-real", () => {
    // A: Brave-shaped — Chromium class, richly populated from the first read. The window class
    //    is the ONLY reason it is suspected; its content is fine.
    const lazyShell = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [431, 431],
      trees: [TREES["claudeWoke"]!],
    });
    expect(lazyShell.steps.filter((s) => s.do === "wait")).toEqual([
      { do: "wait", trigger: "lazy-shell" },
    ]);
    expect(verdict(lazyShell)).toEqual({ do: "accept", thinness: "healthy" });

    // B: Claude desktop as first measured — chrome and nothing else.
    const chromeOnly = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [14, 14, 14, 14],
      trees: [TREES["claudeBare"]!],
    });
    expect(verdict(chromeOnly)).toEqual({
      do: "refuse",
      refusal: "unreadable",
      thinness: "chrome-only",
    });

    // Sparse-but-real: six controls in a Save-changes dialog. NOT a problem, and it must reach
    // a different verdict from both of the above.
    const sparse = run({
      windowClass: "#32770",
      probeCounts: [6],
      trees: [TREES["smallDialog"]!],
    });
    expect(verdict(sparse)).toEqual({ do: "accept", thinness: "sparse" });

    // The three verdicts are pairwise distinct — the property this whole describe block exists
    // to hold onto.
    const kinds = [lazyShell, chromeOnly, sparse].map((r) => JSON.stringify(verdict(r)));
    expect(new Set(kinds).size).toBe(3);
  });

  it("does not treat a sparse window as a broken one", () => {
    const sparse = run({
      windowClass: "#32770",
      probeCounts: [6],
      trees: [TREES["smallDialog"]!],
    });
    // No retrying it into the ground, and no refusal.
    expect(sparse.waits).toBe(0);
    expect(verdict(sparse).do).toBe("accept");
  });

  it("accepts sparse on exactly the same terms as healthy — the label gates nothing", () => {
    expect(cands("smallDialog").length).toBeLessThan(SPARSE_CANDIDATES);
    expect(cands("notepad").length).toBeGreaterThanOrEqual(SPARSE_CANDIDATES);

    const sparse = run({ windowClass: "#32770", probeCounts: [6], trees: [TREES["smallDialog"]!] });
    const healthy = run({ windowClass: "Notepad", probeCounts: [49], trees: [TREES["notepad"]!] });

    expect(verdict(sparse).do).toBe("accept");
    expect(verdict(healthy).do).toBe("accept");
    // Same number of probes, same number of waits, same shape of run.
    expect(sparse.waits).toBe(healthy.waits);
    expect(sparse.probes).toBe(healthy.probes);
  });
});

// ---------------------------------------------------------------------------
describe("the native fast path pays nothing", () => {
  it("goes probe -> enumerate -> accept, with no wait", () => {
    const r = run({ windowClass: "Notepad", probeCounts: [49], trees: [TREES["notepad"]!] });

    expect(r.steps.map((s) => s.do)).toEqual(["probe", "enumerate", "accept"]);
    expect(r.waits).toBe(0);
    expect(r.probes).toBe(1);
    expect(r.enumerations).toBe(1);
  });

  it("does the same for Explorer", () => {
    const r = run({
      windowClass: "CabinetWClass",
      probeCounts: [55],
      trees: [TREES["explorer"]!],
    });
    expect(r.waits).toBe(0);
    expect(verdict(r)).toEqual({ do: "accept", thinness: "healthy" });
  });
});

// ---------------------------------------------------------------------------
describe("a cold Chromium tree", () => {
  it("waits through 13 -> 613 and answers from the settled list, never the partial one", () => {
    // The measured transition. The first tree the loop would see if it enumerated immediately is
    // claudeBare (chrome only); the settled one is claudeWoke.
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [13, 613, 613],
      trees: [TREES["claudeWoke"]!],
    });

    expect(r.steps.map((s) => s.do)).toEqual(["probe", "wait", "wait", "enumerate", "accept"]);
    expect(verdict(r)).toEqual({ do: "accept", thinness: "healthy" });
    // Two settle delays, so ~700ms plus three probes — the plan's ~860ms cold estimate.
    expect(r.waits).toBe(2);
    expect(r.waits * SETTLE_MS).toBe(700);
  });

  it("never enumerates while the count is still moving", () => {
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [13, 200, 480, 613, 613],
      trees: [TREES["claudeWoke"]!],
    });
    // The enumerate happens once, and only after the counts have agreed twice — so it sits
    // after every wait, never between two disagreeing reads.
    expect(r.enumerations).toBe(1);
    expect(r.steps.map((s) => s.do)).toEqual([
      "probe",
      "wait",
      "wait",
      "wait",
      "wait",
      "enumerate",
      "accept",
    ]);
  });

  it("pays one settle even when it was already warm — the accepted trigger-A cost", () => {
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [431, 431],
      trees: [TREES["claudeWoke"]!],
    });
    expect(r.waits).toBe(1);
    expect(verdict(r).do).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// The branch the magnitude design lacked entirely.
// ---------------------------------------------------------------------------
describe("a tree that never settles", () => {
  it("refuses as 'unsettled' rather than answering against a moving list", () => {
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [13, 40, 88, 141, 197, 260, 322, 400],
      trees: [TREES["claudeWoke"]!],
    });

    expect(verdict(r)).toEqual({
      do: "refuse",
      refusal: "unsettled",
      thinness: "lazy-shell",
    });
    // It never got as far as reading the tree, which is the point — there was never a moment
    // worth reading.
    expect(r.enumerations).toBe(0);
  });

  it("stops at the budget rather than waiting forever", () => {
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [13, 40, 88, 141, 197, 260, 322, 400],
      trees: [TREES["claudeWoke"]!],
    });
    expect(r.waits * SETTLE_MS).toBeLessThanOrEqual(SETTLE_BUDGET_MS + SETTLE_MS);
  });

  it("says 'unsettled', not 'unreadable', when a chrome-only tree is still moving", () => {
    // Two different facts: "there is nothing here" versus "it has not finished arriving".
    const r = run({
      windowClass: "SunAwtFrame",
      probeCounts: [31, 55, 70, 96, 130, 175, 220],
      trees: [TREES["lazyNativeChromeOnly"]!],
      budgetMs: 700,
    });
    expect(verdict(r)).toEqual({
      do: "refuse",
      refusal: "unsettled",
      thinness: "chrome-only",
    });
  });
});

// ---------------------------------------------------------------------------
// THE TWO-POINT TIMING. Trigger A is read from the probe; trigger B only from a real enumerate.
// ---------------------------------------------------------------------------
describe("trigger A and trigger B fire at different moments", () => {
  it("catches a non-Chromium window that only reveals itself after the enumerate", () => {
    const r = run({
      windowClass: "SunAwtFrame",
      probeCounts: [31, 31, 31],
      trees: [TREES["lazyNativeChromeOnly"]!],
    });

    // Trigger A never fires: not a Chromium class, so the first thing that happens after the
    // probe is a real enumerate — no wait beforehand.
    expect(r.steps.slice(0, 2).map((s) => s.do)).toEqual(["probe", "enumerate"]);

    // Trigger B then fires on the CONTENT, and only then is a settle paid.
    expect(r.steps.filter((s) => s.do === "wait")).toEqual([
      { do: "wait", trigger: "chrome-only" },
    ]);
    expect(verdict(r)).toEqual({
      do: "refuse",
      refusal: "unreadable",
      thinness: "chrome-only",
    });
  });

  it("reaches the same verdict on Claude's bare tree by the OTHER route", () => {
    const r = run({
      windowClass: "Chrome_WidgetWin_1",
      probeCounts: [14, 14, 14],
      trees: [TREES["claudeBare"]!],
    });

    // Here trigger A fires first, before anything has been enumerated.
    expect(r.steps[1]).toEqual({ do: "wait", trigger: "lazy-shell" });
    // Same destination, different path — which is exactly why a fixture that fires BOTH could
    // not have proved the ordering.
    expect(verdict(r)).toEqual({
      do: "refuse",
      refusal: "unreadable",
      thinness: "chrome-only",
    });
  });

  it("is not fooled by a healthy-looking element count", () => {
    // 31 raw elements is comfortably above any 'looks bare' threshold, and the class is native.
    // Both cheap signals say fine; only the candidates disagree.
    expect(TREES["lazyNativeChromeOnly"]!.elements).toHaveLength(31);
    expect(isLazyShell("SunAwtFrame")).toBe(false);
    expect(classify(cands("lazyNativeChromeOnly"))).toBe("chrome-only");
  });
});

// ---------------------------------------------------------------------------
describe("a minimized window", () => {
  it("refuses as unreadable — zero candidates is nothing to point at", () => {
    const r = run({
      windowClass: "Notepad",
      probeCounts: [49, 49, 49],
      trees: [TREES["notepadMinimized"]!],
    });
    expect(verdict(r)).toEqual({
      do: "refuse",
      refusal: "unreadable",
      thinness: "chrome-only",
    });
  });
});

// ---------------------------------------------------------------------------
describe("the pieces", () => {
  it("isStable needs two consecutive equal counts", () => {
    expect(isStable([])).toBe(false);
    expect(isStable([13])).toBe(false);
    expect(isStable([13, 613])).toBe(false);
    expect(isStable([13, 613, 613])).toBe(true);
    // Equal-then-changed is NOT stable — only the latest pair counts.
    expect(isStable([613, 613, 700])).toBe(false);
  });

  it("isLazyShell knows Chromium and nothing else", () => {
    expect(isLazyShell("Chrome_WidgetWin_1")).toBe(true);
    expect(isLazyShell("Notepad")).toBe(false);
    expect(isLazyShell("CabinetWClass")).toBe(false);
    expect(isLazyShell("")).toBe(false);
  });

  it("classify checks chrome-only BEFORE size", () => {
    // The ordering that lets trigger B tell 3-chrome-buttons from 6-real-buttons; both are
    // under the sparse threshold, and only one of them is a problem.
    expect(cands("claudeBare")).toHaveLength(3);
    expect(cands("smallDialog")).toHaveLength(6);
    expect(classify(cands("claudeBare"))).toBe("chrome-only");
    expect(classify(cands("smallDialog"))).toBe("sparse");
  });

  it("classify calls an empty list chrome-only", () => {
    expect(classify([])).toBe("chrome-only");
  });

  it("re-enumerates when the tree moved after the last read", () => {
    // Candidates from before a settle round are STALE: confirming a count while judging a list
    // captured before it would be the same bug in a new place.
    let state = initialState();
    state = afterProbe(state, 14, "Chrome_WidgetWin_1");
    state = afterProbe(state, 14, "Chrome_WidgetWin_1");
    state = afterEnumerate(state, cands("claudeBare"));
    expect(decide(state).do).toBe("wait");

    state = afterWait(state);
    state = afterProbe(state, 613, "Chrome_WidgetWin_1");
    // The count moved, so the candidates no longer describe the window — read it again.
    expect(decide(state).do).toBe("wait");
    state = afterWait(state);
    state = afterProbe(state, 613, "Chrome_WidgetWin_1");
    expect(decide(state).do).toBe("enumerate");
  });
});
