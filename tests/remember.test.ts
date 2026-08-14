import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, Fact, ToolChoice } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";
import type { Database } from "better-sqlite3";

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// One DB + one MockShell, but a fresh planner per turn — because each turn is a separate
// instruction and the LLM proposes a different tool each time. This mirrors the real app,
// where memory persists across hotkey presses.
function session(selectedText: string | null = null) {
  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  const shell = new MockShell({ context: contextWith(selectedText) });

  // Run one instruction with a canned LLM tool choice, through the full planner path.
  const turn = (choice: ToolChoice, instruction: string, completion = "") => {
    const planner = new Planner(new FakeLLM(choice, completion), shell, registry, memory, memory);
    return planner.run(instruction);
  };

  const factsFor = (subject: string): Fact[] =>
    db
      .prepare<[string], Fact>("SELECT * FROM facts WHERE subject = ? ORDER BY version")
      .all(subject);

  return { db, memory, shell, turn, factsFor };
}

describe("remember (M4)", () => {
  it("stores a new fact through the planner", async () => {
    const { memory, turn, factsFor } = session();

    const outcome = await turn(
      { kind: "tool", name: "remember", input: { subject: "tone", value: "concise and warm" } },
      "remember my tone is concise and warm",
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("remember");
    expect(factsFor("tone")).toHaveLength(1);
    expect(memory.resolve("my tone")?.value).toBe("concise and warm");
  });

  // The guard: remember's args are LITERALS to store, not references to resolve. Even when the
  // model hands us a non-compliant subject like "the team", the planner must not swap it for the
  // fact's current value (#general) before the handler sees it.
  it("does not let the resolve step clobber the subject it is being told to write", async () => {
    const { memory, turn, factsFor } = session();
    memory.write("team", "#general");

    await turn(
      { kind: "tool", name: "remember", input: { subject: "the team", value: "#design-team" } },
      "the team is the design channel",
    );

    // Stored under the canonical subject, with the value we were given...
    const rows = factsFor("team");
    expect(rows.at(-1)).toMatchObject({ subject: "team", value: "#design-team", active: 1 });
    // ...and NOT under a subject corrupted into the old value.
    expect(factsFor("#general")).toHaveLength(0);
  });
});

describe("🏆 the correction loop (M4 flagship)", () => {
  // The whole point of the milestone: a correction routed through the planner versions the old
  // fact AND changes what a DIFFERENT tool does on a later turn. Not a direct memory.write()
  // assertion — that layer was proved in M3. This goes instruction → planner → remember → write
  // → resolve → openTarget → real side effect.
  it("a correction supersedes the old fact and changes future behavior", async () => {
    const { memory, shell, turn, factsFor } = session();
    memory.write("target:dashboard", "https://old.example.com");

    // Turn 1 — the user corrects us.
    const correction = await turn(
      {
        kind: "tool",
        name: "remember",
        input: { subject: "target:dashboard", value: "https://new.example.com" },
      },
      "no, I meant the new dashboard",
    );

    expect(correction.status).toBe("ok");

    // The old fact was versioned, not overwritten.
    const rows = factsFor("target:dashboard");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ value: "https://old.example.com", version: 1, active: 0 });
    expect(rows[1]).toMatchObject({ value: "https://new.example.com", version: 2, active: 1 });
    // The correction is visible to the user, not silent.
    expect(correction.result).toContain("https://new.example.com");

    // Turn 2 — a DIFFERENT tool, a later instruction. It resolves to the corrected value.
    const open = await turn(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } },
      "open my dashboard",
    );

    expect(open.status).toBe("ok");
    expect(shell.actions).toContainEqual({
      kind: "openUrl",
      payload: "https://new.example.com/",
    });
    expect(shell.actions).not.toContainEqual({
      kind: "openUrl",
      payload: "https://old.example.com/",
    });
  });

  // The spec's literal flagship narrative (§6 task 6). sendMessage lands in M5, so the *read* is
  // asserted via resolve — but the WRITE still routes through the planner, not a direct call.
  it("'no, I meant the design channel' changes what 'the team' resolves to", async () => {
    const { memory, turn } = session();
    memory.write("team", "#general");
    expect(memory.resolve("the team")?.value).toBe("#general");

    await turn(
      { kind: "tool", name: "remember", input: { subject: "team", value: "#design-team" } },
      "no, I meant the design channel",
    );

    expect(memory.resolve("the team")?.value).toBe("#design-team");
  });

  it("a corrected tone reaches the rewrite tool on the next turn", async () => {
    const { memory, turn } = session("hey can u send me that thing");
    memory.write("tone", "stiff and formal");

    await turn(
      { kind: "tool", name: "remember", input: { subject: "tone", value: "concise and warm" } },
      "actually my tone is concise and warm",
    );

    const rewritten = await turn(
      { kind: "tool", name: "rewrite", input: { tone: "my tone" } },
      "rewrite this in my tone",
      "REWRITTEN",
    );

    expect(rewritten.status).toBe("ok");
    expect(rewritten.result).toContain("concise and warm");
    expect(rewritten.result).not.toContain("stiff and formal");
  });
});
