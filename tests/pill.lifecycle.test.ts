import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import type { JobView } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore, SqliteJobStore } from "../src/core/jobs/JobStore.ts";
import type { JobStore } from "../src/core/jobs/JobStore.ts";
import {
  DONE_SEEN_CLEAR_MS,
  initialPillState,
  LIST_CAP,
  pillView,
  reducePill,
  SEEN_CLEAR_MS,
} from "../src/core/jobs/pill.ts";
import type { PillState, PillView } from "../src/core/jobs/pill.ts";
import { createDatabase, migrate } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import { PillController } from "../src/main/pill/PillController.ts";

// HOW LONG EACH KIND OF JOB STAYS IN THE PILL, and the one-line-per-event log.
//
//   done          until the user has SEEN it, then one minute (M26 — it used to fade after 8 s)
//   cancelled     never shown
//   failed        until the user has SEEN it (the list open with it in it), then one hour
//   expired       the same
//   interrupted   until dismissed, and only then
//
// "Seen" is saved with the job. Leaving the pill deletes nothing. The clock is a variable: an
// hour is `clock.now += …`.

const T0 = 3_000_000_000;
const HOUR = 60 * 60 * 1000;

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
const at = (jobs: JobView[], now: number): PillState =>
  reducePill(initialPillState(false, T0), { type: "jobs", jobs, now });
const modeAt = (jobs: JobView[], now: number): string => pillView(at(jobs, now)).mode;

