import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { UNREAD_CONTENT } from "../src/core/chain.ts";
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
import { jobWorld, plan as jobPlan } from "./jobWorld.ts";

// THE PLANNER REFUSES A CREATE THAT USES NOTHING THE USER POINTED AT — on every path, before
// anything is narrated, asked, admitted or run (core/chain.ts, `checkUnreadContent`).
//
// The rule's clauses are pinned in tests/unreadContent.test.ts against recorded model answers.
// This file pins WHERE it is applied: a plan, a one-step plan, a lone call, the answer after the
// multi-call retry, a detached job — and what is left behind: one `refused` row with the tool names,
// no miss, nothing shown but the refusal, and nothing created.
//
// The tools here are made up on purpose (`fileThing`, `tellThing`, `readThing`). The planner must
// never know which tool it is looking at; a check that works on tools it has never heard of, by
// their declarations alone, is the proof.

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const POINTING = "log this as an issue and let #bugs know";

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
    // Reads the clipboard itself when it has no notes — the shape `sendMessage` declares.
    readsContext: (args) => typeof args["notes"] !== "string" || args["notes"].trim() === "",
    confirmSummary: (input): string => `Tell ${String(input["channel"])}?`,
    handler: handler("tellThing"),
  };
  const readThing: Tool = {
    name: "readThing",
    description: "Read the open thing.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "ok",
    planPhrase: "run a test step",
    readsContext: true,
    handler: handler("readThing"),
  };
  return [fileThing, tellThing, readThing];
}

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: `do ${tool}` });
const plan = (...steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });
const INVENTED = step("fileThing", { title: "Bug report" });
const TELL = step("tellThing", { channel: "#bugs", notes: "New bug filed: {step1}" });

// Answers in order, one per chooseTool call; records what each call was given.
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
    // A later tick, as a network call is.
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
  const shell = new MockShell({ context: options.context ?? NO_CONTEXT, confirms: options.confirms ?? [] });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    llm,
    shell,
    options.registry ?? tools(ran),
    new NoopMemoryResolver(),
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(), // never the real clock: a chain holds its preview
  );
  return { ran, llm, shell, log, planner };
}

// What every refusal by this rule leaves behind, whatever the path.
function expectRefusedWithNothingElse(
  h: ReturnType<typeof harness>,
  sent: string[],
): void {
  expect(h.ran.handled).toEqual([]);
  expect(h.shell.confirmMessages).toEqual([]);
  expect(h.shell.questions).toEqual([]);
  // No plan preview, no narration: the refusal is the only thing on screen.
  expect(h.shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  expect(h.shell.narrations).toEqual([]);
  expect(h.shell.results).toEqual([UNREAD_CONTENT]);
  expect(h.log.misses).toEqual([]);
  expect(h.log.entries).toEqual([
    expect.objectContaining({ tool: null, arguments: { plan: sent }, result: UNREAD_CONTENT, status: "refused" }),
  ]);
}

describe("a plan", () => {
  it("is refused before its preview, any dialog or any step", async () => {
    const h = harness([plan(INVENTED, TELL)]);
    const outcome = await h.planner.run(POINTING);

    expect(outcome).toMatchObject({ status: "refused", result: UNREAD_CONTENT, chain: { completed: 0, total: 2 } });
    expectRefusedWithNothingElse(h, ["fileThing", "tellThing"]);
  });

  it("logs the tool names as the model sent them, prefix and all", async () => {
    const h = harness([plan(step("functions.fileThing", { title: "Bug report" }), step("functions.tellThing", { channel: "#bugs", notes: "{step1}" }))]);
    await h.planner.run(POINTING);
    expectRefusedWithNothingElse(h, ["functions.fileThing", "functions.tellThing"]);
  });

  it("CONTROL: the same create fed by a step that reads runs — preview, dialogs, steps", async () => {
    const h = harness(
      [plan(step("readThing"), step("fileThing", { title: "Bug report", body: "{step1}" }), step("tellThing", { channel: "#bugs", notes: "{step2}" }))],
      { confirms: [true, true] },
    );
    const outcome = await h.planner.run(POINTING);

    expect(outcome.status).toBe("ok");
    expect(h.shell.actions.filter((action) => action.kind === "notify")).toHaveLength(1);
    expect(h.ran.handled).toEqual(["readThing", "fileThing", "tellThing"]);
  });

  it("CONTROL: the same invented create is not refused when the instruction points at nothing", async () => {
    const h = harness([plan(INVENTED, TELL)], { confirms: [true, true] });
    const outcome = await h.planner.run("file a bug report and let #bugs know");
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["fileThing", "tellThing"]);
  });
});

