import type { LLMClient } from "../types.ts";
import { AnthropicLLMClient } from "./anthropic.ts";
import { readModelSettings, type ModelSettings } from "./modelSettings.ts";
import { OpenAILLMClient } from "./openai.ts";
import type { UsageSink } from "./usage.ts";

// The provider is an explicit choice, never inferred from which API key happens to be
// present — set LLM_PROVIDER in .env. Missing/unrecognized values fail loudly at
// startup; a missing API key for the CHOSEN provider still fails the same way the
// clients already do (lazily, inside getClient(), on first actual use).
//
// The model and reasoning effort per kind of call come from .env too (core/llm/modelSettings.ts),
// read HERE so that an unknown value fails at startup with the provider, not on the first call.
// With none of those variables set, the settings are exactly what every call has always sent.
export function createLLMClient(
  provider: string | undefined = process.env["LLM_PROVIDER"],
  // Told what each call used (core/llm/usage.ts). Absent: nothing is recorded.
  onUsage?: UsageSink,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LLMClient {
  if (provider === "anthropic") {
    return new AnthropicLLMClient(undefined, onUsage, readModelSettings("anthropic", env));
  }
  if (provider === "openai") {
    return new OpenAILLMClient(undefined, onUsage, readModelSettings("openai", env));
  }

  throw new Error(
    `LLM_PROVIDER must be set to "anthropic" or "openai" in your .env file (got: ${
      provider ?? "unset"
    }).`,
  );
}

// What createLLMClient would use, for the startup line and the eval gate's estimate. Throws on
// the same values createLLMClient throws on.
export function modelSettingsFor(
  provider: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelSettings | null {
  if (provider === "anthropic" || provider === "openai") return readModelSettings(provider, env);
  return null;
}
