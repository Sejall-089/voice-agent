import { describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import type { JobView } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import {
  initialPillState,
  PILL_COLLAPSED,
  PILL_LABEL_MAX_WIDTH,
  pillSize,
  pillView,
  reducePill,
} from "../src/core/jobs/pill.ts";
import type { PillState, PillView } from "../src/core/jobs/pill.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import { PillController } from "../src/main/pill/PillController.ts";

// M27, fix C: the pill's label counts EVERY group present, most urgent first — "1 running ·
// 2 done" — where until M27 it counted only the top group, so a running job hid done ones
// (which since M26 can wait indefinitely to be read). The colour is still the top group's. The
// collapsed pill widens to fit, up to PILL_LABEL_MAX_WIDTH; past that it says "+N more".

const T0 = 5_000_000_000;

let seq = 0;
const job = (state: JobView["state"], over: Partial<JobView> = {}): JobView => ({
  id: `j${(seq += 1)}`,
  instruction: "send these notes to the team",
  kind: "work",
  state,
  attached: false,
  background: true,
  acknowledged: false,
  waitingFor: state === "needs-you" ? "confirm" : null,
  waitingSince: state === "needs-you" ? T0 : null,
  tool: "sendMessage",
  step: 1,
  total: 1,
  result: null,
  lines: [],
  updatedAt: T0,
  seenAt: null,
  cancelRequested: false,
  stepsRun: 0,
  ...over,
});

const withJobs = (jobs: JobView[], from: PillState = initialPillState(false, T0)): PillState =>
  reducePill(from, { type: "jobs", jobs, now: T0 });

const measured = (state: PillState, widths: number[]): PillState =>
  reducePill(state, { type: "labelMeasured", labels: pillView(state).labelOptions ?? [], widths });

const many = (state: JobView["state"], count: number): JobView[] => Array.from({ length: count }, () => job(state));

// --- Through the real manager and controller, on a fake clock ---

function world() {
  const clock = { now: T0 };
  let n = 0;
  const manager = new JobManager({ store: new InMemoryJobStore(), now: () => clock.now, newId: () => `job${(n += 1)}` });
  const views: PillView[] = [];
  const controller = new PillController({
    manager,
    settings: new InMemorySettings(),
    surface: { render: (view) => void views.push(view) },
    playChime: () => undefined,
    isBusy: () => false,
    now: () => clock.now,
  });
  // A detached job, still working (planning): it counts as running.
  const running = (instruction = "summarize this"): string => {
    const id = manager.submit(instruction);
    manager.detachAttached("hotkey");
    return id;
  };
  const ended = (state: "done" | "failed" | "cancelled", result = "A result."): string => {
    const id = running();
    manager.finish(id, state, result);
    return id;
  };
  const waiting = async (): Promise<string> => {
    const id = running("send these notes");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return id;
  };
  // Time passing as main's one-second re-check sees it.
  const wait = (ms: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      clock.now += 1_000;
      controller.tick();
    }
  };
  return { clock, manager, controller, views, running, ended, waiting, wait, last: () => views[views.length - 1] };
}

