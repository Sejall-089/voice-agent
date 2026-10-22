import { describe, expect, it } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import {
  MULTIPLE_TOOL_CALLS,
  PLAN_RETRY_INSTRUCTION,
  withPlanRetry,
} from "../src/core/llm/toolChoice.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { Planner } from "../src/core/planner.ts";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  Tool,
  ToolChoice,
  ToolSchema,
} from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { deferred, jobWorld, settle } from "./jobWorld.ts";

// SEVERAL TOOL CALLS IN ONE ANSWER: asked once more, then refused.
//
// Found live: "create an issue on github for body format and send these notes to fun channel"
// came back from gpt-5 as two separate tool calls (github__create_issue + sendMessage) instead
// of one `plan`, and was refused outright. Reproduced on the real model at 1 in 3 for that
// phrase — the two halves are independent, so a native parallel batch is a natural answer, and
// the same model plans it on another attempt.
//
// No real model here. The provider is a script of answers, and what is asserted is what the
// planner DID with each: how many times it asked, with what words, and what ran.

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const INSTRUCTION = "create an issue on github for body format and send these notes to fun channel";

// Answers in order, one per `chooseTool` call. Asking for more than were scripted throws —
// a planner that retried when it should not have fails loudly, not with a recycled answer.
class SequenceLLM implements LLMClient {
  public readonly asked: { instruction: string; previousTurn: ActionLogEntry | null; menu: string[] }[] = [];

  constructor(private readonly answers: ToolChoice[]) {}

  async chooseTool(
    instruction: string,
    _context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    this.asked.push({ instruction, previousTurn, menu: tools.map((tool) => tool.name) });
    // A later tick, as a network call is: a synchronous fake could only test call order.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = this.answers[this.asked.length - 1];
    if (answer === undefined) throw new Error(`chooseTool called ${this.asked.length} times; only ${this.answers.length} scripted`);
    return answer;
  }

  complete(): Promise<string> {
    return Promise.resolve("");
  }
}

function tools(ran: string[]): Tool[] {
  const make = (name: string, risk: Tool["risk"] = "safe"): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: [] },
    risk,
    background: "ok",
    confirmSummary: (): string => `Run ${name}?`,
    handler: (): Promise<string> => {
      ran.push(name);
      return Promise.resolve(`${name} done`);
    },
  });
  return [make("createIssue", "dangerous"), make("sendNotes", "dangerous"), make("readThing"), make("noteThing")];
}

const MULTI: ToolChoice = { kind: "multiple", tools: ["createIssue", "sendNotes"] };
const plan = (...names: string[]): ToolChoice => ({
  kind: "plan",
  steps: names.map((name) => ({ tool: name, arguments: {}, describe: `do ${name}` })),
});
const planWith = (steps: { tool: string; arguments?: Record<string, unknown> }[]): ToolChoice => ({
  kind: "plan",
  steps: steps.map((step) => ({ tool: step.tool, arguments: step.arguments ?? {}, describe: `do ${step.tool}` })),
});

function harness(answers: ToolChoice[], confirms: boolean[] = [true, true, true]) {
  const ran: string[] = [];
  const llm = new SequenceLLM(answers);
  const shell = new MockShell({ context: NO_CONTEXT, confirms });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    llm,
    shell,
    tools(ran),
    new NoopMemoryResolver(),
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(), // never the real clock: a chain holds its preview
  );
  return { ran, llm, shell, log, planner };
}

describe("the retry text", () => {
  it("is a fixed string from code, appended after the user's own words, untouched", () => {
    expect(withPlanRetry(INSTRUCTION)).toBe(`${INSTRUCTION}\n\n${PLAN_RETRY_INSTRUCTION}`);
    expect(withPlanRetry(INSTRUCTION).startsWith(INSTRUCTION)).toBe(true);
  });

  it("says what was wrong and both ways out: one plan listing the steps in order, or one tool", () => {
    expect(PLAN_RETRY_INSTRUCTION).toContain("several separate tool calls");
    expect(PLAN_RETRY_INSTRUCTION).toContain("ONE call to the `plan` tool");
    expect(PLAN_RETRY_INSTRUCTION).toContain("in order");
    expect(PLAN_RETRY_INSTRUCTION).toContain("only one tool");
  });
});

