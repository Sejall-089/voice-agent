import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DROPPED_SEND,
  asksFor,
  canonicalToolName,
  channelKnowledge,
  checkDroppedSends,
  droppedSends,
  isDroppedSendRefusal,
} from "../src/core/chain.ts";
import { CONNECTORS, loadConnectorTools } from "../src/core/mcp/load.ts";
import { UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { buildRegistry, toToolSchemas } from "../src/core/registry.ts";
import { MAX_SPOKEN_CHARS, toSpokenResult } from "../src/core/speech.ts";
import type { PlannedStep, ToolInput } from "../src/core/types.ts";
import { DROPS } from "./fixtures/sendDropped/drops.ts";
import { EVAL } from "./fixtures/unaskedSteps/replay.ts";
import type { Replayed } from "./fixtures/unaskedSteps/replay.ts";

// A CREATE THAT DROPPED A SEND THE INSTRUCTION ASKED FOR (core/chain.ts, `checkDroppedSends`, M31).
// The rule, the words and what counts as a destination are pinned here against the REAL
// declarations; where the planner applies it is in tests/planner.droppedSends.test.ts.
//
// Memory holds the channel facts the app's own memory holds (read read-only from memory.db on
// 2026-10-23): "#help", "#social", "#fun", and "team" = "#social". What counts as a known
// destination depends on exactly that, so it is written down rather than left empty.

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: Object.fromEntries(
      CONNECTORS.map((def) => [
        def.id,
        {
          enabled: true,
          tools: def.tools.map((tool) => tool.name),
          settings: { defaultTeam: "Engineering", owner: "acme", repo: "tracker" },
        },
      ]),
    ),
  }),
  readKey: () => "unused",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;
const TOOLS = buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true, jobs: true, connectors });
const MENU = TOOLS.map((tool) => tool.name);

function appMemory(): SqliteMemory {
  const memory = new SqliteMemory(createDatabase(":memory:"));
  memory.write("alt channel", "#help");
  memory.write("channel:social", "#social");
  memory.write("second channel", "#help");
  memory.write("social channel", "#social");
  memory.write("team", "#social");
  memory.write("third channel", "#fun");
  return memory;
}
const CHANNELS = channelKnowledge(appMemory());

const canonical = (steps: readonly PlannedStep[]): PlannedStep[] =>
  steps.map((step) => ({ ...step, tool: canonicalToolName(step.tool, MENU) }));
const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: "" });
const check = (instruction: string, steps: readonly PlannedStep[]) =>
  checkDroppedSends(instruction, canonical(steps), TOOLS, CHANNELS);

const CREATE = step("linear__create_issue", { title: "Migration fails on orders", description: "the copied text" });
const SEND = step("sendMessage", { channel: "fun", notes: "Filed: {step1}" });
const SEND_WORDS = ["send", "post", "tell", "let ... know", "share", "message", "ping"];
const askWords = (): readonly string[] => TOOLS.find((tool) => tool.name === "sendMessage")?.askedWithCreateBy ?? [];

