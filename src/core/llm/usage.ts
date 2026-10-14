// What one model call cost, and what the session has cost so far.
//
// WHY THIS EXISTS. The bill is almost entirely OUTPUT tokens, and most of those are reasoning
// tokens a reasoning model spends before it emits a tool call a few dozen tokens long. None of
// that is visible from the app: the response's `usage` block was read in exactly one place (the
// truncation message) and otherwise dropped. This records it, per call, with what the call was
// FOR — so "planning costs X, the retry costs Y" is a measurement rather than a guess.
//
// IT CHANGES NO BEHAVIOUR. A client reports usage to a sink after the response has been read;
// the sink's failure is swallowed (`reportUsage`), so a logging bug can never fail a model call.
//
// PRICES ARE NOT IN THIS FILE. They are data — `llm-prices.json`, read by main.ts and parsed by
// `parsePriceTable` — because a price changes without the code changing, and a number hardcoded
// here would go on being printed, confidently, after it stopped being true. A model with no
// entry is reported with its tokens and NO cost, never with a guessed one.

// What a call was for. `complete` is the label of a `complete()` call whose caller did not say.
export type LLMPurpose =
  | "planning"
  | "retry"
  | "summarize"
  | "rewrite"
  | "format"
  | "compose"
  | "compose-note"
  | "point"
  | "complete";

// One call's token counts, as the provider reported them.
export interface LLMUsage {
  purpose: LLMPurpose;
  model: string;
  // Every input token, cached ones included.
  promptTokens: number;
  // The part of `promptTokens` served from the provider's prompt cache.
  cachedTokens: number;
  // The part of `outputTokens` spent on hidden reasoning. null when the provider does not say.
  reasoningTokens: number | null;
  // Every billed output token, reasoning included.
  outputTokens: number;
}

export type UsageSink = (usage: LLMUsage) => void;

// USD per one million tokens.
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export interface ParsedPriceTable {
  prices: PriceTable;
  // One sentence per entry that could not be used. The rest of the table still loads.
  problems: string[];
}

const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// `{ "models": { "<model id>": { "input": n, "cachedInput": n, "output": n } } }`.
//
// Never throws: a missing or unreadable table means "no costs", not "no app". Anything else in
// the file (a `_note`, a date) is ignored.
export function parsePriceTable(text: string | null): ParsedPriceTable {
  if (text === null) return { prices: {}, problems: ["no price table was found"] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { prices: {}, problems: ["the price table is not valid JSON"] };
  }
  const models =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["models"]
      : undefined;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return { prices: {}, problems: ['the price table has no "models" object'] };
  }

  const prices: Record<string, ModelPrice> = {};
  const problems: string[] = [];
  for (const [model, entry] of Object.entries(models as Record<string, unknown>)) {
    const fields = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const { input, cachedInput, output } = fields;
    if (isPrice(input) && isPrice(cachedInput) && isPrice(output)) {
      prices[model] = { input, cachedInput, output };
    } else {
      problems.push(`the price for "${model}" needs numeric input, cachedInput and output`);
    }
  }
  return { prices, problems };
}

