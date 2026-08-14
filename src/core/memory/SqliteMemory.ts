import type { Database } from "better-sqlite3";
import { normalizeReference } from "./normalize.ts";
import { decayed } from "./decay.ts";
import type {
  ActionLog,
  ActionLogEntry,
  Fact,
  Memory,
  ResolvedFact,
  ToolInput,
  WriteOptions,
} from "../types.ts";

// A value is treated as a vague reference when it's phrased like one ("my dashboard",
// "the team", "the usual tone"). Literal values ("formal", "https://…") are left alone.
function isVagueReference(value: string): boolean {
  return /^\s*(my|the)\s+\S/i.test(value);
}

// The memory engine (spec.md §7). It implements MemoryResolver, so it drops straight into
// the planner's existing seam, and ActionLog, so the same instance persists the action log.
// The Database is INJECTED — this class never decides where the DB lives and never imports
// electron, which is what keeps /core portable and headless-testable.
export class SqliteMemory implements Memory, ActionLog {
  constructor(private readonly db: Database) {}

  // --- The seam the planner already calls (step 4 of spec §5) ---
  //
  // For each argument whose VALUE looks like a vague reference, swap in the concrete value.
  // It inspects values, never argument names — so it holds no tool-specific knowledge and
  // every tool (present and future) benefits without changing.
  resolveArgs(input: ToolInput): Promise<ToolInput> {
    const resolved: ToolInput = { ...input };
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value !== "string" || !isVagueReference(value)) continue;
      const hit = this.resolve(value);
      if (hit) {
        resolved[key] = hit.value;
      }
    }
    return Promise.resolve(resolved);
  }

  // Map a vague reference to a concrete active fact, applying light decay.
  // Honors the spec's "target:" subject convention without knowing which tool asked.
  resolve(reference: string): ResolvedFact | null {
    const subject = normalizeReference(reference);
    if (subject.length === 0) return null;

    const row = this.db
      .prepare<[string, string], Fact>(
        `SELECT * FROM facts
          WHERE active = 1 AND subject IN (?, 'target:' || ?)
          ORDER BY confidence DESC, updated_at DESC, id DESC
          LIMIT 1`,
      )
      .get(subject, subject);

    if (!row) return null;
    return { value: row.value, confidence: decayed(row.confidence, row.updated_at) };
  }

  // Version-on-conflict: a differing value NEVER overwrites — the old row is deactivated and
  // a new version is inserted. This is what makes M4's "correction sticks" a small addition.
  write(subject: string, value: string, opts: WriteOptions = {}): void {
    const now = new Date().toISOString();
    const confidence = opts.confidence ?? 0.8;
    const source = opts.source ?? null;

    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare<[string], Fact>(
          `SELECT * FROM facts WHERE subject = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
        )
        .get(subject);

      if (current && current.value === value) {
        // Same fact re-asserted — refresh recency/confidence, no new version.
        this.db
          .prepare(`UPDATE facts SET updated_at = ?, confidence = ?, source = ? WHERE id = ?`)
          .run(now, confidence, source, current.id);
        return;
      }

      if (current) {
        // Contradiction: supersede the old row, insert the next version.
        this.db.prepare(`UPDATE facts SET active = 0, updated_at = ? WHERE id = ?`).run(now, current.id);
      }

      this.db
        .prepare(
          `INSERT INTO facts (subject, value, confidence, source, version, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(subject, value, confidence, source, (current?.version ?? 0) + 1, now, now);
    });

    tx();
  }

  // Active facts for display (used by `recall` in M6).
  query(subjectLike: string): Fact[] {
    return this.db
      .prepare<[string], Fact>(
        `SELECT * FROM facts WHERE active = 1 AND subject LIKE ? ORDER BY updated_at DESC`,
      )
      .all(`%${subjectLike}%`);
  }

  // --- ActionLog (same interface InMemoryActionLog implements; now it persists) ---

  logAction(entry: ActionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO action_log (ts, instruction, tool, arguments, result, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.instruction,
        entry.tool,
        entry.arguments ? JSON.stringify(entry.arguments) : null,
        entry.result,
        entry.status,
      );
  }

  logMiss(instruction: string): void {
    this.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool: null,
      arguments: null,
      result: null,
      status: "no_tool",
    });
  }
}
