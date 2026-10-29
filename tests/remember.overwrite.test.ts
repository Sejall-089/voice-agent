import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { resolveRisk } from "../src/core/risk.ts";
import { toSpokenConfirm } from "../src/core/speech.ts";
import { DIALOG_VALUE_MAX, changeQuestion, rememberTool } from "../src/core/tools/remember.ts";
import type { Memory, MessageSender, ToolChoice, ToolDeps } from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeBotSender, harness } from "./botChainHarness.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";
import { CLIPBOARD_MARKER, REMEMBER_CALLS, type RememberCall } from "./fixtures/rememberCalls/replay.ts";
import { jobWorld, settle } from "./jobWorld.ts";

// M33. `remember` asks before it REPLACES a different value: an argument-dependent tier,
// "dangerous" exactly when an active fact with this very subject holds a value other than the one
// `prepare` settled. A first write, the same value again, and anything `prepare` refused stay
// silent. The dialog is the tool's own question; Cancel writes nothing; Approve versions the old row.

const remember = (subject: string, value: string): ToolChoice => ({
  kind: "tool",
  name: "remember",
  input: { subject, value },
});

interface FactRow {
  subject: string;
  value: string;
  version: number;
  active: number;
}

// The real planner and registry, a real SQLite memory, webhook mode (a sender that says nothing).
function world(choice: ToolChoice, options: { facts?: readonly (readonly [string, string])[]; confirms?: boolean[]; memory?: (inner: SqliteMemory) => Memory } = {}) {
  const db: Database = createDatabase(":memory:");
  const sqlite = new SqliteMemory(db);
  for (const [subject, value] of options.facts ?? []) sqlite.write(subject, value);
  const memory = options.memory ? options.memory(sqlite) : sqlite;
  const shell = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null }, confirms: options.confirms ?? [] });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    new FakeLLM(choice),
    shell,
    registry,
    memory,
    log,
    new FakeSender(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  const facts = (): FactRow[] =>
    db.prepare<[], FactRow>("SELECT subject, value, version, active FROM facts ORDER BY id").all();
  return { planner, shell, log, facts };
}

