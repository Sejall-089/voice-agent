import { describe, it, expect, beforeEach } from "vitest";
import { Planner } from "../../src/core/planner.ts";
import { registry } from "../../src/core/registry.ts";
import { createDatabase } from "../../src/core/memory/db.ts";
import { SqliteMemory } from "../../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../../src/main/shell/MockShell.ts";
import type { ToolChoice } from "../../src/core/types.ts";
import { FakeLLM } from "../FakeLLM.ts";
import { FakeSender } from "../FakeSender.ts";

// The seven demo tasks of spec.md §6, each asserted end to end through the planner —
// plus the eighth case that matters: an unregistered request must refuse and log a miss.
//
// Deterministic: the FakeLLM stands in for the model's tool choice. What is proved here is
// that ONCE a tool is chosen, the whole machine does the right thing.

const NOTES = "standup: shipped memory, next slack, no blockers";

let memory: SqliteMemory;
let shell: MockShell;
let sender: FakeSender;

function run(instruction: string, choice: ToolChoice, completion = "LLM-OUTPUT") {
  const planner = new Planner(
    new FakeLLM(choice, completion),
    shell,
    registry,
    memory,
    memory,
    sender,
  );
  return planner.run(instruction);
}

beforeEach(() => {
  memory = new SqliteMemory(createDatabase(":memory:"));
  shell = new MockShell({
    context: { selectedText: NOTES, activeApp: null, activeWindowTitle: null },
    confirms: [true],
  });
  sender = new FakeSender();
  // The user's known facts.
  memory.write("tone", "concise and warm", { confidence: 0.9 });
  memory.write("team", "#design-team", { confidence: 0.9 });
  memory.write("target:dashboard", "https://dash.example.com", { confidence: 0.9 });
});

describe("✅ The seven demo tasks (spec §6)", () => {
  it("1. Summarize the selection", async () => {
    const outcome = await run(
      "summarize this",
      { kind: "tool", name: "summarize", input: {} },
      "A SUMMARY",
    );
    expect(outcome.status).toBe("ok");
    expect(shell.results).toContain("A SUMMARY");
  });

  it("2. Rewrite the selection in my tone (tone comes from memory)", async () => {
    const outcome = await run(
      "rewrite this in my tone",
      { kind: "tool", name: "rewrite", input: { tone: "my tone" } },
      "REWRITTEN",
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.result).toContain("concise and warm"); // resolved from memory
    expect(shell.actions).toContainEqual({ kind: "copyToClipboard", payload: "REWRITTEN" });
  });

  it("3. Open a named target (resolved from memory)", async () => {
    const outcome = await run("open my dashboard", {
      kind: "tool",
      name: "openTarget",
      input: { target: "my dashboard" },
    });
    expect(outcome.status).toBe("ok");
    expect(shell.actions).toContainEqual({
      kind: "openUrl",
      payload: "https://dash.example.com/",
    });
  });

  it("4. Remember a new fact", async () => {
    const outcome = await run("remember my upwork is https://upwork.com/me", {
      kind: "tool",
      name: "remember",
      input: { subject: "target:upwork", value: "https://upwork.com/me" },
    });
    expect(outcome.status).toBe("ok");
    expect(memory.resolve("my upwork")?.value).toBe("https://upwork.com/me");
  });

  it("5. Format notes and send them (irreversible → confirmed first)", async () => {
    const outcome = await run(
      "send these notes to the team",
      { kind: "tool", name: "sendMessage", input: { channel: "the team" } },
      "FORMATTED",
    );
    expect(outcome.status).toBe("ok");
    expect(shell.confirmMessages[0]).toContain("#design-team"); // confirmed the RESOLVED action
    expect(sender.calls).toEqual([{ channel: "#design-team", text: "FORMATTED" }]);
  });

  it("6. A correction sticks (versions the old fact, changes future behavior)", async () => {
    await run("no, I meant #general", {
      kind: "tool",
      name: "remember",
      input: { subject: "team", value: "#general" },
    });

    // The next send goes to the corrected channel.
    await run(
      "send these notes to the team",
      { kind: "tool", name: "sendMessage", input: { channel: "the team" } },
      "FORMATTED",
    );

    expect(sender.calls[0]?.channel).toBe("#general");
    expect(sender.calls[0]?.channel).not.toBe("#design-team");
  });

  it("7. Recall what is remembered, with metadata", async () => {
    const outcome = await run("what do you remember about the team?", {
      kind: "tool",
      name: "recall",
      input: { subject: "team" },
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.result).toContain("#design-team");
    expect(outcome.result).toMatch(/confidence \d\.\d\d/);
    expect(outcome.result).toMatch(/v\d/);
  });
});

describe("🚫 The closed world holds", () => {
  it("an unregistered request is refused and logged as a miss — never faked", async () => {
    const outcome = await run("book me a flight to Tokyo", { kind: "none", text: "I can't." });

    expect(outcome.status).toBe("no_tool");
    expect(shell.results[0]).toMatch(/can't do that yet/i);
    expect(shell.actions).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);

    // The miss is recorded as a ranked backlog of what to build next (spec §8).
    const misses = memory.query(""); // facts untouched
    expect(misses).toHaveLength(3);
  });

  it("a hallucinated tool never runs", async () => {
    const outcome = await run("do the impossible", {
      kind: "tool",
      name: "deleteAllFiles",
      input: {},
    });

    expect(outcome.status).toBe("no_tool");
    expect(shell.actions).toHaveLength(0);
  });
});
