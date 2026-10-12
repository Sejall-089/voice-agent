import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_FAILED, createRunInstruction } from "../src/main/runInstruction.ts";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { ActionLogEntry, LLMClient, PlannerOutcome } from "../src/core/types.ts";

// M23-pre (M22 leftover). A run that THREW — the model unreachable, say — was shown in the bar
// and named on the console, but left no row in the action log. It now leaves one: no tool, no
// arguments, the instruction as every row records it, the fixed RUN_FAILED text as the result,
// status `error` — and never the error's own message.

const TOKEN = "xoxb-test-LOGROW-SECRET-8080";
const LEAKY = `Connection error. Bearer ${TOKEN} https://api.openai.com/v1/chat/completions`;
const FORBIDDEN = [TOKEN, "Bearer", "https://", "Connection error"];

class APIConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APIConnectionError";
  }
}

function shell() {
  const results: string[] = [];
  const thinking: boolean[] = [];
  return {
    results,
    thinking,
    showThinking: (on: boolean): void => {
      thinking.push(on);
    },
    showResult: (text: string): void => {
      results.push(text);
    },
  };
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" "));
    });
  }
  return lines;
}

const rejecting = { run: (): Promise<PlannerOutcome> => Promise.reject(new APIConnectionError(LEAKY)) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run that throws leaves one action-log row", () => {
  it("records the instruction, no tool, the fixed result and status error — nothing of the error", async () => {
    const lines = captureConsole();
    const s = shell();
    const rows: ActionLogEntry[] = [];

    await expect(
      createRunInstruction(rejecting, s, { logAction: (entry) => rows.push(entry) })("send these notes to #help"),
    ).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instruction: "send these notes to #help",
      tool: null,
      arguments: null,
      result: RUN_FAILED,
      status: "error",
    });
    expect(Number.isNaN(Date.parse(rows[0]?.ts ?? ""))).toBe(false);
    for (const forbidden of FORBIDDEN) expect(JSON.stringify(rows)).not.toContain(forbidden);

    // Everything else exactly as before.
    expect(s.results).toEqual([RUN_FAILED]);
    expect(lines).toEqual(["[main] error: APIConnectionError"]);
    expect(s.thinking).toEqual([true, false]);
  });

  it("with the real SqliteMemory and a real planner whose model call fails: one error row, last in the log", async () => {
    captureConsole();
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    const llm: LLMClient = {
      chooseTool: () => Promise.reject(new APIConnectionError(LEAKY)),
      complete: () => Promise.resolve(""),
    };
    const mock = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null } });
    const planner = new Planner(llm, mock, registry, memory, memory);

    await createRunInstruction(planner, mock, memory)("summarize this");

    const rows = db.prepare("SELECT instruction, tool, arguments, result, status FROM action_log").all();
    expect(rows).toEqual([
      { instruction: "summarize this", tool: null, arguments: null, result: RUN_FAILED, status: "error" },
    ]);
    expect(memory.getLast()).toMatchObject({ instruction: "summarize this", result: RUN_FAILED, status: "error" });
    expect(mock.results).toEqual([RUN_FAILED]);
    for (const forbidden of FORBIDDEN) expect(JSON.stringify(rows)).not.toContain(forbidden);
  });

  it("does not throw, and still reports in the bar, when the log itself cannot be written", async () => {
    const lines = captureConsole();
    const s = shell();
    const brokenLog = {
      logAction: (): void => {
        throw new Error(`SQLITE_BUSY ${TOKEN}`);
      },
    };

    await expect(createRunInstruction(rejecting, s, brokenLog)("send it")).resolves.toBeUndefined();

    expect(s.results).toEqual([RUN_FAILED]);
    expect(s.thinking).toEqual([true, false]);
    expect(lines).toEqual(["[main] error: APIConnectionError", "[main] error: the action log could not record it"]);
    for (const line of lines) for (const forbidden of [...FORBIDDEN, "SQLITE_BUSY"]) expect(line).not.toContain(forbidden);
  });

  it("writes no row of its own when the run succeeds", async () => {
    captureConsole();
    const s = shell();
    const rows: ActionLogEntry[] = [];
    const outcome: PlannerOutcome = { status: "ok", tool: "summarize", result: "SUMMARY" };
    await createRunInstruction({ run: () => Promise.resolve(outcome) }, s, { logAction: (e) => rows.push(e) })("x");
    expect(rows).toEqual([]);
    expect(s.results).toEqual([]);
  });

  it("writes nothing for an empty instruction", async () => {
    const rows: ActionLogEntry[] = [];
    await createRunInstruction(rejecting, shell(), { logAction: (e) => rows.push(e) })("   ");
    expect(rows).toEqual([]);
  });
});
