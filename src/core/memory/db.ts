import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

// Schema per spec.md §7. `version` and `active` exist from the start so corrections
// (M4) are a write() call, never a migration.
//
// `action_log` is written here AS IT WAS BEFORE M23, on purpose: the two columns M23 added
// (`job_id`, `detached`) are added by `migrate` below, to a new database and an old one alike,
// so there is one code path that produces them and it is the one an existing install takes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY,
  subject     TEXT NOT NULL,
  value       TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.8,
  source      TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_subject_active ON facts (subject, active);

CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  instruction TEXT NOT NULL,
  tool        TEXT,
  arguments   TEXT,
  result      TEXT,
  status      TEXT NOT NULL
);

-- M23. One row per job. No column holds captured context: the clipboard is never written
-- down (core/jobs/JobStore.ts).
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  instruction    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  background     INTEGER NOT NULL DEFAULT 0,
  acknowledged   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  step           INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  tool           TEXT,
  pause_reason   TEXT,
  pause_since    INTEGER,
  in_flight_tool TEXT,
  in_flight_step INTEGER,
  result         TEXT
);

-- M23. App settings (the chime's mute). NOT the facts table: a fact is something the user
-- taught the app and \`recall\` reads back; a setting is neither.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added to a table that may already exist. `CREATE TABLE IF NOT EXISTS` does nothing
// to a table that is already there, so an install from before M23 would otherwise keep its
// seven-column `action_log` for ever and the first job to log a row would fail.
//
// ADDITIVE ONLY, AND GUARDED: each column is looked for first (`PRAGMA table_info`) and added
// only when absent — `ALTER TABLE … ADD COLUMN` on a column that exists is an error, and this
// runs on every start. Nothing is dropped, renamed or rewritten; existing rows keep NULL in
// both, which every reader treats as "not a job's row".
const ADDED_COLUMNS: readonly { table: string; column: string; type: string }[] = [
  { table: "action_log", column: "job_id", type: "TEXT" },
  { table: "action_log", column: "detached", type: "INTEGER" },
];

export function migrate(db: DatabaseType): string[] {
  const added: string[] = [];
  for (const { table, column, type } of ADDED_COLUMNS) {
    const present = db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .some((info) => info.name === column);
    if (present) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

// The DB path is a PARAMETER — /core never decides where the file lives and never imports
// electron. main.ts injects the real path; tests inject ":memory:".
export function createDatabase(path: string): DatabaseType {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