describe("multi-call, then a plan: the plan runs", () => {
  it("asks exactly twice — the second time with the fixed text — and runs the plan through the ordinary gates", async () => {
    const h = harness([MULTI, plan("createIssue", "sendNotes")]);
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.llm.asked.length).toBe(2);
    expect(h.llm.asked[0]?.instruction).toBe(INSTRUCTION);
    // THE retry text, exactly, and nothing from the rejected answer.
    expect(h.llm.asked[1]?.instruction).toBe(`${INSTRUCTION}\n\n${PLAN_RETRY_INSTRUCTION}`);
    expect(h.llm.asked[1]?.instruction).not.toContain("createIssue");
    // Same menu and same previous turn both times: the retry is the same question, re-asked.
    expect(h.llm.asked[1]?.menu).toEqual(h.llm.asked[0]?.menu);
    expect(h.llm.asked[1]?.previousTurn).toEqual(h.llm.asked[0]?.previousTurn);

    // Both steps are dangerous: each got its own confirm, as in any chain.
    expect(h.shell.confirmMessages).toEqual(["Step 1 of 2: Run createIssue?", "Step 2 of 2: Run sendNotes?"]);
    expect(h.ran).toEqual(["createIssue", "sendNotes"]);
    expect(outcome).toMatchObject({ status: "ok", chain: { completed: 2, total: 2 } });
    // Logged under the user's own instruction, never with the retry text attached.
    expect(h.log.entries.map((row) => row.instruction)).toEqual([INSTRUCTION, INSTRUCTION]);
    expect(h.log.misses).toEqual([]);
  });

  it("nothing ran between the two asks: the model was shown no result", async () => {
    const h = harness([MULTI, plan("readThing", "noteThing")]);
    const order: string[] = [];
    const original = h.llm.chooseTool.bind(h.llm);
    h.llm.chooseTool = async (...args) => {
      order.push(`ask(ran so far: ${h.ran.length}, shown: ${h.shell.results.length}, dialogs: ${h.shell.confirmMessages.length})`);
      return original(...args);
    };
    await h.planner.run(INSTRUCTION);
    expect(order).toEqual([
      "ask(ran so far: 0, shown: 0, dialogs: 0)",
      "ask(ran so far: 0, shown: 0, dialogs: 0)",
    ]);
  });

  it("a single tool on the retry is taken as a single tool", async () => {
    const h = harness([MULTI, { kind: "tool", name: "readThing", input: {} }]);
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual(["readThing"]);
    expect(outcome).toMatchObject({ status: "ok", tool: "readThing" });
  });

  it("a decline on the retry is an ordinary decline, in the model's words", async () => {
    const h = harness([MULTI, { kind: "none", text: "Ask me for one thing at a time." }]);
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(outcome).toMatchObject({ status: "no_tool", result: "Ask me for one thing at a time." });
  });
});

describe("multi-call twice: refused", () => {
  it("exactly 2 provider calls, no handler invoked, no dialog", async () => {
    const h = harness([MULTI, { kind: "multiple", tools: ["sendNotes", "createIssue", "readThing"] }]);
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(outcome.tool).toBeNull();
  });

  it("LOGS THE TOOL NAMES the model returned — the last answer's, in its order — and nothing else of it", async () => {
    const h = harness([MULTI, { kind: "multiple", tools: ["sendNotes", "createIssue", "readThing"] }]);
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.log.entries).toHaveLength(1);
    expect(h.log.entries[0]).toMatchObject({
      instruction: INSTRUCTION,
      tool: null,
      arguments: { calls: ["sendNotes", "createIssue", "readThing"] },
      result: MULTIPLE_TOOL_CALLS,
      status: "refused",
    });
    expect(outcome.proposed).toEqual({ calls: ["sendNotes", "createIssue", "readThing"] });
  });

  it("is NOT a miss: logMiss is never called and the missing-tool backlog stays empty", async () => {
    const h = harness([MULTI, MULTI]);
    let missCalls = 0;
    const originalMiss = h.log.logMiss.bind(h.log);
    h.log.logMiss = (instruction: string): void => {
      missCalls += 1;
      originalMiss(instruction);
    };
    await h.planner.run(INSTRUCTION);
    expect(missCalls).toBe(0);
    expect(h.log.misses).toEqual([]);
    expect(h.log.entries.some((row) => row.status === "no_tool")).toBe(false);
  });

  it("CONTRAST — a real decline still IS a miss, so the test above can tell them apart", async () => {
    const h = harness([{ kind: "none", text: null }]);
    await h.planner.run("do something there is no tool for");
    expect(h.log.misses).toEqual(["do something there is no tool for"]);
  });

  it("the BAR shows the refusal and, as a second paragraph, what was heard; the SPOKEN line is the refusal alone", async () => {
    const h = harness([MULTI, MULTI]);
    await h.planner.run(`  ${INSTRUCTION}  `);

    expect(h.shell.results).toEqual([`${MULTIPLE_TOOL_CALLS}\n\nWhat I heard: “${INSTRUCTION}”`]);
    expect(h.shell.spoken).toHaveLength(1);
    expect(h.shell.spoken[0]).not.toContain("What I heard");
    expect(h.shell.spoken[0]).not.toContain("github");
    expect(h.shell.spoken[0]).toContain("more than one thing");
    // And nothing was held back for "read me the rest" — the instruction is not a remainder.
    expect(h.shell.spoken[0]).not.toMatch(/read the rest|read them/i);
  });
});

