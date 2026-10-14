import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultModelSettings,
  describeModelSettings,
  readModelSettings,
  settingsFor,
  type ModelSettings,
} from "../src/core/llm/modelSettings.ts";
import type { LLMPurpose } from "../src/core/llm/usage.ts";
import type { CapturedContext, ToolSchema } from "../src/core/types.ts";

// MODEL AND REASONING EFFORT PER KIND OF CALL, from .env (core/llm/modelSettings.ts).
//
// Two claims, and the provider is a FAKE for both — each SDK is mocked, as in
// tests/llmUsage.test.ts, so what is asserted is the request the app would send:
//
//   1. WITH NOTHING SET, NOTHING CHANGES. The request is compared, field for field, with one
//      written out by hand from what the clients sent before this existed — not with the output
//      of the code under test, which could only prove the code agrees with itself.
//   2. AN OVERRIDE REACHES ITS OWN CALLS AND NO OTHERS. Planning settings change `chooseTool`
//      (planning and the retry) and never a `complete`; task settings change every `complete`
//      purpose and never a `chooseTool`.

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
const { createLLMClient, modelSettingsFor } = await import("../src/core/llm/factory.ts");

const CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const TOOLS: ToolSchema[] = [
  { name: "summarize", description: "Summarize the selected text", inputSchema: { type: "object", properties: {} } },
];

const OPENAI_ANSWER = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: { content: "ok", tool_calls: [{ type: "function", function: { name: "summarize", arguments: "{}" } }] },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};
const ANTHROPIC_ANSWER = {
  stop_reason: "tool_use",
  content: [{ type: "tool_use", name: "summarize", input: {} }, { type: "text", text: "ok" }],
  usage: { input_tokens: 100, output_tokens: 20 },
};

const TASK_PURPOSES: LLMPurpose[] = ["summarize", "rewrite", "format", "compose", "compose-note", "point", "complete"];

