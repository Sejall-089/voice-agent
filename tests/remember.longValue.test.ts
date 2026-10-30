import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { FACT_VALUE_MAX, TOO_LONG_FACT } from "../src/core/tools/remember.ts";
import type { ToolChoice } from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { bugChain, harness } from "./botChainHarness.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";
import { ROW_591_SHAPE } from "./fixtures/rememberCalls/replay.ts";

// M34, rule D: a clipboard-sized value is not a fact. Row 591 ("Samurai is this.", a misheard
// "Summarize this.") saved a 1,481-character, 25-line clipboard dump. For EVERY write — a first
// write, a replacement, the same value again — a value with a line break or longer than 500
// characters is refused and nothing is saved.

const remember = (subject: string, value: string): ToolChoice => ({ kind: "tool", name: "remember", input: { subject, value } });

interface FactRow {
  subject: string;
  value: string;
  version: number;
  active: number;
}

function world(choice: ToolChoice, options: { facts?: readonly (readonly [string, string])[]; clipboard?: string } = {}) {
  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  for (const [subject, value] of options.facts ?? []) memory.write(subject, value);
  const shell = new MockShell({
    context: { selectedText: options.clipboard ?? null, activeApp: null, activeWindowTitle: null },
  });
  const sender = new FakeSender();
  const planner = new Planner(
    new FakeLLM(choice),
    shell,
    registry,
    memory,
    new InMemoryActionLog(),
    sender,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  const facts = (): FactRow[] =>
    db.prepare<[], FactRow>("SELECT subject, value, version, active FROM facts ORDER BY id").all();
  return { planner, shell, facts };
}

describe("rule D: a clipboard-sized value is refused", () => {
  it("row 591's shape (1,481 characters, 25 lines) under 'Samurai is this.': refused, nothing written", async () => {
    expect(ROW_591_SHAPE).toHaveLength(1481);
    expect(ROW_591_SHAPE.split("\n")).toHaveLength(25);
    const w = world(remember("Samurai", ROW_591_SHAPE), { clipboard: ROW_591_SHAPE });
    const outcome = await w.planner.run("Samurai is this.");
    expect(outcome.status).toBe("refused");
    expect(w.shell.results).toEqual([TOO_LONG_FACT]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([]);
  });

  it("the cap is 500: exactly 500 characters is saved, 501 is refused", async () => {
    expect(FACT_VALUE_MAX).toBe(500);
    const at = world(remember("note", "a".repeat(500)));
    expect((await at.planner.run("remember the note is that")).status).toBe("ok");
    expect(at.facts()).toHaveLength(1);

    const over = world(remember("note", "a".repeat(501)));
    expect((await over.planner.run("remember the note is that")).status).toBe("refused");
    expect(over.shell.results).toEqual([TOO_LONG_FACT]);
    expect(over.facts()).toEqual([]);
  });

  it.each(["one\ntwo", "one\r\ntwo", "one\rtwo"])("a short value with a line break inside (%j) is refused", async (value) => {
    const w = world(remember("note", value));
    const outcome = await w.planner.run("remember the note is that");
    expect(outcome.status).toBe("refused");
    expect(w.facts()).toEqual([]);
  });

  it("a line break only at the ends is trimmed away first, and the value is saved", async () => {
    const w = world(remember("note", "\nshort\n"));
    expect((await w.planner.run("remember the note is short")).status).toBe("ok");
    expect(w.facts()).toEqual([{ subject: "note", value: "short", version: 1, active: 1 }]);
  });

  it("a replacement too: refused before any dialog, the stored value kept", async () => {
    const w = world(remember("team", ROW_591_SHAPE), { facts: [["team", "#social"]] });
    const outcome = await w.planner.run("remember the team is this");
    expect(outcome.status).toBe("refused");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it("the same value again too: a long stored value is not refreshed", async () => {
    const long = "b".repeat(600);
    const w = world(remember("note", long), { facts: [["note", long]] });
    const outcome = await w.planner.run("remember the note is that");
    expect(outcome.status).toBe("refused");
    expect(w.shell.results).toEqual([TOO_LONG_FACT]);
  });

  it("CONTROL: an ordinary long-ish URL is saved", async () => {
    const url = `https://docs.example.com/spreadsheets/d/${"a1B2".repeat(15)}/edit?gid=0`;
    const w = world(remember("target:sheet", url));
    expect((await w.planner.run(`remember my sheet is ${url}`)).status).toBe("ok");
    expect(w.facts()).toEqual([{ subject: "target:sheet", value: url, version: 1, active: 1 }]);
  });
});

describe("the ask path is untouched", () => {
  // `settleReferences` saves a typed answer with `memory.write` and never through `remember`, so
  // neither rule D nor rule B applies to it. It only asks in bot mode, where the answer must be a
  // channel Slack has (a name of at most 80 characters), so a clipboard-sized answer cannot reach
  // it; what this pins is that the answer is saved without passing either rule. The instruction
  // does not say "bugs channel", so a write that went through `remember` would be refused by B.
  it("'file this bug on GitHub and tell the channel', asked which channel 'the bugs channel' is: the answer is saved", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["#help"] });
    await h.planner.run("file this bug on GitHub and tell the channel");
    expect(h.shell.questions.length).toBeGreaterThan(0);
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
    expect(h.shell.results).not.toContain(TOO_LONG_FACT);
  });
});

describe("the refusal's text", () => {
  it("plain ASCII, no question, and says nothing was saved", () => {
    expect(TOO_LONG_FACT).toMatch(/^[\x20-\x7e]+$/);
    expect(TOO_LONG_FACT).not.toContain("?");
    expect(TOO_LONG_FACT).toContain("Nothing was saved.");
  });
});
