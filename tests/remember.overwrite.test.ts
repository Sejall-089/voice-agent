import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { normalizeReference } from "../src/core/memory/normalize.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry, registry } from "../src/core/registry.ts";
import { resolveRisk } from "../src/core/risk.ts";
import { toSpokenConfirm } from "../src/core/speech.ts";
import {
  DIALOG_VALUE_MAX,
  UNNAMED_FACT,
  changeQuestion,
  judge,
  rememberTool,
  sameName,
  spokenChangeQuestion,
} from "../src/core/tools/remember.ts";
import type { Memory, MessageSender, ToolChoice, ToolDeps } from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeBotSender, harness } from "./botChainHarness.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeMcpServer } from "./FakeMcpServer.ts";
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

  // RE-JUSTIFIED (M33 live finding). This test used to assert a dialog for #social -> social, on
  // the reasoning that a weaker form was a change. It is not: "social" names the same channel, and
  // speech-to-text cannot write a "#". Now it is a silent no-op that keeps #social at v1.
  it("the same channel without its # (#social -> social) is NOT a change: no dialog, #social kept", async () => {
    const w = world(remember("team", "social"), { facts: [["team", "#social"]] });
    const outcome = await w.planner.run("remember the team is social");
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.results).toEqual(['Already remembered "team" as #social.']);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it("a genuinely different value still asks (#social -> help)", async () => {
    const w = world(remember("team", "help"), { facts: [["team", "#social"]] });
    await w.planner.run("remember the team is help");
    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to help?']);
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

// RE-JUSTIFIED (M33 live finding): both used #social -> social, which is no longer a change. They
// now use #social -> #fun, a genuinely different value; what they check is unchanged.
describe("what Cancel and Approve do", () => {
  it("Cancel leaves the facts table exactly as it was, and logs the row cancelled", async () => {
    const w = world(remember("team", "#fun"), { facts: [["team", "#social"], ["tone", "warm"]] });
    const before = w.facts();
    const outcome = await w.planner.run("actually, post it in fun instead");

    expect(w.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to #fun?']);
    expect(outcome.status).toBe("cancelled");
    expect(w.facts()).toEqual(before);
    expect(w.shell.results).toEqual([]);
    expect(w.log.entries).toEqual([
      expect.objectContaining({ tool: "remember", arguments: { subject: "team", value: "#fun" }, status: "cancelled" }),
    ]);
  });

  it("Approve writes v2 and keeps v1, inactive", async () => {
    const w = world(remember("team", "#fun"), { facts: [["team", "#social"]], confirms: [true] });
    const outcome = await w.planner.run("actually, post it in fun instead");

    expect(outcome.status).toBe("ok");
    expect(w.shell.results).toEqual(['Updated "team": #social → #fun (v2).']);
    expect(w.facts()).toEqual([
      { subject: "team", value: "#social", version: 1, active: 0 },
      { subject: "team", value: "#fun", version: 2, active: 1 },
    ]);
  });
});

// M33 live finding: Sejal said "remember the team is #social" with #social stored, the "#" did not
// reach the app (row 674 logs "...is social"), and she was asked to change #social to social.
// "#social" and "social" — typed or spoken — now name the same channel.
describe("the same channel with or without its #", () => {
  it.each([
    { stored: "#social", value: "social", why: "the bare form of the stored #social" },
    { stored: "#social", value: "Social", why: "a different case" },
    { stored: "#social", value: "SOCIAL", why: "all capitals" },
    { stored: "#social", value: "#Social", why: "the # form in a different case" },
    { stored: "#social", value: "  social  ", why: "surrounding spaces (trimmed in prepare)" },
    { stored: "social", value: "Social", why: "two bare forms, different case" },
  ])("$value against stored $stored ($why): no dialog, nothing written, the stored form kept", async ({ stored, value }) => {
    const w = world(remember("team", value), { facts: [["team", stored]], confirms: [true] });
    const outcome = await w.planner.run(`remember the team is ${value}`);
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.results).toEqual([`Already remembered "team" as ${stored}.`]);
    expect(w.facts()).toEqual([{ subject: "team", value: stored, version: 1, active: 1 }]);
  });

  it("the # form against a stored bare value is an upgrade: written silently as v2", async () => {
    const w = world(remember("team", "#social"), { facts: [["team", "social"]] });
    const outcome = await w.planner.run("remember the team is #social");
    expect(outcome.status).toBe("ok");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.results).toEqual(['Updated "team": social → #social (v2).']);
    expect(w.facts()).toEqual([
      { subject: "team", value: "social", version: 1, active: 0 },
      { subject: "team", value: "#social", version: 2, active: 1 },
    ]);
  });

  it("the very same text is still the plain re-assertion: no dialog, no new version", async () => {
    const w = world(remember("team", "#social"), { facts: [["team", "#social"]] });
    await w.planner.run("remember the team is #social");
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.results).toEqual(["Remembered: team = #social"]);
    expect(w.facts()).toEqual([{ subject: "team", value: "#social", version: 1, active: 1 }]);
  });

  it.each([
    { stored: "#social", value: "#fun" },
    { stored: "#social", value: "help" },
    { stored: "#social", value: "social-team" },
    { stored: "#social", value: "##social" },
  ])("$value against $stored is a different value: the dialog", async ({ stored, value }) => {
    const w = world(remember("team", value), { facts: [["team", stored]] });
    await w.planner.run(`remember the team is ${value}`);
    expect(w.shell.confirmMessages).toEqual([`Change what I remember for "team" from ${stored} to ${value}?`]);
    expect(w.facts()).toEqual([{ subject: "team", value: stored, version: 1, active: 1 }]);
  });

  describe("bot mode (the real directory fake lists #social)", () => {
    it.each(["social", "#social", "Social", "#Social"])("'%s' against stored #social: no dialog, #social at v1", async (value) => {
      const h = harness(remember("team", value), { facts: { team: "#social" }, confirms: [true] });
      const outcome = await h.planner.run(`remember the team is ${value}`);
      expect(outcome.status).toBe("ok");
      expect(h.shell.confirmMessages).toEqual([]);
      expect(h.facts()).toEqual([{ subject: "team", value: "#social", active: 1 }]);
    });

    it("'#fun' against stored #social is refused (Slack here has no #fun), with no dialog", async () => {
      const h = harness(remember("team", "#fun"), { facts: { team: "#social" }, confirms: [true] });
      const outcome = await h.planner.run("remember the team is #fun");
      expect(outcome.status).toBe("refused");
      expect(h.shell.confirmMessages).toEqual([]);
    });

    it("'#help' against stored #social: the dialog", async () => {
      const h = harness(remember("team", "#help"), { facts: { team: "#social" }, confirms: [] });
      await h.planner.run("remember the team is #help");
      expect(h.shell.confirmMessages).toEqual(['Change what I remember for "team" from #social to #help?']);
      expect(h.facts()).toEqual([{ subject: "team", value: "#social", active: 1 }]);
    });
  });

  it("sameName: one leading # aside, case and spaces ignored", () => {
    expect(sameName("#social", "social")).toBe(true);
    expect(sameName(" #Social ", "SOCIAL")).toBe(true);
    expect(sameName("#social", "##social")).toBe(false);
    expect(sameName("#social", "soc ial")).toBe(false);
    expect(judge(undefined, "social")).toBe("first");
    expect(judge({ value: "#social" }, "#social")).toBe("same");
    expect(judge({ value: "#social" }, "social")).toBe("keep");
    expect(judge({ value: "social" }, "#social")).toBe("upgrade");
    expect(judge({ value: "#social" }, "#fun")).toBe("change");
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
      spokenChangeQuestion("team", { kind: "value", value: "#social" }, "social"),
    ];
    for (const text of forms) {
      expect(text, text).toMatch(/^[\x20-\x7e]+$/);
      expect(toSpokenConfirm(text).remainder, text).toBeNull(); // spoken whole, nothing held back
    }
  });
});

