import type { Database } from "better-sqlite3";
import type { JobState } from "../types.ts";
import { interruptedText } from "./messages.ts";

// What is written down about a job (M23).
//
// DELIBERATELY ABSENT: the captured context. The clipboard is whatever was last copied — a
// password as easily as meeting notes — and it is only ever needed by a job that is still
// running in this process. Jobs are never resumed after a restart, so nothing that reads this
// table needs it, and it is never written.
export interface JobRecord {
  id: string;
  instruction: string;
  // "status": a question about the jobs themselves. Recorded, never listed.
  kind: "work" | "status";
  state: JobState;
  // Was this job ever detached from the command bar? Only background jobs are shown in the
  // pill or reported by `jobStatus`: one the user watched finish in the bar is not news.
  background: boolean;
  // The user has dismissed it from the pill.
  acknowledged: boolean;
  createdAt: number;
  updatedAt: number;
  // Where it has got to: 1-based step, the plan's length, the tool. 0 / 0 / null while planning.
  step: number;
  total: number;
  tool: string | null;
  pauseReason: "confirm" | "foreground-only" | null;
  pauseSince: number | null;
  // THE WRITE-AHEAD MARKER. Set immediately before a handler is called and cleared when it
  // returns or throws. A record found with this set after a restart is a step that may have
  // happened; one without it is a step that did not.
  inFlightTool: string | null;
  inFlightStep: number | null;
  result: string | null;
}

export interface JobStore {
  save(record: JobRecord): void;
  // Startup only: every job that was still live when the app last stopped becomes
  // `interrupted`, with a sentence saying whether its step may have gone through. Returns how
  // many. NOTHING IS RESUMED — this is a relabelling and no handler is reachable from it.
  markInterrupted(now: number): number;
  // Jobs worth showing after a restart: background, unacknowledged, ended since `since`.
  loadUnacknowledged(since: number): JobRecord[];
}

const LIVE: readonly JobState[] = ["queued", "running", "needs-you"];

export class InMemoryJobStore implements JobStore {
  public readonly records = new Map<string, JobRecord>();

  save(record: JobRecord): void {
    this.records.set(record.id, { ...record });
  }

  markInterrupted(now: number): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (!LIVE.includes(record.state)) continue;
      record.result = interruptedText(record);
      record.state = "interrupted";
      record.pauseReason = null;
      record.pauseSince = null;
      record.updatedAt = now;
      count += 1;
    }
    return count;
  }

  loadUnacknowledged(since: number): JobRecord[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.kind === "work" &&
          record.background &&
          !record.acknowledged &&
          !LIVE.includes(record.state) &&
          record.updatedAt >= since,
      )
      .map((record) => ({ ...record }));
  }
}

interface Row {
  id: string;
  instruction: string;
  kind: string;
  state: string;
  background: number;
  acknowledged: number;
  created_at: number;
  updated_at: number;
  step: number;
  total: number;
  tool: string | null;
  pause_reason: string | null;
  pause_since: number | null;
  in_flight_tool: string | null;
  in_flight_step: number | null;
  result: string | null;
}

function fromRow(row: Row): JobRecord {
  return {
    id: row.id,
    instruction: row.instruction,
    kind: row.kind === "status" ? "status" : "work",
    state: row.state as JobState,
    background: row.background === 1,
    acknowledged: row.acknowledged === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    step: row.step,
    total: row.total,
    tool: row.tool,
    pauseReason:
      row.pause_reason === "confirm" || row.pause_reason === "foreground-only"
        ? row.pause_reason
        : null,
    pauseSince: row.pause_since,
    inFlightTool: row.in_flight_tool,
    inFlightStep: row.in_flight_step,
    result: row.result,
  };
}

// The `jobs` table (core/memory/db.ts). Same database as memory and the action log, injected —
// this class never decides where the file lives.
export class SqliteJobStore implements JobStore {
  constructor(private readonly db: Database) {}

  save(record: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, instruction, kind, state, background, acknowledged, created_at,
                           updated_at, step, total, tool, pause_reason, pause_since,
                           in_flight_tool, in_flight_step, result)
         VALUES (@id, @instruction, @kind, @state, @background, @acknowledged, @createdAt,
                 @updatedAt, @step, @total, @tool, @pauseReason, @pauseSince,
                 @inFlightTool, @inFlightStep, @result)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, state = excluded.state, background = excluded.background,
           acknowledged = excluded.acknowledged, updated_at = excluded.updated_at,
           step = excluded.step, total = excluded.total, tool = excluded.tool,
           pause_reason = excluded.pause_reason, pause_since = excluded.pause_since,
           in_flight_tool = excluded.in_flight_tool, in_flight_step = excluded.in_flight_step,
           result = excluded.result`,
      )
      .run({
        ...record,
        background: record.background ? 1 : 0,
        acknowledged: record.acknowledged ? 1 : 0,
      });
  }

  markInterrupted(now: number): number {
    const live = this.db
      .prepare<[], Row>(`SELECT * FROM jobs WHERE state IN ('queued', 'running', 'needs-you')`)
      .all();
    const update = this.db.prepare(
      `UPDATE jobs SET state = 'interrupted', result = ?, pause_reason = NULL,
                       pause_since = NULL, updated_at = ?
        WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const row of live) update.run(interruptedText(fromRow(row)), now, row.id);
    });
    tx();
    return live.length;
  }

  loadUnacknowledged(since: number): JobRecord[] {
    return this.db
      .prepare<[number], Row>(
        `SELECT * FROM jobs
          WHERE kind = 'work' AND background = 1 AND acknowledged = 0
            AND state NOT IN ('queued', 'running', 'needs-you') AND updated_at >= ?
          ORDER BY created_at`,
      )
      .all(since)
      .map(fromRow);
  }
}
