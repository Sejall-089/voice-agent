import type { LLMPurpose } from "./usage.ts";

// Which model, at which reasoning effort, answers each kind of call — chosen in .env, with
// TODAY'S VALUES AS THE DEFAULTS, so nothing changes unless a variable is set.
//
// WHY TWO GROUPS AND NOT ONE PER PURPOSE. The calls split cleanly by what they are: PLANNING
// (`planning`, and the multi-call `retry`, which is the same decision asked again) picks tools and
// writes plans; TASK calls (`summarize`, `rewrite`, `format`, `compose`, `compose-note`, `point`,
// and an unlabelled `complete`) produce text, or pick one entry from a list, inside a tool that
// has already been chosen. A cheaper setting is a reasonable experiment for one group and not the
// other, and two knobs are enough to run it.
//
//   LLM_PLANNING_MODEL             planning + retry      default: the provider's model
//   LLM_PLANNING_REASONING_EFFORT  planning + retry      default: not sent (the API's default)
//   LLM_TASK_MODEL                 every complete() call default: the provider's model
//   LLM_TASK_REASONING_EFFORT      every complete() call default: not sent
//
// The output caps are NOT here: chooseTool keeps 8192 and complete keeps 4096 whatever is set.
//
// UNKNOWN VALUES FAIL LOUDLY, AT STARTUP. A misspelt model would otherwise be found by the first
// instruction, as an API error in the bar; a misspelt effort could be silently ignored. Both lists
// are closed on purpose — a model is added here when it has been measured, not when it exists.
// A blank value (`LLM_TASK_MODEL=`) means "not set", the way every other optional .env key does.

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
const EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

export interface CallSettings {
  model: string;
  // null: the request carries no effort field, and the API's own default applies.
  reasoningEffort: ReasoningEffort | null;
}

export interface ModelSettings {
  planning: CallSettings;
  task: CallSettings;
}

export interface ProviderModels {
  // The model every call has used so far; the default for both groups.
  defaultModel: string;
  // The models that may be selected. Includes the default.
  known: readonly string[];
  // Whether this provider's client can send a reasoning effort at all.
  effort: boolean;
}

export const PROVIDER_MODELS: Readonly<Record<"openai" | "anthropic", ProviderModels>> = {
  openai: { defaultModel: "gpt-5", known: ["gpt-5", "gpt-5-mini"], effort: true },
  // The Anthropic client requests no extended thinking, so there is no effort to set.
  anthropic: { defaultModel: "claude-sonnet-4-6", known: ["claude-sonnet-4-6"], effort: false },
};

export const PLANNING_PURPOSES: readonly LLMPurpose[] = ["planning", "retry"];

export function settingsFor(settings: ModelSettings, purpose: LLMPurpose): CallSettings {
  return PLANNING_PURPOSES.includes(purpose) ? settings.planning : settings.task;
}

export function defaultModelSettings(provider: "openai" | "anthropic"): ModelSettings {
  const model = PROVIDER_MODELS[provider].defaultModel;
  return { planning: { model, reasoningEffort: null }, task: { model, reasoningEffort: null } };
}

type Env = Readonly<Record<string, string | undefined>>;

const value = (env: Env, key: string): string | null => {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? null : raw.trim();
};

// Throws, naming the variable and what it may be, on any value it does not know.
export function readModelSettings(provider: "openai" | "anthropic", env: Env): ModelSettings {
  const models = PROVIDER_MODELS[provider];
  const group = (prefix: "LLM_PLANNING" | "LLM_TASK"): CallSettings => {
    const modelKey = `${prefix}_MODEL`;
    const effortKey = `${prefix}_REASONING_EFFORT`;
    const model = value(env, modelKey) ?? models.defaultModel;
    if (!models.known.includes(model)) {
      throw new Error(
        `${modelKey}=${model} is not a model this app knows for LLM_PROVIDER=${provider}. ` +
          `Use one of: ${models.known.join(", ")} — or leave it unset for ${models.defaultModel}.`,
      );
    }
    const effort = value(env, effortKey);
    if (effort === null) return { model, reasoningEffort: null };
    if (!models.effort) {
      throw new Error(
        `${effortKey} is set, but LLM_PROVIDER=${provider} takes no reasoning effort. Leave it unset.`,
      );
    }
    if (!(EFFORTS as readonly string[]).includes(effort)) {
      throw new Error(
        `${effortKey}=${effort} is not a reasoning effort. Use one of: ${EFFORTS.join(", ")} — ` +
          `or leave it unset for the API's default.`,
      );
    }
    return { model, reasoningEffort: effort as ReasoningEffort };
  };
  return { planning: group("LLM_PLANNING"), task: group("LLM_TASK") };
}

// One startup line, so what is in effect is never a guess.
export function describeModelSettings(settings: ModelSettings): string {
  const one = ({ model, reasoningEffort }: CallSettings): string =>
    `${model} (reasoning effort: ${reasoningEffort ?? "API default"})`;
  return `models: planning ${one(settings.planning)}; tasks ${one(settings.task)}`;
}