// M33 follow-up. The speech cleaner drops every "#" (core/speech.ts), so the dialog's own words
// spoken would say "from social to social" for the one difference the dialog exists to show.
// `remember` says a value's leading "#" as "hash" — aloud only (`speakConfirm`).
describe("the dialog as spoken", () => {
  // What the planner actually SAID before the dialog, and the dialog itself.
  async function said(subject: string, stored: string, value: string, confirms: boolean[] = []) {
    const w = world(remember(subject, value), { facts: [[subject, stored]], confirms });
    await w.planner.run(`remember ${subject} is ${value}`);
    return { spoken: w.shell.spoken, dialogs: w.shell.confirmMessages };
  }

  // RE-JUSTIFIED (M33 live finding): #social -> social and social -> #social used to be dialogs
  // here; they name the same channel and no longer reach one (see "the same channel with or
  // without its #"). The planner-level pairs are now genuinely different values with a "#" on
  // either side; the wording for the same-name pair is still pinned below, at the function.
  it.each([
    { stored: "#social", value: "help", heard: "from hash social to help" },
    { stored: "help", value: "#social", heard: "from help to hash social" },
    { stored: "#social", value: "#fun", heard: "from hash social to hash fun" },
    { stored: "stiff and formal", value: "concise and warm", heard: "from stiff and formal to concise and warm" },
  ])("$stored -> $value is heard as '$heard'", async ({ stored, value, heard }) => {
    const { spoken, dialogs } = await said("team", stored, value);
    expect(spoken).toEqual([`Change what I remember for team ${heard}?`]);
    // The dialog on screen is untouched: the "#" as written, no "hash".
    expect(dialogs).toEqual([`Change what I remember for "team" from ${stored} to ${value}?`]);
  });

  it("the wording itself says 'hash' on either side (#social -> social, social -> #social)", () => {
    expect(toSpokenConfirm(spokenChangeQuestion("team", { kind: "value", value: "#social" }, "social")).text).toBe(
      "Change what I remember for team from hash social to social?",
    );
    expect(toSpokenConfirm(spokenChangeQuestion("team", { kind: "value", value: "social" }, "#social")).text).toBe(
      "Change what I remember for team from social to hash social?",
    );
  });

  it("only a LEADING # becomes 'hash'", () => {
    expect(spokenChangeQuestion("tag", { kind: "value", value: "issue #4" }, "#a#b")).toBe(
      'Change what I remember for "tag" from issue #4 to hash a#b?',
    );
  });

  it("the 200-character cap still applies, before the # is said", () => {
    const long = `#${"o".repeat(250)}`;
    expect(spokenChangeQuestion("notes", { kind: "value", value: long }, "#fun")).toBe(
      `Change what I remember for "notes" from hash ${"o".repeat(DIALOG_VALUE_MAX - 1)}... to hash fun?`,
    );
    expect(changeQuestion("notes", { kind: "value", value: long }, "#fun")).toBe(
      `Change what I remember for "notes" from #${"o".repeat(DIALOG_VALUE_MAX - 1)}... to #fun?`,
    );
  });

  it("the other two forms say 'hash' too", () => {
    expect(toSpokenConfirm(spokenChangeQuestion("team", { kind: "unread" }, "#fun")).text).toBe(
      "Change what I remember for team to hash fun? I couldn't check what it holds now.",
    );
    expect(toSpokenConfirm(spokenChangeQuestion("team", { kind: "nothing" }, "#fun")).text).toBe(
      "Remember team as hash fun?",
    );
  });

  it("inside a chain, the step prefix is spoken in front", async () => {
    const choice: ToolChoice = {
      kind: "plan",
      steps: [
        { tool: "recall", arguments: { subject: "team" }, describe: "look it up" },
        { tool: "remember", arguments: { subject: "team", value: "#fun" }, describe: "change it" },
      ],
    };
    const w = world(choice, { facts: [["team", "#social"]] });
    await w.planner.run("check the team and then make it #fun");
    expect(w.shell.spoken).toContain("Step 2 of 2: Change what I remember for team from hash social to hash fun?");
    expect(w.shell.confirmMessages).toEqual(['Step 2 of 2: Change what I remember for "team" from #social to #fun?']);
  });

  it("no other tool declares a spoken variant", () => {
    const every = buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true, jobs: true });
    expect(every.filter((tool) => tool.speakConfirm !== undefined).map((tool) => tool.name)).toEqual(["remember"]);
  });

  // Every other tool still has its dialog's own first paragraph spoken, "#" dropped, as before.
  it("a bot-mode send is still heard as 'Send to social?'", async () => {
    const h = harness({ kind: "tool", name: "sendMessage", input: { channel: "#social", notes: "hi" } }, { confirms: [false] });
    await h.planner.run("send hi to #social");
    expect(h.shell.confirmMessages[0]?.startsWith("Send to #social?")).toBe(true);
    expect(h.shell.spoken[0]).toBe("Send to social? Check the dialog.");
  });

  it("a webhook send is still heard with its note, '#' dropped", async () => {
    const w = world({ kind: "tool", name: "sendMessage", input: { channel: "#social", notes: "hi" } });
    await w.planner.run("send hi to #social");
    expect(w.shell.confirmMessages[0]).toMatch(/^Send via your Slack webhook\?\n\(You asked for #social\./);
    expect(w.shell.spoken[0]).toBe(toSpokenConfirm(w.shell.confirmMessages[0] ?? "").text);
    expect(w.shell.spoken[0]).not.toContain("hash");
    expect(w.shell.spoken[0]).toContain("You asked for social.");
  });

  it("a Linear create is still heard as its question and 'Check the dialog.'", async () => {
    const server = new FakeMcpServer({ timeline: [] });
    const connectors = loadConnectorTools({
      configText: JSON.stringify({ connectors: { linear: { enabled: true, tools: ["create_issue"], settings: { defaultTeam: "Engineering" } } } }),
      readKey: () => "lin_api_test",
      connect: (def) => new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: server.transport, timeoutMs: 300, connectTimeoutMs: 300 }),
    }).tools;
    const shell = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null } });
    const memory = new SqliteMemory(createDatabase(":memory:"));
    const choice: ToolChoice = { kind: "tool", name: "linear__create_issue", input: { title: "Login #4 fails", description: "notes" } };
    await new Planner(new FakeLLM(choice), shell, [...registry, ...connectors], memory, memory).run("create a linear issue");
    expect(shell.confirmMessages[0]?.startsWith("Create this Linear issue in Engineering?\n\n")).toBe(true);
    expect(shell.spoken[0]).toBe("Create this Linear issue in Engineering? Check the dialog.");
    expect(server.created).toEqual([]);
  });
});

