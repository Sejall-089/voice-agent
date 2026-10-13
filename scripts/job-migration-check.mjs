// M23: run the action_log migration against a COPY of this machine's real memory.db.
//
//   npx vite-node scripts/job-migration-check.mjs
//   npx vite-node scripts/job-migration-check.mjs "C:\path\to\memory.db"
//
// It needs better-sqlite3 built for NODE, not electron: run `npm run rebuild:node` first (which
// `npm test` does), with the app closed — a running app holds the electron build open.
//
// READ-ONLY ON THE ORIGINAL. The database (and its -wal / -shm files, so rows not yet
// checkpointed come too) is copied into a temp directory, the copy is opened with the app's
// own `createDatabase`, and the copy is deleted afterwards. The app can be running.
//
// It prints counts and column names only — never an instruction, an argument, a result or a
// fact, all of which are the user's.
//
// WHY THIS EXISTS. tests/jobStore.test.ts migrates a database built from the pre-M23 schema,
// which proves the migration against what the schema SAID. A file that has lived through
// twenty-two milestones is the other half: whatever is actually in it.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { SqliteJobStore } from "../src/core/jobs/JobStore.ts";

const source =
  process.argv[2] ?? join(process.env["APPDATA"] ?? "", "voice-agent", "memory.db");
if (!existsSync(source)) {
  console.log(`no database at ${source} - nothing to check`);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "va-migrate-"));
const copy = join(scratch, "memory.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
}

const columns = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((info) => info.name);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

try {
  // As it is on disk today, opened without the app's schema code.
  const before = new Database(copy);
  const beforeColumns = columns(before, "action_log");
  const beforeRows = count(before, "action_log");
  const beforeFacts = count(before, "facts");
  const lastId = before.prepare(`SELECT MAX(id) AS id FROM action_log`).get().id;
  before.close();
  console.log(`before: action_log columns = ${beforeColumns.join(", ")}`);
  console.log(`before: ${beforeRows} action_log rows, ${beforeFacts} facts`);

  // What the app does on start.
  const db = createDatabase(copy);
  const afterColumns = columns(db, "action_log");
  console.log(`after:  action_log columns = ${afterColumns.join(", ")}`);
  console.log(`after:  ${count(db, "action_log")} action_log rows, ${count(db, "facts")} facts`);
  console.log(`after:  tables jobs (${count(db, "jobs")} rows) and settings (${count(db, "settings")} rows) exist`);

  const checks = [
    ["job_id and detached were added", afterColumns.includes("job_id") && afterColumns.includes("detached")],
    ["every column that was there is still there, in order", beforeColumns.every((name, i) => afterColumns[i] === name)],
    ["no action_log row was lost", count(db, "action_log") === beforeRows],
    ["no fact was lost", count(db, "facts") === beforeFacts],
    [
      "every existing row has NULL in both new columns",
      db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE job_id IS NOT NULL OR detached IS NOT NULL`).get().n === 0 ||
        beforeColumns.includes("job_id"),
    ],
    [
      "getLast() still returns the newest existing row",
      beforeRows === 0 ||
        beforeColumns.includes("detached") ||
        db.prepare(`SELECT ts FROM action_log WHERE id = ?`).get(lastId).ts === new SqliteMemory(db).getLast()?.ts,
    ],
    ["a second start changes nothing", (() => { db.close(); const again = createDatabase(copy); const same = columns(again, "action_log").join() === afterColumns.join(); again.close(); return same; })()],
    ["a job row and a stamped log row can be written and read back", (() => {
      const live = createDatabase(copy);
      const memory = new SqliteMemory(live);
      memory.logAction({ ts: new Date().toISOString(), instruction: "migration check", tool: null, arguments: null, result: null, status: "ok", jobId: "check", detached: true });
      new SqliteJobStore(live).save({ id: "check", instruction: "migration check", kind: "work", state: "running", background: true, acknowledged: false, createdAt: 1, updatedAt: 1, step: 0, total: 0, tool: null, pauseReason: null, pauseSince: null, inFlightTool: null, inFlightStep: null, result: null });
      const stamped = live.prepare(`SELECT job_id, detached FROM action_log ORDER BY id DESC LIMIT 1`).get();
      const interrupted = new SqliteJobStore(live).markInterrupted(2);
      live.close();
      return stamped.job_id === "check" && stamped.detached === 1 && interrupted === 1;
    })()],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }
  console.log(failed === 0 ? "migration check: all passed (on a copy; the original was not opened for writing)" : `migration check: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
