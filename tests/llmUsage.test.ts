import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import {
  UsageTracker,
  createUsageLog,
  estimateCost,
  formatUsageLine,
  parsePriceTable,
  type LLMUsage,
  type PriceTable,
} from "../src/core/llm/usage.ts";
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

// USAGE LOGGING: what each model call used, what it was for, and what it probably cost.
//
// No network and no key: each vendor SDK is mocked (as in tests/llm-truncation.test.ts), and the
// mocked responses carry a `usage` block in the SHAPE THE SDK'S OWN TYPES DECLARE —
// `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` for
// OpenAI (node_modules/openai/resources/completions.d.ts), `cache_read_input_tokens` for
// Anthropic. What a live response's numbers look like is a live fact; what the code does with a
// block of that shape is not, and is what is pinned here.
//
// THE OTHER HALF OF THE CLAIM IS "NO BEHAVIOUR CHANGE": the request sent to the SDK is compared
// with and without a sink, and the label is checked never to reach it.

const { openaiCreate, anthropicCreate } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

const { OpenAILLMClient } = await import("../src/core/llm/openai.ts");
const { AnthropicLLMClient } = await import("../src/core/llm/anthropic.ts");

const CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const TOOLS: ToolSchema[] = [
  { name: "summarize", description: "Summarize the selected text", inputSchema: { type: "object", properties: {} } },
];

// A planning call the way the bill describes one: a prompt that is mostly cached, and an output
// that is mostly reasoning around a tool call a few dozen tokens long.
const OPENAI_TOOL_CALL = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{ type: "function", function: { name: "summarize", arguments: "{}" } }],
      },
    },
  ],
  usage: {
    prompt_tokens: 6800,
    completion_tokens: 912,
    total_tokens: 7712,
    prompt_tokens_details: { cached_tokens: 6500 },
    completion_tokens_details: { reasoning_tokens: 832 },
  },
};

const PRICES: PriceTable = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
};

beforeEach(() => {
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
});

describe("OpenAI client — what a call reports", () => {
  it("reports a planning call's prompt, cached, reasoning and output tokens", async () => {
    openaiCreate.mockResolvedValue(OPENAI_TOOL_CALL);
    const seen: LLMUsage[] = [];

    const choice = await new OpenAILLMClient("sk-test", (usage) => seen.push(usage)).chooseTool(
      "summarize this",
      CONTEXT,
      TOOLS,
      null,
    );

    expect(choice).toEqual({ kind: "tool", name: "summarize", input: {} });
    expect(seen).toEqual([
      {
        purpose: "planning",
        model: "gpt-5",
        promptTokens: 6800,
        cachedTokens: 6500,
        reasoningTokens: 832,
        outputTokens: 912,
      },
    ]);
  });

  it("labels a call with the purpose it was given", async () => {
    openaiCreate.mockResolvedValue(OPENAI_TOOL_CALL);
    const seen: LLMUsage[] = [];
    const client = new OpenAILLMClient("sk-test", (usage) => seen.push(usage));

    await client.chooseTool("summarize this", CONTEXT, TOOLS, null, "retry");

    expect(seen.map((usage) => usage.purpose)).toEqual(["retry"]);
  });

  it("reports a complete() call under its own label, and unlabelled as 'complete'", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: " a summary " } }],
      usage: { prompt_tokens: 420, completion_tokens: 310, completion_tokens_details: { reasoning_tokens: 192 } },
    });
    const seen: LLMUsage[] = [];
    const client = new OpenAILLMClient("sk-test", (usage) => seen.push(usage));

    expect(await client.complete("system", "user", "summarize")).toBe("a summary");
    await client.complete("system", "user");

    expect(seen).toEqual([
      { purpose: "summarize", model: "gpt-5", promptTokens: 420, cachedTokens: 0, reasoningTokens: 192, outputTokens: 310 },
      { purpose: "complete", model: "gpt-5", promptTokens: 420, cachedTokens: 0, reasoningTokens: 192, outputTokens: 310 },
    ]);
  });

  it("sends the SAME request with a sink as without one, and never sends the label", async () => {
    // Pinned clock: the request carries "Current time", and two calls a millisecond apart
    // must not differ for that reason.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    try {
      openaiCreate.mockResolvedValue(OPENAI_TOOL_CALL);

      await new OpenAILLMClient("sk-test").chooseTool("summarize this", CONTEXT, TOOLS, null);
      await new OpenAILLMClient("sk-test", () => undefined).chooseTool("summarize this", CONTEXT, TOOLS, null, "retry");
      await new OpenAILLMClient("sk-test").complete("system", "user");
      await new OpenAILLMClient("sk-test", () => undefined).complete("system", "user", "format");

      const sent = openaiCreate.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[3]).toEqual(sent[2]);
      for (const request of sent) {
        expect(JSON.stringify(request)).not.toMatch(/purpose|"retry"|"format"/);
        // No setting is changed by this work: the model, and no reasoning effort.
        expect(request["model"]).toBe("gpt-5");
        expect(request).not.toHaveProperty("reasoning_effort");
      }
      expect(sent[0]?.["max_completion_tokens"]).toBe(8192);
      expect(sent[2]?.["max_completion_tokens"]).toBe(4096);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports nothing — not a row of zeros — when the response has no usage block", async () => {
    openaiCreate.mockResolvedValue({ ...OPENAI_TOOL_CALL, usage: undefined });
    const sink = vi.fn();

    await new OpenAILLMClient("sk-test", sink).chooseTool("summarize this", CONTEXT, TOOLS, null);

    expect(sink).not.toHaveBeenCalled();
  });

  it("still returns the model's answer when the sink throws", async () => {
    openaiCreate.mockResolvedValue(OPENAI_TOOL_CALL);
    const client = new OpenAILLMClient("sk-test", () => {
      throw new Error("the log is broken");
    });

    await expect(client.chooseTool("summarize this", CONTEXT, TOOLS, null)).resolves.toEqual({
      kind: "tool",
      name: "summarize",
      input: {},
    });
  });

  it("reports nothing for a call that failed — there is no usage to report", async () => {
    openaiCreate.mockRejectedValue(new Error("connection reset"));
    const sink = vi.fn();

    await expect(new OpenAILLMClient("sk-test", sink).complete("system", "user")).rejects.toThrow("connection reset");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("Anthropic client — what a call reports", () => {
  it("adds cache reads back into the prompt, and reports no reasoning figure", async () => {
    anthropicCreate.mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "summarize", input: {} }],
      // `input_tokens` EXCLUDES cached tokens on this API.
      usage: { input_tokens: 300, output_tokens: 64, cache_read_input_tokens: 6500, cache_creation_input_tokens: null },
    });
    const seen: LLMUsage[] = [];

    await new AnthropicLLMClient("sk-ant-test", (usage) => seen.push(usage)).chooseTool(
      "summarize this",
      CONTEXT,
      TOOLS,
      null,
    );

    expect(seen).toEqual([
      {
        purpose: "planning",
        model: "claude-sonnet-4-6",
        promptTokens: 6800,
        cachedTokens: 6500,
        reasoningTokens: null,
        outputTokens: 64,
      },
    ]);
  });

  it("reports a complete() call under its label", async () => {
    anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "a reply" }],
      usage: { input_tokens: 120, output_tokens: 40 },
    });
    const seen: LLMUsage[] = [];

    await new AnthropicLLMClient("sk-ant-test", (usage) => seen.push(usage)).complete("system", "user", "compose");

    expect(seen).toEqual([
      { purpose: "compose", model: "claude-sonnet-4-6", promptTokens: 120, cachedTokens: 0, reasoningTokens: null, outputTokens: 40 },
    ]);
  });
});

