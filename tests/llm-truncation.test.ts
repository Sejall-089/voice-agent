import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapturedContext, ToolSchema } from "../src/core/types.ts";

// Reproduces the SILENT FAILURE these clients used to have.
//
// Both planner models spend their reasoning/preamble tokens from the same allowance the
// tool call has to fit inside. If that allowance runs out first, the response comes back
// with no tool call — and the old code returned { kind: "none" }, which the planner reads
// as "the model declined". So a budget failure was reported to the user as "I don't have a
// tool for that" and filed in the miss backlog as a missing capability. Wrong on both
// counts, and invisible.
//
// No network and no API key: each vendor SDK is mocked, so these assert exactly the
// response→ToolChoice mapping and nothing else.

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

const CONTEXT: CapturedContext = {
  selectedText: "some notes",
  activeApp: null,
  activeWindowTitle: null,
};
const TOOLS: ToolSchema[] = [
  {
    name: "summarize",
    description: "Summarize the selected text",
    inputSchema: { type: "object", properties: {} },
  },
];

const choose = (client: { chooseTool: typeof OpenAILLMClient.prototype.chooseTool }) =>
  client.chooseTool("summarize this", CONTEXT, TOOLS, null);

beforeEach(() => {
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
});

describe("OpenAI chooseTool — reasoning starving the tool call", () => {
  it("reports `incomplete` when reasoning consumed the whole budget", async () => {
    // The starvation case: finish_reason "length", no tool_calls, all tokens on reasoning.
    openaiCreate.mockResolvedValue({
      choices: [{ finish_reason: "length", message: { content: null, tool_calls: undefined } }],
      usage: { completion_tokens_details: { reasoning_tokens: 4096 } },
    });

    const choice = await choose(new OpenAILLMClient("sk-test"));

    expect(choice.kind).toBe("incomplete");
    // The reason has to be specific enough to act on, not just "something went wrong".
    if (choice.kind === "incomplete") {
      expect(choice.reason).toMatch(/token limit/i);
      expect(choice.reason).toMatch(/4096 spent on reasoning/);
    }
  });

  it("still reports a genuine decline as `none`, not as a budget failure", async () => {
    openaiCreate.mockResolvedValue({
      choices: [
        { finish_reason: "stop", message: { content: "I can't help with that.", tool_calls: [] } },
      ],
      usage: {},
    });

    const choice = await choose(new OpenAILLMClient("sk-test"));

    expect(choice.kind).toBe("none");
    if (choice.kind === "none") expect(choice.text).toBe("I can't help with that.");
  });

  it("still returns the tool on a normal response", async () => {
    openaiCreate.mockResolvedValue({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              { type: "function", function: { name: "summarize", arguments: '{"style":"short"}' } },
            ],
          },
        },
      ],
      usage: {},
    });

    const choice = await choose(new OpenAILLMClient("sk-test"));

    expect(choice).toEqual({ kind: "tool", name: "summarize", input: { style: "short" } });
  });

  it("asks for enough headroom that reasoning cannot trivially starve the call", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "", tool_calls: [] } }],
      usage: {},
    });

    await choose(new OpenAILLMClient("sk-test"));

    const [request] = openaiCreate.mock.calls[0] as [{ max_completion_tokens: number }];
    expect(request.max_completion_tokens).toBeGreaterThanOrEqual(4096);
  });
});

describe("Anthropic chooseTool — truncated before the tool_use block", () => {
  it("reports `incomplete` when the response hit max_tokens", async () => {
    anthropicCreate.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Let me think about which tool fits…" }],
    });

    const choice = await choose(new AnthropicLLMClient("sk-ant-test"));

    expect(choice.kind).toBe("incomplete");
    if (choice.kind === "incomplete") expect(choice.reason).toMatch(/token limit/i);
  });

  it("still reports a genuine decline as `none`", async () => {
    anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I can't help with that." }],
    });

    const choice = await choose(new AnthropicLLMClient("sk-ant-test"));

    expect(choice).toEqual({ kind: "none", text: "I can't help with that." });
  });

  it("still returns the tool on a normal response", async () => {
    anthropicCreate.mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "summarize", input: { style: "short" } }],
    });

    const choice = await choose(new AnthropicLLMClient("sk-ant-test"));

    expect(choice).toEqual({ kind: "tool", name: "summarize", input: { style: "short" } });
  });
});
