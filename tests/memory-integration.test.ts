import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, ToolChoice } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// Same composition the real app uses (SqliteMemory as BOTH resolver and action log),
// with the LLM and shell swapped for test doubles.
function harness(choice: ToolChoice, completion: string, selectedText: string | null) {
  const db = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  const shell = new MockShell({ context: contextWith(selectedText) });
  const llm = new FakeLLM(choice, completion);
  const planner = new Planner(llm, shell, registry, memory, memory);
  return { db, memory, shell, llm, planner };
}

describe("M3 payoff: the same handlers get smarter because the resolver did", () => {
  // In M2 this exact case had to refuse. The tool file and planner have not changed —
  // only what sits behind the resolver seam.
  it("openTarget now opens 'my dashboard' from a stored fact", async () => {
    const { memory, shell, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } }, // no url from the LLM
      "",
      null,
    );
    memory.write("target:dashboard", "https://dash.example.com");

    const outcome = await planner.run("open my dashboard");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toContainEqual({
      kind: "openUrl",
      payload: "https://dash.example.com/",
    });
  });

  it("still refuses to fabricate a URL when the fact was never taught", async () => {
    const { shell, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } },
      "",
      null,
    );
    // no write() — memory has never heard of "my dashboard"

    const outcome = await planner.run("open my dashboard");

    // M6: an unresolved reference is an honest refusal, not a malfunction.
    expect(outcome.status).toBe("refused");
    expect(shell.actions).toHaveLength(0);
  });

  it("rewrite now uses the stored tone", async () => {
    const { memory, shell, planner } = harness(
      { kind: "tool", name: "rewrite", input: { tone: "my usual tone" } },
      "REWRITTEN",
      "hey can u send me that thing",
    );
    memory.write("tone", "concise, warm, and direct");

    const outcome = await planner.run("rewrite this in my tone");

    expect(outcome.status).toBe("ok");
    // The resolved tone reached the handler and shows up in its result line.
    expect(outcome.result).toContain("concise, warm, and direct");
    expect(shell.actions).toContainEqual({ kind: "copyToClipboard", payload: "REWRITTEN" });
  });

  it("a correction changes what the next run resolves (pre-proves M4)", async () => {
    const { memory, shell, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } },
      "",
      null,
    );
    memory.write("target:dashboard", "https://old.example.com");
    memory.write("target:dashboard", "https://new.example.com"); // the correction

    await planner.run("open my dashboard");

    expect(shell.actions).toContainEqual({
      kind: "openUrl",
      payload: "https://new.example.com/",
    });
    expect(shell.actions).not.toContainEqual({
      kind: "openUrl",
      payload: "https://old.example.com/",
    });
  });

  it("persists a miss to the SQLite action log", async () => {
    const { db, planner } = harness({ kind: "none", text: "no" }, "", null);

    await planner.run("book me a flight");

    // Same ActionLog interface the planner always used — it just persists now.
    const rows = db
      .prepare<[], { instruction: string; tool: string | null; status: string }>(
        "SELECT instruction, tool, status FROM action_log",
      )
      .all();

    expect(rows).toEqual([{ instruction: "book me a flight", tool: null, status: "no_tool" }]);
  });

  it("persists a successful action to the SQLite action log", async () => {
    const { db, memory, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } },
      "",
      null,
    );
    memory.write("target:dashboard", "https://dash.example.com");

    await planner.run("open my dashboard");

    const row = db
      .prepare<[], { tool: string; status: string; arguments: string }>(
        "SELECT tool, status, arguments FROM action_log",
      )
      .get();

    expect(row).toMatchObject({ tool: "openTarget", status: "ok" });
    // The RESOLVED args were logged — you can see what memory turned the reference into.
    // (The value is logged as stored; the handler's URL normalization adds the trailing
    // slash later and does not mutate the args.)
    expect(JSON.parse(row?.arguments ?? "{}")).toMatchObject({
      target: "https://dash.example.com",
    });
  });
});
