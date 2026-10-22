import { describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import type { JobView } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { FOREGROUND_BUSY } from "../src/core/jobs/messages.ts";
import {
  initialPillState,
  PILL_COLLAPSED,
  PILL_MARGIN,
  pillBounds,
  pillSize,
  pillView,
  PULSE_MS,
  reducePill,
} from "../src/core/jobs/pill.ts";
import type { PillState, PillView } from "../src/core/jobs/pill.ts";
import { CHIME_MUTED, InMemorySettings, readFlag } from "../src/core/settings.ts";
import { PillController } from "../src/main/pill/PillController.ts";
import { PILL_WINDOW_OPTIONS, PillWindow } from "../src/main/pill/PillWindow.ts";
import type { PillBrowserWindow, PillWindowOptions } from "../src/main/pill/PillWindow.ts";

// The status pill (M23): what it shows, where it goes, how its window is built, and what its
// buttons may do. Everything here is decided in code that imports no electron, so all of it is
// asserted against plain data and a fake window.

const T0 = 1_000_000;

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
  ...over,
});

const withJobs = (jobs: JobView[], now = T0, from: PillState = initialPillState(false, T0)): PillState =>
  reducePill(from, { type: "jobs", jobs, now });

describe("the pill's state reducer", () => {
  it("nothing to show: hidden", () => {
    expect(pillView(initialPillState(false, T0))).toMatchObject({ mode: "hidden", items: [], pulse: false });
  });

  it("running(count)", () => {
    const view = pillView(withJobs([job("running"), job("running"), job("queued")]));
    expect(view).toMatchObject({ mode: "running", label: "3 running" });
  });

  // RE-JUSTIFIED AT M27. It pinned "1 needs you" for all four groups: under M23's rule the
  // label was the top group alone. Now "outranks" means the COLOUR and the label's FIRST place;
  // every other group is still counted after it, in order.
  it("needs-you is amber and outranks everything else: its colour, and first in the label", () => {
    const view = pillView(withJobs([job("running"), job("failed"), job("needs-you"), job("done")]));
    expect(view).toMatchObject({ mode: "needs-you", label: "1 needs you · 1 didn't finish · 1 running · 1 done" });
    expect(pillView(withJobs([job("needs-you"), job("needs-you")])).label).toBe("2 need you");
  });

  // Title corrected when the rule changed: it stays while UNSEEN (this job never is), not
  // "until acknowledged" — once seen it also clears after an hour (tests/pill.lifecycle.test.ts).
  // RE-JUSTIFIED AT M27: it pinned "1 didn't finish" with a job running beside it; the running
  // job is now counted too, after the failure, and the colour is still the failure's.
  it("failed outranks running, and an unseen one stays however long that takes; a dismissed one is gone", () => {
    const failed = job("failed", { result: "Slack said no." });
    const state = withJobs([failed, job("running")]);
    expect(pillView(state)).toMatchObject({ mode: "failed", label: "1 didn't finish · 1 running" });
    const muchLater = reducePill(state, { type: "tick", now: T0 + 6 * 60 * 60 * 1000 });
    expect(pillView(muchLater).mode).toBe("failed");
    // Acknowledged: gone.
    expect(pillView(withJobs([{ ...failed, acknowledged: true }])).mode).toBe("hidden");
  });

  it("interrupted and expired are shown like failures: each is something that did not happen", () => {
    expect(pillView(withJobs([job("interrupted")])).mode).toBe("failed");
    expect(pillView(withJobs([job("expired")])).mode).toBe("failed");
    expect(pillView(withJobs([job("expired"), job("interrupted")])).label).toBe("2 didn't finish");
  });

  // RE-JUSTIFIED AT M26. Was "done fades: shown, then gone, with no click" (8 s). A done job now
  // waits to be seen: with no click it stays, labelled with how many there are.
  it("done stays until seen: no click, and it is still there long after", () => {
    const state = withJobs([job("done", { result: "Sent." })]);
    expect(pillView(state)).toMatchObject({ mode: "done", label: "1 done" });
    const later = reducePill(state, { type: "tick", now: T0 + 24 * 60 * 60 * 1000 });
    expect(pillView(later)).toMatchObject({ mode: "done", label: "1 done" });
  });

  // The rule changed (it used to fade like a finished job): the user cancelled it themselves,
  // so there is nothing to tell them. tests/pill.lifecycle.test.ts has every state's rule.
  it("a job the user cancelled is not shown at all, not even for the done-fade", () => {
    expect(pillView(withJobs([job("cancelled")])).mode).toBe("hidden");
    // The contrast, so "hidden" above is the rule and not an empty harness: done IS shown.
    expect(pillView(withJobs([job("done")])).mode).toBe("done");
  });

  it("never shows a status question, an attached-only job, or a dismissed one", () => {
    const view = pillView(
      withJobs([
        job("running", { kind: "status" }),
        job("running", { background: false, attached: true }),
        job("failed", { acknowledged: true }),
      ]),
    );
    expect(view.mode).toBe("hidden");
  });

  it("PULSES when a job starts waiting, then holds steady amber", () => {
    const waiting = job("needs-you");
    const state = withJobs([waiting]);
    expect(pillView(state)).toMatchObject({ mode: "needs-you", pulse: true });

    const during = reducePill(state, { type: "tick", now: T0 + PULSE_MS - 1 });
    expect(pillView(during).pulse).toBe(true);
    const after = reducePill(state, { type: "tick", now: T0 + PULSE_MS });
    expect(pillView(after)).toMatchObject({ mode: "needs-you", pulse: false });
  });

  it("does not pulse again because the same waiting job was re-sent", () => {
    const waiting = job("needs-you");
    let state = withJobs([waiting]);
    state = reducePill(state, { type: "tick", now: T0 + PULSE_MS });
    state = reducePill(state, { type: "jobs", jobs: [{ ...waiting, lines: ["a new line"] }], now: T0 + PULSE_MS + 50 });
    expect(pillView(state).pulse).toBe(false);
  });

  it("pulses again when a SECOND job starts waiting", () => {
    const first = job("needs-you");
    let state = withJobs([first]);
    state = reducePill(state, { type: "tick", now: T0 + 10_000 });
    expect(pillView(state).pulse).toBe(false);
    state = reducePill(state, { type: "jobs", jobs: [first, job("needs-you")], now: T0 + 10_000 });
    expect(pillView(state).pulse).toBe(true);
  });

  it("a pulse does not outlive the wait it was for", () => {
    const waiting = job("needs-you");
    let state = withJobs([waiting]);
    state = reducePill(state, { type: "jobs", jobs: [{ ...waiting, state: "running", waitingFor: null }], now: T0 + 100 });
    expect(pillView(state)).toMatchObject({ mode: "running", pulse: false });
  });

  it("rows: waiting first, then what did not finish, then the rest — each with only its own buttons", () => {
    const view = pillView(
      withJobs([
        job("running", { id: "run", tool: "summarize", step: 1, total: 2 }),
        job("failed", { id: "fail", result: "Slack said no." }),
        job("needs-you", { id: "ok", waitingFor: "confirm", step: 2, total: 3 }),
        job("needs-you", { id: "screen", waitingFor: "foreground-only", tool: "addToPage" }),
        job("queued", { id: "q" }),
        job("done", { id: "done", result: "Sent." }),
      ]),
    );
    expect(view.items.map((item) => [item.id, item.actions])).toEqual([
      ["ok", ["review", "cancel"]],
      ["screen", ["resume", "cancel"]],
      ["fail", ["dismiss"]],
      ["run", ["cancel"]],
      ["q", ["cancel"]],
      ["done", ["dismiss"]],
    ]);
    const detail = Object.fromEntries(view.items.map((item) => [item.id, item.detail]));
    expect(detail["ok"]).toBe("Needs your OK — Step 2 of 3 · sendMessage");
    expect(detail["screen"]).toBe("Needs you at the screen — addToPage");
    expect(detail["fail"]).toBe("Slack said no.");
    expect(detail["run"]).toBe("Running — Step 1 of 2 · summarize");
    expect(detail["q"]).toBe("Queued — starts when a running job finishes");
  });

  it("no row ever offers an 'approve': the only way to a yes is the dialog 'review' opens", () => {
    const view = pillView(withJobs([job("needs-you"), job("running"), job("failed"), job("done"), job("queued")]));
    const offered = new Set(view.items.flatMap((item) => item.actions));
    expect([...offered].sort()).toEqual(["cancel", "dismiss", "review"]);
  });

  // RE-JUSTIFIED when the rule changed (the list must always start collapsed). This test used
  // to be titled "expand and mute are remembered", and it stopped at "a hidden pill is not
  // drawn expanded" — which was true while the flag underneath stayed set, so the pill came
  // back OPEN for the next job. It now asserts the flag itself is gone. Mute IS remembered;
  // the list being open is not. The full set of rules is in tests/pill.collapse.test.ts.
  it("mute is remembered; the open list is not — when the pill empties, it is closed for good", () => {
    let state = withJobs([job("running")]);
    state = reducePill(state, { type: "expand", expanded: true, now: T0 });
    state = reducePill(state, { type: "mute", muted: true });
    expect(pillView(state)).toMatchObject({ expanded: true, muted: true });
    state = reducePill(state, { type: "jobs", jobs: [], now: T0 });
    expect(pillView(state)).toMatchObject({ mode: "hidden", expanded: false, muted: true });
    expect(state.expanded).toBe(false);
    // The next job arrives: the pill is back, and it is collapsed.
    state = reducePill(state, { type: "jobs", jobs: [job("running")], now: T0 + 1000 });
    expect(pillView(state)).toMatchObject({ mode: "running", expanded: false });
  });

  it("titles are one short line; details are one line of up to 420 characters", () => {
    const view = pillView(
      withJobs([job("failed", { instruction: `a\nvery ${"long ".repeat(40)}instruction`, result: "x".repeat(900) })]),
    );
    expect(view.items[0]?.title.length).toBeLessThanOrEqual(64);
    expect(view.items[0]?.title).not.toContain("\n");
    expect(view.items[0]?.detail.length).toBeLessThanOrEqual(420);
  });
});

