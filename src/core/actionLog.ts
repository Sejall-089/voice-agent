import type { ActionLog, ActionLogEntry } from "./types.ts";

// M1 in-memory action log. Public arrays are inspectable by tests. M3 replaces this
// with the SQLite action_log table (spec.md §7); the ActionLog interface stays the same.
export class InMemoryActionLog implements ActionLog {
  public readonly entries: ActionLogEntry[] = [];
  public readonly misses: string[] = [];

  logAction(entry: ActionLogEntry): void {
    this.entries.push(entry);
  }

  logMiss(instruction: string): void {
    this.misses.push(instruction);
    this.entries.push({
      ts: new Date().toISOString(),
      instruction,
      tool: null,
      arguments: null,
      result: null,
      status: "no_tool",
    });
  }

  getLast(): ActionLogEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }
}
