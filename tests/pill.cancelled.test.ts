import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore, SqliteJobStore } from "../src/core/jobs/JobStore.ts";
import type { JobStore } from "../src/core/jobs/JobStore.ts";
import { DONE_SEEN_CLEAR_MS } from "../src/core/jobs/pill.ts";
import type { PillView } from "../src/core/jobs/pill.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import type { Tool } from "../src/core/types.ts";
import { PillController } from "../src/main/pill/PillController.ts";
import { deferred, jobWorld, plan, settle, tool } from "./jobWorld.ts";

// M27, live finding: Cancel on a running job, then the row turned to Dismiss and the pill to
// "done". Investigated (no code changed) and found to be case (a): the cancel arrived during the
// job's LAST step, which finished, so the job legitimately ended done — with nothing saying the
// Cancel had come too late. And a job cancelled after an earlier step had run (case B) vanished
// from the pill, its "I'd already done step 1 of 2" message never shown.
//
// Now: too late reads "Finished before it could be cancelled — <result>" on an ordinary done row;
// cancelled AFTER A STEP RAN is shown, counted in "didn't finish", with its own message and
// Dismiss, until seen, then a minute, and it survives a restart; cancelled BEFORE ANY STEP RAN
// stays hidden, as since M23.
//
// Scripted as the investigation was: the REAL JobManager, JobRunner, Planner and PillController
// over MockShell, with a scripted model (tests/jobWorld.ts) — not a hand-driven gate, which is
// how a test of the old rule kept passing (pill.dismiss.test.ts, "when the step ends").

// `cancelDuring`: which step's handler is running when Cancel is pressed, "confirm" for a job
// waiting at its first confirm, or "none" — nobody presses Cancel (the contrast).
async function scenario(
  instruction: "one step" | "two steps" | "post only",
  cancelDuring: "slow" | "post" | "confirm" | "none",
) {
  const ran: string[] = [];
  const holds = { slow: deferred(), post: deferred() };
  const entered = { slow: deferred(), post: deferred() };
  const make = (name: "slow" | "post", over: Partial<Tool> = {}): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "ok",
    planPhrase: "run a test step",
    handler: async (): Promise<string> => {
      ran.push(`${name} started`);
      entered[name].resolve();
      await holds[name].promise;
      ran.push(`${name} finished`);
      return `${name} result`;
    },
    ...over,
  });
  const w = jobWorld({
    script: { "one step": tool("slow"), "two steps": plan({ tool: "slow" }, { tool: "post" }), "post only": tool("post") },
    tools: [
      make("slow"),
      cancelDuring === "confirm"
        ? make("post", { risk: "dangerous", confirmLabel: "Post", confirmSummary: () => "Post it?" })
        : make("post"),
    ],
  });
  const views: PillView[] = [];
  const pill = new PillController({
    manager: w.manager,
    settings: new InMemorySettings(),
    surface: { render: (view) => void views.push(view) },
    playChime: () => undefined,
    isBusy: () => false,
    now: () => w.clock.now,
  });

  const run = w.run(instruction);
  // Detached at once, while still planning: an attached job that reaches a confirm holds the
  // foreground and (rightly) cannot be detached.
  w.manager.detachAttached("hotkey");
  await settle();
  const id = w.manager.views().find((job) => job.kind === "work")?.id ?? "";
  expect(id).not.toBe("");
  pill.onExpand(true);

  if (cancelDuring === "confirm") {
    // A detached job waits BEFORE its first confirm: nothing has run.
    expect(w.manager.get(id)?.state).toBe("needs-you");
  } else if (cancelDuring !== "none") {
    if (cancelDuring === "post") {
      await entered.slow.promise;
      holds.slow.resolve();
    }
    await entered[cancelDuring].promise;
    await settle();
  }
  if (cancelDuring !== "none") pill.onAction(id, "cancel");
  holds.slow.resolve();
  holds.post.resolve();
  await run;
  await settle();
  const row = () => pill.view().items.find((item) => item.id === id);
  return { w, pill, id, ran, views, row };
}