describe("pillBounds — bottom-right of the work area, in DIP", () => {
  const size = { width: 232, height: 44 };

  it("sits in the bottom-right corner, inset by the margin", () => {
    // A 1920x1080 panel at 100%: the work area is the screen minus a 48px taskbar.
    expect(pillBounds({ x: 0, y: 0, width: 1920, height: 1032 }, size)).toEqual({
      x: 1920 - 232 - PILL_MARGIN,
      y: 1032 - 44 - PILL_MARGIN,
      width: 232,
      height: 44,
    });
  });

  it("ACROSS SCALE FACTORS: the same panel at 100%, 125%, 150% and 200% is four different work areas, and each is answered in its own DIP", () => {
    // What electron reports for a 1920x1080 panel with a 48 DIP taskbar at each scale. This
    // machine is the 150% row (1280x720 DIP), measured in M15's recon.
    const panels = [
      { scale: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 } },
      { scale: 1.25, workArea: { x: 0, y: 0, width: 1536, height: 816 } },
      { scale: 1.5, workArea: { x: 0, y: 0, width: 1280, height: 672 } },
      { scale: 2, workArea: { x: 0, y: 0, width: 960, height: 492 } },
    ];
    for (const { scale, workArea } of panels) {
      const bounds = pillBounds(workArea, size);
      // Flush to the corner in DIP on every one of them...
      expect(bounds.x + bounds.width + PILL_MARGIN, `scale ${scale}`).toBe(workArea.width);
      expect(bounds.y + bounds.height + PILL_MARGIN, `scale ${scale}`).toBe(workArea.height);
      // ...and the pill is the same DIP size at every scale: nothing multiplied it.
      expect(bounds.width).toBe(232);
      expect(bounds.height).toBe(44);
    }
  });

  it("takes no scale factor at all — there is no parameter to pass one in", () => {
    expect(pillBounds.length).toBeLessThanOrEqual(2); // workArea, size (+ a defaulted margin)
  });

  it("A SECOND MONITOR to the right: the work area's origin is carried through", () => {
    const second = { x: 1280, y: 0, width: 2560, height: 1400 };
    expect(pillBounds(second, size)).toEqual({
      x: 1280 + 2560 - 232 - PILL_MARGIN,
      y: 1400 - 44 - PILL_MARGIN,
      width: 232,
      height: 44,
    });
  });

  it("a second monitor to the LEFT and ABOVE: negative origins stay on that display", () => {
    const left = { x: -1920, y: -200, width: 1920, height: 1040 };
    const bounds = pillBounds(left, size);
    expect(bounds).toEqual({ x: -1920 + 1920 - 232 - 16, y: -200 + 1040 - 44 - 16, width: 232, height: 44 });
    // Entirely inside the display it was asked about.
    expect(bounds.x).toBeGreaterThanOrEqual(left.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(left.x + left.width);
    expect(bounds.y).toBeGreaterThanOrEqual(left.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(left.y + left.height);
  });

  it("a taskbar on the left or top moves the work area's origin, and the pill follows it", () => {
    expect(pillBounds({ x: 62, y: 0, width: 1218, height: 720 }, size).x).toBe(62 + 1218 - 232 - 16);
    expect(pillBounds({ x: 0, y: 48, width: 1280, height: 672 }, size).y).toBe(48 + 672 - 44 - 16);
  });

  it("a pill larger than the work area is shrunk to fit, not hung over the edge", () => {
    const tiny = { x: 100, y: 100, width: 300, height: 200 };
    const bounds = pillBounds(tiny, { width: 348, height: 440 });
    expect(bounds).toEqual({ x: 116, y: 116, width: 268, height: 168 });
  });

  it("fractional work areas and sizes come out as whole pixels", () => {
    const bounds = pillBounds({ x: 0.5, y: 0.25, width: 1279.6, height: 671.7 }, { width: 232.4, height: 44.2 });
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true);
  });

  it("pillSize: collapsed is fixed; expanded grows with the rows and stops at a ceiling", () => {
    const row = { id: "a", title: "", state: "running", detail: "", actions: [] };
    expect(pillSize({ expanded: false, items: [row, row] })).toEqual({ ...PILL_COLLAPSED });
    const one = pillSize({ expanded: true, items: [row] });
    const three = pillSize({ expanded: true, items: [row, row, row] });
    expect(three.height).toBeGreaterThan(one.height);
    expect(pillSize({ expanded: true, items: Array(40).fill(row) }).height).toBe(440);
  });
});

