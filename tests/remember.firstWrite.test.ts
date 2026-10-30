import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { UNNAMED_FACT, subjectInInstruction } from "../src/core/tools/remember.ts";
import type { ActionLogEntry, ToolChoice } from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { harness, plan, step } from "./botChainHarness.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";

// M34, rule B: a FIRST `remember` write is refused unless every word of its subject is one the
// instruction used. M33's live trials saw a correction ("actually, post it in social instead")
// silently save `channel:fun` = social and `channel` = #social, 5 times in 27 — a first write is
// `reversible`, so it had no dialog. A replacement is asked about (M33) and is never judged here.
//
// Each describe below exists so a specific wrong implementation fails a test.

const remember = (subject: string, value: string): ToolChoice => ({ kind: "tool", name: "remember", input: { subject, value } });

interface FactRow {
  subject: string;
  value: string;
  version: number;
  active: number;
}

// The real planner and registry, a real SQLite memory, webhook mode; a previous turn and a
// clipboard a test can set.
function world(
  choice: ToolChoice,
  options: { facts?: readonly (readonly [string, string])[]; previous?: Omit<ActionLogEntry, "ts">; clipboard?: string; confirms?: boolean[] } = {},
) {
  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  for (const [subject, value] of options.facts ?? []) memory.write(subject, value);
  const shell = new MockShell({
    context: { selectedText: options.clipboard ?? null, activeApp: null, activeWindowTitle: null },
    confirms: options.confirms ?? [],
  });
  const log = new InMemoryActionLog();
  if (options.previous !== undefined) log.logAction({ ...options.previous, ts: new Date(Date.now() - 40_000).toISOString() });
  const sender = new FakeSender();
  const planner = new Planner(
    new FakeLLM(choice),
    shell,
    registry,
    memory,
    log,
    sender,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  const facts = (): FactRow[] =>
    db.prepare<[], FactRow>("SELECT subject, value, version, active FROM facts ORDER BY id").all();
  return { planner, shell, log, sender, facts };
}

describe("subjectInInstruction: which words count", () => {
  it.each([
    // Every word present.
    { subject: "team", instruction: "remember the team is #social", named: true },
    { subject: "social channel", instruction: "remember the social channel is #social", named: true },
    // Order does not matter; a ":" splits like any other non-letter.
    { subject: "channel:social", instruction: "remember the social channel is #social", named: true },
    // "#design-team" is two words, "design" and "team".
    { subject: "team", instruction: "actually it's #design-team", named: true },
    // One leading "target:" is this app's URL convention, not a word anyone says.
    { subject: "target:dashboard", instruction: "remember my dashboard is https://github.com/dashboard", named: true },
    // ...and only that prefix, only once, only at the start.
    { subject: "target:target", instruction: "remember my dashboard is https://a.example.com", named: false },
    // A trailing "s" either way.
    { subject: "bugs channel", instruction: "remember the bug channel is #help", named: true },
    { subject: "bug channel", instruction: "remember the bugs channel is #help", named: true },
    // Case.
    { subject: "team", instruction: "REMEMBER THE TEAM IS #social", named: true },
    // A word missing.
    { subject: "channel:fun", instruction: "actually, post it in social instead", named: false },
    { subject: "channel", instruction: "actually, post it in social instead", named: false },
    { subject: "team", instruction: "no, send it to help", named: false },
    // A word inside another word is not that word.
    { subject: "fun", instruction: "that was funny", named: false },
    // A subject with no words names nothing.
    { subject: "#", instruction: "remember # is #", named: false },
  ])("'$subject' in '$instruction': $named", ({ subject, instruction, named }) => {
    expect(subjectInInstruction(subject, instruction)).toBe(named);
  });

  it("'name' and 'tone' are exempt: said without the word", () => {
    expect(subjectInInstruction("name", "call me Sam")).toBe(true);
    expect(subjectInInstruction("tone", "I like short replies")).toBe(true);
    // Exact subjects only: a longer subject that contains one is judged like any other.
    expect(subjectInInstruction("name tag", "call me Sam")).toBe(false);
  });
});

describe("only the instruction's own words count", () => {
  // The previous turn holds every word of the subject. Counting it would let the junk through.
  it("not the previous turn: 'fun channel' named only in the turn before is refused", async () => {
    const w = world(remember("fun channel", "#social"), {
      previous: { instruction: "send it to the fun channel", tool: "sendMessage", arguments: { channel: "the fun channel" }, result: null, status: "cancelled" },
    });
    const outcome = await w.planner.run("actually, post it in social instead");
    expect(outcome.status).toBe("refused");
    expect(w.shell.results).toEqual([UNNAMED_FACT]);
    expect(w.facts()).toEqual([]);
  });

  it("not the clipboard: 'fun channel' only in the copied text is refused", async () => {
    const w = world(remember("fun channel", "#social"), { clipboard: "please post updates to the fun channel" });
    const outcome = await w.planner.run("actually, post it in social instead");
    expect(outcome.status).toBe("refused");
    expect(w.facts()).toEqual([]);
  });

  it("CONTROL: the same subject named in the instruction is saved", async () => {
    const w = world(remember("fun channel", "#social"));
    const outcome = await w.planner.run("remember the fun channel is #social");
    expect(outcome.status).toBe("ok");
    expect(w.facts()).toEqual([{ subject: "fun channel", value: "#social", version: 1, active: 1 }]);
  });
});

describe("refused before Slack is asked (bot mode)", () => {
  it("the junk 'channel' = #social: refused, the channel directory never asked, nothing written", async () => {
    const h = harness(remember("channel", "#social"));
    const outcome = await h.planner.run("actually, post it in social instead");
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([UNNAMED_FACT]);
    expect(h.directory.calls).toEqual([]);
    expect(h.facts()).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
  });

  it("CONTROL: a first write that names its subject is checked in Slack and saved as Slack's name", async () => {
    const h = harness(remember("bugs channel", "help"));
    await h.planner.run("remember the bugs channel is help");
    expect(h.directory.calls.length).toBeGreaterThan(0);
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
  });
});

describe("a first write is judged by its EXACT subject, as the tier judges it", () => {
  // `resolve("dashboard")` also finds "target:dashboard". Judged that way, this write would not be
  // a first write, B would step aside, and the tier (exact subject: nothing stored) would save it
  // silently — a junk fact under a subject nobody said.
  it("'dashboard' with only 'target:dashboard' stored is a first write, and is refused", async () => {
    const w = world(remember("dashboard", "https://other.example.com"), { facts: [["target:dashboard", "https://dash.example.com"]] });
    const outcome = await w.planner.run("no, the other one");
    expect(outcome.status).toBe("refused");
    expect(w.shell.results).toEqual([UNNAMED_FACT]);
    expect(w.facts()).toEqual([{ subject: "target:dashboard", value: "https://dash.example.com", version: 1, active: 1 }]);
  });
});

describe("rule B never touches a replacement or a refresh", () => {
  it("the flagship correction 'no, I meant #general' → team (stored): the dialog, not a refusal", async () => {
    const w = world(remember("team", "#general"), { facts: [["team", "#design-team"]] });
    await w.planner.run("no, I meant #general");
    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #design-team to #general?']);
    expect(w.shell.results).not.toContain(UNNAMED_FACT);
  });

  it("the same value again, subject unsaid: the old refresh, no refusal", async () => {
    const w = world(remember("team", "#social"), { facts: [["team", "#social"]] });
    const outcome = await w.planner.run("actually, post it in social instead");
    expect(outcome.status).toBe("ok");
    expect(w.shell.results).toEqual(["Remembered: team = #social"]);
  });

  it("the same channel without its '#', subject unsaid: kept, no refusal", async () => {
    const w = world(remember("team", "social"), { facts: [["team", "#social"]] });
    await w.planner.run("actually, post it in social instead");
    expect(w.shell.results).toEqual(['Already remembered "team" as #social.']);
  });
});

describe("'name' and 'tone' are exempt", () => {
  it.each([
    { instruction: "call me Sam Placeholder", subject: "name", value: "Sam Placeholder" },
    { instruction: "I like short replies", subject: "tone", value: "short" },
  ])("'$instruction' → $subject: saved as v1, no dialog", async ({ instruction, subject, value }) => {
    const w = world(remember(subject, value));
    const outcome = await w.planner.run(instruction);
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.facts()).toEqual([{ subject, value, version: 1, active: 1 }]);
  });
});