describe("the reducer: each state's lifecycle", () => {
  // RE-JUSTIFIED AT M26. Was "DONE fades after a few seconds (unchanged)" — 8 s, seen or not.
  // A done job now waits to be seen, like a failure, with a one-minute tail instead of an hour.
  it("DONE that nobody has seen stays — at 8 s, a minute, a day, a month", () => {
    const done = job("done", { result: "A summary." });
    for (const later of [8_000, 60_000, HOUR, 24 * HOUR, 30 * 24 * HOUR]) {
      expect(pillView(at([done], T0 + later)), `done after ${later} ms`).toMatchObject({ mode: "done", label: "1 done" });
    }
  });

  it("DONE, once SEEN: still shown just under a minute later, cleared at a minute", () => {
    const seen = job("done", { result: "A summary.", seenAt: T0 + 5_000 });
    expect(modeAt([seen], T0 + 5_000 + DONE_SEEN_CLEAR_MS - 1)).toBe("done");
    expect(modeAt([seen], T0 + 5_000 + DONE_SEEN_CLEAR_MS)).toBe("hidden");
    expect(DONE_SEEN_CLEAR_MS).toBe(60_000);
  });

  it("several done jobs are counted: '3 done'", () => {
    const three = [job("done"), job("done"), job("done")];
    expect(pillView(at(three, T0 + HOUR))).toMatchObject({ mode: "done", label: "3 done" });
    expect(pillView(at(three, T0 + HOUR)).items).toHaveLength(3);
  });

  it("a done job that was never detached (finished in the bar) never appears", () => {
    const attached = job("done", { attached: true, background: false, result: "Shown in the bar." });
    expect(modeAt([attached], T0)).toBe("hidden");
    expect(modeAt([attached], T0 + HOUR)).toBe("hidden");
  });

  // M26 must not move a failure onto the done job's minute, nor a done job onto the hour.
  it("seen together, a done job leaves at a minute and a failed one keeps its hour", () => {
    const done = job("done", { result: "A summary.", seenAt: T0 });
    const failed = job("failed", { result: "It did not happen.", seenAt: T0 });
    expect(pillView(at([done, failed], T0 + DONE_SEEN_CLEAR_MS - 1)).items.map((i) => i.id)).toEqual(
      expect.arrayContaining([done.id, failed.id]),
    );
    const afterMinute = pillView(at([done, failed], T0 + DONE_SEEN_CLEAR_MS));
    expect(afterMinute).toMatchObject({ mode: "failed", label: "1 didn't finish" });
    expect(afterMinute.items.map((i) => i.id)).toEqual([failed.id]);
    expect(modeAt([done, failed], T0 + HOUR)).toBe("hidden");
  });

  it("CANCELLED by the user is removed immediately — not shown even for an instant", () => {
    expect(modeAt([job("cancelled")], T0)).toBe("hidden");
    expect(pillView(at([job("cancelled"), job("running")], T0))).toMatchObject({ mode: "running", label: "1 running" });
  });

  it.each(["failed", "expired"] as const)(
    "%s that arrives while the list is closed stays, INDEFINITELY — a minute, a day, a month",
    (state) => {
      const stopped = job(state, { result: "It did not happen." });
      for (const later of [0, 60_000, HOUR, 24 * HOUR, 30 * 24 * HOUR]) {
        expect(pillView(at([stopped], T0 + later)), `${state} after ${later} ms`).toMatchObject({
          mode: "failed",
          label: "1 didn't finish",
        });
      }
    },
  );

  it.each(["failed", "expired"] as const)("%s, once SEEN: still shown at 59 min 59 s, cleared at 1 h", (state) => {
    const seen = job(state, { seenAt: T0 + 5_000 });
    expect(modeAt([seen], T0 + 5_000 + HOUR - 1_000)).toBe("failed"); // 59:59
    expect(modeAt([seen], T0 + 5_000 + HOUR - 1)).toBe("failed");
    expect(modeAt([seen], T0 + 5_000 + HOUR)).toBe("hidden"); // 1:00:00
    expect(SEEN_CLEAR_MS).toBe(HOUR);
  });

  it("the hour runs from when it was SEEN, not from when it failed", () => {
    // Failed at T0, first looked at three days later: it has an hour from the look.
    const seenLate = job("failed", { updatedAt: T0, seenAt: T0 + 72 * HOUR });
    expect(modeAt([seenLate], T0 + 72 * HOUR + HOUR - 1)).toBe("failed");
    expect(modeAt([seenLate], T0 + 73 * HOUR)).toBe("hidden");
  });

  it("INTERRUPTED never auto-clears: not unseen, and not an hour — or a month — after being seen", () => {
    const unseen = job("interrupted", { result: "It may or may not have gone through." });
    const seen = { ...unseen, id: "seen", seenAt: T0 };
    for (const later of [HOUR - 1, HOUR, 24 * HOUR, 30 * 24 * HOUR]) {
      expect(modeAt([unseen], T0 + later), `unseen +${later}`).toBe("failed");
      expect(modeAt([seen], T0 + later), `seen +${later}`).toBe("failed");
    }
    // Only a dismissal removes it.
    expect(modeAt([{ ...seen, acknowledged: true }], T0)).toBe("hidden");
  });

  it("a dismissed job is gone at once, whatever it was", () => {
    for (const state of ["failed", "expired", "interrupted", "done"] as const) {
      expect(modeAt([job(state, { acknowledged: true })], T0), state).toBe("hidden");
    }
  });

  it("live jobs are shown for as long as they are live, seen or not", () => {
    for (const state of ["running", "queued", "needs-you"] as const) {
      expect(modeAt([job(state, { seenAt: T0 })], T0 + 10 * HOUR), state).not.toBe("hidden");
    }
  });

  it("when the last job clears, the pill is hidden — and an open list is closed with it", () => {
    let state = at([job("failed", { seenAt: T0 })], T0);
    state = reducePill(state, { type: "expand", expanded: true, now: T0 });
    state = reducePill(state, { type: "hover", inside: true, now: T0 }); // pointer on it: no idle timer
    state = reducePill(state, { type: "tick", now: T0 + HOUR });
    expect(pillView(state)).toMatchObject({ mode: "hidden", expanded: false, items: [] });
    expect(state.expanded).toBe(false);
  });
});