describe("a one-step plan", () => {
  it("is refused the same way, before it is run as a single call", async () => {
    const h = harness([plan(INVENTED)]);
    const outcome = await h.planner.run(POINTING);
    expect(outcome).toMatchObject({ status: "refused", result: UNREAD_CONTENT });
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });
});

describe("a lone call", () => {
  it("is refused before the dialog, with the same row and no chain", async () => {
    const h = harness([{ kind: "tool", name: "fileThing", input: { title: "Bug report" } }]);
    const outcome = await h.planner.run(POINTING);

    expect(outcome).toMatchObject({ status: "refused", tool: null, result: UNREAD_CONTENT });
    expect(outcome.chain).toBeUndefined();
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });

  it("CONTROL: a lone create the user dictated runs", async () => {
    const h = harness([{ kind: "tool", name: "fileThing", input: { title: "Login button is broken" } }], { confirms: [true] });
    const outcome = await h.planner.run("file a bug titled login button is broken");
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled).toEqual(["fileThing"]);
  });
});

describe("after the multi-call retry", () => {
  it("judges whatever came back, and a refusal is not retried", async () => {
    const h = harness([{ kind: "multiple", tools: ["fileThing", "tellThing"] }, plan(INVENTED, TELL)]);
    const outcome = await h.planner.run(POINTING);

    expect(outcome).toMatchObject({ status: "refused", result: UNREAD_CONTENT });
    // Asked twice — the answer and the one retry — and never a third time.
    expect(h.llm.asked.map((call) => call.purpose)).toEqual([undefined, "retry"]);
    expectRefusedWithNothingElse(h, ["fileThing", "tellThing"]);
  });
});

describe("the next instruction", () => {
  it("is not shown this refusal as its previous turn", async () => {
    const h = harness([plan(INVENTED, TELL), { kind: "none", text: "ok" }]);
    await h.planner.run(POINTING);
    await h.planner.run("what's on my calendar");

    // The precondition: the refusal IS the last row in the log.
    expect(h.log.entries[0]?.result).toBe(UNREAD_CONTENT);
    expect(h.llm.asked[1]?.previousTurn).toBeNull();
  });

  it("CONTROL: an ordinary refused plan is still shown as the previous turn", async () => {
    // A four-step plan is refused by `validatePlan`, not by this rule.
    const h = harness([plan(step("readThing"), step("readThing"), step("readThing"), step("readThing")), { kind: "none", text: "ok" }]);
    await h.planner.run("read it four times");
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
    const h = harness(
      [plan(step("linear__create_issue", { title: "Bug report" }), step("tellThing", { channel: "the social channel", notes: "New bug filed: {step1}" }))],
      { registry: [...tools(ran), ...connectors] },
    );
    const outcome = await h.planner.run("file this bug in Linear and tell the social channel");

    expect(outcome).toMatchObject({ status: "refused", result: UNREAD_CONTENT });
    expect(server.created).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
  });
});

describe("a detached job", () => {
  it("is refused before it is admitted: a row, no dialog, no question", async () => {
    const ran: Ran = { handled: [] };
    const w = jobWorld({
      script: {
        [POINTING]: jobPlan(
          { tool: "fileThing", arguments: { title: "Bug report" } },
          { tool: "tellThing", arguments: { channel: "#bugs", notes: "New bug filed: {step1}" } },
        ),
      },
      tools: tools(ran),
    });

    const done = w.run(POINTING);
    // Detached before the model has answered: whatever happens next happens in the background.
    w.manager.detachAttached("hotkey");
    await done;

    expect(ran.handled).toEqual([]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.questions).toEqual([]);
    expect(w.log.entries).toEqual([
      expect.objectContaining({
        tool: null,
        arguments: { plan: ["fileThing", "tellThing"] },
        result: UNREAD_CONTENT,
        status: "refused",
        detached: true,
      }),
    ]);
    expect(w.log.misses).toEqual([]);
  });
});