describe("when remember asks", () => {
  it("a first write: no dialog, saved as v1", async () => {
    const w = world(remember("team", "#social"));
    const outcome = await w.planner.run("remember that team is #social");
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it("the same value again: no dialog, still one row at v1", async () => {
    const w = world(remember("team", "#social"), { facts: [["team", "#social"]] });
    const outcome = await w.planner.run("remember that team is #social");
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it("a different value: the dialog names both values, with the tool's own button", async () => {
    const w = world(remember("team", "#fun"), { facts: [["team", "#social"]] });
    await w.planner.run("remember the team is #fun");
    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to #fun?']);
    expect(w.shell.confirmLabels).toEqual(["Change it"]);
  });

  it("a weaker form (#social -> social) is a different value, and asks", async () => {
    const w = world(remember("team", "social"), { facts: [["team", "#social"]] });
    await w.planner.run("actually, post it in social instead");
    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to social?']);
  });

  it("matches the subject EXACTLY: 'channel' is not 'bugs channel'", async () => {
    const w = world(remember("channel", "#fun"), { facts: [["bugs channel", "#help"]] });
    const outcome = await w.planner.run("remember the channel is #fun");
    // The precondition: memory's own LIKE lookup WOULD find the other fact.
    expect(w.facts().map((f) => f.subject)).toContain("bugs channel");
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
  });

  it("a subject the model wrote as 'the team' is judged as 'team'", async () => {
    const w = world(remember("the team", "#fun"), { facts: [["team", "#social"]] });
    await w.planner.run("the team is #fun");
    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to #fun?']);
  });
});

describe("what Cancel and Approve do", () => {
  it("Cancel leaves the facts table exactly as it was, and logs the row cancelled", async () => {
    const w = world(remember("team", "social"), { facts: [["team", "#social"], ["tone", "warm"]] });
    const before = w.facts();
    const outcome = await w.planner.run("actually, post it in social instead");

    expect(outcome.status).toBe("cancelled");
    expect(w.facts()).toEqual(before);
    expect(w.shell.results).toEqual([]);
    expect(w.log.entries).toEqual([
      expect.objectContaining({ tool: "remember", arguments: { subject: "team", value: "social" }, status: "cancelled" }),
    ]);
  });

  it("Approve writes v2 and keeps v1, inactive", async () => {
    const w = world(remember("team", "social"), { facts: [["team", "#social"]], confirms: [true] });
    const outcome = await w.planner.run("actually, post it in social instead");

    expect(outcome.status).toBe("ok");
    expect(w.shell.results).toEqual(['Updated "team": #social → social (v2).']);
    expect(w.facts()).toEqual([
      { subject: "team", value: "#social", version: 1, active: 0 },
      { subject: "team", value: "social", version: 2, active: 1 },
    ]);
  });
});

describe("bot mode: the dialog shows what prepare settled", () => {
  it("'Social' for a channel fact holding #social is the same value: no dialog", async () => {
    const h = harness(remember("social channel", "Social"), { facts: { "social channel": "#social" }, confirms: [] });
    const outcome = await h.planner.run("the social channel is Social");
    expect(outcome.status).toBe("ok");
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.facts()).toEqual([{ subject: "social channel", value: "#social", active: 1 }]);
  });

  it("against #help, the dialog shows Slack's #social, not the typed 'Social'", async () => {
    const h = harness(remember("bugs channel", "Social"), { facts: { "bugs channel": "#help" }, confirms: [] });
    await h.planner.run("the bugs channel is Social");
    expect(h.shell.confirmMessages).toEqual(['Change what I remember for "bugs channel" from #help to #social?']);
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
  });

  it("asks Slack once, in prepare: approving does not look the channel up again", async () => {
    const h = harness(remember("bugs channel", "Social"), { facts: { "bugs channel": "#help" }, confirms: [true] });
    await h.planner.run("the bugs channel is Social");
    expect(h.directory.calls).toEqual(["Social"]);
    expect(h.facts()).toEqual([
      { subject: "bugs channel", value: "#help", active: 0 },
      { subject: "bugs channel", value: "#social", active: 1 },
    ]);
  });

  it("a channel Slack does not have is refused before any dialog, with nothing written", async () => {
    const h = harness(remember("bugs channel", "#nope"), { facts: { "bugs channel": "#help" }, confirms: [true] });
    const outcome = await h.planner.run("the bugs channel is #nope");
    expect(outcome.status).toBe("refused");
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
  });
});

describe("a memory that cannot be read", () => {
  // The lookup `remember` makes — one subject's facts — fails. Listing every fact (`query("")`,
  // which M31's check makes on every lone call) still answers: a memory that failed THAT read
  // would end the run before any tool, which is not the path under test.
  const unreadable = (inner: SqliteMemory): Memory => ({
    resolveArgs: (input) => inner.resolveArgs(input),
    resolve: (reference) => inner.resolve(reference),
    query: (subject) => {
      if (subject === "") return inner.query(subject);
      throw new Error("database is locked");
    },
    write: (subject, value, opts) => inner.write(subject, value, opts),
  });

  it("escalates the tier to dangerous", async () => {
    const memory = unreadable(new SqliteMemory(createDatabase(":memory:")));
    const tier = await resolveRisk(rememberTool.risk, { subject: "team", value: "#fun" }, { memory } as unknown as ToolDeps);
    expect(tier).toBe("dangerous");
  });

  it("asks, saying it could not check; Cancel writes nothing", async () => {
    const writes: string[] = [];
    const w = world(remember("team", "#fun"), {
      facts: [["team", "#social"]],
      memory: (inner) => {
        const broken = unreadable(inner);
        return { ...broken, write: (s, v, o) => (writes.push(`${s}=${v}`), inner.write(s, v, o)) };
      },
    });
    await w.planner.run("remember the team is #fun");
    expect(w.shell.confirmMessages).toEqual([
      `Change what I remember for "team" to #fun? I couldn't check what it holds now.`,
    ]);
    expect(writes).toEqual([]);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });
});

describe("inside a chain, and in a detached job", () => {
  it("a chain's step gets the step prefix", async () => {
    const choice: ToolChoice = {
      kind: "plan",
      steps: [
        { tool: "recall", arguments: { subject: "team" }, describe: "look it up" },
        { tool: "remember", arguments: { subject: "team", value: "#fun" }, describe: "change it" },
      ],
    };
    const w = world(choice, { facts: [["team", "#social"]] });
    await w.planner.run("check the team and then make it #fun");
    expect(w.shell.confirmMessages).toEqual(['Step 2 of 2: Change what I remember for "team" from #social to #fun?']);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it("a detached job waits at the pill for it, opening no dialog and writing nothing", async () => {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    memory.write("team", "#social");
    const w = jobWorld({ script: { "remember the team is #fun": remember("team", "#fun") }, tools: [rememberTool], memory });

    const running = w.run("remember the team is #fun");
    w.manager.detachAttached("hotkey");
    await settle();

    expect(w.manager.get("job1")).toMatchObject({ state: "needs-you", waitingFor: "confirm", tool: "remember" });
    expect(w.shell.confirmMessages).toEqual([]);
    expect(memory.resolve("the team")?.value).toBe("#social");

    w.manager.cancel("job1");
    await running;
    expect(memory.resolve("the team")?.value).toBe("#social");
  });

  it("a detached job's first write does not wait", async () => {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    const w = jobWorld({ script: { "remember the team is #fun": remember("team", "#fun") }, tools: [rememberTool], memory });
    const running = w.run("remember the team is #fun");
    w.manager.detachAttached("hotkey");
    await running;
    expect(w.manager.get("job1")?.state).toBe("done");
    expect(memory.resolve("the team")?.value).toBe("#fun");
  });
});

describe("the dialog's text", () => {
  it("cuts a value over 200 characters in the dialog only; the saved value stays whole", async () => {
    const old = "o".repeat(250);
    const next = "n".repeat(300);
    const w = world(remember("notes", next), { facts: [["notes", old]], confirms: [true] });
    await w.planner.run("my notes are these");

    expect(w.shell.confirmMessages).toEqual([
      `Change what I remember for "notes" from ${"o".repeat(DIALOG_VALUE_MAX)}... to ${"n".repeat(DIALOG_VALUE_MAX)}...?`,
    ]);
    expect(w.facts().find((f) => f.active === 1)?.value).toBe(next);
  });

  it("does not cut a value of exactly 200 characters", () => {
    const exact = "x".repeat(DIALOG_VALUE_MAX);
    expect(changeQuestion("notes", { kind: "value", value: exact }, "y")).toBe(
      `Change what I remember for "notes" from ${exact} to y?`,
    );
  });

  it("is plain ASCII around the values, and spoken whole", () => {
    const forms = [
      changeQuestion("team", { kind: "value", value: "#social" }, "social"),
      changeQuestion("team", { kind: "unread" }, "social"),
      changeQuestion("team", { kind: "nothing" }, "social"),
    ];
    for (const text of forms) {
      expect(text, text).toMatch(/^[\x20-\x7e]+$/);
      expect(toSpokenConfirm(text).remainder, text).toBeNull(); // spoken whole, nothing held back
    }
    // AS SPOKEN, the speech layer drops the quotes and the "#" — so the weaker-form case, the very
    // one M33 is for, is heard as "from social to social". The dialog's text shows the difference;
    // the voice does not. Pinned as it is, and recorded as an M33 finding, not fixed here.
    expect(toSpokenConfirm(forms[0]!).text).toBe("Change what I remember for team from social to social?");
    expect(toSpokenConfirm(forms[1]!).text).toBe("Change what I remember for team to social? I couldn't check what it holds now.");
    expect(toSpokenConfirm(forms[2]!).text).toBe("Remember team as social?");
  });
});

// The phrasing set: what the model is likely to plan for each instruction, in two memory states.
// The dialog appears only where a DIFFERENT value is already stored — the instruction's wording
// plays no part, which is the point of B over a word-list check.
describe("the phrasing set: corrections and real remembers", () => {
  const PHRASES: { instruction: string; kind: "correction" | "remember"; subject: string; value: string; other: string }[] = [
    { instruction: "actually, post it in social instead", kind: "correction", subject: "team", value: "social", other: "#general" },
    { instruction: "no, send it to help", kind: "correction", subject: "team", value: "help", other: "#general" },
    { instruction: "no, I meant the design channel", kind: "correction", subject: "team", value: "#design-team", other: "#general" },
    { instruction: "actually it's #design-team", kind: "correction", subject: "team", value: "#design-team", other: "#general" },
    { instruction: "remember that team is #social", kind: "remember", subject: "team", value: "#social", other: "#general" },
    { instruction: "my name is Sam Placeholder", kind: "remember", subject: "name", value: "Sam Placeholder", other: "Alex Placeholder" },
    { instruction: "the design channel is #design-team", kind: "remember", subject: "design channel", value: "#design-team", other: "#design-old" },
    { instruction: "remember my dashboard is https://dash.example.com", kind: "remember", subject: "target:dashboard", value: "https://dash.example.com", other: "https://old.example.com" },
  ];

  it.each(PHRASES)("$kind '$instruction', memory empty: no dialog", async ({ instruction, subject, value }) => {
    const w = world(remember(subject, value));
    await w.planner.run(instruction);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([{ subject, value, version: 1, active: 1 }]);
  });

  it.each(PHRASES)("$kind '$instruction', a different value stored: the dialog", async ({ instruction, subject, value, other }) => {
    const w = world(remember(subject, value), { facts: [[subject, other]] });
    await w.planner.run(instruction);
    expect(w.shell.confirmMessages).toEqual([`Change what I remember for "${subject}" from ${other} to ${value}?`]);
    expect(w.facts()).toEqual([{ subject, value: other, version: 1, active: 1 }]);
  });
});

// Every remember call on record, through the real planner. Cancelled where a dialog appears (the
// facts must not move), approved on a second run to show the recorded result is still reached;
// rows with no dialog must reproduce what the app recorded.
describe("the replay: every recorded remember call", () => {
  function replayWorld(call: RememberCall, confirms: boolean[]) {
    const db: Database = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    for (const [subject, value] of call.before) memory.write(subject, value);
    const shell = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null }, confirms });
    const bot = call.mode === "bot";
    const planner = new Planner(
      new FakeLLM(remember(call.arguments.subject, call.arguments.value)),
      shell,
      registry,
      memory,
      new InMemoryActionLog(),
      (bot ? new FakeBotSender() : new FakeSender()) as MessageSender,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => Promise.resolve(),
      undefined,
      // Slack as it was on 2026-10-12: no #fun yet.
      bot ? new FakeChannelDirectory({ channels: [{ id: "C1", name: "help" }, { id: "C2", name: "social" }, { id: "C3", name: "general" }] }) : undefined,
    );
    const facts = (): FactRow[] =>
      db.prepare<[], FactRow>("SELECT subject, value, version, active FROM facts ORDER BY id").all();
    return { planner, shell, facts };
  }

  it("holds every row, with names and the clipboard dump as markers", () => {
    expect(REMEMBER_CALLS.filter((c) => c.source === "action log")).toHaveLength(12);
    const text = JSON.stringify(REMEMBER_CALLS);
    expect(text).toContain(CLIPBOARD_MARKER);
    expect(text).not.toMatch(/Sejal|Lisa|Gupta|Don't change any code/);
  });

  it("asks on exactly rows 323, 389, 435, M32's row and the flagship corrections", () => {
    expect(REMEMBER_CALLS.filter((c) => c.dialog).map((c) => c.id)).toEqual([
      "row 323",
      "row 389",
      "row 435",
      "M32 correction",
      "demoTasks #6",
      "story step 4",
      "remember.test subject guard",
      "M4 flagship: the new dashboard",
      "M4 flagship: the design channel",
      "M4 flagship: the tone",
    ]);
  });

  it.each(REMEMBER_CALLS)("$id ($source)", async (call) => {
    // The log records an error's bare message; the bar shows it after the planner's lead.
    const shown = call.status === "error" ? `Something went wrong: ${call.result}` : call.result;
    const cancelled = replayWorld(call, []);
    const before = cancelled.facts();
    const outcome = await cancelled.planner.run(call.instruction);

    if (call.dialog) {
      expect(cancelled.shell.confirmMessages).toHaveLength(1);
      expect(cancelled.shell.confirmMessages[0]).toMatch(/^Change what I remember for "/);
      expect(outcome.status).toBe("cancelled");
      expect(cancelled.facts()).toEqual(before);

      const approved = replayWorld(call, [true]);
      const done = await approved.planner.run(call.instruction);
      expect(done.status).toBe(call.status);
      expect(approved.shell.results).toEqual([shown]);
    } else {
      expect(cancelled.shell.confirmMessages).toEqual([]);
      expect(outcome.status).toBe(call.status);
      expect(cancelled.shell.results).toEqual([shown]);
    }
  });
});