describe("the list shows the ten most recent", () => {
  it("eleven failed jobs: ten listed, the oldest left off, all eleven counted", () => {
    const jobs = Array.from({ length: 11 }, (_, i) => job("failed", { id: `f${i}`, updatedAt: T0 + i * 1_000 }));
    const view = pillView(at(jobs, T0 + 60_000));
    expect(LIST_CAP).toBe(10);
    expect(view.items).toHaveLength(10);
    expect(view.items.map((item) => item.id)).not.toContain("f0");
    expect(view.items.map((item) => item.id)).toContain("f10");
    // The pill itself still counts every one: nothing was cleared, only not listed.
    expect(view.label).toBe("11 didn't finish");
  });

  it("a job WAITING for the user is never the one left off, however old it is", () => {
    const waiting = job("needs-you", { id: "old-waiting", updatedAt: T0 - 5 * HOUR });
    const newer = Array.from({ length: 12 }, (_, i) => job("failed", { id: `f${i}`, updatedAt: T0 + i * 1_000 }));
    const view = pillView(at([waiting, ...newer], T0 + 60_000));
    expect(view.items).toHaveLength(10);
    expect(view.items[0]).toMatchObject({ id: "old-waiting", actions: ["review", "cancel"] });
  });

  it("when a listed one is dismissed, the one that was left off takes its place", () => {
    const jobs = Array.from({ length: 11 }, (_, i) => job("failed", { id: `f${i}`, updatedAt: T0 + i * 1_000 }));
    const afterDismiss = jobs.map((entry) => (entry.id === "f10" ? { ...entry, acknowledged: true } : entry));
    const view = pillView(at(afterDismiss, T0 + 60_000));
    expect(view.items).toHaveLength(10);
    expect(view.items.map((item) => item.id)).toContain("f0");
  });

  it("ten or fewer: all listed", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job("failed", { id: `f${i}`, updatedAt: T0 + i }));
    expect(pillView(at(jobs, T0)).items).toHaveLength(10);
  });
});

// --- Through the real manager and controller, on a fake clock ---

function world(options: { store?: JobStore; startAt?: number } = {}) {
  const clock = { now: options.startAt ?? T0 };
  const store = options.store ?? new InMemoryJobStore();
  let n = 0;
  const manager = new JobManager({ store, now: () => clock.now, newId: () => `job${clock.now}-${(n += 1)}` });
  const restored = manager.restore();
  const views: PillView[] = [];
  const lines: string[] = [];
  const controller = new PillController({
    manager,
    settings: new InMemorySettings(),
    surface: { render: (view) => void views.push(view) },
    playChime: () => undefined,
    isBusy: () => false,
    log: (line) => void lines.push(line),
    now: () => clock.now,
  });
  const background = (instruction: string): string => {
    const id = manager.submit(instruction);
    manager.detachAttached("hotkey");
    return id;
  };
  const failed = (text = "Slack said no."): string => {
    const id = background("send these notes");
    manager.finish(id, "failed", text);
    return id;
  };
  const expired = async (): Promise<string> => {
    const id = background("send these notes");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.now += 30 * 60 * 1000;
    manager.expireDue();
    return id;
  };
  return { clock, store, manager, controller, views, lines, restored, background, failed, expired, mode: () => controller.view().mode };
}

