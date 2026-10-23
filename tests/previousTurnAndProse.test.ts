import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { DROPPED_SEND, UNASKED_STEP } from "../src/core/chain.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { PREVIOUS_TURN_MAX_AGE_MS, PROSE_LEAD, Planner } from "../src/core/planner.ts";
import { MAX_SPOKEN_CHARS, toSpokenWithLead } from "../src/core/speech.ts";
import { createRunInstruction } from "../src/main/runInstruction.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  Memory,
  Tool,
  ToolChoice,
  ToolInput,
  ToolSchema,
} from "../src/core/types.ts";

// M32. TWO RULES FROM ONE LIVE FINDING (rows 666 > 667). "create a linear issue and post in fun"
// was answered in prose about a "close-out prompt" and a channel called "Claude Code": text from
// row 666, a "rewrite this politely" 152 minutes earlier, which reached the model as the previous
// turn (and, very likely, as the clipboard its rewrite had replaced). Not screen text: the app
// captures only the clipboard.
//   A. A previous turn older than PREVIOUS_TURN_MAX_AGE_MS (10 minutes) is not sent.
//   B. A reply the model wrote instead of choosing a tool is shown and spoken after a fixed lead,
//      "Nothing ran. The model said: ", so it cannot pass for a question the app is holding open.

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const CONTEXT: CapturedContext = { selectedText: "some copied text", activeApp: null, activeWindowTitle: null };

class SequenceLLM implements LLMClient {
  public readonly previousTurns: (ActionLogEntry | null)[] = [];
  constructor(private readonly answers: ToolChoice[]) {}
  async chooseTool(_i: string, _c: CapturedContext, _t: ToolSchema[], previousTurn: ActionLogEntry | null): Promise<ToolChoice> {
    this.previousTurns.push(previousTurn);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = this.answers[this.previousTurns.length - 1];
    if (answer === undefined) throw new Error("no answer scripted");
    return answer;
  }
  complete(): Promise<string> {
    return Promise.resolve("");
  }
}

function tools(): Tool[] {
  const ok = (name: string) => (_input: ToolInput): Promise<string> => Promise.resolve(`${name} done`);
  return [
    { name: "readThing", description: "Read.", inputSchema: { type: "object", properties: {}, required: [] }, risk: "safe", background: "ok", planPhrase: "run a test step", handler: ok("readThing") },
    {
      name: "fileThing",
      description: "File an issue.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
      risk: "dangerous",
      background: "ok",
      planPhrase: "run a test step",
      contentArg: { title: "title", body: "body" },
      confirmSummary: (input): string => `File "${String(input["title"])}"?`,
      handler: ok("fileThing"),
    },
    {
      name: "tellThing",
      description: "Tell a channel.",
      inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
      risk: "dangerous",
      background: "ok",
      planPhrase: "run a test step",
      askedWithCreateBy: ["send", "post"],
      handler: ok("tellThing"),
    },
    {
      name: "shrinkThing",
      description: "Shrink.",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      planPhrase: "run a test step",
      readsContext: true,
      askedForBy: ["shrink"],
      handler: ok("shrinkThing"),
    },
  ];
}

function harness(answers: ToolChoice[], seeded: ActionLogEntry[] = [], options: { memory?: Memory; clock?: () => number } = {}) {
  const llm = new SequenceLLM(answers);
  const shell = new MockShell({ context: CONTEXT, confirms: [false, false] });
  const log = new InMemoryActionLog();
  for (const row of seeded) log.logAction(row);
  const planner = new Planner(
    llm,
    shell,
    tools(),
    options.memory ?? new NoopMemoryResolver(),
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
    undefined, undefined, undefined, undefined,
    options.clock ?? (() => NOW),
  );
  return { llm, shell, log, planner };
}

const row = (ts: string, extra: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
  ts,
  instruction: "rewrite this politely",
  tool: "rewrite",
  arguments: { tone: "polite" },
  result: "Rewritten (polite) and copied to clipboard.\n\nPlease send the close-out prompt to the other channel.",
  status: "ok",
  ...extra,
});
const READ: ToolChoice = { kind: "tool", name: "readThing", input: {} };