beforeEach(() => {
  openaiCreate.mockReset().mockResolvedValue(OPENAI_ANSWER);
  anthropicCreate.mockReset().mockResolvedValue(ANTHROPIC_ANSWER);
  // The factory's clients read their key from the environment; the SDKs are mocked, so any
  // non-empty value will do and nothing leaves the machine.
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// The fields that decide model, effort and cap, from every OpenAI request made so far.
const openaiFields = (): Record<string, unknown>[] =>
  openaiCreate.mock.calls.map((call) => {
    const request = call[0] as Record<string, unknown>;
    return {
      model: request["model"],
      max_completion_tokens: request["max_completion_tokens"],
      ...("reasoning_effort" in request ? { reasoning_effort: request["reasoning_effort"] } : {}),
    };
  });

describe("with nothing set, every request is what it was", () => {
  it("OpenAI: gpt-5, no effort field at all, caps 8192 and 4096", async () => {
    const client = createLLMClient("openai", undefined, {});
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.chooseTool("x", CONTEXT, TOOLS, null, "retry");
    for (const purpose of TASK_PURPOSES) await client.complete("s", "u", purpose);
    await client.complete("s", "u");

    // Written out by hand: the request before this change.
    expect(openaiFields()).toEqual([
      { model: "gpt-5", max_completion_tokens: 8192 },
      { model: "gpt-5", max_completion_tokens: 8192 },
      ...TASK_PURPOSES.map(() => ({ model: "gpt-5", max_completion_tokens: 4096 })),
      { model: "gpt-5", max_completion_tokens: 4096 },
    ]);
    for (const call of openaiCreate.mock.calls) {
      expect(call[0]).not.toHaveProperty("reasoning_effort");
    }
  });

  it("blank values in .env are 'not set', not an error", async () => {
    const client = createLLMClient("openai", undefined, {
      LLM_PLANNING_MODEL: "",
      LLM_PLANNING_REASONING_EFFORT: "  ",
      LLM_TASK_MODEL: "",
      LLM_TASK_REASONING_EFFORT: "",
    });
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.complete("s", "u", "format");
    expect(openaiFields()).toEqual([
      { model: "gpt-5", max_completion_tokens: 8192 },
      { model: "gpt-5", max_completion_tokens: 4096 },
    ]);
  });

  it("Anthropic: claude-sonnet-4-6, caps 8192 and 4096", async () => {
    const client = createLLMClient("anthropic", undefined, {});
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.complete("s", "u", "summarize");
    expect(anthropicCreate.mock.calls.map((call) => [call[0].model, call[0].max_tokens])).toEqual([
      ["claude-sonnet-4-6", 8192],
      ["claude-sonnet-4-6", 4096],
    ]);
  });

  it("a client built with no settings at all behaves the same (tests and scripts that build one directly)", async () => {
    await new OpenAILLMClient("sk-test").chooseTool("x", CONTEXT, TOOLS, null);
    await new OpenAILLMClient("sk-test").complete("s", "u");
    expect(openaiFields()).toEqual([
      { model: "gpt-5", max_completion_tokens: 8192 },
      { model: "gpt-5", max_completion_tokens: 4096 },
    ]);
  });
});

describe("an override reaches its own calls and no others", () => {
  it("planning settings change planning and the retry — and no complete() call", async () => {
    const client = createLLMClient("openai", undefined, {
      LLM_PLANNING_MODEL: "gpt-5-mini",
      LLM_PLANNING_REASONING_EFFORT: "minimal",
    });
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.chooseTool("x", CONTEXT, TOOLS, null, "retry");
    for (const purpose of TASK_PURPOSES) await client.complete("s", "u", purpose);

    expect(openaiFields()).toEqual([
      { model: "gpt-5-mini", max_completion_tokens: 8192, reasoning_effort: "minimal" },
      { model: "gpt-5-mini", max_completion_tokens: 8192, reasoning_effort: "minimal" },
      ...TASK_PURPOSES.map(() => ({ model: "gpt-5", max_completion_tokens: 4096 })),
    ]);
  });

  it("task settings change every complete() purpose — and no chooseTool call", async () => {
    const client = createLLMClient("openai", undefined, {
      LLM_TASK_MODEL: "gpt-5-mini",
      LLM_TASK_REASONING_EFFORT: "low",
    });
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.chooseTool("x", CONTEXT, TOOLS, null, "retry");
    for (const purpose of TASK_PURPOSES) await client.complete("s", "u", purpose);

    expect(openaiFields()).toEqual([
      { model: "gpt-5", max_completion_tokens: 8192 },
      { model: "gpt-5", max_completion_tokens: 8192 },
      ...TASK_PURPOSES.map(() => ({ model: "gpt-5-mini", max_completion_tokens: 4096, reasoning_effort: "low" })),
    ]);
  });

  it("an effort alone keeps the model, and a model alone sends no effort", async () => {
    const client = createLLMClient("openai", undefined, {
      LLM_PLANNING_REASONING_EFFORT: "low",
      LLM_TASK_MODEL: "gpt-5-mini",
    });
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.complete("s", "u", "summarize");
    expect(openaiFields()).toEqual([
      { model: "gpt-5", max_completion_tokens: 8192, reasoning_effort: "low" },
      { model: "gpt-5-mini", max_completion_tokens: 4096 },
    ]);
  });

  it("the usage log names the model that actually answered", async () => {
    const seen: string[] = [];
    const client = createLLMClient("openai", (usage) => seen.push(`${usage.purpose} ${usage.model}`), {
      LLM_PLANNING_MODEL: "gpt-5-mini",
    });
    await client.chooseTool("x", CONTEXT, TOOLS, null);
    await client.complete("s", "u", "format");
    expect(seen).toEqual(["planning gpt-5-mini", "format gpt-5"]);
  });

  it("Anthropic: a model setting is honoured per group the same way", () => {
    const settings: ModelSettings = {
      planning: { model: "claude-sonnet-4-6", reasoningEffort: null },
      task: { model: "claude-sonnet-4-6", reasoningEffort: null },
    };
    // Only one Anthropic model is known, so the routing is checked on the settings themselves.
    expect(settingsFor(settings, "retry")).toBe(settings.planning);
    expect(settingsFor(settings, "point")).toBe(settings.task);
    expect(new AnthropicLLMClient("k", undefined, settings)).toBeInstanceOf(AnthropicLLMClient);
  });
});

describe("unknown values fail loudly", () => {
  it("an unknown model names the variable and what it may be", () => {
    expect(() => readModelSettings("openai", { LLM_PLANNING_MODEL: "gpt-5-mnii" })).toThrow(
      "LLM_PLANNING_MODEL=gpt-5-mnii is not a model this app knows for LLM_PROVIDER=openai. Use one of: gpt-5, gpt-5-mini — or leave it unset for gpt-5.",
    );
    expect(() => readModelSettings("openai", { LLM_TASK_MODEL: "claude-sonnet-4-6" })).toThrow(/LLM_TASK_MODEL=claude-sonnet-4-6/);
  });

  it("an unknown effort names the variable and the allowed values", () => {
    expect(() => readModelSettings("openai", { LLM_TASK_REASONING_EFFORT: "minimum" })).toThrow(
      "LLM_TASK_REASONING_EFFORT=minimum is not a reasoning effort. Use one of: minimal, low, medium, high — or leave it unset for the API's default.",
    );
    // Case matters: the API takes these lower-case.
    expect(() => readModelSettings("openai", { LLM_PLANNING_REASONING_EFFORT: "Minimal" })).toThrow(/is not a reasoning effort/);
  });

  it("an effort on a provider that takes none is refused, not ignored", () => {
    expect(() => readModelSettings("anthropic", { LLM_PLANNING_REASONING_EFFORT: "low" })).toThrow(
      "LLM_PLANNING_REASONING_EFFORT is set, but LLM_PROVIDER=anthropic takes no reasoning effort. Leave it unset.",
    );
  });

  it("createLLMClient fails at construction — the app's startup — not on the first call", () => {
    expect(() => createLLMClient("openai", undefined, { LLM_TASK_MODEL: "gpt-6" })).toThrow(/LLM_TASK_MODEL=gpt-6/);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(() => modelSettingsFor("openai", { LLM_TASK_MODEL: "gpt-6" })).toThrow(/LLM_TASK_MODEL=gpt-6/);
  });
});

describe("the startup line", () => {
  it("says what is in effect, defaults included", () => {
    expect(describeModelSettings(defaultModelSettings("openai"))).toBe(
      "models: planning gpt-5 (reasoning effort: API default); tasks gpt-5 (reasoning effort: API default)",
    );
    expect(
      describeModelSettings(readModelSettings("openai", { LLM_PLANNING_MODEL: "gpt-5-mini", LLM_PLANNING_REASONING_EFFORT: "minimal" })),
    ).toBe("models: planning gpt-5-mini (reasoning effort: minimal); tasks gpt-5 (reasoning effort: API default)");
  });
});
