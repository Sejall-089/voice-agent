import type { LLMClient } from "../types.ts";
import { AnthropicLLMClient } from "./anthropic.ts";
import { OpenAILLMClient } from "./openai.ts";
import type { UsageSink } from "./usage.ts";

// The provider is an explicit choice, never inferred from which API key happens to be
// present — set LLM_PROVIDER in .env. Missing/unrecognized values fail loudly at
// startup; a missing API key for the CHOSEN provider still fails the same way the
// clients already do (lazily, inside getClient(), on first actual use).
export function createLLMClient(
  provider: string | undefined = process.env["LLM_PROVIDER"],
  // Told what each call used (core/llm/usage.ts). Absent: nothing is recorded.
  onUsage?: UsageSink,
): LLMClient {
  if (provider === "anthropic") return new AnthropicLLMClient(undefined, onUsage);
  if (provider === "openai") return new OpenAILLMClient(undefined, onUsage);

  throw new Error(
    `LLM_PROVIDER must be set to "anthropic" or "openai" in your .env file (got: ${
      provider ?? "unset"
    }).`,
  );
}