describe("the planner labels its two planning calls", () => {
  // The first answer is several tool calls at once, so the planner asks exactly once more.
  class LabelLLM implements LLMClient {
    public readonly purposes: (string | undefined)[] = [];
    constructor(private readonly answers: ToolChoice[]) {}

    async chooseTool(
      _instruction: string,
      _context: CapturedContext,
      _tools: ToolSchema[],
      _previousTurn: ActionLogEntry | null,
      purpose?: string,
    ): Promise<ToolChoice> {
      this.purposes.push(purpose);
      // A later tick, as a network call is.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const answer = this.answers[this.purposes.length - 1];
      if (answer === undefined) throw new Error("chooseTool called more often than scripted");
      return answer;
    }

    complete(): Promise<string> {
      return Promise.resolve("");
    }
  }

  const tool: Tool = {
    name: "readThing",
    description: "readThing",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "ok",
    planPhrase: "run a test step",
    handler: (): Promise<string> => Promise.resolve("read"),
  };

  it("the first call carries no label (planning); the multi-call retry is labelled 'retry'", async () => {
    const llm = new LabelLLM([
      { kind: "multiple", tools: ["readThing", "readThing"] },
      { kind: "tool", name: "readThing", input: {} },
    ]);
    const planner = new Planner(
      llm,
      new MockShell({ context: CONTEXT }),
      [tool],
      new NoopMemoryResolver(),
      new InMemoryActionLog(),
    );

    const outcome = await planner.run("read the thing twice");

    expect(outcome.status).toBe("ok");
    expect(llm.purposes).toEqual([undefined, "retry"]);
  });
});