// A fake BrowserWindow that records everything done to it, in order.
function fakeWindow() {
  const calls: string[] = [];
  const sent: { channel: string; args: unknown[] }[] = [];
  let visible = false;
  let destroyed = false;
  const win: PillBrowserWindow & { calls: string[]; sent: typeof sent; bounds: unknown[] } = {
    calls,
    sent,
    bounds: [],
    setContentProtection: (enable) => void calls.push(`setContentProtection(${enable})`),
    setBounds: (bounds) => {
      calls.push("setBounds");
      win.bounds.push(bounds);
    },
    showInactive: () => {
      calls.push("showInactive");
      visible = true;
    },
    hide: () => {
      calls.push("hide");
      visible = false;
    },
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroy: () => {
      calls.push("destroy");
      destroyed = true;
    },
    webContents: { send: (channel, ...args) => void sent.push({ channel, args }) },
  };
  return win;
}

const VIEW: PillView = { mode: "running", label: "1 running", pulse: false, expanded: false, muted: false, items: [] };
const WORK_AREA = { x: 0, y: 0, width: 1280, height: 672 };

function windowHarness() {
  const created: { options: PillWindowOptions; win: ReturnType<typeof fakeWindow> }[] = [];
  // ASYNC, like the real thing: `loadFile` resolves when the page has loaded, never in the
  // same tick. A synchronous fake could not tell "sent before the page existed" from "sent".
  let finishLoad: () => void = () => undefined;
  const pill = new PillWindow({
    create: (options) => {
      const win = fakeWindow();
      created.push({ options, win });
      return win;
    },
    load: () =>
      new Promise<void>((resolve) => {
        finishLoad = resolve;
      }),
    workArea: () => WORK_AREA,
  });
  const loaded = async (): Promise<void> => {
    finishLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { pill, created, loaded };
}

describe("the pill's window (a fake BrowserWindow)", () => {
  it("creates no window at all until there is something to show", () => {
    const { pill, created } = windowHarness();
    pill.render({ ...VIEW, mode: "hidden" });
    expect(created).toEqual([]);
    expect(pill.window()).toBeNull();
  });

  it("is created NON-FOCUSABLE, hidden, frameless, on top and off the taskbar", () => {
    const { pill, created } = windowHarness();
    pill.render(VIEW);
    expect(created[0]?.options).toEqual(PILL_WINDOW_OPTIONS);
    // Spelled out, so loosening any one of them fails here by name.
    expect(created[0]?.options.focusable).toBe(false);
    expect(created[0]?.options.show).toBe(false);
    expect(created[0]?.options.frame).toBe(false);
    expect(created[0]?.options.alwaysOnTop).toBe(true);
    expect(created[0]?.options.skipTaskbar).toBe(true);
    expect(created[0]?.options.resizable).toBe(false);
    expect(created[0]?.options.movable).toBe(false);
  });

  it("turns CONTENT PROTECTION on before anything is shown", () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    const win = created[0]?.win;
    expect(win?.calls[0]).toBe("setContentProtection(true)");
    return loaded().then(() => {
      const calls = win?.calls ?? [];
      expect(calls.indexOf("setContentProtection(true)")).toBeLessThan(calls.indexOf("showInactive"));
    });
  });

  it("is shown with showInactive and by no other means — the fake has no show() or focus() to call", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    await loaded();
    const win = created[0]?.win;
    expect(win?.calls.filter((call) => call === "showInactive")).toEqual(["showInactive"]);
    expect(win).not.toHaveProperty("show");
    expect(win).not.toHaveProperty("focus");
  });

  it("is not shown, and is sent nothing, until its page has loaded — then gets the LATEST view", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    pill.render({ ...VIEW, label: "2 running" });
    const win = created[0]?.win;
    expect(win?.sent).toEqual([]);
    expect(win?.isVisible()).toBe(false);

    await loaded();
    expect(win?.sent).toEqual([{ channel: "pill:view", args: [{ ...VIEW, label: "2 running" }] }]);
    expect(win?.isVisible()).toBe(true);
  });

  it("a view that went hidden while the page was loading never flashes up", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    pill.render({ ...VIEW, mode: "hidden" });
    await loaded();
    expect(created[0]?.win.calls).not.toContain("showInactive");
  });

  it("is placed with the pure position function, every time it is drawn", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    await loaded();
    pill.render({ ...VIEW, expanded: true, items: [{ id: "a", title: "t", state: "running", detail: "", actions: ["cancel"] }] });
    const win = created[0]?.win;
    expect(win?.bounds.at(0)).toEqual(pillBounds(WORK_AREA, PILL_COLLAPSED));
    expect(win?.bounds.at(-1)).toEqual(
      pillBounds(WORK_AREA, pillSize({ expanded: true, items: [{ id: "a", title: "t", state: "running", detail: "", actions: ["cancel"] }] })),
    );
  });

  it("hides when there is nothing to show, reuses the same window afterwards, and shows it inactive again", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    await loaded();
    pill.render({ ...VIEW, mode: "hidden" });
    expect(created[0]?.win.isVisible()).toBe(false);
    pill.render(VIEW);
    expect(created.length).toBe(1);
    expect(created[0]?.win.calls.filter((call) => call === "showInactive").length).toBe(2);
  });

  it("is the owner a detached dialog hangs off, and is destroyed on dispose", async () => {
    const { pill, created, loaded } = windowHarness();
    pill.render(VIEW);
    await loaded();
    expect(pill.window()).toBe(created[0]?.win);
    pill.dispose();
    expect(created[0]?.win.calls).toContain("destroy");
    expect(pill.window()).toBeNull();
  });
});

