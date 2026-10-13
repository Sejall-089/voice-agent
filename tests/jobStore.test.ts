import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore, SqliteJobStore } from "../src/core/jobs/JobStore.ts";
import type { JobRecord, JobStore } from "../src/core/jobs/JobStore.ts";
import { interruptedText } from "../src/core/jobs/messages.ts";
import { createDatabase, migrate } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { CHIME_MUTED, InMemorySettings, readFlag, SqliteSettings, writeFlag } from "../src/core/settings.ts";
import type { ActionLogEntry } from "../src/core/types.ts";

// What M23 writes to disk: the job records, the two columns it added to `action_log`, and the
// settings table. And what happens to all of it across a restart.

const scratch: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "va-jobs-"));
  scratch.push(dir);
  return join(dir, "memory.db");
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<JobRecord>): JobRecord => ({
  id: "j1",
  instruction: "send these to the team",
  kind: "work",
  state: "running",
  background: true,
  acknowledged: false,
  createdAt: 1000,
  updatedAt: 1000,
  step: 0,
  total: 0,
  tool: null,
  pauseReason: null,
  pauseSince: null,
  inFlightTool: null,
  inFlightStep: null,
  result: null,
  ...over,
});

// THE action_log TABLE AS EVERY INSTALL BEFORE M23 HAS IT — written out literally, not taken
// from db.ts, so this cannot agree with the code under test by construction.
const PRE_M23_SCHEMA = `
CREATE TABLE facts (
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL, value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8, source TEXT, version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_subject_active ON facts (subject, active);
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, instruction TEXT NOT NULL,
  tool TEXT, arguments TEXT, result TEXT, status TEXT NOT NULL
);
`;

const columns = (db: Database.Database, table: string): string[] =>
  db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((info) => info.name);

describe("the action_log migration (addition C)", () => {
  it("adds job_id and detached to a database from before M23, and keeps every existing row", () => {
    const path = tempDb();
    const old = new Database(path);
    old.exec(PRE_M23_SCHEMA);
    old
      .prepare(`INSERT INTO action_log (ts, instruction, tool, arguments, result, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("2026-10-01T10:00:00.000Z", "summarize this", "summarize", null, "A summary.", "ok");
    old
      .prepare(`INSERT INTO facts (subject, value, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("team", "#design-team", "2026-09-01", "2026-09-01");
    expect(columns(old, "action_log")).toEqual(["id", "ts", "instruction", "tool", "arguments", "result", "status"]);
    old.close();

    // The app starts on that file.
    const db = createDatabase(path);
    expect(columns(db, "action_log")).toEqual([
      "id", "ts", "instruction", "tool", "arguments", "result", "status", "job_id", "detached",
    ]);
    // The old row is intact, with NULL in both new columns.
    expect(db.prepare(`SELECT * FROM action_log`).all()).toEqual([
      {
        id: 1, ts: "2026-10-01T10:00:00.000Z", instruction: "summarize this", tool: "summarize",
        arguments: null, result: "A summary.", status: "ok", job_id: null, detached: null,
      },
    ]);
    // And it still reads as the previous turn, which it is.
    const memory = new SqliteMemory(db);
    expect(memory.getLast()?.instruction).toBe("summarize this");
    expect(memory.resolve("the team")?.value).toBe("#design-team");
    db.close();
  });

  it("is safe to run again: a second start adds nothing and fails on nothing", () => {
    const path = tempDb();
    const old = new Database(path);
    old.exec(PRE_M23_SCHEMA);
    expect(migrate(old)).toEqual(["action_log.job_id", "action_log.detached"]);
    expect(migrate(old)).toEqual([]);
    old.close();
    const again = createDatabase(path);
    expect(columns(again, "action_log").filter((name) => name === "job_id")).toEqual(["job_id"]);
    again.close();
  });

  it("a fresh database ends up with exactly the same action_log columns", () => {
    const db = createDatabase(":memory:");
    expect(columns(db, "action_log")).toEqual([
      "id", "ts", "instruction", "tool", "arguments", "result", "status", "job_id", "detached",
    ]);
    expect(columns(db, "jobs")).toContain("in_flight_tool");
    expect(columns(db, "settings")).toEqual(["key", "value"]);
  });

  it("no jobs column can hold captured context", () => {
    // The clipboard is never written down. This pins the column list, so adding one is a
    // decision someone has to make in front of this test.
    const db = createDatabase(":memory:");
    expect(columns(db, "jobs")).toEqual([
      "id", "instruction", "kind", "state", "background", "acknowledged", "created_at", "updated_at",
      "step", "total", "tool", "pause_reason", "pause_since", "in_flight_tool", "in_flight_step", "result",
    ]);
  });
});

describe("getLast() skips rows a detached job wrote (addition C)", () => {
  const row = (instruction: string, over: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
    ts: "2026-10-13T10:00:00.000Z",
    instruction,
    tool: "summarize",
    arguments: { a: 1 },
    result: "ok",
    status: "ok",
    ...over,
  });

  for (const [name, make] of [
    ["SqliteMemory", () => new SqliteMemory(createDatabase(":memory:"))],
    ["InMemoryActionLog", () => new InMemoryActionLog()],
  ] as const) {
    it(`${name}: the previous turn is the last row that is NOT from a detached job`, () => {
      const log = make();
      expect(log.getLast()).toBeNull();
      log.logAction(row("in front of the bar"));
      log.logAction(row("background step 1", { jobId: "j9", detached: true }));
      log.logAction(row("background step 2", { jobId: "j9", detached: true }));
      expect(log.getLast()?.instruction).toBe("in front of the bar");

      // An ATTACHED job's row is an ordinary previous turn.
      log.logAction(row("attached job", { jobId: "j10", detached: false }));
      expect(log.getLast()?.instruction).toBe("attached job");
    });

    it(`${name}: with only detached rows there is no previous turn`, () => {
      const log = make();
      log.logAction(row("background", { jobId: "j9", detached: true }));
      expect(log.getLast()).toBeNull();
    });
  }

  it("SqliteMemory writes the job id and the flag where a reader can find them", () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    memory.logAction(row("a", { jobId: "j1", detached: true }));
    memory.logAction(row("b", { jobId: "j2", detached: false }));
    memory.logAction(row("c"));
    expect(db.prepare(`SELECT instruction, job_id, detached FROM action_log ORDER BY id`).all()).toEqual([
      { instruction: "a", job_id: "j1", detached: 1 },
      { instruction: "b", job_id: "j2", detached: 0 },
      { instruction: "c", job_id: null, detached: null },
    ]);
  });
});

