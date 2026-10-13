import { describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import type { JobView } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { interruptedText, EXPIRED } from "../src/core/jobs/messages.ts";
import {
  clip,
  IDLE_COLLAPSE_MS,
  initialPillState,
  isPointInRect,
  PILL_COLLAPSED,
  pillBounds,
  pillSize,
  pillView,
  reducePill,
} from "../src/core/jobs/pill.ts";
import type { PillEvent, PillState, PillView } from "../src/core/jobs/pill.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import { createOnDictateHotkey } from "../src/main/dictate.ts";
import { createOnInstructionHotkey } from "../src/main/instructionHotkey.ts";
import { createStartingSomethingElse } from "../src/main/jobs/startingSomethingElse.ts";
import { PillController } from "../src/main/pill/PillController.ts";
import { PillWindow } from "../src/main/pill/PillWindow.ts";
import type { PillBrowserWindow } from "../src/main/pill/PillWindow.ts";

// THE LIST ALWAYS STARTS COLLAPSED.
//
// Found live: after one click on the pill, the job list stayed open for that instruction and
// every later one, as if the app had remembered a choice. The cause: whether the list is open
// was one flag in the pill's state, set by the click and cleared by nothing but another click.
// The view hid it while there was nothing to show, but the flag stayed set — so the pill came
// back already open for the next job.
//
// The rule now: it opens ONLY on a click of the pill, and closes on anything that means the
// user has moved on. Each of those is a test below, first on the pure reducer, then through
// the controller and the real hotkey handlers.

const T0 = 2_000_000;
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
  ...over,
});

const apply = (state: PillState, ...events: PillEvent[]): PillState => events.reduce(reducePill, state);
const withJobs = (jobs: JobView[], now = T0): PillState =>
  reducePill(initialPillState(false, T0), { type: "jobs", jobs, now });
// An open list, with the pointer on it — where a click leaves things.
const opened = (jobs: JobView[]): PillState =>
  apply(withJobs(jobs), { type: "hover", inside: true, now: T0 }, { type: "expand", expanded: true, now: T0 });

