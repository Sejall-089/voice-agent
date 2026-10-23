import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { UNASKED_STEP, UNASKED_STEP_NO_TEXT } from "../src/core/chain.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
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
import { LONG_TRACE } from "./fixtures/planChoice/clipboards.ts";
import { jobWorld, plan as jobPlan } from "./jobWorld.ts";

// THE PLANNER REFUSES A SUMMARIZE OR REWRITE STEP NOBODY ASKED FOR, BEFORE A CREATE — on the plan
// path, before anything is narrated, asked, admitted or run (core/chain.ts, `checkUnaskedSteps`).
//
// The rule and the real word lists are pinned in tests/unaskedSteps.test.ts. This file pins WHERE
// it is applied and what is left behind: one `refused` row with the tool names, no miss, nothing
// shown but the refusal, nothing created, and the row kept out of the next planning call.
//
// The tools are made up (`shrinkThing`, `polishThing`, `fileThing`), with words of their own: the
// planner must never know which tool it is looking at, only what each one declares.

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const COPIED: CapturedContext = { selectedText: LONG_TRACE, activeApp: null, activeWindowTitle: null };
const UNASKED = "create an issue and send to fun";

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
  const shrinkThing: Tool = {
    name: "shrinkThing",
    description: "Shrink the copied text.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "ok",
    planPhrase: "run a test step",
    readsContext: true,
    askedForBy: ["shrink", "cut down"],
    handler: handler("shrinkThing"),
  };
  const polishThing: Tool = {
    name: "polishThing",
    description: "Polish the copied text.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "reversible",
    background: "ok",
    planPhrase: "run a test step",
    readsContext: true,
    askedForBy: ["polish"],
    handler: handler("polishThing"),
  };
  const fileThing: Tool = {
    name: "fileThing",
    description: "File an issue.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
    },
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
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, notes: { type: "string" } },
      required: ["channel"],
    },
    risk: "dangerous",
    background: "ok",
    planPhrase: "run a test step",
    confirmSummary: (input): string => `Tell ${String(input["channel"])}?`,
    handler: handler("tellThing"),
  };
  return [shrinkThing, polishThing, fileThing, tellThing];
}

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: `do ${tool}` });
const plan = (...steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });
const SHRINK = step("shrinkThing");
const FILE = step("fileThing", { title: "Migration fails", body: "{step1}" });
const TELL = step("tellThing", { channel: "fun", notes: "Filed: {step2}" });
// The same, as the second step of two.
const TELL_SECOND = step("tellThing", { channel: "fun", notes: "Filed: {step1}" });

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

function harness(answers: ToolChoice[], options: { registry?: Tool[]; context?: CapturedContext; confirms?: boolean[] } = {}) {
  const ran: Ran = { handled: [] };
  const llm = new SequenceLLM(answers);
  const shell = new MockShell({ context: options.context ?? COPIED, confirms: options.confirms ?? [] });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    llm,
    shell,
    options.registry ?? tools(ran),
    new NoopMemoryResolver(),
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  return { ran, llm, shell, log, planner };
}

function expectRefusedWithNothingElse(h: ReturnType<typeof harness>, sent: string[], reason: string): void {
  expect(h.ran.handled).toEqual([]);
  expect(h.shell.confirmMessages).toEqual([]);
  expect(h.shell.questions).toEqual([]);
  expect(h.shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  expect(h.shell.narrations).toEqual([]);
  expect(h.shell.results).toEqual([reason]);
  expect(h.shell.spoken).toEqual([reason]);
  expect(h.log.misses).toEqual([]);
  expect(h.log.entries).toEqual([
    expect.objectContaining({ tool: null, arguments: { plan: sent }, result: reason, status: "refused" }),
  ]);
}

describe("a plan with a step nobody asked for before a create", () => {
  it("is refused before its preview, any dialog or any step — text copied", async () => {
    const h = harness([plan(SHRINK, FILE, TELL)]);
    const outcome = await h.planner.run(UNASKED);

    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP, chain: { completed: 0, total: 3 } });
    expectRefusedWithNothingElse(h, ["shrinkThing", "fileThing", "tellThing"], UNASKED_STEP);
  });

  it("is refused with the copy-the-text wording when nothing was copied", async () => {
    const h = harness([plan(SHRINK, FILE, TELL)], { context: NO_CONTEXT });
    const outcome = await h.planner.run("log this as an issue and let #bugs know");

    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP_NO_TEXT });
    expectRefusedWithNothingElse(h, ["shrinkThing", "fileThing", "tellThing"], UNASKED_STEP_NO_TEXT);
  });

  it("logs the tool names as the model sent them, prefix and all", async () => {
    const h = harness([plan(step("functions.polishThing"), step("functions.fileThing", { title: "T", body: "{step1}" }))]);
    await h.planner.run(UNASKED);
    expectRefusedWithNothingElse(h, ["functions.polishThing", "functions.fileThing"], UNASKED_STEP);
  });

  it("is judged on the answer that came back after the multi-call retry", async () => {
    const h = harness([{ kind: "multiple", tools: ["shrinkThing", "fileThing"] }, plan(SHRINK, FILE)]);
    const outcome = await h.planner.run(UNASKED);

    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP });
    expect(h.llm.asked.map((call) => call.purpose)).toEqual([undefined, "retry"]);
    expectRefusedWithNothingElse(h, ["shrinkThing", "fileThing"], UNASKED_STEP);
  });

  it("the plan is refused as it was sent, never rewritten: the console gets it whole", async () => {
    const h = harness([plan(SHRINK, FILE, TELL)]);
    const outcome = await h.planner.run(UNASKED);
    expect(outcome.proposed?.plan).toEqual([SHRINK, FILE, TELL]);
  });
});