describe("the label counts every group present (M27)", () => {
  it("THE LIVE FINDING: two done and one running reads '1 running · 2 done', and keeps saying so", () => {
    const w = world();
    w.ended("done");
    w.ended("done");
    const id = w.running();
    expect(w.last()).toMatchObject({ mode: "running", label: "1 running · 2 done" });
    // Ten minutes on, nothing seen: the done jobs are still in the label, not just the list.
    w.wait(10 * 60 * 1000);
    expect(w.last()).toMatchObject({ mode: "running", label: "1 running · 2 done", expanded: false });
    // The running one finishes: all three are done, and the colour is done's.
    w.manager.finish(id, "done", "Another result.");
    expect(w.last()).toMatchObject({ mode: "done", label: "3 done" });
  });

  it("all four groups, most urgent first, through the real controller", async () => {
    const w = world();
    w.ended("done");
    w.ended("done");
    w.running();
    w.ended("failed", "Slack said no.");
    await w.waiting();
    expect(w.last()).toMatchObject({
      mode: "needs-you",
      pulse: true,
      label: "1 needs you · 1 didn't finish · 1 running · 2 done",
    });
  });

  it("the words agree with the count in every group", () => {
    const label = pillView(withJobs([...many("needs-you", 2), ...many("expired", 3), ...many("queued", 4), ...many("done", 5)])).label;
    expect(label).toBe("2 need you · 3 didn't finish · 4 running · 5 done");
  });

  // Written from the priority order in the spec (§5c), not from the code's list: every one of
  // the fifteen ways the four groups can be present or absent.
  it("THE COLOUR IS THE TOP GROUP'S, for every combination of groups present", () => {
    const order = [
      { mode: "needs-you", state: "needs-you" as const, text: "1 needs you" },
      { mode: "failed", state: "failed" as const, text: "1 didn't finish" },
      { mode: "running", state: "running" as const, text: "1 running" },
      { mode: "done", state: "done" as const, text: "1 done" },
    ];
    for (let mask = 1; mask < 16; mask += 1) {
      const present = order.filter((_, index) => (mask & (1 << index)) !== 0);
      // Handed over in REVERSE priority, so an answer that takes the first job it is given is
      // wrong here.
      const view = pillView(withJobs([...present].reverse().map((group) => job(group.state))));
      const name = present.map((group) => group.mode).join("+");
      expect(view.mode, name).toBe(present[0]?.mode);
      expect(view.label, name).toBe(present.map((group) => group.text).join(" · "));
    }
  });

  // RE-JUSTIFIED AT M27: true of a job cancelled BEFORE ANY STEP RAN (stepsRun 0, below). One
  // cancelled after a step ran is counted in "didn't finish" — tests/pill.cancelled.test.ts.
  it("CANCELLED BEFORE ANY STEP RAN IS NEVER COUNTED: not as done, not as its own group, not in '+N more'", () => {
    const cancelled = many("cancelled", 3);
    expect(cancelled.every((one) => one.stepsRun === 0)).toBe(true);
    expect(pillView(withJobs([...cancelled, job("done")]))).toMatchObject({ mode: "done", label: "1 done" });
    expect(pillView(withJobs([...cancelled, job("running")]))).toMatchObject({ mode: "running", label: "1 running" });
    const alone = pillView(withJobs(cancelled));
    expect(alone).toMatchObject({ mode: "hidden", label: "" });
    expect(alone.labelOptions).toBeUndefined();
    // And past the cap, the "+N more" is jobs actually shown.
    const state = withJobs([...cancelled, job("needs-you"), job("failed"), job("running"), job("done")]);
    expect(pillView(state).labelOptions?.at(-1)).toBe("1 needs you · +3 more");
  });

  // Cancelled from the pill while waiting — the one cancel that ends a job at once (a job
  // mid-step finishes that step first, §5c).
  it("cancelled through the real controller: the user cancelled it, so it is in no count", async () => {
    const w = world();
    w.ended("done");
    w.ended("cancelled");
    const id = await w.waiting();
    expect(w.last()?.label).toBe("1 needs you · 1 done");
    w.manager.cancel(id);
    expect(w.manager.get(id)?.state).toBe("cancelled");
    // RE-JUSTIFIED AT M27: in no count because nothing it was asked to do had run.
    expect(w.manager.get(id)?.stepsRun).toBe(0);
    expect(w.last()).toMatchObject({ mode: "done", label: "1 done" });
  });

  it("one group has one way of being written, and no '+N more'", () => {
    const view = pillView(withJobs(many("running", 3)));
    expect(view.labelOptions).toEqual(["3 running"]);
  });
});