describe("the interrupted sentence says which phase the job was in", () => {
  it("a handler in flight: it may have gone through", () => {
    const text = interruptedText(record({ step: 2, total: 3, tool: "sendMessage", inFlightTool: "sendMessage", inFlightStep: 2 }));
    expect(text).toContain("step 2 of 3 (sendMessage) was running");
    expect(text).toContain("may or may not have gone through");
  });

  it("between steps, or waiting: that step did nothing — and it never says 'may have'", () => {
    const text = interruptedText(record({ step: 2, total: 3, tool: "sendMessage" }));
    expect(text).toContain("before step 2 of 3 (sendMessage) ran");
    expect(text).toContain("Nothing was sent by that step");
    expect(text).toContain("The steps before it had finished");
    expect(text).not.toContain("may");
  });

  it("step 1 not yet run: no claim about earlier steps", () => {
    expect(interruptedText(record({ step: 1, total: 2, tool: "readEmail" }))).not.toContain("steps before it");
  });

  it("still planning: nothing was run", () => {
    expect(interruptedText(record({}))).toBe(
      "Interrupted: the app closed before anything was run. Nothing was sent.",
    );
  });
});

describe("a restart: interrupted, never resumed", () => {
  for (const [name, make] of [
    ["InMemoryJobStore", (): JobStore => new InMemoryJobStore()],
    ["SqliteJobStore", (): JobStore => new SqliteJobStore(createDatabase(":memory:"))],
  ] as const) {
    it(`${name}: every live job becomes interrupted, and ended ones are left alone`, () => {
      const store = make();
      store.save(record({ id: "running-mid-handler", state: "running", step: 2, total: 2, tool: "sendMessage", inFlightTool: "sendMessage", inFlightStep: 2 }));
      store.save(record({ id: "waiting", state: "needs-you", step: 1, total: 1, tool: "sendMessage", pauseReason: "confirm", pauseSince: 900 }));
      store.save(record({ id: "queued", state: "queued", total: 1, tool: "summarize" }));
      store.save(record({ id: "finished", state: "done", result: "All good." }));
      store.save(record({ id: "failed-and-seen", state: "failed", acknowledged: true }));

      expect(store.markInterrupted(5000)).toBe(3);
      const after = new Map(store.loadUnacknowledged(0).map((job) => [job.id, job]));

      expect(after.get("running-mid-handler")).toMatchObject({ state: "interrupted", updatedAt: 5000 });
      expect(after.get("running-mid-handler")?.result).toContain("may or may not have gone through");
      // A wait is cleared, not carried over: nothing is waiting for anyone any more.
      expect(after.get("waiting")).toMatchObject({ state: "interrupted", pauseReason: null, pauseSince: null });
      expect(after.get("waiting")?.result).toContain("Nothing was sent by that step");
      expect(after.get("queued")?.result).toBe("Interrupted: the app closed before anything was run. Nothing was sent.");
      expect(after.get("finished")).toMatchObject({ state: "done", result: "All good." });
      // Dismissed before the restart: not brought back.
      expect(after.has("failed-and-seen")).toBe(false);

      // A second start has nothing left to interrupt.
      expect(store.markInterrupted(6000)).toBe(0);
    });
  }

  it("survives a real close and reopen of the file", () => {
    const path = tempDb();
    const first = createDatabase(path);
    new SqliteJobStore(first).save(record({ id: "j1", state: "needs-you", step: 1, total: 1, tool: "sendMessage", pauseReason: "confirm", pauseSince: 900 }));
    first.close();

    const second = createDatabase(path);
    const store = new SqliteJobStore(second);
    expect(store.markInterrupted(5000)).toBe(1);
    expect(store.loadUnacknowledged(0)).toMatchObject([{ id: "j1", state: "interrupted", background: true }]);
    second.close();
  });

  it("NOTHING RUNS ON STARTUP: a restored job has no gate to wake, and cannot be resumed", async () => {
    // The app "stops" with one job mid-handler and one waiting on a confirm...
    const store = new InMemoryJobStore();
    const before = new JobManager({ store, now: () => 1000, newId: () => "live" });
    const id = before.submit("send these");
    const gate = before.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    before.detachAttached();
    const woken: unknown[] = [];
    void gate.beforeConfirm().then((answer) => woken.push(answer));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(id)?.state).toBe("needs-you");

    // ...and "starts" again: a NEW manager over the same store, as main.ts builds one.
    const after = new JobManager({ store, now: () => 2000 });
    expect(after.restore()).toBe(1);
    expect(after.get(id)).toMatchObject({ state: "interrupted", background: true });
    // There is no way to make it go: every door answers that nothing is waiting.
    expect(after.resume(id)).toBe("not-waiting");
    expect(after.cancel(id)).toBe(false);
    expect(after.expireDue()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The old run's pending question was never answered "go" by anything the restart did.
    expect(woken).toEqual([]);
    // It is shown, so the user is told, and can be dismissed.
    expect(after.views().map((job) => job.id)).toEqual([id]);
    expect(after.acknowledge(id)).toBe(true);
    expect(after.views()).toEqual([]);
  });
});