describe("the reducer: collapsed by default, opened only by a click", () => {
  it("is collapsed initially", () => {
    expect(initialPillState(false, T0).expanded).toBe(false);
    expect(pillView(withJobs([job("running")])).expanded).toBe(false);
  });

  it("a click on the pill expands it; a second click collapses it", () => {
    let state = withJobs([job("running")]);
    state = reducePill(state, { type: "expand", expanded: true, now: T0 });
    expect(pillView(state).expanded).toBe(true);
    state = reducePill(state, { type: "expand", expanded: false, now: T0 + 500 });
    expect(pillView(state).expanded).toBe(false);
    expect(state.collapseAt).toBeNull();
  });

  it("NOTHING ABOUT A JOB OPENS IT: a new job, one that starts waiting, one that fails — all stay collapsed", () => {
    const running = job("running");
    let state = withJobs([running]);
    const arrivals: JobView[][] = [
      [running, job("running")], // a new job
      [running, job("needs-you")], // one starts waiting
      [running, job("failed", { result: "It broke." })], // one fails
      [running, job("interrupted")],
      [running, job("expired")],
      [running, job("queued")],
      [{ ...running, state: "needs-you", waitingFor: "confirm" }], // an existing one starts waiting
    ];
    for (const jobs of arrivals) {
      state = reducePill(state, { type: "jobs", jobs, now: T0 + 100 });
      expect(state.expanded, jobs.map((j) => j.state).join(",")).toBe(false);
      expect(pillView(state).expanded).toBe(false);
    }
    // ...while the pulse, which IS how a waiting job asks for attention, did fire.
    expect(pillView(reducePill(withJobs([running]), { type: "jobs", jobs: [running, job("needs-you")], now: T0 })).pulse).toBe(true);
  });

  it("and none of them CLOSES an open list either: a job changing under an open list leaves it open", () => {
    const running = job("running");
    let state = opened([running]);
    state = reducePill(state, { type: "jobs", jobs: [running, job("needs-you")], now: T0 + 100 });
    expect(state.expanded).toBe(true);
  });

  it("the `collapse` event closes it — the hotkey, a new instruction, a row's button — and is a no-op when closed", () => {
    const state = reducePill(opened([job("running")]), { type: "collapse" });
    expect(state.expanded).toBe(false);
    expect(state.collapseAt).toBeNull();
    const closedAlready = withJobs([job("running")]);
    expect(reducePill(closedAlready, { type: "collapse" })).toBe(closedAlready);
  });

  it("THE BUG: opened once, emptied, and the next job comes — the pill returns COLLAPSED", () => {
    let state = opened([job("done", { result: "Sent." })]);
    // The job fades and the pill goes away with its list still open...
    state = reducePill(state, { type: "tick", now: T0 + 9_000 });
    expect(pillView(state).mode).toBe("hidden");
    // ...and this is the assertion the old code failed: the flag is cleared, not just hidden.
    expect(state.expanded).toBe(false);
    state = reducePill(state, { type: "jobs", jobs: [job("running", { updatedAt: T0 + 60_000 })], now: T0 + 60_000 });
    expect(pillView(state)).toMatchObject({ mode: "running", expanded: false });
  });

  it("the same when the last job is dismissed rather than fading", () => {
    let state = opened([job("failed")]);
    state = reducePill(state, { type: "jobs", jobs: [], now: T0 + 1_000 });
    expect(state.expanded).toBe(false);
    state = reducePill(state, { type: "jobs", jobs: [job("needs-you")], now: T0 + 2_000 });
    expect(pillView(state).expanded).toBe(false);
  });

  it("'expanded' is not a setting: the state a restart builds is collapsed whatever came before, and only mute is carried", () => {
    const settings = new InMemorySettings();
    const before = apply(initialPillState(false, T0), { type: "jobs", jobs: [job("running")], now: T0 }, { type: "expand", expanded: true, now: T0 }, { type: "mute", muted: true });
    expect(before.expanded).toBe(true);
    // What a restart has to go on is the settings store and nothing else.
    const after = initialPillState(settings.get("chime.muted") === "1", T0);
    expect(after.expanded).toBe(false);
    expect(initialPillState.length).toBe(2); // (muted, now): there is nowhere to pass "expanded"
  });
});

