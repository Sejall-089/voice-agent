import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { DROPPED_SEND } from "../src/core/chain.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  PlannedStep,
  Tool,
  ToolChoice,
  ToolInput,
  ToolSchema,
} from "../src/core/types.ts";
import type { LLMPurpose } from "../src/core/llm/usage.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeMcpServer } from "./FakeMcpServer.ts";
import { jobWorld, plan as jobPlan } from "./jobWorld.ts";

// THE PLANNER REFUSES A CREATE THAT DROPPED A REQUESTED SEND — on the lone-call path, where every
// drop on record came, and on the plan path before the one-step branch; before anything is
// narrated, asked, admitted or run (core/chain.ts, `checkDroppedSends`, M31).
//
// The rule and the real word list are pinned in tests/droppedSends.test.ts. This file pins WHERE
// it is applied and what is left behind: one `refused` row with the tool names, no miss, nothing
// shown but the refusal, nothing created, and the row kept out of the next planning call.
//
// The tools are made up (`fileThing`, `tellThing`, `replyThing`) and declare their own words: the
// planner must never know which tool it is looking at.

const COPIED: CapturedContext = { selectedText: "Tried the migration again on staging.", activeApp: null, activeWindowTitle: null };
const ASKED = "create an issue and send to fun";

interface Ran {
  handled: string[];
}

function tools(ran: Ran): Tool[] {
  const handler =
    (name: string) =>
    (_input: ToolInput): Promise<string> => {
      ran.handled.push(name);
      return Promise.resolve(`${name} done`);
    };
  const fileThing: Tool = {
    name: "fileThing",
    description: "File an issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
    risk: "dangerous",
    background: "ok",
    planPhrase: "run a test step",
    contentArg: { title: "title", body: "body" },
    confirmSummary: (input): string => `File "${String(input["title"])}"?`,
    handler: handler("fileThing"),
  };
  const tellThing: Tool = {
    name: "tellThing",
    description: "Tell a channel.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, notes: { type: "string" } }, required: ["channel"] },
    risk: "dangerous",
    background: "ok",
    planPhrase: "run a test step",
    askedWithCreateBy: ["send", "tell", "let ... know"],
    confirmSummary: (input): string => `Tell ${String(input["channel"])}?`,
    handler: handler("tellThing"),
  };
  // A send of another kind (as `sendReply` is): it declares no words, so it is never THE send.
  const replyThing: Tool = {
    name: "replyThing",
    description: "Send a reply.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "dangerous",
    background: "ok",
    planPhrase: "run a test step",
    confirmSummary: (): string => "Send the reply?",
    handler: handler("replyThing"),
  };
  return [fileThing, tellThing, replyThing];
}

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: `do ${tool}` });
const plan = (...steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });
const lone = (name: string, input: ToolInput = {}): ToolChoice => ({ kind: "tool", name, input });
const FILE = step("fileThing", { title: "Migration fails", body: "notes" });
const TELL = step("tellThing", { channel: "fun", notes: "Filed: {step1}" });

class SequenceLLM implements LLMClient {
  public readonly asked: { instruction: string; previousTurn: ActionLogEntry | null; purpose: LLMPurpose | undefined }[] = [];
  constructor(private readonly answers: ToolChoice[]) {}

  async chooseTool(
    instruction: string,
    _context: CapturedContext,
    _tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
    purpose?: LLMPurpose,
  ): Promise<ToolChoice> {
    this.asked.push({ instruction, previousTurn, purpose });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = this.answers[this.asked.length - 1];
    if (answer === undefined) throw new Error(`chooseTool called ${this.asked.length} times; only ${this.answers.length} scripted`);
    return answer;
  }

  complete(): Promise<string> {
    return Promise.resolve("");
  }
}