describe("seen: opening the list starts the one-hour clock", () => {
  it("a failed job is NOT seen until the list is opened — a closed pill showing it red is not seeing it", () => {
    const w = world();
    const id = w.failed();
    expect(w.mode()).toBe("failed");
    w.clock.now += 5 * HOUR;
    w.controller.tick();
    expect(w.manager.get(id)?.seenAt).toBeNull();
    expect(w.mode()).toBe("failed");
  });

  it("opening the list marks it seen, at that moment; 59 min 59 s later it is still there; at 1 h it is cleared", () => {
    const w = world();
    const id = w.failed();
    w.clock.now += 5 * HOUR; // nobody looked for five hours
    w.controller.onExpand(true);
    const seenAt = w.clock.now;
    expect(w.manager.get(id)?.seenAt).toBe(seenAt);

    w.controller.collapse();
    w.clock.now = seenAt + HOUR - 1_000;
    w.controller.tick();
    expect(w.mode()).toBe("failed");

    w.clock.now = seenAt + HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
    // And the pill is drawn hidden: the surface was told so.
    expect(w.views.at(-1)?.mode).toBe("hidden");
  });

  it("an EXPIRED job follows the same rule", async () => {
    const w = world();
    const id = await w.expired();
    expect(w.manager.get(id)?.state).toBe("expired");
    w.clock.now += 24 * HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("failed");
    w.controller.onExpand(true);
    w.clock.now += HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
  });

  it("looking again does not restart the hour", () => {
    const w = world();
    const id = w.failed();
    w.controller.onExpand(true);
    const first = w.manager.get(id)?.seenAt;
    w.controller.onExpand(false);
    w.clock.now += 40 * 60 * 1000;
    w.controller.onExpand(true);
    expect(w.manager.get(id)?.seenAt).toBe(first);
    w.controller.onExpand(false);
    w.clock.now += 20 * 60 * 1000;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
  });

  it("a job that fails WHILE the list is open is seen then", () => {
    const w = world();
    w.failed("first");
    w.controller.onExpand(true);
    w.controller.onHover(true);
    w.clock.now += 10_000;
    const second = w.failed("second");
    expect(w.manager.get(second)?.seenAt).toBe(w.clock.now);
  });

  it("a job past the cap is NOT seen by opening the list — it was not on screen", () => {
    const w = world();
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      w.clock.now += 1_000;
      ids.push(w.failed(`failure ${i}`));
    }
    w.controller.onExpand(true);
    expect(w.manager.get(ids[0] ?? "")?.seenAt).toBeNull(); // the oldest: left off the list
    expect(w.manager.get(ids[10] ?? "")?.seenAt).toBe(w.clock.now);
    // An hour on, the ten that were seen have gone and the unseen one is still owed.
    w.controller.onExpand(false);
    w.clock.now += HOUR;
    w.controller.tick();
    expect(w.controller.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
  });

  it("INTERRUPTED: opening the list does not start any clock — only Dismiss removes it", () => {
    const store = new InMemoryJobStore();
    const before = new JobManager({ store, now: () => T0, newId: () => "was-live" });
    before.submit("send these notes");
    before.detachAttached("hotkey");

    const w = world({ store, startAt: T0 + 60_000 }); // the restart
    expect(w.restored).toBe(1);
    expect(w.mode()).toBe("failed");
    w.controller.onExpand(true);
    w.controller.onExpand(false);
    w.clock.now += 100 * HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("failed");

    w.controller.onExpand(true);
    w.controller.onAction("was-live", "dismiss");
    expect(w.mode()).toBe("hidden");
  });

  it("CANCELLED from the pill: gone at once, with the pill", async () => {
    const w = world();
    const id = w.background("send these notes");
    const gate = w.manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.mode()).toBe("needs-you");
    w.controller.onExpand(true);
    w.controller.onAction(id, "cancel");
    expect(w.manager.get(id)?.state).toBe("cancelled");
    expect(w.mode()).toBe("hidden");
  });

  // RE-JUSTIFIED AT M26. Was "DONE still fades on its own, opened or not". Through the real
  // manager and controller now: unseen it stays; opening the list marks it seen and starts the
  // minute; dismiss clears it at once.
  it("DONE stays until the list is opened, then clears a minute after — through the real controller", () => {
    const w = world();
    const id = w.background("summarize this");
    w.manager.finish(id, "done", "A summary.");
    w.clock.now += 60_000;
    w.controller.tick();
    expect(w.controller.view()).toMatchObject({ mode: "done", label: "1 done" });
    expect(w.manager.get(id)?.seenAt).toBeNull();

    w.controller.onExpand(true); // the list is open with it in it: seen
    const seenAt = w.clock.now;
    expect(w.manager.get(id)?.seenAt).toBe(seenAt);
    expect(w.controller.view().items[0]).toMatchObject({ id, detail: "A summary." });

    w.clock.now = seenAt + DONE_SEEN_CLEAR_MS - 1;
    w.controller.tick();
    expect(w.mode()).toBe("done");
    w.clock.now = seenAt + DONE_SEEN_CLEAR_MS;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
  });

  // Showing it is not seeing it: a collapsed pill reading "1 done" says only that something
  // finished. Ticked every second, as main.ts's re-check does, so a mark made on any redraw of
  // the collapsed pill would be caught, not just one made on the first.
  it("DONE shown collapsed for two minutes is NOT seen; opening the list is what sees it", () => {
    const w = world();
    const id = w.background("summarize this");
    w.manager.finish(id, "done", "A summary.");
    const finishedAt = w.clock.now;
    for (let second = 1; second <= 120; second += 1) {
      w.clock.now = finishedAt + second * 1_000;
      w.controller.tick();
    }
    const drawn = w.views[w.views.length - 1];
    expect(drawn).toMatchObject({ mode: "done", label: "1 done", expanded: false });
    expect(w.controller.view()).toMatchObject({ mode: "done", label: "1 done", expanded: false });
    expect(w.manager.get(id)?.seenAt).toBeNull();

    w.controller.onExpand(true);
    const seenAt = w.clock.now;
    expect(seenAt).toBe(finishedAt + 120_000);
    expect(w.manager.get(id)?.seenAt).toBe(seenAt);

    w.clock.now = seenAt + DONE_SEEN_CLEAR_MS - 1_000;
    w.controller.tick();
    expect(w.mode()).toBe("done");
    w.clock.now = seenAt + DONE_SEEN_CLEAR_MS;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
  });

  it("DONE: Dismiss clears it at once", () => {
    const w = world();
    const id = w.background("summarize this");
    w.manager.finish(id, "done", "A summary.");
    w.controller.onExpand(true);
    w.controller.onAction(id, "dismiss");
    expect(w.mode()).toBe("hidden");
    expect(w.manager.get(id)?.acknowledged).toBe(true);
  });

  it("DONE in the bar (never detached) is never in the pill", () => {
    const w = world();
    const id = w.manager.submit("summarize this"); // attached, and stays so
    w.manager.finish(id, "done", "Shown in the bar.");
    w.clock.now += HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("hidden");
  });
});