describe("the declaration", () => {
  it("sendMessage declares exactly the approved words, and no other tool declares any", () => {
    expect(askWords()).toEqual(SEND_WORDS);
    expect(TOOLS.filter((tool) => tool.askedWithCreateBy !== undefined).map((tool) => tool.name)).toEqual(["sendMessage"]);
  });

  it("is never sent to the model", () => {
    for (const schema of toToolSchemas(TOOLS)) expect(Object.keys(schema).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(JSON.stringify(toToolSchemas(TOOLS))).not.toContain("askedWithCreateBy");
  });
});

describe("what memory knows about channels", () => {
  it("every fact value that is a #channel, lowercased, and the resolve lookup", () => {
    expect([...CHANNELS.known].sort()).toEqual(["#fun", "#help", "#social"]);
    expect(CHANNELS.resolve("the team")).toBe("#social");
    expect(CHANNELS.resolve("fun")).toBeNull();
  });

  it("nothing, from a memory that remembers nothing", () => {
    const empty = channelKnowledge(new NoopMemoryResolver());
    expect([...empty.known]).toEqual([]);
    expect(empty.resolve("the team")).toBeNull();
  });
});

// The phrasing set. Each "asks" phrase is a create plus a send; each "content" phrase has a send
// word that belongs to the bug or the title, and asks for no send at all.
const ASKS: readonly string[] = [
  "create a linear issue and send to fun",
  "create a linear issue and post in fun",
  "create a linear issue then tell fun",
  "create a linear issue and let #bugs know",
  "create a linear issue and share it in #social",
  "create a linear issue and message fun",
  "create a linear issue and ping the team",
];
const CONTENT: readonly string[] = [
  "file a bug: the send button is broken",
  "create an issue titled post-merge hook fails",
  "log this error message",
  "file an issue to tell users about downtime",
  "create a ticket: share sheet crashes",
  "file this: notify badge doesn't clear",
  'create an issue titled "send to fun fails"',
];

describe("asks for a send: a word plus a known destination", () => {
  it.each(ASKS)("'%s' asks", (instruction) => {
    expect(asksFor(instruction, askWords(), CHANNELS)).toBe(true);
  });

  it.each(CONTENT)("'%s' does not ask: the word is part of the content", (instruction) => {
    expect(asksFor(instruction, askWords(), CHANNELS)).toBe(false);
  });

  it("a #name is a destination with nothing in memory", () => {
    const empty = channelKnowledge(new NoopMemoryResolver());
    expect(asksFor("create an issue and send to #bugs", askWords(), empty)).toBe(true);
    expect(asksFor("create an issue and send to fun", askWords(), empty)).toBe(false);
  });

  it("a bare name is known only when memory holds its #channel — never taken as given", () => {
    expect(asksFor("create an issue and send to general", askWords(), CHANNELS)).toBe(false);
    expect(asksFor("create an issue and send to fun", askWords(), CHANNELS)).toBe(true);
  });

  it("a phrase memory resolves to a #channel, and 'the X channel' for a known X", () => {
    expect(asksFor("create an issue and tell the team", askWords(), CHANNELS)).toBe(true);
    expect(asksFor("create an issue and tell the social channel", askWords(), CHANNELS)).toBe(true);
    expect(asksFor("create an issue and tell the bugs channel", askWords(), CHANNELS)).toBe(false);
  });

  it("up to three object words before the preposition, and not four", () => {
    expect(asksFor("create an issue and send the whole thing to fun", askWords(), CHANNELS)).toBe(true);
    expect(asksFor("create an issue and send all of the notes to fun", askWords(), CHANNELS)).toBe(false);
  });

  it("'let ... know' takes the destination between", () => {
    expect(asksFor("file it and let the team know", askWords(), CHANNELS)).toBe(true);
    expect(asksFor("file it and let me know", askWords(), CHANNELS)).toBe(false);
  });

  it("whole tokens only, and one clause at a time", () => {
    expect(asksFor("create an issue: sender to fun is broken", askWords(), CHANNELS)).toBe(false);
    expect(asksFor("create an issue about the send. fun is broken", askWords(), CHANNELS)).toBe(false);
  });

  it("quoted text is not judged, single or double quotes, and an apostrophe is not a quote", () => {
    expect(asksFor("create an issue titled 'send to fun fails'", askWords(), CHANNELS)).toBe(false);
    expect(asksFor("don't forget, create an issue and send to fun", askWords(), CHANNELS)).toBe(true);
  });
});

describe("the rule", () => {
  it("refuses a lone create when a send was asked for", () => {
    expect(check("create a linear issue and send to fun", [CREATE])).toEqual({ ok: false, reason: DROPPED_SEND });
  });

  it("refuses a plan with a create and no send step, and a GitHub create too", () => {
    expect(check("create a linear issue and send to fun", [step("summarize"), CREATE]).ok).toBe(false);
    expect(check("open a github issue and post in fun", [step("github__create_issue", { title: "T", body: "B" })]).ok).toBe(false);
  });

  it("judges a `functions.`-prefixed answer by its canonical names", () => {
    expect(check("create a linear issue and send to fun", [step("functions.linear__create_issue", { title: "T" })]).ok).toBe(false);
    expect(check("create a linear issue and send to fun", [step("functions.linear__create_issue", { title: "T" }), step("functions.sendMessage", { channel: "fun" })])).toEqual({ ok: true });
  });

  it("a send anywhere in the plan is the send: after the create or before it", () => {
    expect(check("create a linear issue and send to fun", [CREATE, SEND])).toEqual({ ok: true });
    expect(check("send these to fun and raise a ticket on linear", [step("sendMessage", { channel: "fun" }), CREATE])).toEqual({ ok: true });
  });

  it("an answer with no create is never looked at", () => {
    expect(check("reply to this and send it", [step("draftReply"), step("sendReply")])).toEqual({ ok: true });
    expect(check("summarize this and send to fun", [step("summarize"), SEND])).toEqual({ ok: true });
    expect(check("summarize this and send to fun", [step("summarize")])).toEqual({ ok: true });
    expect(check("find the login issue in Linear", [step("linear__search_issues", { query: "login" })])).toEqual({ ok: true });
  });

  it("a create with no send asked for is never refused", () => {
    expect(check("create a linear issue", [CREATE])).toEqual({ ok: true });
    expect(check("file this bug in Linear", [step("readEmail"), CREATE])).toEqual({ ok: true });
  });

  it("sendReply is not the send", () => {
    expect(check("create a linear issue and send to fun", [CREATE, step("sendReply")]).ok).toBe(false);
  });

  it("names the tool asked for and missing", () => {
    expect(droppedSends("create a linear issue and send to fun", canonical([CREATE]), TOOLS, CHANNELS)).toEqual(["sendMessage"]);
  });
});

describe("the refusal", () => {
  it("is the fixed sentence, plain ASCII with no slash, one paragraph, spoken whole", () => {
    expect(DROPPED_SEND).toBe(
      "You asked me to send it too, but my plan had no send step, so nothing was filed. Ask again, or file it and send it as two requests.",
    );
    expect(DROPPED_SEND).toMatch(/^[\x20-\x7e]+$/);
    expect(DROPPED_SEND).not.toContain("/");
    expect(DROPPED_SEND.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(toSpokenResult(DROPPED_SEND)).toEqual({ text: DROPPED_SEND, remainder: null });
  });

  it("its rows are recognised, and nothing else is", () => {
    expect(isDroppedSendRefusal({ status: "refused", tool: null, result: DROPPED_SEND })).toBe(true);
    expect(isDroppedSendRefusal({ status: "ok", tool: null, result: DROPPED_SEND })).toBe(false);
    expect(isDroppedSendRefusal({ status: "refused", tool: "linear__create_issue", result: DROPPED_SEND })).toBe(false);
    expect(isDroppedSendRefusal({ status: "refused", tool: null, result: "My plan for that used a tool I don't have" })).toBe(false);
  });
});

// THE REPLAY. Every drop on record is refused, and every plan that kept its send — or never had
// one to keep — is not.
interface Recorded {
  source: string;
  instruction: string;
  clipboard: string | null;
  steps: PlannedStep[];
}
const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/unreadContent/recorded.json", import.meta.url), "utf8"),
) as Recorded[];

// M30's stand-in arguments for a rebuilt eval trial; this check reads tool names only.
const evalPlan = (row: Replayed): PlannedStep[] => row.tools.map((tool) => step(tool));

describe("replaying the records", () => {
  it.each(DROPS.map((drop) => [drop.source, drop] as const))("%s: refused", (_source, drop) => {
    const steps =
      drop.answer.kind === "tool"
        ? [step(drop.answer.name, drop.answer.input as ToolInput)]
        : drop.answer.steps.map((planned) => step(planned.tool, planned.arguments as ToolInput));
    // The precondition: a create, no send, and an instruction that asks for one.
    expect(steps.map((planned) => planned.tool)).not.toContain("sendMessage");
    expect(asksFor(drop.instruction, askWords(), CHANNELS)).toBe(true);
    expect(check(drop.instruction, steps)).toEqual({ ok: false, reason: DROPPED_SEND });
  });

  it("the 77 recorded answers: none is refused (every one kept its send)", () => {
    for (const entry of RECORDED) {
      expect(check(entry.instruction, entry.steps), `${entry.source}: ${entry.instruction}`).toEqual({ ok: true });
    }
    expect(RECORDED.every((entry) => entry.steps.some((planned) => canonicalToolName(planned.tool, MENU) === "sendMessage"))).toBe(true);
  });

  it("M28's eval table: the one 'create only' trial is refused, the other 44 are not", () => {
    const refused = EVAL.filter((row) => !check(row.instruction, evalPlan(row)).ok);
    expect(refused.map((row) => `${row.instruction} | ${row.tools.join(">")}`)).toEqual([
      "create a linear issue and send to fun | linear__create_issue",
    ]);
    // The 32 rows that asked for a send and kept it.
    const kept = EVAL.filter((row) => /\b(send|post|tell|know)\b/.test(row.instruction) && row.tools.includes("sendMessage"));
    expect(kept).toHaveLength(32);
    for (const row of kept) expect(check(row.instruction, evalPlan(row))).toEqual({ ok: true });
  });

  // M30's live fixture is NOT replayed here: those runs were cancelled at a dialog, and a cancelled
  // run logged only the steps up to it, so a send planned after the create was never recorded.
  // Reading them as answers would call every one a drop.
});
