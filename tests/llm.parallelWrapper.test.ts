import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { withPlanRetry } from "../src/core/llm/toolChoice.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { Planner } from "../src/core/planner.ts";
import type { CapturedContext, Tool } from "../src/core/types.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";

// The provider's parallel wrapper, from the RAW response to what the planner does with it (live
// finding after M23). tests/planner.multicall.test.ts feeds the planner ToolChoices; this pins
// the step before that: an OpenAI response naming `multi_tool_use.parallel` — as a lone call,
// or inside a `plan` call's steps — reaches the planner in a shape it retries. No network: the
// SDK is mocked, and the responses are written in the shape the API returns (the function's
// arguments as a JSON STRING), the plan one transcribed from the live action log's names.

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
const { OpenAILLMClient } = await import("../src/core/llm/openai.ts");

const INSTRUCTION = "summarize this and send to fun then create a issue of body in linear and write in notion";
const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

const response = (name: string, args: unknown) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: { content: null, tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    },
  ],
  usage: {},
});
const WRAPPER_CALL = response("multi_tool_use.parallel", {
  tool_uses: [
    { recipient_name: "functions.summarize", parameters: {} },
    { recipient_name: "functions.sendNotes", parameters: { text: "x" } },
  ],
});
const WRAPPER_IN_PLAN = response("plan", {
  steps: [
    { tool: "functions.summarize", arguments: {}, describe: "summarize" },
    { tool: "multi_tool_use.parallel", arguments: { tool_uses: [] }, describe: "do the rest" },
  ],
});
const GOOD_PLAN = response("plan", {
  steps: [
    { tool: "summarize", arguments: {}, describe: "summarize the notes" },
    { tool: "sendNotes", arguments: { text: "{step1}" }, describe: "send them" },
  ],
});

function world() {
  const ran: string[] = [];
  const make = (name: string): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: [] },
    risk: "safe",
    background: "ok",
    planPhrase: "run a test step",
    handler: (): Promise<string> => {
      ran.push(name);
      return Promise.resolve(`${name} done`);
    },
  });
  const shell = new MockShell({ context: NO_CONTEXT, confirms: [] });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    new OpenAILLMClient("sk-test"),
    shell,
    [make("summarize"), make("sendNotes")],
    new NoopMemoryResolver(),
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    () => Promise.resolve(),
  );
  return { ran, shell, log, planner };
}

const askedWith = (): string[] =>
  openaiCreate.mock.calls.map((call) => {
    const messages = (call[0] as { messages: { role: string; content: string }[] }).messages;
    return messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  });

beforeEach(() => openaiCreate.mockReset());

describe("an OpenAI response naming multi_tool_use.parallel reaches the planner as a retry", () => {
  for (const [label, first] of [
    ["a LONE call named the wrapper", WRAPPER_CALL],
    ["a PLAN with a step named the wrapper", WRAPPER_IN_PLAN],
  ] as const) {
    it(`${label}: asked again with the fixed text, and the plan that comes back runs`, async () => {
      openaiCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(GOOD_PLAN);
      const w = world();
      const outcome = await w.planner.run(INSTRUCTION);

      expect(openaiCreate).toHaveBeenCalledTimes(2);
      expect(askedWith()[1]).toContain(withPlanRetry(INSTRUCTION).split("\n\n")[1]);
      expect(w.ran).toEqual(["summarize", "sendNotes"]);
      expect(outcome).toMatchObject({ status: "ok", chain: { completed: 2, total: 2 } });
      expect(w.log.misses).toEqual([]);
    });

    it(`${label}, twice: refused after exactly 2 provider calls, nothing run, not a miss`, async () => {
      openaiCreate.mockResolvedValue(first);
      const w = world();
      const outcome = await w.planner.run(INSTRUCTION);

      expect(openaiCreate).toHaveBeenCalledTimes(2);
      expect(w.ran).toEqual([]);
      expect(outcome.status).toBe("refused");
      expect(w.log.misses).toEqual([]);
    });
  }
});
