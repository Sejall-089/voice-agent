import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { UNFILLED_BLANK, checkUnfilledBlanks, unfilledBlanks } from "../src/core/chain.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { Planner } from "../src/core/planner.ts";
import { toSpokenResult } from "../src/core/speech.ts";
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
import { MockShell } from "../src/main/shell/MockShell.ts";

// A BLANK THE MODEL LEFT THAT NOTHING WILL FILL (core/chain.ts, `checkUnfilledBlanks`, M28).
//
// From M28's eval: "log this as an issue and let #bugs know", nothing on screen, came back as a
// create whose description was the literal "{selected_text}". Not a `{stepN}`, not blank — so it
// passed every other check, and would have been filed as those characters.
//
// How a blank is told from a brace in someone's text: its SHAPE (one bare name in braces, nothing
// else inside) and WHOSE TEXT it is (a blank in the instruction or the clipboard is the user's).

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const POINTING = "log this as an issue and let #bugs know";

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: `do ${tool}` });
const blanks = (args: ToolInput, theirs: (string | null)[] = []): string[] =>
  unfilledBlanks([step("fileThing", args)], theirs);

describe("what counts as a blank", () => {
  it("a bare name in braces, as the model wrote it", () => {
    expect(blanks({ body: "{selected_text}" })).toEqual(["{selected_text}"]);
    expect(blanks({ body: "Details: {clipboard}" })).toEqual(["{clipboard}"]);
    expect(blanks({ body: "{ clipboard }" })).toEqual(["{ clipboard }"]);
    expect(blanks({ body: "{email.body}" })).toEqual(["{email.body}"]);
  });

  it("found in nested arrays and objects, and in every argument", () => {
    expect(blanks({ title: "T", attendees: ["{attendee}"], meta: { note: "{note}" } })).toEqual(["{attendee}", "{note}"]);
  });

  it("a {stepN} reference is not a blank, in any form the reference parser accepts", () => {
    expect(blanks({ body: "{step1}", notes: "New bug filed: {step2}" })).toEqual([]);
    expect(blanks({ body: "{ step 1 }" })).toEqual([]);
    expect(blanks({ body: "{STEP3}" })).toEqual([]);
  });

  it("CONTROL: a near-miss of {stepN} that the reference parser does not accept IS a blank", () => {
    expect(blanks({ body: "{step_one}" })).toEqual(["{step_one}"]);
    expect(blanks({ body: "{step1x}" })).toEqual(["{step1x}"]);
  });

  it("literal braces that are not the shape: JSON, code, sets, empty, prose in braces", () => {
    expect(blanks({ body: '{"error": "timeout", "code": 504}' })).toEqual([]);
    expect(blanks({ body: "function f() { return x; }" })).toEqual([]);
    expect(blanks({ body: "the set {1, 2, 3}" })).toEqual([]);
    expect(blanks({ body: "{}" })).toEqual([]);
    expect(blanks({ body: "{see below}" })).toEqual([]);
    expect(blanks({ body: "{0}" })).toEqual([]);
  });
});

describe("whose text it is", () => {
  const COPIED = "Template: Hello {name}, your order {order_id} has shipped.";

  it("a blank copied from the clipboard is the user's text, not a blank", () => {
    expect(blanks({ body: COPIED }, [POINTING, COPIED])).toEqual([]);
  });

  it("a blank the user said in the instruction is theirs", () => {
    const said = "send 'use {name} in the greeting' to #team";
    expect(blanks({ notes: "use {name} in the greeting" }, [said, null])).toEqual([]);
  });

  it("CONTROL: the same {name} the user never wrote is a blank — the shape alone would refuse it", () => {
    expect(blanks({ body: "Hello {name}" }, [POINTING, null])).toEqual(["{name}"]);
  });

  it("CONTROL: a clipboard that holds one blank does not excuse a different one", () => {
    expect(blanks({ body: `${COPIED}\n\n{selected_text}` }, [POINTING, COPIED])).toEqual(["{selected_text}"]);
  });

  it("checkUnfilledBlanks reads the instruction and the clipboard", () => {
    const steps = [step("fileThing", { title: "T", body: COPIED })];
    expect(checkUnfilledBlanks(POINTING, { selectedText: COPIED }, steps)).toEqual({ ok: true });
    expect(checkUnfilledBlanks(POINTING, { selectedText: null }, steps)).toEqual({ ok: false, reason: UNFILLED_BLANK });
  });
});

describe("the refusal's words", () => {
  it("are plain ASCII, and one paragraph spoken whole", () => {
    expect(UNFILLED_BLANK).toMatch(/^[\x20-\x7e]+$/);
    expect(UNFILLED_BLANK).not.toContain("\n");
    expect(toSpokenResult(UNFILLED_BLANK)).toEqual({ text: UNFILLED_BLANK, remainder: null });
  });
});

// --- Through the planner -----------------------------------------------------------------------

interface Ran {
  handled: { name: string; input: ToolInput }[];
}