describe("no retry for anything else", () => {
  it.each<[string, ToolChoice, string[]]>([
    ["a single tool", { kind: "tool", name: "readThing", input: {} }, ["readThing"]],
    ["a plan", plan("readThing", "noteThing"), ["readThing", "noteThing"]],
    ["no tool, with prose", { kind: "none", text: "I can't help with that." }, []],
    ["no tool at all", { kind: "none", text: null }, []],
    ["a truncated answer", { kind: "incomplete", reason: "ran out of room" }, []],
    ["a tool that does not exist", { kind: "tool", name: "inventedTool", input: {} }, []],
  ])("%s: asked exactly once", async (_name, answer, expectedRan) => {
    // Only ONE answer is scripted: a second ask would throw.
    const h = harness([answer]);
    await h.planner.run("anything");
    expect(h.llm.asked.length).toBe(1);
    expect(h.llm.asked[0]?.instruction).toBe("anything");
    expect(h.ran).toEqual(expectedRan);
  });

  it("a refused PLAN is not retried either: the retry is for multi-call answers only", async () => {
    const h = harness([plan("readThing", "inventedTool")]);
    const outcome = await h.planner.run("anything");
    expect(h.llm.asked.length).toBe(1);
    expect(outcome.status).toBe("refused");
  });
});

describe("the retried plan meets the SAME validators as any plan", () => {
  it.each<[string, ToolChoice, RegExp]>([
    ["an unknown tool", plan("createIssue", "inventedTool"), /inventedTool/],
    ["four steps", plan("readThing", "noteThing", "readThing", "noteThing"), /3|three|steps/i],
    [
      "a forward reference",
      planWith([{ tool: "noteThing", arguments: { text: "{step2}" } }, { tool: "readThing" }]),
      /step/i,
    ],
    [
      "a self reference",
      planWith([{ tool: "readThing" }, { tool: "noteThing", arguments: { text: "{step2}" } }]),
      /step/i,
    ],
    ["`plan` named as a step", plan("readThing", "plan"), /plan/],
  ])("%s -> refused, nothing runs, and it is not asked a third time", async (_name, retried, reason) => {
    const h = harness([MULTI, retried]);
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(outcome.result ?? "").toMatch(reason);
    expect(outcome.chain).toMatchObject({ completed: 0 });
  });

  it("the `functions.` prefix rule applies to a retried plan exactly as to a first one", async () => {
    // What the real model returned on one trial of the live phrase.
    const h = harness([MULTI, plan("functions.createIssue", "functions.sendNotes")]);
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.ran).toEqual(["createIssue", "sendNotes"]);
    expect(outcome.status).toBe("ok");
  });

  it("and a prefix on a name that is NOT on the menu is still refused", async () => {
    const h = harness([MULTI, plan("functions.createIssue", "functions.inventedTool")]);
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.ran).toEqual([]);
    expect(outcome.status).toBe("refused");
  });
});