describe("a plan whose step the person asked for", () => {
  it("runs — preview, the create's dialog, every step", async () => {
    const h = harness([plan(SHRINK, FILE, TELL)], { confirms: [true, true] });
    const outcome = await h.planner.run("shrink this and file it, then tell fun");

    expect(outcome.status).toBe("ok");
    expect(h.shell.actions.filter((action) => action.kind === "notify")).toHaveLength(1);
    expect(h.shell.confirmMessages).toHaveLength(2);
    expect(h.ran.handled).toEqual(["shrinkThing", "fileThing", "tellThing"]);
  });

  it("with the other tool's word, is refused: the lists are per tool", async () => {
    const h = harness([plan(SHRINK, FILE)]);
    const outcome = await h.planner.run("polish this and file it");
    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP });
    expect(h.ran.handled).toEqual([]);
  });
});

describe("a plan the check does not look at", () => {
  it("a step that is not before a create runs", async () => {
    const h = harness([plan(SHRINK, TELL_SECOND)], { confirms: [true] });
    const outcome = await h.planner.run(UNASKED);
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["shrinkThing", "tellThing"]);
  });

  it("a step after the create runs", async () => {
    const h = harness([plan(step("fileThing", { title: "Migration fails", body: LONG_TRACE }), SHRINK)], { confirms: [true] });
    const outcome = await h.planner.run(UNASKED);
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["fileThing", "shrinkThing"]);
  });

  it("a lone step runs", async () => {
    const h = harness([{ kind: "tool", name: "polishThing", input: {} }]);
    const outcome = await h.planner.run(UNASKED);
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["polishThing"]);
  });
});

describe("the next instruction", () => {
  it.each([
    ["text copied", COPIED, UNASKED_STEP],
    ["nothing copied", NO_CONTEXT, UNASKED_STEP_NO_TEXT],
  ] as const)("is not shown this refusal as its previous turn (%s)", async (_name, context, reason) => {
    const h = harness([plan(SHRINK, FILE), { kind: "none", text: "ok" }], { context });
    await h.planner.run(UNASKED);
    await h.planner.run("what's on my calendar");

    // The precondition: the refusal IS the last row in the log.
    expect(h.log.entries[0]?.result).toBe(reason);
    expect(h.llm.asked[1]?.previousTurn).toBeNull();
  });

  it("CONTROL: an ordinary refused plan is still shown as the previous turn", async () => {
    const h = harness([plan(SHRINK, SHRINK, SHRINK, SHRINK), { kind: "none", text: "ok" }]);
    await h.planner.run("shrink it four times");
    await h.planner.run("what's on my calendar");
    expect(h.llm.asked[1]?.previousTurn).toMatchObject({ status: "refused" });
  });
});

describe("where each create's description came from (the outcome, for the [main] line)", () => {
  it("a plan's create fed by a step", async () => {
    const h = harness([plan(SHRINK, FILE)]);
    const outcome = await h.planner.run(UNASKED);
    expect(outcome.descriptions).toEqual(["from an earlier step"]);
  });

  it("a lone create carrying the clipboard as copied, approved", async () => {
    const h = harness([{ kind: "tool", name: "fileThing", input: { title: "T", body: LONG_TRACE } }], { confirms: [true] });
    const outcome = await h.planner.run(UNASKED);
    expect(outcome).toMatchObject({ status: "ok", descriptions: ["equals clipboard"] });
  });

  it("a plan's create carrying something shorter than what was copied", async () => {
    const h = harness([plan(step("fileThing", { title: "T", body: LONG_TRACE.slice(0, 300) }), TELL_SECOND)], { confirms: [false] });
    const outcome = await h.planner.run(UNASKED);
    expect(outcome).toMatchObject({ status: "cancelled", descriptions: ["differs from clipboard"] });
  });

  it("nothing when no create has a description", async () => {
    const h = harness([plan(SHRINK, TELL_SECOND)], { confirms: [true] });
    expect((await h.planner.run(UNASKED)).descriptions).toBeUndefined();
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
    const h = harness(
      [plan(SHRINK, step("linear__create_issue", { title: "Migration fails", description: "{step1}" }), TELL)],
      { registry: [...tools(ran), ...connectors] },
    );
    const outcome = await h.planner.run("create a linear issue and send to fun");

    expect(outcome).toMatchObject({ status: "refused", result: UNASKED_STEP });
    expect(server.created).toEqual([]);
    expect(ran.handled).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
  });
});

describe("a detached job", () => {
  it("is refused before it is admitted: a row, no dialog, no question", async () => {
    const ran: Ran = { handled: [] };
    const w = jobWorld({
      script: {
        [UNASKED]: jobPlan(
          { tool: "shrinkThing", arguments: {} },
          { tool: "fileThing", arguments: { title: "Migration fails", body: "{step1}" } },
        ),
      },
      tools: tools(ran),
    });

    const done = w.run(UNASKED);
    w.manager.detachAttached("hotkey");
    await done;

    expect(ran.handled).toEqual([]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.questions).toEqual([]);
    expect(w.log.entries).toEqual([
      expect.objectContaining({
        tool: null,
        arguments: { plan: ["shrinkThing", "fileThing"] },
        status: "refused",
        detached: true,
      }),
    ]);
    expect([UNASKED_STEP, UNASKED_STEP_NO_TEXT]).toContain(w.log.entries[0]?.result);
    expect(w.log.misses).toEqual([]);
  });
});