describe("too late: the cancel came during the last step, which finished (case a)", () => {
  it("A. ONE-STEP job: done, green, counted in 'done', with Dismiss — and the row says the cancel came too late", async () => {
    const s = await scenario("one step", "slow");
    expect(s.ran).toEqual(["slow started", "slow finished"]);
    expect(s.w.manager.get(s.id)).toMatchObject({ state: "done", cancelRequested: true, result: "slow result" });
    expect(s.row()).toEqual({
      id: s.id,
      title: "one step",
      state: "done",
      detail: "Finished before it could be cancelled — slow result",
      actions: ["dismiss"],
    });
    expect(s.pill.view()).toMatchObject({ mode: "done", label: "1 done" });
    // On the way: "Cancelling — finishing step 1 of 1" while the step was still running.
    const details = s.views.flatMap((view) => view.items.filter((item) => item.id === s.id).map((item) => item.detail));
    expect(details).toContain("Cancelling — finishing step 1 of 1");
  });

  it("C. LAST step of two: both steps ran; done, with the too-late wording on the last step's result", async () => {
    const s = await scenario("two steps", "post");
    expect(s.ran).toEqual(["slow started", "slow finished", "post started", "post finished"]);
    expect(s.w.manager.get(s.id)).toMatchObject({ state: "done", cancelRequested: true, stepsRun: 2 });
    expect(s.row()).toMatchObject({ state: "done", detail: "Finished before it could be cancelled — post result", actions: ["dismiss"] });
    expect(s.pill.view()).toMatchObject({ mode: "done", label: "1 done" });
  });

  it("THE CONTRAST: the same job, nobody pressing Cancel, reads as it always did", async () => {
    const s = await scenario("one step", "none");
    expect(s.w.manager.get(s.id)).toMatchObject({ state: "done", cancelRequested: false });
    expect(s.row()).toMatchObject({ state: "done", detail: "slow result", actions: ["dismiss"] });
  });
});