function controllerHarness(options: { muted?: boolean; busy?: () => boolean; foregroundFree?: () => boolean } = {}) {
  const clock = { now: T0 };
  const settings = new InMemorySettings();
  if (options.muted === true) settings.set(CHIME_MUTED, "1");
  let n = 0;
  const manager = new JobManager({
    store: new InMemoryJobStore(),
    now: () => clock.now,
    newId: () => `job${(n += 1)}`,
    ...(options.foregroundFree === undefined ? {} : { foregroundFree: options.foregroundFree }),
  });
  const views: PillView[] = [];
  const world = { chimes: 0 };
  const controller = new PillController({
    manager,
    settings,
    surface: { render: (view) => void views.push(view) },
    playChime: () => (world.chimes += 1),
    isBusy: options.busy ?? (() => false),
    now: () => clock.now,
  });
  // A background job parked at a confirm, the way the planner would park it.
  const waitingJob = async (reason: "confirm" | "foreground-only" = "confirm"): Promise<{ id: string; answer: { value: unknown } }> => {
    const id = manager.submit("send these notes");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    manager.detachAttached("hotkey");
    const answer: { value: unknown } = { value: "PENDING" };
    if (reason === "confirm") {
      await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
      void gate.beforeConfirm().then((value) => (answer.value = value));
    } else {
      void gate.enterStep({ tool: "addToPage", index: 1, total: 1, foregroundOnly: true }).then((value) => (answer.value = value));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { id, answer };
  };
  return { clock, settings, manager, views, world, controller, waitingJob, last: () => views[views.length - 1] };
}

describe("PillController — the pill's buttons, and the chime", () => {
  it("draws the job list as it changes, and nothing while nothing changes", async () => {
    const h = controllerHarness();
    await h.waitingJob();
    expect(h.last()).toMatchObject({ mode: "needs-you", label: "1 needs you" });
    const drawn = h.views.length;
    h.controller.tick();
    h.controller.tick();
    expect(h.views.length).toBe(drawn); // within the pulse: the view is identical, so no redraw
  });

  it("a job entering needs-you chimes once; the tick ends the pulse", async () => {
    const h = controllerHarness();
    await h.waitingJob();
    expect(h.world.chimes).toBe(1);
    expect(h.last()?.pulse).toBe(true);
    h.clock.now += PULSE_MS;
    h.controller.tick();
    expect(h.last()).toMatchObject({ mode: "needs-you", pulse: false });
    expect(h.world.chimes).toBe(1);
  });

  it("'review' lets the job go on to OPEN its dialog — it wakes the gate, and approves nothing", async () => {
    const h = controllerHarness();
    const { id, answer } = await h.waitingJob();
    h.controller.onAction(id, "review");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The planner is told "go, and you waited" — which makes it build the summary and ask the
    // shell for the dialog. Whether anything runs is still the dialog's answer.
    expect(answer.value).toEqual({ answer: "go", waited: true });
    expect(h.manager.takeConfirmPermit(id)).toBe("detached");
  });

  it("'cancel' stops a waiting job; 'dismiss' removes one that ended", async () => {
    const h = controllerHarness();
    const { id, answer } = await h.waitingJob();
    h.controller.onAction(id, "cancel");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answer.value).toEqual({ answer: "cancelled", waited: true });
    expect(h.manager.get(id)?.state).toBe("cancelled");
    // Cancelled by the user: it leaves the pill at once, with nothing to dismiss.
    expect(h.last()?.mode).toBe("hidden");

    // Dismiss is for a job that ended some other way.
    const failed = h.manager.submit("file this bug");
    h.manager.detachAttached("hotkey");
    h.manager.finish(failed, "failed", "It broke.");
    expect(h.last()?.mode).toBe("failed");
    h.controller.onAction(failed, "dismiss");
    expect(h.manager.get(failed)?.acknowledged).toBe(true);
    expect(h.last()?.mode).toBe("hidden");
  });

  it("drops anything the page should not be able to ask for", async () => {
    const h = controllerHarness();
    const { id, answer } = await h.waitingJob();
    const before = h.manager.get(id);
    for (const [rawId, rawAction] of [
      [id, "approve"], // there is no such action
      [id, "dismiss"], // not offered while it is waiting
      [id, "resume"], // this row offers "review", not "resume"
      ["no-such-job", "cancel"],
      [id, 42],
      [{ id }, "cancel"],
      [undefined, undefined],
    ] as const) {
      h.controller.onAction(rawId, rawAction);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.manager.get(id)).toEqual(before);
    expect(answer.value).toBe("PENDING");
    h.controller.onExpand("yes");
    h.controller.onMute(1);
    expect(h.last()).toMatchObject({ expanded: false, muted: false });
  });

  it("a stale click does nothing: the row no longer offers that action", async () => {
    const h = controllerHarness();
    const { id } = await h.waitingJob();
    h.controller.onAction(id, "review");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.manager.get(id)?.state).toBe("running");
    // A second click on "Review…" arriving late: the job is running now.
    h.controller.onAction(id, "review");
    expect(h.manager.get(id)?.state).toBe("running");
  });

  it("a foreground-only job cannot be resumed while the user is busy — and the pill says why, briefly", async () => {
    let free = false;
    const h = controllerHarness({ foregroundFree: () => free });
    const { id } = await h.waitingJob("foreground-only");
    h.controller.onAction(id, "resume");
    expect(h.manager.get(id)?.state).toBe("needs-you");
    expect(h.last()?.notice).toBe(FOREGROUND_BUSY);

    h.clock.now += 6_000;
    h.controller.tick();
    expect(h.last()?.notice ?? null).toBeNull();

    free = true;
    h.controller.onAction(id, "resume");
    expect(h.manager.get(id)).toMatchObject({ state: "running", attached: true });
  });

  it("the tick expires a wait that has gone on thirty minutes", async () => {
    const h = controllerHarness();
    const { id, answer } = await h.waitingJob();
    h.clock.now += 30 * 60 * 1000;
    h.controller.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.manager.get(id)?.state).toBe("expired");
    expect(answer.value).toEqual({ answer: "expired", waited: true });
    expect(h.last()).toMatchObject({ mode: "failed" });
  });

  it("MUTE is written to settings, starts from settings, and silences the chime", async () => {
    const h = controllerHarness();
    h.controller.onMute(true);
    expect(readFlag(h.settings, CHIME_MUTED)).toBe(true);
    await h.waitingJob();
    expect(h.world.chimes).toBe(0);
    expect(h.last()).toMatchObject({ muted: true, mode: "needs-you" }); // the pill still shows it

    // A new controller over the same settings — a restart — comes up muted.
    const restarted = controllerHarness({ muted: true });
    await restarted.waitingJob();
    expect(restarted.world.chimes).toBe(0);
    expect(restarted.last()?.muted).toBe(true);
  });

  it("the chime waits for the microphone, and the tick plays it once it is free", async () => {
    let busy = true;
    const h = controllerHarness({ busy: () => busy });
    await h.waitingJob();
    expect(h.world.chimes).toBe(0);
    h.controller.tick();
    expect(h.world.chimes).toBe(0);
    busy = false;
    h.controller.tick();
    expect(h.world.chimes).toBe(1);
    h.controller.tick();
    expect(h.world.chimes).toBe(1);
  });
});