// Made-up tools, as in planner.unreadContent.test.ts: the check reads arguments, never which tool.
function tools(ran: Ran): Tool[] {
  const handler =
    (name: string) =>
    (input: ToolInput): Promise<string> => {
      ran.handled.push({ name, input });
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
    confirmSummary: (input): string => `Tell ${String(input["channel"])}?`,
    handler: handler("tellThing"),
  };
  return [fileThing, tellThing];
}

const plan = (...steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });
const BLANK_CREATE = step("fileThing", { title: "Bug report", body: "{selected_text}" });
const TELL = step("tellThing", { channel: "#bugs", notes: "New bug filed: {step1}" });

class SequenceLLM implements LLMClient {
  public readonly asked: { previousTurn: ActionLogEntry | null }[] = [];
  constructor(private readonly answers: ToolChoice[]) {}

  async chooseTool(
    _instruction: string,
    _context: CapturedContext,
    _tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    this.asked.push({ previousTurn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = this.answers[this.asked.length - 1];
    if (answer === undefined) throw new Error(`chooseTool called ${this.asked.length} times`);
    return answer;
  }

  complete(): Promise<string> {
    return Promise.resolve("");
  }
}

function harness(answers: ToolChoice[], options: { context?: CapturedContext; confirms?: boolean[] } = {}) {
  const ran: Ran = { handled: [] };
  const llm = new SequenceLLM(answers);
  const shell = new MockShell({ context: options.context ?? NO_CONTEXT, confirms: options.confirms ?? [] });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    llm,
    shell,
    tools(ran),
    new NoopMemoryResolver(),
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
  expect(h.shell.results).toEqual([UNFILLED_BLANK]);
  expect(h.log.misses).toEqual([]);
  expect(h.log.entries).toEqual([
    expect.objectContaining({ tool: null, arguments: { plan: sent }, result: UNFILLED_BLANK, status: "refused" }),
  ]);
}

describe("the planner refuses a blank before anything runs", () => {
  it("a plan: refused before its preview, any dialog or any step", async () => {
    const h = harness([plan(BLANK_CREATE, TELL)]);
    const outcome = await h.planner.run(POINTING);
    expect(outcome).toMatchObject({ status: "refused", result: UNFILLED_BLANK, chain: { completed: 0, total: 2 } });
    expectRefusedWithNothingElse(h, ["fileThing", "tellThing"]);
  });

  it("a one-step plan", async () => {
    const h = harness([plan(BLANK_CREATE)]);
    const outcome = await h.planner.run(POINTING);
    expect(outcome).toMatchObject({ status: "refused", result: UNFILLED_BLANK });
    expectRefusedWithNothingElse(h, ["fileThing"]);
  });

  it("a lone call, with no chain on the outcome", async () => {
    const h = harness([{ kind: "tool", name: "tellThing", input: { channel: "#bugs", notes: "{clipboard}" } }]);
    const outcome = await h.planner.run("send this to #bugs");
    expect(outcome).toMatchObject({ status: "refused", tool: null, result: UNFILLED_BLANK });
    expect(outcome.chain).toBeUndefined();
    expectRefusedWithNothingElse(h, ["tellThing"]);
  });

  it("PRECONDITION: the blank create is not refused by the unread-content rule — only this one", async () => {
    // A body that is not blank passes `checkUnreadContent`; without the blank check this plan
    // would reach the dialog. Shown with a blank that is the user's own text, which this rule lets
    // through: the same plan then runs.
    const h = harness([plan(BLANK_CREATE, TELL)], {
      context: { ...NO_CONTEXT, selectedText: "Use the {selected_text} macro in the template." },
      confirms: [true, true],
    });
    const outcome = await h.planner.run(POINTING);
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled.map((call) => call.name)).toEqual(["fileThing", "tellThing"]);
  });

  it("the next instruction is not shown this refusal as its previous turn", async () => {
    const h = harness([plan(BLANK_CREATE, TELL), { kind: "none", text: "ok" }]);
    await h.planner.run(POINTING);
    await h.planner.run("what's on my calendar");
    expect(h.log.entries[0]?.result).toBe(UNFILLED_BLANK);
    expect(h.llm.asked[1]?.previousTurn).toBeNull();
  });
});

describe("CONTROLS: what still runs", () => {
  it("a valid {step1} is substituted and the chain runs", async () => {
    const h = harness([plan(step("fileThing", { title: "Bug report", body: "Login fails on Safari." }), TELL)], {
      confirms: [true, true],
    });
    const outcome = await h.planner.run("file a bug that login fails on Safari and tell #bugs");
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled.map((call) => call.name)).toEqual(["fileThing", "tellThing"]);
    expect(h.ran.handled[1]?.input["notes"]).toBe("New bug filed: fileThing done");
  });

  it("the clipboard as given, braces and all, runs", async () => {
    const clip = 'Crash in render(): TypeError at {"line": 12}; template was "Hi {name}".';
    const h = harness([plan(step("fileThing", { title: "Crash in render", body: clip }), TELL)], {
      context: { ...NO_CONTEXT, selectedText: clip },
      confirms: [true, true],
    });
    const outcome = await h.planner.run(POINTING);
    expect(outcome.status).toBe("ok");
    expect(h.ran.handled[0]?.input["body"]).toBe(clip);
  });
});