describe("A. a previous turn older than ten minutes is not sent", () => {
  it("the cutoff is ten minutes", () => {
    expect(PREVIOUS_TURN_MAX_AGE_MS).toBe(10 * MINUTE);
  });

  it.each([
    ["rows 642 > 647 (76 minutes)", 76 * MINUTE],
    ["rows 666 > 667 (152 minutes)", 152 * MINUTE],
  ])("%s: no previous turn", async (_name, age) => {
    const h = harness([READ], [row(ago(age))]);
    // The precondition: the old row IS the last row, and no other exclusion applies to it.
    expect(h.log.getLast()).toMatchObject({ ts: ago(age), tool: "rewrite", status: "ok" });
    await h.planner.run("create a linear issue and post in fun");
    expect(h.llm.previousTurns).toEqual([null]);
  });

  it("a turn two minutes old is still sent, whole", async () => {
    const seeded = row(ago(2 * MINUTE));
    const h = harness([READ], [seeded]);
    await h.planner.run("create a linear issue and post in fun");
    expect(h.llm.previousTurns[0]).toMatchObject({ ts: seeded.ts, tool: "rewrite", result: seeded.result });
  });

  it("exactly at the cutoff it is sent; one second over, it is not", async () => {
    const at = harness([READ], [row(ago(PREVIOUS_TURN_MAX_AGE_MS))]);
    await at.planner.run("do it");
    expect(at.llm.previousTurns[0]).not.toBeNull();

    const over = harness([READ], [row(ago(PREVIOUS_TURN_MAX_AGE_MS + 1000))]);
    await over.planner.run("do it");
    expect(over.llm.previousTurns[0]).toBeNull();
  });

  it("a correction inside the window gets the turn it corrects", async () => {
    const seeded = row(ago(30_000), { instruction: "open my dashboard", tool: "openTarget", arguments: { target: "my dashboard" }, result: "Opened https://old.example.com" });
    const h = harness([READ], [seeded]);
    await h.planner.run("no, I meant the new one");
    expect(h.llm.previousTurns[0]).toMatchObject({ instruction: "open my dashboard", tool: "openTarget" });
  });

  it("'send it' after a draft inside the window gets the draft turn", async () => {
    const seeded = row(ago(45_000), { instruction: "reply to this", tool: "draftReply", arguments: {}, result: "Draft is in the Gmail reply box." });
    const h = harness([READ], [seeded]);
    await h.planner.run("send it");
    expect(h.llm.previousTurns[0]).toMatchObject({ tool: "draftReply" });
  });

  it("two runs in a row: the second gets the first as its previous turn", async () => {
    const h = harness([READ, READ]);
    await h.planner.run("read it");
    await h.planner.run("again");
    expect(h.llm.previousTurns[1]).toMatchObject({ instruction: "read it", tool: "readThing" });
  });

  it("a timestamp that cannot be read is judged as before (sent)", async () => {
    const h = harness([READ], [row("not a time")]);
    await h.planner.run("do it");
    expect(h.llm.previousTurns[0]).toMatchObject({ ts: "not a time" });
  });

  it("CONTROL: the default clock is the real one — a row written just now is sent", async () => {
    const llm = new SequenceLLM([READ]);
    const log = new InMemoryActionLog();
    log.logAction(row(new Date().toISOString()));
    const planner = new Planner(llm, new MockShell({ context: CONTEXT }), tools(), new NoopMemoryResolver(), log);
    await planner.run("do it");
    expect(llm.previousTurns[0]).not.toBeNull();
  });
});