describe("the idle timer, on a fake clock: ten seconds with the pointer off the list", () => {
  const leave = (state: PillState, at: number): PillState => reducePill(state, { type: "hover", inside: false, now: at });
  const enter = (state: PillState, at: number): PillState => reducePill(state, { type: "hover", inside: true, now: at });
  const tick = (state: PillState, at: number): PillState => reducePill(state, { type: "tick", now: at });

  it("does not run while the pointer is on the list, however long that is", () => {
    let state = opened([job("needs-you")]);
    expect(state.collapseAt).toBeNull();
    state = tick(state, T0 + 10 * 60_000);
    expect(state.expanded).toBe(true);
  });

  it("collapses 10 s after the pointer leaves — and not a tick before", () => {
    let state = leave(opened([job("needs-you")]), T0 + 1_000);
    expect(state.collapseAt).toBe(T0 + 1_000 + IDLE_COLLAPSE_MS);
    state = tick(state, T0 + 1_000 + IDLE_COLLAPSE_MS - 1);
    expect(state.expanded).toBe(true);
    state = tick(state, T0 + 1_000 + IDLE_COLLAPSE_MS);
    expect(state.expanded).toBe(false);
    expect(state.collapseAt).toBeNull();
  });

  it("A RE-ENTER CANCELS IT: back on the list at 9 s, it is still open long after the 10 s mark", () => {
    let state = leave(opened([job("needs-you")]), T0);
    state = enter(state, T0 + 9_000);
    expect(state.collapseAt).toBeNull();
    state = tick(state, T0 + 30_000);
    expect(state.expanded).toBe(true);
  });

  it("leaving again starts a FRESH ten seconds, not the remainder of the last", () => {
    let state = leave(opened([job("needs-you")]), T0);
    state = enter(state, T0 + 9_000);
    state = leave(state, T0 + 20_000);
    state = tick(state, T0 + 29_999);
    expect(state.expanded).toBe(true);
    state = tick(state, T0 + 30_000);
    expect(state.expanded).toBe(false);
  });

  it("opened with the pointer already elsewhere (it cannot be, but if it is): the ten seconds start at the click", () => {
    let state = reducePill(withJobs([job("needs-you")]), { type: "expand", expanded: true, now: T0 });
    expect(state.collapseAt).toBe(T0 + IDLE_COLLAPSE_MS);
    state = tick(state, T0 + IDLE_COLLAPSE_MS);
    expect(state.expanded).toBe(false);
  });

  it("hovering a COLLAPSED pill starts nothing and opens nothing", () => {
    let state = withJobs([job("needs-you")]);
    state = leave(enter(state, T0), T0 + 1_000);
    expect(state.collapseAt).toBeNull();
    state = tick(state, T0 + 60_000);
    expect(state.expanded).toBe(false);
  });

  it("a list closed by the timer does not reopen when the pointer comes back", () => {
    let state = leave(opened([job("needs-you")]), T0);
    state = tick(state, T0 + IDLE_COLLAPSE_MS);
    state = enter(state, T0 + IDLE_COLLAPSE_MS + 500);
    expect(state.expanded).toBe(false);
  });
});

describe("sizing the open list to its content", () => {
  const row = { id: "a", title: "t", state: "failed", detail: "d", actions: [] };

  it("uses the page's measurement when there is one, and an estimate until then", () => {
    const estimate = pillSize({ expanded: true, items: [row] });
    expect(estimate.height).toBe(180);
    expect(pillSize({ expanded: true, items: [row], contentHeight: 236 })).toEqual({ width: 348, height: 236 });
    // One job with a long message is simply a taller panel — not a scrollbar.
    expect(pillSize({ expanded: true, items: [row], contentHeight: 310 }).height).toBe(310);
  });

  it("never taller than the ceiling (then the list scrolls), never shorter than the pill itself", () => {
    expect(pillSize({ expanded: true, items: [row], contentHeight: 5_000 }).height).toBe(440);
    expect(pillSize({ expanded: true, items: [row], contentHeight: 3 }).height).toBe(PILL_COLLAPSED.height);
  });

  it("collapsed ignores any measurement", () => {
    expect(pillSize({ expanded: false, items: [row], contentHeight: 400 })).toEqual({ ...PILL_COLLAPSED });
  });

  it("the measurement is kept only while open, and thrown away on close and on the next open", () => {
    let state = opened([job("failed")]);
    state = reducePill(state, { type: "measured", height: 236.4 });
    expect(pillView(state).contentHeight).toBe(237);
    state = reducePill(state, { type: "collapse" });
    expect(pillView(state).contentHeight).toBeUndefined();
    state = reducePill(state, { type: "measured", height: 300 }); // a late report for a closed list
    expect(state.contentHeight).toBeNull();
    state = reducePill(state, { type: "expand", expanded: true, now: T0 });
    expect(pillView(state).contentHeight).toBeUndefined();
  });

  it("rejects a measurement that is not a real height", () => {
    const state = opened([job("failed")]);
    for (const height of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reducePill(state, { type: "measured", height }).contentHeight, String(height)).toBeNull();
    }
  });

  it("THE ANCHOR DOES NOT MOVE: collapsed, open, and open-and-measured all share one bottom-right corner", () => {
    const workArea = { x: 0, y: 0, width: 1280, height: 672 };
    const corners = [
      pillSize({ expanded: false, items: [row] }),
      pillSize({ expanded: true, items: [row] }),
      pillSize({ expanded: true, items: [row], contentHeight: 301 }),
      pillSize({ expanded: true, items: [row], contentHeight: 9_999 }),
    ].map((size) => {
      const bounds = pillBounds(workArea, size);
      return [bounds.x + bounds.width, bounds.y + bounds.height];
    });
    expect(corners).toEqual([[1264, 656], [1264, 656], [1264, 656], [1264, 656]]);
  });

  it("isPointInRect: inside, on each edge, and outside", () => {
    const rect = { x: 100, y: 200, width: 50, height: 20 };
    expect(isPointInRect({ x: 100, y: 200 }, rect)).toBe(true);
    expect(isPointInRect({ x: 149, y: 219 }, rect)).toBe(true);
    expect(isPointInRect({ x: 150, y: 210 }, rect)).toBe(false);
    expect(isPointInRect({ x: 120, y: 220 }, rect)).toBe(false);
    expect(isPointInRect({ x: 99, y: 210 }, rect)).toBe(false);
  });
});

