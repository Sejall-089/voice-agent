import { describe, it, expect } from "vitest";
import { createLLMClient } from "../src/core/llm/factory.ts";
import { AnthropicLLMClient } from "../src/core/llm/anthropic.ts";
import { OpenAILLMClient } from "../src/core/llm/openai.ts";

// No network calls — this only tests provider SELECTION, not either vendor's actual
// API behavior. Missing/invalid API keys still fail lazily inside each client (unchanged).
describe("createLLMClient (LLM_PROVIDER selection)", () => {
  it("returns an AnthropicLLMClient for 'anthropic'", () => {
    expect(createLLMClient("anthropic")).toBeInstanceOf(AnthropicLLMClient);
  });

  it("returns an OpenAILLMClient for 'openai'", () => {
    expect(createLLMClient("openai")).toBeInstanceOf(OpenAILLMClient);
  });

  it("throws a clear error when LLM_PROVIDER is unset", () => {
    expect(() => createLLMClient(undefined)).toThrow(/LLM_PROVIDER must be set/);
  });

  it("throws a clear error for an unrecognized provider, without guessing", () => {
    expect(() => createLLMClient("gemini")).toThrow(/LLM_PROVIDER must be set/);
  });
});