// Memory knows "#fun" as the app's does ("third channel" = "#fun").
function harness(answers: ToolChoice[], options: { registry?: Tool[]; context?: CapturedContext; confirms?: boolean[] } = {}) {
  const ran: Ran = { handled: [] };
  const llm = new SequenceLLM(answers);
  const shell = new MockShell({ context: options.context ?? COPIED, confirms: options.confirms ?? [] });
  const log = new InMemoryActionLog();
  const memory = new SqliteMemory(createDatabase(":memory:"));
  memory.write("third channel", "#fun");
  const planner = new Planner(
    llm,
    shell,
    options.registry ?? tools(ran),
    memory,
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  return { ran, llm, shell, log, planner };
}

function expectRefusedWithNothingElse(h: ReturnType<typeof harness>, sent: string[]): void {
  expect(h.ran.handled).toEqual([]);
  expect(h.shell.confirmMessages).toEqual([]);
  expect(h.shell.questions).toEqual([]);
  expect(h.shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  expect(h.shell.narrations).toEqual([]);
  expect(h.shell.results).toEqual([DROPPED_SEND]);
  expect(h.shell.spoken).toEqual([DROPPED_SEND]);
  expect(h.log.misses).toEqual([]);
  expect(h.log.entries).toEqual([
    expect.objectContaining({ tool: null, arguments: { plan: sent }, result: DROPPED_SEND, status: "refused" }),
  ]);
}

describe("a lone create when a send was asked for", () => {
  it("is refused before the dialog, with one row and no chain", async () => {
    const h = harness([lone("fileThing", { title: "Migration fails", body: "notes" })]);
    const outcome = await h.planner.run(ASKED);

    expect(outcome).toMatchObject({ status: "refused", tool: null, result: DROPPED_SEND, proposed: { tool: "fileThing" } });
    expect(outcome.chain).toBeUndefined();
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });

  it("is judged after the multi-call retry", async () => {
    const h = harness([{ kind: "multiple", tools: ["fileThing", "tellThing"] }, lone("fileThing", { title: "T" })]);
    const outcome = await h.planner.run(ASKED);
    expect(outcome).toMatchObject({ status: "refused", result: DROPPED_SEND });
    expect(h.llm.asked.map((call) => call.purpose)).toEqual([undefined, "retry"]);
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });

  it("CONTROL: a lone create with no send asked for runs to its dialog", async () => {
    const h = harness([lone("fileThing", { title: "T" })], { confirms: [true] });
    const outcome = await h.planner.run("create an issue");
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["fileThing"]);
  });

  it("CONTROL: a lone create whose send names a channel nobody taught the app runs", async () => {
    const h = harness([lone("fileThing", { title: "T" })], { confirms: [true] });
    expect((await h.planner.run("create an issue and send to general")).status).toBe("ok");
  });
});

describe("a plan", () => {
  it("a one-step plan is refused the same way, before it is run as a single call", async () => {
    const h = harness([plan(FILE)]);
    const outcome = await h.planner.run(ASKED);
    expect(outcome).toMatchObject({ status: "refused", result: DROPPED_SEND, chain: { completed: 0, total: 1 } });
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });

  it("a plan with a create and another kind of send is refused", async () => {
    const h = harness([plan(FILE, step("replyThing"))]);
    const outcome = await h.planner.run(ASKED);
    expect(outcome).toMatchObject({ status: "refused", result: DROPPED_SEND });
    expectRefusedWithNothingElse(h, ["fileThing", "replyThing"]);
  });

  it("logs the tool names as the model sent them, prefix and all", async () => {
    const h = harness([plan(step("functions.fileThing", { title: "T" }))]);
    await h.planner.run(ASKED);
    expectRefusedWithNothingElse(h, ["functions.fileThing"]);
  });

  it("CONTROL: create then send runs — preview, both dialogs, both steps", async () => {
    const h = harness([plan(FILE, TELL)], { confirms: [true, true] });
    const outcome = await h.planner.run(ASKED);
    expect(outcome.status).toBe("ok");
    expect(h.shell.actions.filter((action) => action.kind === "notify")).toHaveLength(1);
    expect(h.ran.handled).toEqual(["fileThing", "tellThing"]);
  });

  it("CONTROL: send then create runs", async () => {
    const h = harness([plan(step("tellThing", { channel: "fun", notes: "heads up" }), FILE)], { confirms: [true, true] });
    expect((await h.planner.run("send these to fun and raise an issue")).status).toBe("ok");
    expect(h.ran.handled).toEqual(["tellThing", "fileThing"]);
  });

  it("CONTROL: an answer with no create is never looked at", async () => {
    const h = harness([lone("replyThing")], { confirms: [true] });
    expect((await h.planner.run("reply to this and send it")).status).toBe("ok");
    expect(h.ran.handled).toEqual(["replyThing"]);
  });
});

describe("the instruction is judged, never the clipboard", () => {
  it("a clipboard that says 'send to fun' does not make a create a dropped send", async () => {
    const h = harness([lone("fileThing", { title: "T" })], {
      context: { selectedText: "Remember to send to fun when this is filed.", activeApp: null, activeWindowTitle: null },
      confirms: [true],
    });
    expect((await h.planner.run("create an issue")).status).toBe("ok");
  });

  it("an instruction that asks is refused whatever the clipboard says", async () => {
    const h = harness([lone("fileThing", { title: "T" })], {
      context: { selectedText: "Nothing about channels here.", activeApp: null, activeWindowTitle: null },
    });
    expect((await h.planner.run(ASKED)).status).toBe("refused");
  });
});

describe("the next instruction", () => {
  it("is not shown this refusal as its previous turn", async () => {
    const h = harness([lone("fileThing", { title: "T" }), { kind: "none", text: "ok" }]);
    await h.planner.run(ASKED);
    await h.planner.run("what's on my calendar");

    // The precondition: the refusal IS the last row in the log.
    expect(h.log.entries[0]?.result).toBe(DROPPED_SEND);
    expect(h.llm.asked[1]?.previousTurn).toBeNull();
  });

  it("CONTROL: an ordinary refused plan is still shown as the previous turn", async () => {
    const h = harness([plan(FILE, FILE, FILE, FILE), { kind: "none", text: "ok" }]);
    await h.planner.run("file it four times");
    await h.planner.run("what's on my calendar");
    expect(h.llm.asked[1]?.previousTurn).toMatchObject({ status: "refused" });
  });
});

describe("a real connector create (Linear over a fake MCP server)", () => {
  it("is refused with nothing sent to the server", async () => {
    const server = new FakeMcpServer({ timeline: [] });
    const connectors = loadConnectorTools({
      configText: JSON.stringify({
        connectors: { linear: { enabled: true, tools: ["create_issue"], settings: { defaultTeam: "Engineering" } } },
      }),
      readKey: () => "lin_api_test",
      connect: (def) =>
        new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: server.transport, timeoutMs: 300, connectTimeoutMs: 300 }),
    }).tools;
    const ran: Ran = { handled: [] };
    const h = harness([lone("linear__create_issue", { title: "Migration fails", description: "notes" })], {
      registry: [...tools(ran), ...connectors],
    });
    const outcome = await h.planner.run("create a linear issue and send to fun");

    expect(outcome).toMatchObject({ status: "refused", result: DROPPED_SEND });
    expect(server.created).toEqual([]);
    expect(server.calls.filter((call) => call.name === "save_issue")).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
  });
});

describe("a detached job", () => {
  it("is refused before it is admitted: a row, no dialog, no question", async () => {
    const ran: Ran = { handled: [] };
    const instruction = "create an issue and let #bugs know";
    const w = jobWorld({
      script: { [instruction]: jobPlan({ tool: "fileThing", arguments: { title: "Migration fails", body: "notes" } }) },
      tools: tools(ran),
    });

    const done = w.run(instruction);
    w.manager.detachAttached("hotkey");
    await done;

    expect(ran.handled).toEqual([]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.questions).toEqual([]);
    expect(w.log.entries).toEqual([
      expect.objectContaining({ tool: null, arguments: { plan: ["fileThing"] }, result: DROPPED_SEND, status: "refused", detached: true }),
    ]);
    expect(w.log.misses).toEqual([]);
  });
});