describe("as a job — attached and detached", () => {
  const jobTools = (ran: string[], hold?: Promise<void>): Tool[] => [
    {
      name: "readThing",
      description: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      handler: async (): Promise<string> => {
        ran.push("readThing");
        if (hold !== undefined) await hold;
        return "read";
      },
    },
    {
      name: "noteThing",
      description: "note",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      handler: (): Promise<string> => {
        ran.push("noteThing");
        return Promise.resolve("noted");
      },
    },
  ];

  // jobWorld's model answers by instruction: the retry's instruction is a different string,
  // which is exactly how the two asks are told apart here.
  const script = (retried: ToolChoice) => ({
    [INSTRUCTION]: { kind: "multiple", tools: ["readThing", "noteThing"] } as ToolChoice,
    [withPlanRetry(INSTRUCTION)]: retried,
  });

  it("attached: retried and run, with the result in the bar", async () => {
    const ran: string[] = [];
    const w = jobWorld({ script: script(plan("readThing", "noteThing")), tools: jobTools(ran) });
    await w.run(INSTRUCTION);
    expect(w.llm.chooseCalls).toBe(2);
    expect(ran).toEqual(["readThing", "noteThing"]);
    expect(w.manager.get("job1")).toMatchObject({ state: "done" });
    expect(w.shell.results.at(-1)).toBe("noted");
  });

  it("detached during planning: still retried, and a second multi-call refusal goes to the job's record, not the bar", async () => {
    const ran: string[] = [];
    const w = jobWorld({ script: script({ kind: "multiple", tools: ["readThing", "noteThing"] }), tools: jobTools(ran) });
    const running = w.run(INSTRUCTION);
    w.manager.detachAttached("hotkey"); // the user pressed the hotkey while it was still planning
    await running;

    expect(w.llm.chooseCalls).toBe(2);
    expect(ran).toEqual([]);
    expect(w.shell.results).toEqual([]);
    expect(w.shell.spoken).toEqual([]);
    const job = w.manager.get("job1");
    expect(job?.state).toBe("failed");
    expect(job?.lines.at(-1)).toContain("What I heard");
    // The row is stamped as a detached job's, with the names.
    expect(w.log.entries[0]).toMatchObject({
      status: "refused",
      detached: true,
      arguments: { calls: ["readThing", "noteThing"] },
    });
  });

  it("detached during planning: a retried plan runs in the background", async () => {
    const ran: string[] = [];
    const hold = deferred();
    hold.resolve();
    const w = jobWorld({ script: script(plan("readThing", "noteThing")), tools: jobTools(ran, hold.promise) });
    const running = w.run(INSTRUCTION);
    w.manager.detachAttached("hotkey");
    await running;
    await settle();
    expect(ran).toEqual(["readThing", "noteThing"]);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", background: true });
    expect(w.shell.results).toEqual([]);
  });
});

