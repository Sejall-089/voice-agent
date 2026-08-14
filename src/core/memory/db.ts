import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

// Schema per spec.md §7. `version` and `active` exist from the start so corrections
// (M4) are a write() call, never a migration.
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
`;

// The DB path is a PARAMETER — /core never decides where the file lives and never imports
// electron. main.ts injects the real path; tests inject ":memory:".
export function createDatabase(path: string): DatabaseType {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA);
  return db;
}