// The estimated cost of one call in USD, or null when the model has no price.
//
// Cached input is billed at its own rate and the rest of the prompt at the input rate.
// Reasoning tokens are already inside `outputTokens` and are NOT added a second time.
export function estimateCost(usage: LLMUsage, prices: PriceTable): number | null {
  const price = prices[usage.model];
  if (price === undefined) return null;
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  return (
    ((usage.promptTokens - cached) * price.input +
      cached * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

export interface SessionTotals {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  // The sum over the calls that HAD a price.
  costUsd: number;
  // Calls whose model had no price. When this is not zero, `costUsd` is an undercount.
  unpricedCalls: number;
}

export interface RecordedUsage {
  usage: LLMUsage;
  costUsd: number | null;
  session: SessionTotals;
}

// The running total for one app run. Nothing is persisted: a restart starts from zero.
export class UsageTracker {
  private readonly prices: PriceTable;
  private totals: SessionTotals = {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };

  constructor(prices: PriceTable) {
    this.prices = prices;
  }

  record(usage: LLMUsage): RecordedUsage {
    const costUsd = estimateCost(usage, this.prices);
    this.totals = {
      calls: this.totals.calls + 1,
      promptTokens: this.totals.promptTokens + usage.promptTokens,
      cachedTokens: this.totals.cachedTokens + usage.cachedTokens,
      reasoningTokens: this.totals.reasoningTokens + (usage.reasoningTokens ?? 0),
      outputTokens: this.totals.outputTokens + usage.outputTokens,
      costUsd: this.totals.costUsd + (costUsd ?? 0),
      unpricedCalls: this.totals.unpricedCalls + (costUsd === null ? 1 : 0),
    };
    return { usage, costUsd, session: this.session() };
  }

  session(): SessionTotals {
    return { ...this.totals };
  }
}

const usd = (amount: number): string => `$${amount.toFixed(4)}`;

// One log line for one call. Token counts and a model name only — never a prompt, a reply or a
// key.
export function formatUsageLine({ usage, costUsd, session }: RecordedUsage): string {
  const sessionCost =
    usd(session.costUsd) + (session.unpricedCalls > 0 ? ` + ${session.unpricedCalls} unpriced` : "");
  return (
    `${usage.purpose} ${usage.model}: prompt ${usage.promptTokens} (cached ${usage.cachedTokens}), ` +
    `output ${usage.outputTokens} (reasoning ${usage.reasoningTokens ?? "n/a"}), ` +
    `est ${costUsd === null ? "no price for this model" : usd(costUsd)}` +
    ` | session: ${session.calls} ${session.calls === 1 ? "call" : "calls"}, ` +
    `output ${session.outputTokens}, est ${sessionCost}`
  );
}

// The sink the running app uses: one line per call, through whatever `log` is given. Lives here
// rather than in main.ts so that it has a test (CLAUDE.md: nothing in main.ts can have one).
// A problem with the price table is said once, at the start, and the calls are still logged.
export function createUsageLog(priceText: string | null, log: (line: string) => void): UsageSink {
  const { prices, problems } = parsePriceTable(priceText);
  for (const problem of problems) log(`usage: ${problem} (llm-prices.json) — costs may be missing`);
  const tracker = new UsageTracker(prices);
  return (usage) => log(formatUsageLine(tracker.record(usage)));
}

// Hand one call's usage to the sink. A throwing sink is swallowed: the model has already
// answered, and losing a log line must not lose the answer.
export function reportUsage(sink: UsageSink | undefined, usage: LLMUsage | null): void {
  if (sink === undefined || usage === null) return;
  try {
    sink(usage);
  } catch {
    // Deliberately nothing — see above.
  }
}

// --- Reading each provider's own usage block -------------------------------------------------
//
// Typed structurally, not against the SDKs, so this file imports neither. Every field is
// optional because every field can be absent: a response with no usage block reports nothing
// (null) rather than a row of zeros that would read as "this call was free".

export interface OpenAIUsageBlock {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

// OpenAI: `prompt_tokens` already includes the cached ones, and `completion_tokens` already
// includes the reasoning ones.
export function usageFromOpenAI(
  purpose: LLMPurpose,
  model: string,
  usage: OpenAIUsageBlock | null | undefined,
): LLMUsage | null {
  if (usage === null || usage === undefined) return null;
  if (usage.prompt_tokens === undefined || usage.completion_tokens === undefined) return null;
  return {
    purpose,
    model,
    promptTokens: usage.prompt_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    outputTokens: usage.completion_tokens,
  };
}

export interface AnthropicUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// Anthropic: `input_tokens` EXCLUDES cache reads and cache writes, so the three are added to
// get the whole prompt. Reasoning is not reported separately (and no thinking is requested).
// A cache WRITE is billed above the input rate; the app requests no caching today, so it is
// counted as plain input here rather than given a price column nothing would exercise.
export function usageFromAnthropic(
  purpose: LLMPurpose,
  model: string,
  usage: AnthropicUsageBlock | null | undefined,
): LLMUsage | null {
  if (usage === null || usage === undefined) return null;
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return null;
  const cached = usage.cache_read_input_tokens ?? 0;
  return {
    purpose,
    model,
    promptTokens: usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0),
    cachedTokens: cached,
    reasoningTokens: null,
    outputTokens: usage.output_tokens,
  };
}