describe("estimated cost", () => {
  const planning: LLMUsage = {
    purpose: "planning",
    model: "gpt-5",
    promptTokens: 6800,
    cachedTokens: 6500,
    reasoningTokens: 832,
    outputTokens: 912,
  };

  it("bills cached input at its own rate, and reasoning once (it is inside output)", () => {
    // 300 uncached x 1.25 + 6500 cached x 0.125 + 912 output x 10, per million.
    expect(estimateCost(planning, PRICES)).toBeCloseTo((375 + 812.5 + 9120) / 1_000_000, 10);
  });

  it("is null for a model with no price — never a guess", () => {
    expect(estimateCost({ ...planning, model: "gpt-9" }, PRICES)).toBeNull();
  });

  it("keeps a session total, and says when part of it had no price", () => {
    const tracker = new UsageTracker(PRICES);
    tracker.record(planning);
    tracker.record({ ...planning, purpose: "retry" });
    const third = tracker.record({ ...planning, model: "gpt-9", reasoningTokens: null });

    expect(third.costUsd).toBeNull();
    expect(third.session).toEqual({
      calls: 3,
      promptTokens: 20400,
      cachedTokens: 19500,
      reasoningTokens: 1664,
      outputTokens: 2736,
      costUsd: expect.closeTo(0.020615, 8) as number,
      unpricedCalls: 1,
    });
  });

  it("writes one line per call: purpose, model, the four counts, the cost, the session", () => {
    const tracker = new UsageTracker(PRICES);
    expect(formatUsageLine(tracker.record(planning))).toBe(
      "planning gpt-5: prompt 6800 (cached 6500), output 912 (reasoning 832), est $0.0103" +
        " | session: 1 call, output 912, est $0.0103",
    );
    expect(formatUsageLine(tracker.record({ ...planning, model: "gpt-9", reasoningTokens: null }))).toBe(
      "planning gpt-9: prompt 6800 (cached 6500), output 912 (reasoning n/a), est no price for this model" +
        " | session: 2 calls, output 1824, est $0.0103 + 1 unpriced",
    );
  });
});

describe("the price table is data", () => {
  it("reads prices per model and ignores anything else in the file", () => {
    const parsed = parsePriceTable(
      JSON.stringify({ _note: "x", models: { "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 } } }),
    );
    expect(parsed).toEqual({ prices: PRICES, problems: [] });
  });

  it("drops a broken entry, names it, and keeps the rest", () => {
    const parsed = parsePriceTable(
      JSON.stringify({
        models: {
          "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
          "gpt-5-mini": { input: "0.25", output: 2 },
          negative: { input: -1, cachedInput: 0, output: 1 },
        },
      }),
    );
    expect(parsed.prices).toEqual(PRICES);
    expect(parsed.problems).toEqual([
      'the price for "gpt-5-mini" needs numeric input, cachedInput and output',
      'the price for "negative" needs numeric input, cachedInput and output',
    ]);
  });

  it("never throws: a missing, unreadable or shapeless table is no prices and one problem", () => {
    expect(parsePriceTable(null)).toEqual({ prices: {}, problems: ["no price table was found"] });
    expect(parsePriceTable("{ not json")).toEqual({ prices: {}, problems: ["the price table is not valid JSON"] });
    expect(parsePriceTable("[]").problems).toEqual(['the price table has no "models" object']);
  });

  it("the committed llm-prices.json loads clean and prices both providers' models", () => {
    const text = readFileSync(new URL("../llm-prices.json", import.meta.url), "utf8");
    const { prices, problems } = parsePriceTable(text);
    expect(problems).toEqual([]);
    expect(Object.keys(prices)).toEqual(expect.arrayContaining(["gpt-5", "claude-sonnet-4-6"]));
  });

  it("a changed price changes the estimate with no code change", () => {
    const usage: LLMUsage = { purpose: "planning", model: "gpt-5", promptTokens: 0, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1_000_000 };
    const doubled = parsePriceTable(JSON.stringify({ models: { "gpt-5": { input: 1.25, cachedInput: 0.125, output: 20 } } }));
    expect(estimateCost(usage, PRICES)).toBe(10);
    expect(estimateCost(usage, doubled.prices)).toBe(20);
  });
});

describe("the app's usage log", () => {
  it("logs each call with a running session total", () => {
    const lines: string[] = [];
    const sink = createUsageLog(JSON.stringify({ models: PRICES }), (line) => lines.push(line));
    const usage: LLMUsage = { purpose: "planning", model: "gpt-5", promptTokens: 6800, cachedTokens: 6500, reasoningTokens: 832, outputTokens: 912 };

    sink(usage);
    sink({ ...usage, purpose: "format", outputTokens: 400, reasoningTokens: 320 });

    expect(lines).toEqual([
      "planning gpt-5: prompt 6800 (cached 6500), output 912 (reasoning 832), est $0.0103 | session: 1 call, output 912, est $0.0103",
      "format gpt-5: prompt 6800 (cached 6500), output 400 (reasoning 320), est $0.0052 | session: 2 calls, output 1312, est $0.0155",
    ]);
  });

  it("says once that the table is missing, and still logs the calls without a cost", () => {
    const lines: string[] = [];
    const sink = createUsageLog(null, (line) => lines.push(line));

    sink({ purpose: "planning", model: "gpt-5", promptTokens: 10, cachedTokens: 0, reasoningTokens: 0, outputTokens: 5 });

    expect(lines).toEqual([
      "usage: no price table was found (llm-prices.json) — costs may be missing",
      "planning gpt-5: prompt 10 (cached 0), output 5 (reasoning 0), est no price for this model | session: 1 call, output 5, est $0.0000 + 1 unpriced",
    ]);
  });
});
