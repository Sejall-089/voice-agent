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
  // Is this job shown as background work? Only these are shown in the pill or reported by
  // `jobStatus`: one the user watched finish in the bar is not news. Set when the job is
  // detached from the bar — and at a restart, for an attached job the app closed on while one
  // of its steps was running (`markInterrupted`): that one may have done something the user
  // never saw the end of. An attached job cut off before any step ran stays false.
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
  // When the user first SAW this job in the pill's open list, or null if they never have.
  // It starts the one-hour clock after which a failed or expired job leaves the pill, and the
  // minute after which a done one does (M26) — and it
  // is written down with the job, so restarting the app neither resets that clock nor makes a
  // job the user has not seen look seen. Leaving the pill never deletes this record.
  seenAt: number | null;
  // How many of its steps' handlers were called and have returned or thrown (M27) — something
  // may have happened in each. What tells a job cancelled after doing something (shown in the
  // pill, with its own message) from one cancelled before it did anything (never shown). Saved,
  // so the difference survives a restart.
  stepsRun: number;
}

export interface JobStore {
  save(record: JobRecord): void;
  // Startup only: every job that was still live when the app last stopped becomes
  // `interrupted`, with a sentence saying whether its step may have gone through. Returns how
  // many. NOTHING IS RESUMED — this is a relabelling and no handler is reachable from it.
  //
  // One that was cut off WITH A STEP RUNNING (the write-ahead marker set) is also made
  // `background`, so it is shown even if it never left the bar (live finding after M23: an
  // attached job killed mid-step showed nowhere). Planning, or waiting at a confirm, the marker
  // is not set: such a job is recorded as interrupted and shown only if it was already
  // background. Its sentence already says "may or may not have gone through".
  markInterrupted(now: number): number;
  // Jobs worth showing after a restart: background and unacknowledged, and either ended
  // since `since` — or failed, expired or interrupted at ANY time, or done and never seen (M26),
  // or cancelled after a step ran and never seen (M27).
  // Those wait for the user (core/jobs/pill.ts): one that happened last week and was never seen
  // is still owed.
  loadUnacknowledged(since: number): JobRecord[];
}

const LIVE: readonly JobState[] = ["queued", "running", "needs-you"];

// The write-ahead marker is set: the app closed while a handler was running.
function stepWasRunning(record: { inFlightTool: string | null; inFlightStep: number | null }): boolean {
  return record.inFlightTool !== null && record.inFlightStep !== null;
}
const WAITS_TO_BE_SEEN: readonly JobState[] = ["failed", "expired", "interrupted"];

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
      if (stepWasRunning(record)) record.background = true;
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
          (record.updatedAt >= since ||
            WAITS_TO_BE_SEEN.includes(record.state) ||
            // M26: a done job nobody has seen waits for them too, however old it is.
            (record.state === "done" && record.seenAt === null) ||
            // M27: so does one cancelled AFTER a step ran — it did something.
            (record.state === "cancelled" && record.stepsRun > 0 && record.seenAt === null)),
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
  seen_at: number | null;
  steps_run: number | null;
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
    // NULL on every row written before the column existed: never seen.
    seenAt: row.seen_at ?? null,
    // NULL before M27: counted as none, so a job cancelled then stays hidden.
    stepsRun: row.steps_run ?? 0,
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
                           in_flight_tool, in_flight_step, result, seen_at, steps_run)
         VALUES (@id, @instruction, @kind, @state, @background, @acknowledged, @createdAt,
                 @updatedAt, @step, @total, @tool, @pauseReason, @pauseSince,
                 @inFlightTool, @inFlightStep, @result, @seenAt, @stepsRun)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, state = excluded.state, background = excluded.background,
           acknowledged = excluded.acknowledged, updated_at = excluded.updated_at,
           step = excluded.step, total = excluded.total, tool = excluded.tool,
           pause_reason = excluded.pause_reason, pause_since = excluded.pause_since,
           in_flight_tool = excluded.in_flight_tool, in_flight_step = excluded.in_flight_step,
           result = excluded.result, seen_at = excluded.seen_at, steps_run = excluded.steps_run`,
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
      `UPDATE jobs SET state = 'interrupted', result = ?, background = ?, pause_reason = NULL,
                       pause_since = NULL, updated_at = ?
        WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const row of live) {
        const record = fromRow(row);
        const background = record.background || stepWasRunning(record) ? 1 : 0;
        update.run(interruptedText(record), background, now, row.id);
      }
    });
    tx();
    return live.length;
  }

  loadUnacknowledged(since: number): JobRecord[] {
    return this.db
      .prepare<[number], Row>(
        `SELECT * FROM jobs
          WHERE kind = 'work' AND background = 1 AND acknowledged = 0
            AND state NOT IN ('queued', 'running', 'needs-you')
            AND (updated_at >= ? OR state IN ('failed', 'expired', 'interrupted')
                 OR (state = 'done' AND seen_at IS NULL)
                 OR (state = 'cancelled' AND steps_run > 0 AND seen_at IS NULL))
          ORDER BY created_at`,
      )
      .all(since)
      .map(fromRow);
  }
}
