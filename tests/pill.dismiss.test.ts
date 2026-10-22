import { describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { LIST_CAP } from "../src/core/jobs/pill.ts";
import type { PillView } from "../src/core/jobs/pill.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import { PillController } from "../src/main/pill/PillController.ts";

// M27, fix A: Dismiss — and Cancel on a row that is not the last — no longer close the list.
// It stays open while anything is still listed and closes when the last row goes. Review… and
// Resume still close it (a dialog or the screen is about to need the user). And "Dismiss all"
// beside the chime toggle clears the listed done, failed and expired rows, and nothing else.
//
// M26's first live finding: every row button that took effect closed the list (2026-10-13, so
// it was out of the way of Review…'s dialog), so clearing several done jobs meant reopening the
// pill for each one.

const T0 = 7_000_000_000;

function world() {
  const clock = { now: T0 };
  const store = new InMemoryJobStore();
  let n = 0;
  const newId = (): string => `job${(n += 1)}`;
  // Is the user free for a job to take the screen? False: every Resume is refused as busy.
  const user = { free: true };
  const foregroundFree = (): boolean => user.free;
  let manager = new JobManager({ store, now: () => clock.now, newId, foregroundFree });

  // Jobs that are INTERRUPTED: left running in the background when the app "closed", and
  // brought back by a fresh manager on the same store — the only way a job becomes one.
  const interruptedByRestart = (count: number): string[] => {
    const ids = Array.from({ length: count }, () => {
      const id = manager.submit("post the notes");
      manager.detachAttached("hotkey");
      return id;
    });
    manager = new JobManager({ store, now: () => clock.now, newId, foregroundFree });
    manager.restore();
    return ids;
  };

  const views: PillView[] = [];
  const lines: string[] = [];
  let controller: PillController | null = null;
  const start = (): PillController => {
    controller = new PillController({
      manager,
      settings: new InMemorySettings(),
      surface: { render: (view) => void views.push(view) },
      playChime: () => undefined,
      isBusy: () => false,
      log: (line) => void lines.push(line),
      now: () => clock.now,
    });
    return controller;
  };

  const running = (instruction = "summarize this"): string => {
    const id = manager.submit(instruction);
    manager.detachAttached("hotkey");
    clock.now += 1;
    return id;
  };
  const ended = (state: "done" | "failed", result = "A result."): string => {
    const id = running();
    manager.finish(id, state, result);
    return id;
  };
  const waiting = async (foregroundOnly = false): Promise<string> => {
    const id = running(foregroundOnly ? "add to my page" : "send these notes");
    const gate = manager.gateFor(id);
    const tool = foregroundOnly ? "addToPage" : "sendMessage";
    await gate.admit({ tools: [tool], statusOnly: false });
    if (foregroundOnly) {
      void gate.enterStep({ tool, index: 1, total: 1, foregroundOnly: true });
    } else {
      await gate.enterStep({ tool, index: 1, total: 1, foregroundOnly: false });
      void gate.beforeConfirm();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return id;
  };
  const expired = async (): Promise<string> => {
    const id = await waiting();
    clock.now += 30 * 60 * 1000;
    manager.expireDue();
    return id;
  };

  return {
    clock,
    user,
    get manager() {
      return manager;
    },
    get controller(): PillController {
      if (controller === null) throw new Error("start() the controller first");
      return controller;
    },
    views,
    lines,
    start,
    running,
    ended,
    waiting,
    expired,
    interruptedByRestart,
    listed: (): string[] => (controller?.view().items ?? []).map((item) => item.id),
    open: (): boolean => controller?.view().expanded ?? false,
  };
}

describe("Dismiss and Cancel keep the list open while anything is listed (M27)", () => {
  it("THE LIVE FINDING: dismiss one of four and the list stays open, all the way down to the last", () => {
    const w = world();
    const ids = [w.ended("done"), w.ended("done"), w.ended("done"), w.ended("done")];
    w.start().onExpand(true);
    expect(w.listed()).toHaveLength(4);

    for (const [index, id] of ids.slice(0, 3).entries()) {
      w.controller.onAction(id, "dismiss");
      expect(w.manager.get(id)?.acknowledged).toBe(true);
      // Still open, with the rest still in it.
      expect(w.open(), `after dismissing ${index + 1}`).toBe(true);
      expect(w.listed()).toEqual(ids.slice(index + 1));
    }
  });

  it("dismissing the LAST row closes it — there is nothing left to show", () => {
    const w = world();
    const id = w.ended("done");
    w.start().onExpand(true);
    w.controller.onAction(id, "dismiss");
    expect(w.open()).toBe(false);
    expect(w.controller.view().mode).toBe("hidden");
    expect(w.lines.some((line) => line.endsWith("list CLOSED: nothing left to show"))).toBe(true);
  });

  it("closed by its last row, it comes back COLLAPSED for the next job", () => {
    const w = world();
    const id = w.ended("failed", "It broke.");
    w.start().onExpand(true);
    w.controller.onAction(id, "dismiss");
    w.running("the next instruction");
    expect(w.controller.view()).toMatchObject({ mode: "running", expanded: false });
  });

  it("Cancel on a row that is NOT the last leaves it open, and the cancelled row goes", async () => {
    const w = world();
    const done = w.ended("done");
    const id = await w.waiting();
    w.start().onExpand(true);
    w.controller.onAction(id, "cancel");
    expect(w.manager.get(id)?.state).toBe("cancelled");
    expect(w.open()).toBe(true);
    expect(w.listed()).toEqual([done]);
  });

  // RE-JUSTIFIED FROM pill.collapse.test.ts's "a row's cancel button closes it", which had one job
  // and so could not tell "Cancel closes the list" (M23) from "the last row went" (M27).
  it("Cancel on the LAST row closes it, because the row goes", async () => {
    const w = world();
    const id = await w.waiting();
    w.start().onExpand(true);
    expect(w.listed()).toEqual([id]); // the precondition: it is the only row
    w.controller.onAction(id, "cancel");
    expect(w.open()).toBe(false);
  });

  // A job mid-step cannot be stopped mid-step (§5c): its row stays, running, until the step ends
  // — so the list does too, and it closes when the row goes.
  it("Cancel on the only row while it is mid-step: the row stays until the step ends, then the list closes", () => {
    const w = world();
    const id = w.running();
    w.start().onExpand(true);
    w.controller.onAction(id, "cancel");
    expect(w.manager.get(id)?.state).toBe("running");
    expect(w.open()).toBe(true);
    w.manager.finish(id, "cancelled", null);
    expect(w.open()).toBe(false);
  });

  it("Review… still closes it, even with other rows listed — its dialog needs the screen", async () => {
    const w = world();
    w.ended("done");
    w.ended("failed", "It broke.");
    const id = await w.waiting();
    w.start().onExpand(true);
    w.controller.onAction(id, "review");
    expect(w.listed().length).toBeGreaterThan(1); // still things listed: it closed on purpose
    expect(w.open()).toBe(false);
  });

  it("Resume still closes it, even with other rows listed", async () => {
    const w = world();
    w.ended("done");
    const id = await w.waiting(true);
    w.start().onExpand(true);
    w.controller.onAction(id, "resume");
    expect(w.manager.isAttached(id)).toBe(true);
    expect(w.listed().length).toBeGreaterThan(0);
    expect(w.open()).toBe(false);
  });

  it("a DROPPED press changes nothing: not offered, no such row, no such action — open stays open, no job changes", async () => {
    const w = world();
    const done = w.ended("done");
    const id = await w.waiting();
    w.start().onExpand(true);
    const before = JSON.stringify(w.manager.views());
    w.controller.onAction(id, "dismiss"); // not offered while waiting
    w.controller.onAction(done, "cancel"); // not offered once ended
    w.controller.onAction("nope", "dismiss");
    w.controller.onAction(done, "approve");
    w.controller.onAction(42, "dismiss");
    expect(JSON.stringify(w.manager.views())).toBe(before);
    expect(w.open()).toBe(true);
  });

  it("a REFUSED Resume (the user is busy) changes nothing and leaves it open, as before", async () => {
    const w = world();
    const done = w.ended("done");
    const id = await w.waiting(true);
    w.start().onExpand(true);
    w.user.free = false;
    const before = JSON.stringify(w.manager.views());
    w.controller.onAction(id, "resume");
    expect(JSON.stringify(w.manager.views())).toBe(before);
    expect(w.manager.get(id)?.state).toBe("needs-you");
    expect(w.open()).toBe(true);
    expect(w.listed().sort()).toEqual([done, id].sort());
    // The contrast: the same press once the user is free does resume, and closes it.
    w.user.free = true;
    w.controller.onAction(id, "resume");
    expect(w.open()).toBe(false);
  });
});

describe("Dismiss all (M27)", () => {
  it("is offered only while the list is open with a done, failed or expired row in it", async () => {
    const w = world();
    w.running();
    await w.waiting();
    w.interruptedByRestart(1);
    w.start();
    w.controller.onExpand(true);
    // Live and interrupted rows only: nothing for it to do, so no button.
    expect(w.controller.view().dismissAll).toBeUndefined();

    const v = world();
    v.ended("done");
    v.start();
    expect(v.controller.view().dismissAll).toBeUndefined(); // closed: no list, no button
    v.controller.onExpand(true);
    expect(v.controller.view().dismissAll).toBe(true);
  });

  it("CLEARS ONLY ENDED ROWS: done, failed and expired go; running, queued, needs-you and interrupted stay, and nothing is cancelled", async () => {
    const w = world();
    const [interrupted] = w.interruptedByRestart(1);
    const done = w.ended("done");
    const failed = w.ended("failed", "Slack said no.");
    const gone = await w.expired();
    const live = w.running();
    const wait = await w.waiting();
    w.start().onExpand(true);
    expect(w.controller.view().items.map((item) => item.state).sort()).toEqual(
      ["done", "expired", "failed", "interrupted", "needs-you", "running"],
    );

    w.controller.onDismissAll();

    for (const id of [done, failed, gone]) expect(w.manager.get(id)?.acknowledged, id).toBe(true);
    expect(w.manager.get(interrupted ?? "")).toMatchObject({ state: "interrupted", acknowledged: false });
    expect(w.manager.get(live)).toMatchObject({ state: "running", acknowledged: false });
    expect(w.manager.get(wait)).toMatchObject({ state: "needs-you", acknowledged: false });
    // Cancel was never asked for, of anything. Asked of the manager, not just read off the state:
    // a running job told to cancel stays "running" until its step ends (§5c), so its state alone
    // could not show a cancel had been requested.
    for (const id of [live, wait, interrupted ?? ""]) expect(w.manager.isCancelRequested(id), id).toBe(false);
    expect(w.lines.some((line) => line.includes('"cancel"'))).toBe(false);
    // The list stays open, with what is left.
    expect(w.open()).toBe(true);
    expect(w.listed().sort()).toEqual([interrupted, live, wait].sort());
    expect(w.controller.view().dismissAll).toBeUndefined();
  });

  it("with nothing left after it, the list closes", () => {
    const w = world();
    w.ended("done");
    w.ended("failed", "It broke.");
    w.start().onExpand(true);
    w.controller.onDismissAll();
    expect(w.controller.view()).toMatchObject({ mode: "hidden", expanded: false });
  });

  it("acts on the rows LISTED, not the jobs past the cap — those are listed next, and not dismissed", () => {
    const w = world();
    const ids = Array.from({ length: LIST_CAP + 2 }, () => w.ended("done"));
    w.start().onExpand(true);
    const listed = w.listed();
    expect(listed).toHaveLength(LIST_CAP);
    const unlisted = ids.filter((id) => !listed.includes(id));
    expect(unlisted).toHaveLength(2);

    w.controller.onDismissAll();
    for (const id of listed) expect(w.manager.get(id)?.acknowledged).toBe(true);
    for (const id of unlisted) expect(w.manager.get(id)?.acknowledged, id).toBe(false);
    expect(w.open()).toBe(true);
    expect(w.listed().sort()).toEqual(unlisted.sort());
  });

  it("a DROPPED press changes nothing: with the list closed, or with nothing ended listed", async () => {
    const w = world();
    const done = w.ended("done");
    await w.waiting();
    w.start();
    const drawn = w.views.length;
    w.controller.onDismissAll(); // the list is closed
    expect(w.manager.get(done)?.acknowledged).toBe(false);
    expect(w.views.length).toBe(drawn);
    expect(w.lines.at(-1)).toMatch(/dismiss all" dropped: not offered \(the list is closed\)/);

    const v = world();
    await v.waiting();
    v.running();
    v.start().onExpand(true);
    const before = JSON.stringify(v.manager.views());
    v.controller.onDismissAll(); // open, but nothing ended in it
    expect(JSON.stringify(v.manager.views())).toBe(before);
    expect(v.open()).toBe(true);
    expect(v.lines.at(-1)).toMatch(/dismiss all" dropped: not offered \(nothing ended is listed\)/);
  });

  it("goes through the controller's view, not the page: a row that ended AFTER the list was drawn is still checked", async () => {
    const w = world();
    const done = w.ended("done");
    const id = await w.waiting();
    w.start().onExpand(true);
    // The waiting job is cancelled elsewhere between the draw and the press — it is not listed
    // any more (cancelled is never shown), so the press covers only what is listed now.
    w.manager.cancel(id);
    w.controller.onDismissAll();
    expect(w.manager.get(done)?.acknowledged).toBe(true);
    expect(w.manager.get(id)).toMatchObject({ state: "cancelled", acknowledged: false });
  });
});

describe("a cancelled job shows Cancelling until its step ends (M27)", () => {
  // A detached job inside step 1 of 2, as the planner would leave it mid-handler.
  const midStep = async (w: ReturnType<typeof world>) => {
    const id = w.running("summarize then post");
    const gate = w.manager.gateFor(id);
    await gate.admit({ tools: ["summarize", "sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "summarize", index: 1, total: 2, foregroundOnly: false });
    return { id, gate };
  };
  const row = (w: ReturnType<typeof world>, id: string) => w.controller.view().items.find((item) => item.id === id);

  it("THE CONTRAST: a job nobody cancelled says Running and offers Cancel", async () => {
    const w = world();
    const { id } = await midStep(w);
    w.start().onExpand(true);
    expect(row(w, id)).toMatchObject({ detail: "Running — Step 1 of 2 · summarize", actions: ["cancel"] });
    expect(w.manager.get(id)?.cancelRequested).toBe(false);
  });

  it("Cancel mid-step: the row says 'Cancelling — finishing step 1 of 2' and offers no second Cancel; the label and the list are otherwise unchanged", async () => {
    const w = world();
    const done = w.ended("done");
    const { id } = await midStep(w);
    w.start().onExpand(true);
    const before = w.controller.view();
    w.controller.onAction(id, "cancel");

    // Still running — a handler cannot be un-called — and the view says a cancel is pending.
    expect(w.manager.get(id)).toMatchObject({ state: "running", cancelRequested: true });
    expect(row(w, id)).toMatchObject({ state: "running", detail: "Cancelling — finishing step 1 of 2", actions: [] });
    // Otherwise unchanged: same label, same mode, same rows, the done one untouched, still open.
    const after = w.controller.view();
    expect(after.label).toBe(before.label);
    expect(after.label).toBe("1 running · 1 done");
    expect(after.mode).toBe(before.mode);
    expect(after.items.map((item) => item.id).sort()).toEqual([done, id].sort());
    expect(row(w, done)).toEqual(before.items.find((item) => item.id === done));
    expect(w.open()).toBe(true);
  });

  it("a second Cancel press on a cancelling row is DROPPED: not offered, nothing changes", async () => {
    const w = world();
    const { id } = await midStep(w);
    w.start().onExpand(true);
    w.controller.onAction(id, "cancel");
    const viewsBefore = JSON.stringify(w.manager.views());
    w.controller.onAction(id, "cancel");
    expect(JSON.stringify(w.manager.views())).toBe(viewsBefore);
    expect(w.lines.at(-1)).toMatch(/action dropped: "cancel" is not offered by this row \(running\)/);
  });

  it("when the step ends, the job stops before the next one and leaves the pill — the list closes with its last row", async () => {
    const w = world();
    const { id, gate } = await midStep(w);
    w.start().onExpand(true);
    w.controller.onAction(id, "cancel");
    // The planner asks to enter step 2 and is told no; the job runner then ends it as cancelled.
    await expect(gate.enterStep({ tool: "sendMessage", index: 2, total: 2, foregroundOnly: false })).resolves.toBe("cancelled");
    w.manager.finish(id, "cancelled", null);
    expect(w.manager.get(id)?.state).toBe("cancelled");
    expect(row(w, id)).toBeUndefined();
    expect(w.open()).toBe(false);
  });

  it("cancelled while still PLANNING (no step yet): 'Cancelling — stops before its first step', and it never enters one", async () => {
    const w = world();
    const id = w.running("summarize this");
    w.start().onExpand(true);
    w.controller.onAction(id, "cancel");
    expect(row(w, id)).toMatchObject({ detail: "Cancelling — stops before its first step", actions: [] });
    await expect(w.manager.gateFor(id).admit({ tools: ["summarize"], statusOnly: false })).resolves.toBe("cancelled");
  });

  it("a waiting job cancels at once and is never shown as Cancelling", async () => {
    const w = world();
    w.ended("done");
    const id = await w.waiting();
    w.start().onExpand(true);
    const drawn: string[] = [];
    const watch = w.views.length;
    w.controller.onAction(id, "cancel");
    for (const view of w.views.slice(watch)) for (const item of view.items) drawn.push(item.detail);
    expect(drawn.some((detail) => detail.startsWith("Cancelling"))).toBe(false);
    expect(w.manager.get(id)?.state).toBe("cancelled");
    expect(row(w, id)).toBeUndefined();
  });
});