describe("the collapsed pill widens to fit its label, up to a cap; past it, '+N more' (M27)", () => {
  // 1 needs you, 2 didn't finish, 3 running, 1 done.
  const four = (): PillState =>
    withJobs([job("needs-you"), ...many("failed", 2), ...many("running", 3), job("done")]);

  it("offers every form, longest first; '+N more' counts the JOBS left off, and the top group is never one of them", () => {
    expect(pillView(four()).labelOptions).toEqual([
      "1 needs you · 2 didn't finish · 3 running · 1 done",
      "1 needs you · 2 didn't finish · 3 running · +1 more",
      "1 needs you · 2 didn't finish · +4 more",
      "1 needs you · +6 more",
    ]);
  });

  it("before the page has measured: the full label, at the stylesheet's width, and asks to be measured", () => {
    const view = pillView(four());
    expect(view.label).toBe("1 needs you · 2 didn't finish · 3 running · 1 done");
    expect(view.width).toBeUndefined();
    expect(view.labelWidths).toBeUndefined();
    expect(pillSize(view)).toEqual({ ...PILL_COLLAPSED });
  });

  it("the longest form that fits under the cap is shown, and the window is that wide", () => {
    const state = measured(four(), [PILL_LABEL_MAX_WIDTH + 60, PILL_LABEL_MAX_WIDTH + 20, 300, 190]);
    const view = pillView(state);
    expect(view.label).toBe("1 needs you · 2 didn't finish · +4 more");
    expect(view.width).toBe(300);
    expect(view.labelWidths).toEqual([PILL_LABEL_MAX_WIDTH + 60, PILL_LABEL_MAX_WIDTH + 20, 300, 190]);
    expect(pillSize(view)).toEqual({ width: 300, height: PILL_COLLAPSED.height });
  });

  it("a form exactly at the cap fits; one pixel over does not", () => {
    expect(pillView(measured(four(), [PILL_LABEL_MAX_WIDTH, 300, 250, 190])).label).toBe(
      "1 needs you · 2 didn't finish · 3 running · 1 done",
    );
    expect(pillView(measured(four(), [PILL_LABEL_MAX_WIDTH + 1, 300, 250, 190])).label).toBe(
      "1 needs you · 2 didn't finish · 3 running · +1 more",
    );
  });

  it("everything fits: the full label, and never narrower than the M23 pill", () => {
    const state = withJobs([job("running"), job("done")]);
    const view = pillView(measured(state, [150, 140]));
    expect(view).toMatchObject({ label: "1 running · 1 done", width: PILL_COLLAPSED.width });
    const wide = pillView(measured(state, [270, 250]));
    expect(wide).toMatchObject({ label: "1 running · 1 done", width: 270 });
    expect(pillSize(wide)).toEqual({ width: 270, height: PILL_COLLAPSED.height });
  });

  it("nothing fits (a very large font): the shortest form, at the cap", () => {
    const view = pillView(measured(four(), [900, 800, 700, 600]));
    expect(view).toMatchObject({ label: "1 needs you · +6 more", width: PILL_LABEL_MAX_WIDTH });
  });

  it("A STALE MEASUREMENT IS DROPPED: widths for labels that have since changed are never applied", () => {
    const before = withJobs([job("running"), job("done")]);
    const oldLabels = pillView(before).labelOptions ?? [];
    const after = withJobs([job("running"), job("done"), job("done")], before);
    // The precondition that makes this test about the LABELS: the old and new forms are as
    // many, so a check on the count of widths alone would let the stale ones through.
    const newLabels = pillView(after).labelOptions ?? [];
    expect(newLabels).toHaveLength(oldLabels.length);
    expect(newLabels).not.toEqual(oldLabels);
    const view = pillView(reducePill(after, { type: "labelMeasured", labels: oldLabels, widths: [300, 250] }));
    expect(view.label).toBe("1 running · 2 done");
    expect(view.labelWidths).toBeUndefined();
    expect(view.width).toBeUndefined();
  });

  it("a measurement with the wrong number of widths, or one that is not a width, is dropped", () => {
    const state = four();
    const labels = pillView(state).labelOptions ?? [];
    for (const widths of [[300], [300, 200, 100, 50, 25], [300, Number.NaN, 200, 100], [300, 0, 200, 100], [300, -5, 200, 100]]) {
      expect(pillView(reducePill(state, { type: "labelMeasured", labels, widths })).labelWidths, JSON.stringify(widths)).toBeUndefined();
    }
  });

  it("when the counts change, the pill keeps its last width until the new label is measured — no shrink for a frame", () => {
    const first = measured(withJobs([job("needs-you"), job("running"), job("done")]), [290, 270, 200]);
    expect(pillView(first).width).toBe(290);
    const next = withJobs([job("needs-you"), job("running"), job("done"), job("done")], first);
    const view = pillView(next);
    expect(view.labelWidths).toBeUndefined(); // the page is asked to measure again
    expect(view.width).toBe(290);
    expect(view.label).toBe("1 needs you · 1 running · 2 done");
  });

  it("the open list is never narrower than the collapsed pill, and the cap is the list's width", () => {
    const row = { id: "a", title: "", state: "running", detail: "", actions: [] };
    expect(pillSize({ expanded: true, items: [row], width: 300 }).width).toBe(PILL_LABEL_MAX_WIDTH);
    expect(pillSize({ expanded: false, items: [], width: 5_000 }).width).toBe(PILL_LABEL_MAX_WIDTH);
    expect(pillSize({ expanded: false, items: [], width: 10 }).width).toBe(PILL_COLLAPSED.width);
  });

  it("through the controller: an accepted report sizes the pill; garbage from the page is dropped", async () => {
    const w = world();
    w.ended("done");
    w.running();
    w.ended("failed", "It broke.");
    await w.waiting();
    const labels = w.last()?.labelOptions ?? [];
    expect(labels).toHaveLength(4);

    for (const [rawLabels, rawWidths] of [
      ["x", [1]],
      [labels, "300"],
      [labels, [300, 250]],
      [labels.map(() => 7), [400, 380, 300, 200]],
      [labels, [400, "380", 300, 200]],
      [labels, [400, 380, 300, Number.POSITIVE_INFINITY]],
      [labels, [400, 380, 300, 20_000]],
      [[...labels, "+9 more"], [400, 380, 300, 200, 100]],
    ] as [unknown, unknown][]) {
      w.controller.onLabelWidths(rawLabels, rawWidths);
      expect(w.controller.view().labelWidths, JSON.stringify([rawLabels, rawWidths])).toBeUndefined();
    }

    w.controller.onLabelWidths(labels, [400, 380, 300, 200]);
    expect(w.last()).toMatchObject({ label: labels[2], width: 300, labelWidths: [400, 380, 300, 200] });
  });
});