// THE PROVIDER'S PARALLEL WRAPPER (live finding after M23). gpt-5-mini answered "summarize this and
// send to fun then create a issue of body in linear and write in notion" with ONE plan call:
// ["functions.summarize", "multi_tool_use.parallel"] — three actions packed into a "step" named
// for the wrapper. It is the multi-call case in another shape: retried once with the same fixed
// text, then refused as one. Exact name only; never unwrapped; never a miss.
describe("multi_tool_use.parallel: the multi-call case in another shape", () => {
  const WRAPPER = "multi_tool_use.parallel";
  // Written out, not imported: a test must not agree with the code by reading the same constant.
  const CAP = "That's more than 3 steps. Say the first three, then the rest.";
  const LIVE = "summarize this and send to fun then create a issue of body in linear and write in notion";
  const wrapperAsStep = planWith([{ tool: "functions.readThing" }, { tool: WRAPPER, arguments: { tool_uses: [] } }]);
  const wrapperAsCall: ToolChoice = { kind: "tool", name: WRAPPER, input: { tool_uses: [] } };
  const noteFor = (n: number) => `I planned ${n} steps. If you asked for more, say the rest after.`;
  const previews = (h: ReturnType<typeof harness>) =>
    h.shell.actions.filter((action) => action.kind === "notify").map((action) => String(action.payload));

  it("as a PLAN STEP: retried once with the fixed text, and the plan that comes back runs", async () => {
    const h = harness([wrapperAsStep, plan("readThing", "noteThing")]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.map((ask) => ask.instruction)).toEqual([LIVE, withPlanRetry(LIVE)]);
    expect(h.ran).toEqual(["readThing", "noteThing"]);
    expect(outcome).toMatchObject({ status: "ok", chain: { completed: 2, total: 2 } });
  });

  it("as a TOP-LEVEL call: retried once too — and no longer reaches logMiss", async () => {
    const h = harness([wrapperAsCall, { kind: "tool", name: "readThing", input: {} }]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual(["readThing"]);
    expect(outcome).toMatchObject({ status: "ok", tool: "readThing" });
    expect(h.log.misses).toEqual([]);
  });

  it.each([
    ["step, then step", wrapperAsStep, wrapperAsStep],
    ["call, then call", wrapperAsCall, wrapperAsCall],
    ["step, then call", wrapperAsStep, wrapperAsCall],
  ] as const)("TWICE (%s): refused with the STEP-CAP wording — the model was packing steps — exactly 2 provider calls, nothing run, no miss", async (_label, first, second) => {
    const h = harness([first, second]);
    let missCalls = 0;
    const originalMiss = h.log.logMiss.bind(h.log);
    h.log.logMiss = (instruction: string): void => {
      missCalls += 1;
      originalMiss(instruction);
    };
    const outcome = await h.planner.run(LIVE);

    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(outcome.status).toBe("refused");
    // Live, gpt-5-mini low, 2 trials of 3: the wrapper both times. What the user can act on is
    // "say fewer at once", not "I decided more than one thing".
    expect(h.shell.results).toEqual([`${CAP}\n\nWhat I heard: “${LIVE}”`]);
    expect(h.shell.spoken).toEqual([CAP]);
    expect(missCalls).toBe(0);
    // Logged as before — the NAMES of the last answer, as the model wrote them — with the wording.
    const names = second.kind === "plan" ? second.steps.map((step) => step.tool) : [WRAPPER];
    expect(h.log.entries).toEqual([expect.objectContaining({ status: "refused", arguments: { calls: names }, result: CAP })]);
  });

  it.each([
    ["a native multi-call, then the wrapper", MULTI, "wrapper"],
    ["the wrapper, then a native multi-call", "wrapper", MULTI],
  ] as const)("MIXED (%s): the GENERIC multi-call wording — only a wrapper both times means packing", async (_label, first, second) => {
    const h = harness([first === "wrapper" ? wrapperAsStep : first, second === "wrapper" ? wrapperAsStep : second]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([`${MULTIPLE_TOOL_CALLS}\n\nWhat I heard: “${LIVE}”`]);
    expect(h.log.misses).toEqual([]);
  });

  it("a GENUINE multi-call answer twice keeps the generic wording, unchanged", async () => {
    const h = harness([MULTI, MULTI]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(2);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([`${MULTIPLE_TOOL_CALLS}\n\nWhat I heard: “${LIVE}”`]);
    expect(h.log.entries).toEqual([expect.objectContaining({ status: "refused", result: MULTIPLE_TOOL_CALLS })]);
  });

  it("the wrapper, then a 4-STEP plan (live, trial 3): the step-cap wording, nothing run", async () => {
    const h = harness([wrapperAsStep, plan("readThing", "noteThing", "readThing", "noteThing")]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(2);
    expect(h.ran).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([CAP]);
  });

  it("an ARBITRARY unknown name is still an ordinary unknown tool: refused with NO retry", async () => {
    for (const unknown of [
      planWith([{ tool: "readThing" }, { tool: "teleport" }]),
      planWith([{ tool: "readThing" }, { tool: "parallel" }]),
      planWith([{ tool: "readThing" }, { tool: "functions.multi_tool_use.parallel" }]),
      planWith([{ tool: "readThing" }, { tool: "Multi_Tool_Use.Parallel" }]),
    ]) {
      const h = harness([unknown]);
      const outcome = await h.planner.run(LIVE);
      expect(h.llm.asked.length).toBe(1);
      expect(outcome.status).toBe("refused");
      expect(h.shell.results[0]).toContain("used a tool I don't have");
      expect(h.ran).toEqual([]);
    }
    // And at the top level, as a miss — exactly as before.
    const h = harness([{ kind: "tool", name: "teleport", input: {} }]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(1);
    expect(outcome.status).toBe("no_tool");
    expect(h.log.misses).toEqual([LIVE]);
  });

  it("a 4-STEP plan is refused with the new wording, and nothing runs or is narrated", async () => {
    const h = harness([plan("readThing", "noteThing", "readThing", "noteThing")]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(1);
    expect(outcome).toMatchObject({ status: "refused", chain: { completed: 0, total: 4 } });
    expect(h.shell.results).toEqual(["That's more than 3 steps. Say the first three, then the rest."]);
    expect(previews(h)).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.log.misses).toEqual([]);
  });

  it("a valid 3-step plan is unaffected: one ask, runs, and its preview carries no extra line", async () => {
    const h = harness([plan("readThing", "noteThing", "readThing")]);
    const outcome = await h.planner.run(LIVE);
    expect(h.llm.asked.length).toBe(1);
    expect(h.ran).toEqual(["readThing", "noteThing", "readThing"]);
    expect(outcome).toMatchObject({ status: "ok", chain: { completed: 3, total: 3 } });
    expect(previews(h)).toHaveLength(1);
    expect(previews(h)[0]).not.toContain("I planned");
    expect(h.shell.spoken.join(" ")).not.toContain("I planned");
  });

  describe("the 'I planned N steps' line — the only sign a dropped action would leave", () => {
    it("SHOWN after a wrapper retry: the preview's last line, and said on its own", async () => {
      const h = harness([wrapperAsStep, plan("readThing", "noteThing", "readThing")]);
      await h.planner.run(LIVE);
      expect(previews(h)).toHaveLength(1);
      expect(previews(h)[0]?.split("\n").at(-1)).toBe(noteFor(3));
      // Its own utterance, so the plan's length cap on speech can never cut it off.
      expect(h.shell.spoken).toContain(noteFor(3));
      // ASCII, so Piper says it as written.
      expect(noteFor(3)).toMatch(/^[\x20-\x7e]+$/);
    });

    it("NOT shown for a normal plan", async () => {
      const h = harness([plan("readThing", "noteThing")]);
      await h.planner.run(LIVE);
      expect(previews(h).join("\n")).not.toContain("I planned");
      expect(h.shell.spoken.join(" ")).not.toContain("I planned");
    });

    it("NOT shown when a retry returns a single tool — after a wrapper or a native multi-call", async () => {
      for (const first of [wrapperAsCall, MULTI]) {
        const h = harness([first, { kind: "tool", name: "readThing", input: {} }]);
        await h.planner.run(LIVE);
        expect(h.ran).toEqual(["readThing"]);
        expect(previews(h).join("\n")).not.toContain("I planned");
        expect(h.shell.spoken.join(" ")).not.toContain("I planned");
      }
    });

    it("NOT shown when a NATIVE multi-call retry returns a plan: it is for the wrapper only", async () => {
      const h = harness([MULTI, plan("readThing", "noteThing")]);
      await h.planner.run(LIVE);
      expect(h.ran).toEqual(["readThing", "noteThing"]);
      expect(previews(h).join("\n")).not.toContain("I planned");
    });
  });

  it("as a DETACHED job: the wrapper is retried in the background, and a second one is refused into the job's record", async () => {
    const ran: string[] = [];
    const tools: Tool[] = ["readThing", "noteThing"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      handler: (): Promise<string> => {
        ran.push(name);
        return Promise.resolve(`${name} done`);
      },
    }));
    const w = jobWorld({ script: { [LIVE]: wrapperAsStep, [withPlanRetry(LIVE)]: wrapperAsStep }, tools });
    const running = w.run(LIVE);
    w.manager.detachAttached("hotkey");
    await running;

    expect(w.llm.chooseCalls).toBe(2);
    expect(ran).toEqual([]);
    expect(w.shell.results).toEqual([]);
    expect(w.manager.get("job1")?.state).toBe("failed");
    expect(w.log.entries[0]).toMatchObject({ status: "refused", detached: true, arguments: { calls: ["functions.readThing", WRAPPER] }, result: CAP });
    expect(w.manager.get("job1")?.lines.at(-1)).toContain(CAP);
    expect(w.log.misses).toEqual([]);
  });
});
