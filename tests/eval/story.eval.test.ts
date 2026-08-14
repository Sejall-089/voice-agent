import { describe, it, expect } from "vitest";
import { Planner } from "../../src/core/planner.ts";
import { registry } from "../../src/core/registry.ts";
import { createDatabase } from "../../src/core/memory/db.ts";
import { SqliteMemory } from "../../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../../src/main/shell/MockShell.ts";
import type { Fact, ToolChoice } from "../../src/core/types.ts";
import { FakeLLM } from "../FakeLLM.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MEMORY STORY — the eval harness, and the demo script.
//
// This is ONE continuous scenario, not six independent tests. There is a single
// memory and a single shell for the whole file; every step runs against the state
// the previous step left behind. That continuity IS the demonstration:
//
//   empty memory fails  →  teaching fixes it  →  a correction adapts it  →  recall reveals it
//
// Deterministic: a FakeLLM supplies the tool choice per step (standing in for the
// model's judgment), in-memory SQLite, no network, no API key.
// ─────────────────────────────────────────────────────────────────────────────

const OLD_URL = "https://old.example.com";
const NEW_URL = "https://new.example.com";

const db = createDatabase(":memory:");
const memory = new SqliteMemory(db);
const shell = new MockShell({
  context: { selectedText: null, activeApp: null, activeWindowTitle: null },
});

// One instruction through the full planner path. The FakeLLM stands in for tool choice.
function say(instruction: string, choice: ToolChoice) {
  const planner = new Planner(new FakeLLM(choice), shell, registry, memory, memory);
  return planner.run(instruction);
}

const factsFor = (subject: string): Fact[] =>
  db.prepare<[string], Fact>("SELECT * FROM facts WHERE subject = ? ORDER BY version").all(subject);

const openDashboard: ToolChoice = {
  kind: "tool",
  name: "openTarget",
  input: { target: "my dashboard" },
};

const narrate = (line: string): void => console.log(`      ${line}`);

describe("📖 The memory story (eval harness — one continuous scenario)", () => {
  it("Step 1 — cold memory: 'open my dashboard' cannot resolve, and NOTHING fires", async () => {
    const outcome = await say("open my dashboard", openDashboard);

    expect(outcome.status).toBe("refused");
    expect(shell.actions).toHaveLength(0); // it refuses rather than inventing a URL
    narrate(`❌ "open my dashboard" → refused: ${outcome.result}`);
    narrate("   No action fired. The agent does not guess.");
  });

  it("Step 2 — teach it: 'my dashboard is https://old.example.com'", async () => {
    const outcome = await say("my dashboard is https://old.example.com", {
      kind: "tool",
      name: "remember",
      input: { subject: "target:dashboard", value: OLD_URL },
    });

    expect(outcome.status).toBe("ok");
    expect(memory.resolve("my dashboard")?.value).toBe(OLD_URL);
    narrate(`✅ remembered  target:dashboard = ${OLD_URL}  (v1)`);
  });

  it("Step 3 — the SAME task now works, with no code change", async () => {
    const outcome = await say("open my dashboard", openDashboard);

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toContainEqual({ kind: "openUrl", payload: `${OLD_URL}/` });
    narrate(`✅ "open my dashboard" → opened ${OLD_URL}`);
    narrate("   Same instruction, same code. Only memory changed.");
  });

  it("Step 4 — correct it: 'no, I meant the new one' → v2, the old row is retired", async () => {
    const outcome = await say("no, I meant the new one", {
      kind: "tool",
      name: "remember",
      input: { subject: "target:dashboard", value: NEW_URL },
    });

    expect(outcome.status).toBe("ok");

    const rows = factsFor("target:dashboard");
    expect(rows).toHaveLength(2); // the old fact is KEPT, not overwritten
    expect(rows[0]).toMatchObject({ value: OLD_URL, version: 1, active: 0 });
    expect(rows[1]).toMatchObject({ value: NEW_URL, version: 2, active: 1 });

    narrate(`✏️  corrected → ${NEW_URL}`);
    narrate(`   v1 (${OLD_URL}) retired: active=0.  v2 is now active.`);
    narrate("   The old belief is superseded, not erased — memory can explain itself.");
  });

  it("Step 5 — the same task now uses the CORRECTED value", async () => {
    const before = shell.actions.length;
    const outcome = await say("open my dashboard", openDashboard);

    expect(outcome.status).toBe("ok");
    const fired = shell.actions.slice(before);
    expect(fired).toContainEqual({ kind: "openUrl", payload: `${NEW_URL}/` });
    expect(fired).not.toContainEqual({ kind: "openUrl", payload: `${OLD_URL}/` });

    narrate(`✅ "open my dashboard" → opened ${NEW_URL}`);
    narrate("   The correction stuck. This is what a prompt cannot fake.");
  });

  it("Step 6 — recall reveals the value, version, confidence, and recency", async () => {
    const outcome = await say("what do you know about my dashboard?", {
      kind: "tool",
      name: "recall",
      input: { subject: "dashboard" },
    });

    expect(outcome.status).toBe("ok");
    const shown = outcome.result ?? "";
    expect(shown).toContain(NEW_URL); // the corrected value
    expect(shown).toContain("v2"); // visible proof the correction versioned
    expect(shown).not.toContain(OLD_URL); // the superseded value is not active
    expect(shown).toMatch(/confidence \d\.\d\d/);

    narrate("🧠 recall:");
    shown.split("\n").forEach((line) => narrate(`   ${line}`));
    narrate("   The memory layer is legible: value, version, confidence, recency.");
  });
});