describe("a long message: whole, or cut BETWEEN words with an ellipsis", () => {
  it("every sentence this app writes about a job is short enough to be shown whole", () => {
    const ours = [
      EXPIRED,
      interruptedText({ step: 2, total: 3, tool: "github__create_issue", inFlightTool: "github__create_issue", inFlightStep: 2 }),
      interruptedText({ step: 3, total: 3, tool: "linear__search_issues", inFlightTool: null, inFlightStep: null }),
    ];
    for (const text of ours) {
      const view = pillView(withJobs([job("failed", { result: text })]));
      expect(view.items[0]?.detail).toBe(text);
    }
  });

  it("the live case — a stopped-chain message of a few hundred characters — is not cut at all", () => {
    const message =
      "Could not confirm the message to #fun. It may have been sent. Check Slack before trying again. " +
      "I'd already done step 1 of 2 (create the GitHub issue), but step 2 didn't finish.";
    expect(pillView(withJobs([job("failed", { result: message })])).items[0]?.detail).toBe(message);
  });

  it("something longer is cut at a word and ends with an ellipsis — never mid-word", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const cut = clip(words.join(" "), 420);
    expect(cut.length).toBeLessThanOrEqual(420);
    expect(cut.endsWith("…")).toBe(true);
    // Everything before the ellipsis is a run of WHOLE words from the original.
    const kept = cut.slice(0, -1).split(" ");
    expect(kept).toEqual(words.slice(0, kept.length));
  });

  it("at every limit from 6 to 80, the last word kept is a whole word", () => {
    // From 6: the first word is five letters, and below that there is no whole word to keep.
    const text = "Could not confirm the message to the channel. It may have been sent already.";
    const whole = new Set(text.split(" ").map((word) => word.replace(/[.,]+$/, "")));
    for (let max = 6; max <= 80; max += 1) {
      const cut = clip(text, max);
      expect(cut.length, `max ${max}`).toBeLessThanOrEqual(max);
      if (cut === text) continue;
      expect(cut.endsWith("…"), `max ${max}`).toBe(true);
      const last = cut.slice(0, -1).split(" ").at(-1) ?? "";
      expect(whole.has(last), `max ${max}: "${cut}"`).toBe(true);
    }
  });

  it("no dangling punctuation or space before the ellipsis", () => {
    expect(clip("It may have been sent. Check Slack before trying again.", 24)).toBe("It may have been sent…");
    expect(clip("one two, three four five six", 9)).toBe("one two…");
  });

  it("one word longer than the limit has no boundary: it is cut where it must be, still with an ellipsis", () => {
    const cut = clip("https://example.com/" + "a".repeat(600), 420);
    expect(cut.length).toBe(420);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("short text and exact-length text are untouched", () => {
    expect(clip("Slack said no.", 420)).toBe("Slack said no.");
    expect(clip("abcde", 5)).toBe("abcde");
  });
});

// --- Through the controller, and through the real hotkey handlers ---

function fakeWindow() {
  const bounds: { x: number; y: number; width: number; height: number }[] = [];
  const sent: PillView[] = [];
  let visible = false;
  const win: PillBrowserWindow = {
    setContentProtection: () => undefined,
    setBounds: (rect) => void bounds.push(rect),
    showInactive: () => void (visible = true),
    hide: () => void (visible = false),
    isVisible: () => visible,
    isDestroyed: () => false,
    destroy: () => undefined,
    webContents: { send: (_channel, view) => void sent.push(view as PillView) },
  };
  return { win, bounds, sent };
}

async function world(options: { pointerOver?: () => boolean | null } = {}) {
  const clock = { now: T0 };
  let n = 0;
  const manager = new JobManager({ store: new InMemoryJobStore(), now: () => clock.now, newId: () => `job${(n += 1)}` });
  const settings = new InMemorySettings();
  const fake = fakeWindow();
  const workArea = { x: 0, y: 0, width: 1280, height: 672 };
  let loaded: () => void = () => undefined;
  const pillWindow = new PillWindow({
    create: () => fake.win,
    // Async, as loading a page is.
    load: () => new Promise<void>((resolve) => (loaded = resolve)),
    workArea: () => workArea,
  });
  const controller = new PillController({
    manager,
    settings,
    surface: pillWindow,
    playChime: () => undefined,
    isBusy: () => false,
    now: () => clock.now,
    ...(options.pointerOver === undefined ? {} : { pointerOver: options.pointerOver }),
  });
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  // A background job waiting on a confirm, parked the way the planner parks one.
  const waitingJob = async (instruction = "send these notes"): Promise<string> => {
    const id = manager.submit(instruction);
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    manager.detachAttached();
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await flush();
    return id;
  };
  const failedJob = (result: string): string => {
    const id = manager.submit("file this bug");
    manager.detachAttached();
    manager.finish(id, "failed", result);
    return id;
  };
  await flush();
  return {
    clock, manager, settings, controller, pillWindow, fake, workArea, waitingJob, failedJob, flush,
    pageLoaded: async () => { loaded(); await flush(); },
    last: () => fake.sent.at(-1),
    corner: () => { const b = fake.bounds.at(-1); return b === undefined ? null : [b.x + b.width, b.y + b.height]; },
  };
}

describe("PillController: what closes an open list", () => {
  it("starts collapsed, a click opens it, a second click closes it", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    expect(w.last()?.expanded).toBe(false);
    w.controller.onExpand(true);
    expect(w.last()?.expanded).toBe(true);
    w.controller.onExpand(false);
    expect(w.last()?.expanded).toBe(false);
  });

  it.each(["review", "cancel"] as const)("a row's %s button closes it", async (action) => {
    const w = await world();
    const id = await w.waitingJob();
    await w.pageLoaded();
    w.controller.onExpand(true);
    w.controller.onAction(id, action);
    expect(w.last()?.expanded).toBe(false);
  });

  it("Dismiss closes it (with another job still listed, so the pill stays)", async () => {
    const w = await world();
    await w.waitingJob();
    const failed = w.failedJob("It broke.");
    await w.pageLoaded();
    w.controller.onExpand(true);
    w.controller.onAction(failed, "dismiss");
    expect(w.last()).toMatchObject({ mode: "needs-you", expanded: false });
  });

  it("Resume closes it", async () => {
    const w = await world();
    const id = w.manager.submit("add to my page");
    const gate = w.manager.gateFor(id);
    await gate.admit({ tools: ["addToPage"], statusOnly: false });
    w.manager.detachAttached();
    void gate.enterStep({ tool: "addToPage", index: 1, total: 1, foregroundOnly: true });
    await w.flush();
    await w.pageLoaded();
    w.controller.onExpand(true);
    w.controller.onAction(id, "resume");
    // Resumed and back in front of the user — and the list is out of the way.
    expect(w.manager.isAttached(id)).toBe(true);
    expect(w.last()).toMatchObject({ mode: "running", expanded: false });
  });

  it("an action that was REFUSED or DROPPED does not close it", async () => {
    const w = await world();
    const id = await w.waitingJob();
    await w.pageLoaded();
    w.controller.onExpand(true);
    w.controller.onAction(id, "approve"); // no such action
    w.controller.onAction("nope", "cancel"); // no such job
    w.controller.onAction(id, "dismiss"); // not offered while waiting
    expect(w.last()?.expanded).toBe(true);
  });

  it("a job entering needs-you or failing while collapsed leaves it collapsed", async () => {
    const w = await world();
    await w.waitingJob("first");
    await w.pageLoaded();
    await w.waitingJob("second");
    w.failedJob("It broke.");
    expect(w.last()).toMatchObject({ expanded: false, label: "2 need you" });
  });

  it("the idle timer runs off the controller's tick: open, pointer leaves, ten seconds, closed", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onHover(true);
    w.controller.onExpand(true);
    w.controller.onHover(false);
    w.clock.now += IDLE_COLLAPSE_MS - 1;
    w.controller.tick();
    expect(w.last()?.expanded).toBe(true);
    w.clock.now += 1;
    w.controller.tick();
    expect(w.last()?.expanded).toBe(false);
  });

  it("a re-enter through the controller cancels it", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onHover(true);
    w.controller.onExpand(true);
    w.controller.onHover(false);
    w.clock.now += 9_000;
    w.controller.onHover(true);
    w.clock.now += 60_000;
    w.controller.tick();
    expect(w.last()?.expanded).toBe(true);
  });

  it("THE OS POINTER CORRECTS A MISSED mouseleave: the page said 'inside' and never said otherwise", async () => {
    let over = true;
    const w = await world({ pointerOver: () => over });
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onHover(true);
    w.controller.onExpand(true);
    over = false; // the pointer left; the window was resizing and no mouseleave arrived
    w.controller.tick(); // the tick notices, and the ten seconds start
    w.clock.now += IDLE_COLLAPSE_MS;
    w.controller.tick();
    expect(w.last()?.expanded).toBe(false);
  });

  it("drops a hover or a height that is not what it should be", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onExpand(true);
    const before = JSON.stringify(w.last());
    for (const bad of ["yes", 1, null, undefined, {}]) w.controller.onHover(bad);
    for (const bad of ["300", -1, 0, Number.NaN, 1e9, null]) w.controller.onContentHeight(bad);
    expect(JSON.stringify(w.last())).toBe(before);
  });

  it("the window is resized to the measured content and its bottom-right corner never moves", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    const anchor = [w.workArea.width - 16, w.workArea.height - 16];
    expect(w.corner()).toEqual(anchor);
    expect(w.fake.bounds.at(-1)).toMatchObject({ ...PILL_COLLAPSED });

    w.controller.onExpand(true);
    expect(w.corner()).toEqual(anchor);
    const estimated = w.fake.bounds.at(-1)?.height;

    w.controller.onContentHeight(263); // the page measured a long, wrapped message
    expect(w.fake.bounds.at(-1)).toMatchObject({ width: 348, height: 263 });
    expect(w.fake.bounds.at(-1)?.height).not.toBe(estimated);
    expect(w.corner()).toEqual(anchor);
    // The page is sent the height main used, so it does not report the same one again.
    expect(w.last()?.contentHeight).toBe(263);

    w.controller.collapse();
    expect(w.fake.bounds.at(-1)).toMatchObject({ ...PILL_COLLAPSED });
    expect(w.corner()).toEqual(anchor);
  });

  it("NOT PERSISTED: opening the list writes nothing to settings, and a new controller over the same settings starts collapsed", async () => {
    const w = await world();
    await w.waitingJob();
    await w.pageLoaded();
    const writes: string[] = [];
    const set = w.settings.set.bind(w.settings);
    w.settings.set = (key: string, value: string): void => {
      writes.push(key);
      set(key, value);
    };
    w.controller.onExpand(true);
    w.controller.onHover(false);
    w.controller.onContentHeight(250);
    expect(writes).toEqual([]);

    // "Restart": a second controller, same settings store, same job records.
    const views: PillView[] = [];
    new PillController({
      manager: w.manager,
      settings: w.settings,
      surface: { render: (view) => void views.push(view) },
      playChime: () => undefined,
      isBusy: () => false,
      now: () => w.clock.now,
    });
    expect(views.at(-1)).toMatchObject({ mode: "needs-you", expanded: false });
  });
});