describe("settings", () => {
  it("a flag is false until it is set, and anything but '1' is false", () => {
    const settings = new InMemorySettings();
    expect(readFlag(settings, CHIME_MUTED)).toBe(false);
    settings.set(CHIME_MUTED, "true");
    expect(readFlag(settings, CHIME_MUTED)).toBe(false);
    writeFlag(settings, CHIME_MUTED, true);
    expect(readFlag(settings, CHIME_MUTED)).toBe(true);
    writeFlag(settings, CHIME_MUTED, false);
    expect(readFlag(settings, CHIME_MUTED)).toBe(false);
  });

  it("MUTE PERSISTS across a settings reload: written to one database handle, read from another", () => {
    const path = tempDb();
    const first = createDatabase(path);
    writeFlag(new SqliteSettings(first), CHIME_MUTED, true);
    first.close();

    const second = createDatabase(path);
    expect(readFlag(new SqliteSettings(second), CHIME_MUTED)).toBe(true);
    // And unmuting persists just the same.
    writeFlag(new SqliteSettings(second), CHIME_MUTED, false);
    second.close();
    const third = createDatabase(path);
    expect(readFlag(new SqliteSettings(third), CHIME_MUTED)).toBe(false);
    third.close();
  });

  it("is not a fact: nothing a setting writes is visible to memory", () => {
    const db = createDatabase(":memory:");
    writeFlag(new SqliteSettings(db), CHIME_MUTED, true);
    const memory = new SqliteMemory(db);
    expect(memory.query("")).toEqual([]);
    expect(memory.resolve("chime.muted")).toBeNull();
  });
});