// The phrasing set: what the model is likely to plan for each instruction, in two memory states.
// The dialog appears only where a DIFFERENT value is already stored — the instruction's wording
// plays no part, which is the point of B over a word-list check.
describe("the phrasing set: corrections and real remembers", () => {
  // `onEmpty` (M34): what happens with nothing stored. RE-JUSTIFIED AT M34 — until then all eight
  // were written silently on empty memory. Rule B now refuses a first write whose subject the
  // instruction never says, and three of the corrections are exactly that shape: "team" was
  // never said, so writing `team` is the junk first write M33's trials saw. "actually it's
  // #design-team" still writes: "#design-team" is the words "design" and "team", so the subject
  // IS in the instruction.
  const PHRASES: {
    instruction: string;
    kind: "correction" | "remember";
    subject: string;
    value: string;
    other: string;
    onEmpty: "written" | "refused";
  }[] = [
    { instruction: "actually, post it in social instead", kind: "correction", subject: "team", value: "social", other: "#general", onEmpty: "refused" },
    { instruction: "no, send it to help", kind: "correction", subject: "team", value: "help", other: "#general", onEmpty: "refused" },
    { instruction: "no, I meant the design channel", kind: "correction", subject: "team", value: "#design-team", other: "#general", onEmpty: "refused" },
    { instruction: "actually it's #design-team", kind: "correction", subject: "team", value: "#design-team", other: "#general", onEmpty: "written" },
    { instruction: "remember that team is #social", kind: "remember", subject: "team", value: "#social", other: "#general", onEmpty: "written" },
    { instruction: "my name is Sam Placeholder", kind: "remember", subject: "name", value: "Sam Placeholder", other: "Alex Placeholder", onEmpty: "written" },
    { instruction: "the design channel is #design-team", kind: "remember", subject: "design channel", value: "#design-team", other: "#design-old", onEmpty: "written" },
    { instruction: "remember my dashboard is https://dash.example.com", kind: "remember", subject: "target:dashboard", value: "https://dash.example.com", other: "https://old.example.com", onEmpty: "written" },
  ];

  it.each(PHRASES.filter((p) => p.onEmpty === "written"))(
    "$kind '$instruction', memory empty: written silently as v1",
    async ({ instruction, subject, value }) => {
      const w = world(remember(subject, value));
      const outcome = await w.planner.run(instruction);
      expect(outcome.status).toBe("ok");
      expect(w.shell.confirmMessages).toEqual([]);
      expect(w.facts()).toEqual([{ subject, value, version: 1, active: 1 }]);
    },
  );

  it.each(PHRASES.filter((p) => p.onEmpty === "refused"))(
    "$kind '$instruction', memory empty: refused by rule B, nothing written, no dialog",
    async ({ instruction, subject, value }) => {
      const w = world(remember(subject, value));
      const outcome = await w.planner.run(instruction);
      expect(outcome.status).toBe("refused");
      expect(w.shell.results).toEqual([UNNAMED_FACT]);
      expect(w.shell.confirmMessages).toEqual([]);
      expect(w.facts()).toEqual([]);
      expect(w.log.entries).toMatchObject([{ tool: "remember", status: "refused", result: UNNAMED_FACT }]);
    },
  );

  // Rule B never judges a replacement. The precondition (a fact with this exact subject is active)
  // is asserted, so a B that also fired on overwrites would show here as a refusal, not a dialog.
  it.each(PHRASES)("$kind '$instruction', a different value stored: the dialog", async ({ instruction, subject, value, other }) => {
    const w = world(remember(subject, value), { facts: [[subject, other]] });
    expect(w.facts()).toEqual([{ subject, value: other, version: 1, active: 1 }]);
    await w.planner.run(instruction);
    expect(w.shell.confirmMessages).toEqual([`Change what I remember for "${subject}" from ${other} to ${value}?`]);
    expect(w.shell.results).not.toContain(UNNAMED_FACT);
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
    // RE-JUSTIFIED AT M34: 14 → 17, with rows 676-678 (M33's human checks).
    expect(REMEMBER_CALLS.filter((c) => c.source === "action log")).toHaveLength(17);
    const text = JSON.stringify(REMEMBER_CALLS);
    expect(text).toContain(CLIPBOARD_MARKER);
    expect(text).not.toMatch(/Sejal|Lisa|Gupta|Don't change any code/);
  });

  // RE-JUSTIFIED (M33 live finding): M32's row (`team` = social against #social) left this list —
  // the same channel, so no dialog — and row 674 (the live finding, the same shape) never joins it.
  // Row 672 (`fun` against #social) is a genuinely different value and does.
  it("asks on exactly rows 323, 389, 435 and 672, and the flagship corrections", () => {
    expect(REMEMBER_CALLS.filter((c) => c.dialog).map((c) => c.id)).toEqual([
      "row 323",
      "row 389",
      "row 435",
      "row 672",
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
      // M34: a refusal writes nothing.
      if (call.status === "refused") expect(cancelled.facts()).toEqual(before);
    }
  });

  // M34, rule B. Every first write on record: the junk is refused and nothing is written; every
  // genuine one gets past B (it may still be refused for its own reason — row 475 by Slack).
  it("rule B: all 5 junk first writes are refused, and every genuine recorded first write gets past it", async () => {
    const firstWrites = REMEMBER_CALLS.filter((c) => c.firstWrite !== undefined);
    const outcomes: Record<string, string[]> = { junk: [], genuine: [] };
    for (const call of firstWrites) {
      // The precondition: nothing is stored under this subject, so this IS a first write.
      expect(call.before.some(([subject]) => subject === normalizeReference(call.arguments.subject)), call.id).toBe(false);
      const w = replayWorld(call, []);
      const outcome = await w.planner.run(call.instruction);
      const refusedByB = outcome.status === "refused" && outcome.result === UNNAMED_FACT;
      outcomes[call.firstWrite ?? "genuine"]?.push(`${call.id}: ${refusedByB ? "refused by B" : "passed B"}`);
    }
    expect(outcomes["junk"]).toEqual([
      "M33 T1 #1: channel:fun = social: refused by B",
      "M33 T1 #2: channel:fun = social: refused by B",
      "M33 T2: channel = #social: refused by B",
      "M33 T3 #1: channel = #social: refused by B",
      "M33 T3 #3: channel = #social: refused by B",
    ]);
    expect(outcomes["genuine"]?.every((line) => line.endsWith("passed B")), outcomes["genuine"]?.join("\n")).toBe(true);
    expect(outcomes["genuine"]).toHaveLength(13);
  });
});