describe("B. a reply the model wrote is shown and spoken after a fixed lead", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the lead is plain ASCII with no slash, and short", () => {
    expect(PROSE_LEAD).toBe("Nothing ran. The model said: ");
    expect(PROSE_LEAD).toMatch(/^[\x20-\x7e]+$/);
    expect(PROSE_LEAD).not.toContain("/");
  });

  it("on the bar and in speech, then the model's text", async () => {
    const h = harness([{ kind: "none", text: "Which channel is Claude Code?" }]);
    const outcome = await h.planner.run("create a linear issue and post in fun");
    expect(outcome).toMatchObject({ status: "no_tool", reply: "model prose", result: "Nothing ran. The model said: Which channel is Claude Code?" });
    expect(h.shell.results).toEqual(["Nothing ran. The model said: Which channel is Claude Code?"]);
    expect(h.shell.spoken).toEqual(["Nothing ran. The model said: Which channel is Claude Code?"]);
    expect(h.log.misses).toEqual(["create a linear issue and post in fun"]);
  });

  it("a long reply: the lead is spoken whole, the first cut stays under the cap, the rest is held", async () => {
    const long =
      "I need a bit more before I can do this, because the request mentions a close-out prompt that I have not been given anywhere in what you sent " +
      "and also a channel named Claude Code which I do not recognise from anything I have been told so far. Could you paste the prompt, and tell me which channel that is?";
    const spoken = toSpokenWithLead(PROSE_LEAD, long);
    expect(spoken.text.startsWith(PROSE_LEAD)).toBe(true);
    // The lead and the first cut of the text fit the cap; "There's more…" is offered after it, as
    // for any long result.
    const firstCut = spoken.text.replace(" There's more. Want me to read the rest?", "");
    expect(firstCut.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(spoken.remainder).not.toBeNull();
    // The cut never lands on the lead's own full stop.
    expect(firstCut.length).toBeGreaterThan(PROSE_LEAD.length + 20);

    const h = harness([{ kind: "none", text: long }]);
    await h.planner.run("create a linear issue and post in fun");
    expect(h.shell.spoken[0]).toBe(spoken.text);
  });

  it("the fixed refusal is not framed", async () => {
    const h = harness([{ kind: "none", text: null }]);
    const outcome = await h.planner.run("book me a flight");
    expect(outcome).toMatchObject({ status: "no_tool", reply: "fixed refusal" });
    expect(h.shell.results[0]).toBe("I can't do that yet — I don't have a tool for that.");
    expect(h.shell.results[0]).not.toContain(PROSE_LEAD);
    expect(h.shell.spoken[0]).not.toContain("Nothing ran");
  });

  it("an unknown tool is the fixed refusal, not framed", async () => {
    const h = harness([{ kind: "tool", name: "noSuchTool", input: {} }]);
    const outcome = await h.planner.run("do the impossible");
    expect(outcome.reply).toBe("fixed refusal");
    expect(h.shell.results[0]).not.toContain(PROSE_LEAD);
  });

  it("the [main] line says which it was", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const prose = harness([{ kind: "none", text: "Which channel?" }]);
      await createRunInstruction({ run: (text: string) => prose.planner.run(text) }, { showThinking: () => undefined, showResult: () => undefined })("post it");
      const fixed = harness([{ kind: "none", text: null }]);
      await createRunInstruction({ run: (text: string) => fixed.planner.run(text) }, { showThinking: () => undefined, showResult: () => undefined })("fly me");
    } finally {
      spy.mockRestore();
    }
    const main = lines.filter((line) => line.startsWith("[main]"));
    expect(main[0]).toContain("[reply: model prose]");
    expect(main[0]).toContain("Nothing ran. The model said: Which channel?");
    expect(main[1]).toContain("[reply: fixed refusal]");
  });
});

describe("the M30 and M31 refusals are untouched", () => {
  it("M31: a lone create with a send asked for is refused with its own wording, not framed", async () => {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    memory.write("third channel", "#fun");
    const h = harness([{ kind: "tool", name: "fileThing", input: { title: "T" } }], [], { memory });
    const outcome = await h.planner.run("create an issue and send to fun");
    expect(outcome).toMatchObject({ status: "refused", result: DROPPED_SEND });
    expect(outcome.reply).toBeUndefined();
  });

  it("M30: an unasked step before a create is refused with its own wording, not framed", async () => {
    const h = harness([{ kind: "plan", steps: [{ tool: "shrinkThing", arguments: {}, describe: "x" }, { tool: "fileThing", arguments: { title: "T", body: "{step1}" }, describe: "x" }] }]);
    const outcome = await h.planner.run("create an issue");
    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP });
    expect(outcome.reply).toBeUndefined();
  });
});