describe("inside a chain", () => {
  // M33's T3 #3: the correction planned `remember channel = #social`, then a send.
  it("plan 'remember channel > send': refused at step 1, no send dialog, nothing sent or written", async () => {
    const choice = plan([
      step("remember", { subject: "channel", value: "#social" }, "save the channel"),
      step("sendMessage", { channel: "#social", notes: "an update" }, "post it"),
    ]);
    const w = world(choice);
    const outcome = await w.planner.run("actually, post it in social instead");
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toMatchObject({ completed: 0, total: 2 });
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.sender.calls).toEqual([]);
    expect(w.facts()).toEqual([]);
  });

  // M34's live run, F2 #4: the correction planned the send FIRST, then `remember channel = social`.
  // Live, the send was cancelled, so step 2 never ran. Approved here, step 2 is reached and refused.
  it("plan 'send > remember channel' (live F2 #4), send approved: sent once, step 2 refused, nothing written", async () => {
    const choice = plan([
      step("sendMessage", { channel: "social", notes: "an update" }, "post it"),
      step("remember", { subject: "channel", value: "social" }, "save the channel"),
    ]);
    const w = world(choice, { facts: [["team", "#social"]], confirms: [true] });
    const outcome = await w.planner.run("actually, post it in social instead");
    expect(w.sender.calls).toHaveLength(1);
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toMatchObject({ completed: 1, total: 2 });
    expect(outcome.result).toContain(UNNAMED_FACT);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });
});

// Pinned on purpose, so a change in either direction is a decision someone makes in front of this
// test: a genuine first write whose subject the model PARAPHRASED is refused. The refusal tells the
// user the form that works. `name` and `tone` are exempt for the two most common of these.
describe("KNOWN REGRESSION (M34): first-write paraphrases whose subject words are not in the instruction are refused", () => {
  it.each([
    { instruction: "I like short replies", subject: "reply style", value: "short" },
    { instruction: "I go by Sam", subject: "nickname", value: "Sam" },
    { instruction: "my standup is at ten", subject: "meeting time", value: "10:00" },
  ])("'$instruction' → $subject: refused, nothing written", async ({ instruction, subject, value }) => {
    const w = world(remember(subject, value));
    const outcome = await w.planner.run(instruction);
    expect(outcome.status).toBe("refused");
    expect(w.shell.results).toEqual([UNNAMED_FACT]);
    expect(w.facts()).toEqual([]);
  });
});

describe("the refusal's text", () => {
  it("plain ASCII, no question, no 'webhook', short enough to speak whole, and says what to do", () => {
    expect(UNNAMED_FACT).toMatch(/^[\x20-\x7e]+$/);
    expect(UNNAMED_FACT).not.toContain("?");
    expect(UNNAMED_FACT).not.toMatch(/webhook/i);
    expect(UNNAMED_FACT.length).toBeLessThan(240);
    expect(UNNAMED_FACT).toMatch(/did not save/);
    expect(UNNAMED_FACT).toContain('"remember the team is #social"');
  });
});