describe("cancelled after a step ran: shown, with its own message (case B)", () => {
  it("B. cancelled during step 1 of 2: step 2 never ran; the row shows the job's own message, Dismiss, counted in 'didn't finish'", async () => {
    const s = await scenario("two steps", "slow");
    expect(s.ran).toEqual(["slow started", "slow finished"]);
    const job = s.w.manager.get(s.id);
    expect(job).toMatchObject({ state: "cancelled", stepsRun: 1 });
    expect(job?.result).toContain("I'd already done step 1 of 2, but step 2 didn't run.");
    expect(s.row()).toMatchObject({ state: "cancelled", detail: job?.result, actions: ["dismiss"] });
    expect(s.pill.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
    // The list stays open: the row did not go.
    expect(s.pill.view().expanded).toBe(true);
  });

  it("cancelled BEFORE ANY STEP RAN (at its first confirm) stays hidden, as since M23", async () => {
    const s = await scenario("post only", "confirm");
    expect(s.ran).toEqual([]);
    expect(s.w.manager.get(s.id)).toMatchObject({ state: "cancelled", stepsRun: 0 });
    expect(s.row()).toBeUndefined();
    expect(s.pill.view().mode).toBe("hidden");
  });

  it("SEEN — the list was open when it ended — it clears a minute later, like a done job", async () => {
    // Seen: the list was open when it ended.
    const seen = await scenario("two steps", "slow");
    const seenAt = seen.w.manager.get(seen.id)?.seenAt;
    expect(seenAt).not.toBeNull();
    seen.w.clock.now = (seenAt ?? 0) + DONE_SEEN_CLEAR_MS - 1;
    seen.pill.tick();
    expect(seen.row()).toBeDefined();
    seen.w.clock.now = (seenAt ?? 0) + DONE_SEEN_CLEAR_MS;
    seen.pill.tick();
    expect(seen.row()).toBeUndefined();
    expect(seen.pill.view().mode).toBe("hidden");
  });

  it("UNSEEN — the list closed before it ended — it stays a day later, and is seen only when the list is opened", async () => {
    const ran: string[] = [];
    const hold = deferred();
    const entered = deferred();
    const w = jobWorld({
      script: { "two steps": plan({ tool: "slow" }, { tool: "post" }) },
      tools: [
        {
          name: "slow",
          description: "slow",
          inputSchema: { type: "object", properties: {}, required: [] },
          risk: "safe",
          background: "ok",
          planPhrase: "run a test step",
          handler: async () => {
            ran.push("slow");
            entered.resolve();
            await hold.promise;
            return "slow result";
          },
        },
        {
          name: "post",
          description: "post",
          inputSchema: { type: "object", properties: {}, required: [] },
          risk: "safe",
          background: "ok",
          planPhrase: "run a test step",
          handler: () => {
            ran.push("post");
            return Promise.resolve("post result");
          },
        },
      ],
    });
    const pill = new PillController({
      manager: w.manager,
      settings: new InMemorySettings(),
      surface: { render: () => undefined },
      playChime: () => undefined,
      isBusy: () => false,
      now: () => w.clock.now,
    });
    const run = w.run("two steps");
    await settle();
    w.manager.detachAttached("hotkey");
    await entered.promise;
    const id = w.manager.views()[0]?.id ?? "";
    pill.onExpand(true);
    pill.onAction(id, "cancel");
    pill.onExpand(false); // closed before it ends: not seen
    hold.resolve();
    await run;
    await settle();
    expect(ran).toEqual(["slow"]);
    expect(w.manager.get(id)).toMatchObject({ state: "cancelled", stepsRun: 1, seenAt: null });
    w.clock.now += 24 * 60 * 60 * 1000;
    pill.tick();
    expect(pill.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
    pill.onExpand(true);
    expect(w.manager.get(id)?.seenAt).toBe(w.clock.now);
  });

  // The other way to be cancelled after a step ran: step 1 done, step 2 waiting for an OK in the
  // pill, Cancel pressed THERE. The manager ends it at once, before the planner has written its
  // message — checked that the message still arrives and is what the row shows.
  it("cancelled while WAITING FOR OK ON STEP 2 (step 1 ran): shown, with the planner's message", async () => {
    const ran: string[] = [];
    const make = (name: string, over: Partial<Tool> = {}): Tool => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      planPhrase: "run a test step",
      handler: () => {
        ran.push(name);
        return Promise.resolve(`${name} result`);
      },
      ...over,
    });
    const w = jobWorld({
      script: { "two steps": plan({ tool: "slow" }, { tool: "post" }) },
      tools: [make("slow"), make("post", { risk: "dangerous", confirmLabel: "Post", confirmSummary: () => "Post it?" })],
    });
    const pill = new PillController({
      manager: w.manager,
      settings: new InMemorySettings(),
      surface: { render: () => undefined },
      playChime: () => undefined,
      isBusy: () => false,
      now: () => w.clock.now,
    });
    const run = w.run("two steps");
    w.manager.detachAttached("hotkey");
    await settle(30);
    const id = w.manager.views()[0]?.id ?? "";
    expect(w.manager.get(id)).toMatchObject({ state: "needs-you", step: 2, stepsRun: 1, waitingFor: "confirm" });
    pill.onExpand(true);
    pill.onAction(id, "cancel");
    await run;
    await settle(30);
    expect(ran).toEqual(["slow"]);
    const job = w.manager.get(id);
    expect(job).toMatchObject({ state: "cancelled", stepsRun: 1 });
    expect(job?.result).toContain("I'd already done step 1 of 2, but step 2 didn't run.");
    expect(pill.view().items.find((item) => item.id === id)).toMatchObject({ state: "cancelled", detail: job?.result, actions: ["dismiss"] });
    expect(pill.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
  });

  it("DISMISS ALL treats it as an ended row: it goes, with the done one beside it", async () => {
    const s = await scenario("two steps", "slow");
    const done = s.w.manager.submit("summarize this");
    s.w.manager.detachAttached("hotkey");
    s.w.manager.finish(done, "done", "A summary.");
    expect(s.pill.view().dismissAll).toBe(true);
    s.pill.onDismissAll();
    expect(s.w.manager.get(s.id)?.acknowledged).toBe(true);
    expect(s.w.manager.get(done)?.acknowledged).toBe(true);
    expect(s.pill.view().mode).toBe("hidden");
  });
});

// --- Across a restart, on both stores ---

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 8_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MESSAGE = "You cancelled that, so I stopped there. I'd already done step 1 of 2, but step 2 didn't run.";

// A background job cancelled during step 1 of 2, driven through the gate exactly as the planner
// drives it: the handler starts and finishes, step 2 is refused, the runner ends it.
async function cancelledAfterStepOne(manager: JobManager): Promise<string> {
  const id = manager.submit("summarize then post");
  manager.detachAttached("hotkey");
  const gate = manager.gateFor(id);
  await gate.admit({ tools: ["summarize", "sendMessage"], statusOnly: false });
  await gate.enterStep({ tool: "summarize", index: 1, total: 2, foregroundOnly: false });
  gate.handlerStarting();
  manager.cancel(id);
  gate.handlerFinished();
  await gate.enterStep({ tool: "sendMessage", index: 2, total: 2, foregroundOnly: false });
  manager.finish(id, "cancelled", MESSAGE);
  return id;
}

async function cancelledBeforeAnyStep(manager: JobManager): Promise<string> {
  const id = manager.submit("send these notes");
  manager.detachAttached("hotkey");
  manager.cancel(id);
  await manager.gateFor(id).admit({ tools: ["sendMessage"], statusOnly: false });
  manager.finish(id, "cancelled", "Cancelled before it started.");
  return id;
}

function stores(): { name: string; open: () => JobStore; close: () => void }[] {
  const memory = new InMemoryJobStore();
  const dir = mkdtempSync(join(tmpdir(), "va-cancelled-"));
  dirs.push(dir);
  const path = join(dir, "memory.db");
  const dbs: ReturnType<typeof createDatabase>[] = [];
  return [
    { name: "InMemoryJobStore", open: () => memory, close: () => undefined },
    {
      name: "SqliteJobStore",
      open: () => {
        const db = createDatabase(path);
        dbs.push(db);
        return new SqliteJobStore(db);
      },
      close: () => dbs.splice(0).forEach((db) => db.close()),
    },
  ];
}

describe("a job cancelled after a step ran survives a restart, like an unseen done job", () => {
  for (const kind of ["InMemoryJobStore", "SqliteJobStore"]) {
    it(`${kind}: UNSEEN, it is brought back ten days later with its message; the one cancelled before any step is not`, async () => {
      const store = stores().find((s) => s.name === kind);
      if (store === undefined) throw new Error(kind);
      const before = new JobManager({ store: store.open(), now: () => T0 });
      const ranOne = await cancelledAfterStepOne(before);
      const ranNone = await cancelledBeforeAnyStep(before);
      store.close();

      const now = T0 + 10 * DAY; // far outside the 24 h restore window, so only the rule can bring it back
      const after = new JobManager({ store: store.open(), now: () => now });
      after.restore();
      expect(after.get(ranOne)).toMatchObject({ state: "cancelled", stepsRun: 1, seenAt: null, result: MESSAGE });
      expect(after.get(ranNone)).toBeNull();
      const pill = new PillController({
        manager: after,
        settings: new InMemorySettings(),
        surface: { render: () => undefined },
        playChime: () => undefined,
        isBusy: () => false,
        now: () => now,
      });
      expect(pill.view()).toMatchObject({ mode: "failed", label: "1 didn't finish" });
      expect(pill.view().items).toEqual([
        { id: ranOne, title: "summarize then post", state: "cancelled", detail: MESSAGE, actions: ["dismiss"] },
      ]);
      store.close();
    });

    it(`${kind}: SEEN and past its minute, it is not brought back`, async () => {
      const store = stores().find((s) => s.name === kind);
      if (store === undefined) throw new Error(kind);
      let now = T0;
      const before = new JobManager({ store: store.open(), now: () => now });
      const id = await cancelledAfterStepOne(before);
      before.markSeen([id]);
      store.close();

      now = T0 + 2 * DAY;
      const after = new JobManager({ store: store.open(), now: () => now });
      after.restore();
      expect(after.get(id)).toBeNull();
      store.close();
    });
  }
});