describe("clearing from the pill deletes nothing", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDb = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "va-lifecycle-"));
    scratch.push(dir);
    return join(dir, "memory.db");
  };

  it("the job's row and its action-log rows are all still there after it auto-clears, and after a dismiss", () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    const w = world({ store: new SqliteJobStore(db) });

    const cleared = w.failed("Slack said no.");
    memory.logAction({ ts: "2026-10-14T10:00:00.000Z", instruction: "send these notes", tool: "sendMessage", arguments: { channel: "#fun" }, result: "Slack said no.", status: "error", jobId: cleared, detached: true });
    const dismissed = w.failed("Linear said no.");
    memory.logAction({ ts: "2026-10-14T10:00:01.000Z", instruction: "file this", tool: "linear__create_issue", arguments: null, result: "Linear said no.", status: "error", jobId: dismissed, detached: true });

    w.controller.onExpand(true);
    w.controller.onAction(dismissed, "dismiss");
    w.clock.now += HOUR;
    w.controller.tick();
    expect(w.mode()).toBe("hidden"); // both are gone from the pill

    const jobs = db.prepare(`SELECT id, state, result, acknowledged, seen_at FROM jobs ORDER BY created_at, id`).all() as { id: string; state: string; result: string; acknowledged: number; seen_at: number | null }[];
    expect(jobs.map((row) => [row.id, row.state, row.result])).toEqual([
      [cleared, "failed", "Slack said no."],
      [dismissed, "failed", "Linear said no."],
    ]);
    expect(jobs.every((row) => row.seen_at !== null)).toBe(true);
    const rows = db.prepare(`SELECT job_id, tool, status FROM action_log ORDER BY id`).all();
    expect(rows).toEqual([
      { job_id: cleared, tool: "sendMessage", status: "error" },
      { job_id: dismissed, tool: "linear__create_issue", status: "error" },
    ]);
    // And the manager still knows the job; it is only not shown.
    expect(w.manager.get(cleared)).toMatchObject({ state: "failed", result: "Slack said no." });
  });

  it("A RESTART KEEPS THE SEEN STATE: seen 40 minutes before the restart, it clears 20 minutes after — not a fresh hour", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    const id = before.failed("Slack said no.");
    before.controller.onExpand(true);
    const seenAt = before.clock.now;
    first.close();

    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: seenAt + 40 * 60 * 1000 });
    expect(after.manager.get(id)).toMatchObject({ state: "failed", seenAt });
    expect(after.mode()).toBe("failed");

    after.clock.now = seenAt + HOUR - 1_000;
    after.controller.tick();
    expect(after.mode()).toBe("failed");
    after.clock.now = seenAt + HOUR;
    after.controller.tick();
    expect(after.mode()).toBe("hidden");
    second.close();
  });

  it("A RESTART DOES NOT MAKE AN UNSEEN JOB SEEN, and brings it back however old it is", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    const id = before.failed("Slack said no.");
    first.close();

    // Ten days later.
    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: T0 + 240 * HOUR });
    expect(after.manager.get(id)).toMatchObject({ state: "failed", seenAt: null });
    expect(after.controller.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
    second.close();
  });

  it("a restart does not bring back a job that was seen and has already had its hour", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    before.failed();
    before.controller.onExpand(true);
    first.close();

    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: T0 + 5 * HOUR });
    expect(after.mode()).toBe("hidden");
    // Still in the store.
    expect((second.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(1);
    second.close();
  });

  // M26: a done job waits to be seen across a restart, as a failure does.
  it("DONE, UNSEEN, survives a restart however old it is — ten days later it is still waiting", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    const id = before.background("summarize this");
    before.manager.finish(id, "done", "A summary.");
    first.close();

    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: T0 + 240 * HOUR });
    expect(after.manager.get(id)).toMatchObject({ state: "done", seenAt: null, result: "A summary." });
    expect(after.controller.view()).toMatchObject({ mode: "done", label: "1 done" });
    second.close();
  });

  it("DONE, seen just before a restart, keeps only what is left of its minute", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    const id = before.background("summarize this");
    before.manager.finish(id, "done", "A summary.");
    before.controller.onExpand(true);
    const seenAt = before.clock.now;
    first.close();

    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: seenAt + 30_000 });
    expect(after.mode()).toBe("done");
    after.clock.now = seenAt + DONE_SEEN_CLEAR_MS;
    after.controller.tick();
    expect(after.mode()).toBe("hidden");
    second.close();
  });

  it("DONE, seen and a day old, is not brought back by a restart", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const before = world({ store: new SqliteJobStore(first) });
    const id = before.background("summarize this");
    before.manager.finish(id, "done", "A summary.");
    before.controller.onExpand(true);
    first.close();

    const second = createDatabase(path);
    const after = world({ store: new SqliteJobStore(second), startAt: T0 + 48 * HOUR });
    expect(after.manager.get(id)).toBeNull();
    expect(after.mode()).toBe("hidden");
    second.close();
  });

  it("the `seen_at` column is added to a jobs table that shipped without it, keeping its rows", () => {
    const path = tempDb();
    const m23 = new Database(path);
    // The jobs table exactly as M23 created it — no seen_at.
    m23.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, instruction TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      background INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, step INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, tool TEXT,
      pause_reason TEXT, pause_since INTEGER, in_flight_tool TEXT, in_flight_step INTEGER, result TEXT)`);
    m23.prepare(`INSERT INTO jobs (id, instruction, kind, state, background, created_at, updated_at, result) VALUES (?, ?, 'work', 'failed', 1, ?, ?, ?)`)
      .run("old-job", "send these notes", T0, T0, "Slack said no.");
    expect(migrate(m23)).toEqual(["jobs.seen_at"]);
    expect(migrate(m23)).toEqual([]);
    m23.close();

    const db = createDatabase(path);
    const w = world({ store: new SqliteJobStore(db), startAt: T0 + 2 * HOUR });
    // The old row reads as never seen, and is shown.
    expect(w.manager.get("old-job")).toMatchObject({ state: "failed", seenAt: null, result: "Slack said no." });
    expect(w.mode()).toBe("failed");
    db.close();
  });
});

describe("the diagnostic log: one line per pill event, with its reason", () => {
  const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pill /;

  it("a click, an action and a collapse each leave a timestamped line saying what and why", () => {
    const w = world();
    const id = w.failed();
    w.lines.length = 0;

    w.controller.onExpand(true); // a click on the pill
    w.controller.onHover(true);
    w.controller.onAction(id, "dismiss"); // a row's button
    const other = w.failed("another");
    w.controller.onExpand(true);
    w.controller.collapse(); // the hotkey
    void other;

    for (const line of w.lines) expect(line).toMatch(STAMP);
    const said = w.lines.map((line) => line.replace(STAMP, ""));
    expect(said).toEqual([
      "click on the pill: asks to open the list",
      "list OPENED: a click on the pill",
      "hover enter",
      `action "dismiss" on ${id}`,
      "list CLOSED: nothing left to show",
      "click on the pill: asks to open the list",
      "list OPENED: a click on the pill",
      "list CLOSED: hotkey or new instruction",
    ]);
  });

  it("the timestamp is the controller's clock", () => {
    const w = world();
    w.failed();
    w.lines.length = 0;
    w.clock.now = Date.UTC(2026, 9, 14, 9, 30, 15, 250);
    w.controller.onExpand(true);
    expect(w.lines[0]).toBe("2026-10-14T09:30:15.250Z pill click on the pill: asks to open the list");
  });

  it("every way the list closes names its own reason", async () => {
    const w = world();
    const closes = (): string[] => w.lines.filter((line) => line.includes("list CLOSED")).map((line) => line.split("list CLOSED: ")[1] ?? "");

    w.failed();
    w.controller.onExpand(true);
    w.controller.onExpand(false); // second click
    w.controller.onExpand(true);
    w.controller.onHover(true);
    w.controller.onHover(false);
    w.clock.now += 10_000;
    w.controller.tick(); // idle
    const waiting = w.background("send these notes");
    const gate = w.manager.gateFor(waiting);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    w.controller.onExpand(true);
    w.controller.onAction(waiting, "review"); // a row's button

    expect(closes()).toEqual([
      "a click on the pill",
      "10 s with the pointer off the pill",
      'the "review" button',
    ]);
    expect(w.lines.some((line) => line.endsWith(`action "review" on ${waiting}`))).toBe(true);
    // The click is logged BEFORE the close it causes.
    const order = w.lines.map((line) => line.split(" pill ")[1] ?? "");
    expect(order.indexOf(`action "review" on ${waiting}`)).toBeLessThan(order.lastIndexOf('list CLOSED: the "review" button'));
    expect(w.lines.some((line) => line.endsWith("hover leave"))).toBe(true);
  });

  it("a dropped or refused action is logged as such, and never echoes text the page sent", () => {
    const w = world();
    const id = w.failed();
    w.controller.onExpand(true);
    w.lines.length = 0;
    w.controller.onAction(id, "<script>alert(1)</script>");
    w.controller.onAction(id, "review"); // a real action, not offered by a failed row
    w.controller.onAction("no-such-job", "cancel");
    w.controller.onAction(42, null);
    const said = w.lines.map((line) => line.split(" pill ")[1]);
    expect(said).toEqual([
      "action dropped: an unknown action is not offered by this row (failed)",
      'action dropped: "review" is not offered by this row (failed)',
      'action dropped: "cancel" is not offered (no such row)',
      "action dropped: not a job id and an action name",
    ]);
    expect(w.lines.join("\n")).not.toContain("script");
  });

  it("no line ever carries an instruction or a result", () => {
    const w = world();
    const id = w.background("a very private instruction about salaries");
    w.manager.finish(id, "failed", "a very private result");
    w.controller.onExpand(true);
    w.controller.onHover(false);
    w.controller.onAction(id, "dismiss");
    const all = w.lines.join("\n");
    expect(all).not.toContain("salaries");
    expect(all).not.toContain("private");
    expect(w.lines.length).toBeGreaterThan(3);
  });

  it("NO BEHAVIOUR CHANGE: with and without a log, the same events give the same views", () => {
    const run = (withLog: boolean): string => {
      const clock = { now: T0 };
      let n = 0;
      const manager = new JobManager({ store: new InMemoryJobStore(), now: () => clock.now, newId: () => `j${(n += 1)}` });
      const views: PillView[] = [];
      const controller = new PillController({
        manager,
        settings: new InMemorySettings(),
        surface: { render: (view) => void views.push(view) },
        playChime: () => undefined,
        isBusy: () => false,
        now: () => clock.now,
        ...(withLog ? { log: () => undefined } : {}),
      });
      const id = manager.submit("send these notes");
      manager.detachAttached("hotkey");
      manager.finish(id, "failed", "no");
      controller.onExpand(true);
      controller.onHover(false);
      clock.now += 10_000;
      controller.tick();
      controller.onExpand(true);
      controller.onAction(id, "dismiss");
      return JSON.stringify(views);
    };
    expect(run(true)).toBe(run(false));
  });
});