describe("THE REAL WIRING: an accepted hotkey press collapses an open pill", () => {
  // main.ts's own composition: the hotkey handlers' `detach` hook is `startingSomethingElse`,
  // which detaches the attached job AND collapses the pill.
  async function wired(options: { confirmPending?: boolean } = {}) {
    const w = await world();
    const startingSomethingElse = createStartingSomethingElse({ jobs: w.manager, pill: () => w.controller });
    const events: string[] = [];
    const press = createOnInstructionHotkey({
      shell: {
        isConfirmPending: () => options.confirmPending === true,
        isAskPending: () => false,
        focusAsk: () => undefined,
        narrate: (text) => void events.push(`narrate:${text}`),
        showInput: () => {
          events.push("showInput");
          return Promise.resolve("");
        },
        clearPointer: () => undefined,
        snapshotPointTarget: () => Promise.resolve(),
      },
      dictation: null,
      voice: null,
      speech: null,
      chain: { isRunning: () => w.manager.attachedBlocks() },
      detach: startingSomethingElse,
      runInstruction: () => Promise.resolve(),
    });
    return { w, press, events, startingSomethingElse };
  }

  it("the instruction hotkey: list open -> press -> list closed, and the bar opens", async () => {
    const { w, press, events } = await wired();
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onExpand(true);
    expect(w.last()?.expanded).toBe(true);

    press();
    await w.flush();
    expect(w.last()?.expanded).toBe(false);
    expect(events).toContain("showInput");
    // And it stays closed for the instruction that follows and the job it becomes.
    await w.waitingJob("the next instruction");
    expect(w.last()).toMatchObject({ expanded: false, label: "2 need you" });
  });

  it("a BLOCKED press changes nothing: with a confirm waiting, the list stays as it was", async () => {
    const { w, press, events } = await wired({ confirmPending: true });
    await w.waitingJob();
    await w.pageLoaded();
    w.controller.onExpand(true);
    press();
    await w.flush();
    expect(events.some((event) => event.startsWith("narrate:"))).toBe(true);
    expect(w.last()?.expanded).toBe(true);
  });

  it("the dictation hotkey collapses it too, and a blocked one does not", async () => {
    const { w, startingSomethingElse } = await wired();
    await w.waitingJob();
    await w.pageLoaded();
    let busy = "capturing";
    const dictate = createOnDictateHotkey({ begin: () => Promise.resolve() }, { getState: () => busy }, startingSomethingElse);

    w.controller.onExpand(true);
    dictate(); // blocked: the bar is mid-capture
    expect(w.last()?.expanded).toBe(true);

    busy = "idle";
    dictate();
    expect(w.last()?.expanded).toBe(false);
  });

  it("the same press still detaches the job that had the bar", async () => {
    const { w, press } = await wired();
    const attached = w.manager.submit("summarize this");
    await w.manager.gateFor(attached).admit({ tools: ["summarize"], statusOnly: false });
    press();
    await w.flush();
    expect(w.manager.get(attached)).toMatchObject({ attached: false, background: true });
  });

  it("before the pill exists there is nothing to collapse, and the press is unharmed", () => {
    const manager = new JobManager({ store: new InMemoryJobStore() });
    const starting = createStartingSomethingElse({ jobs: manager, pill: () => null });
    expect(() => starting()).not.toThrow();
  });
});
