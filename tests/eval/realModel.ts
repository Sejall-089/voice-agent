// THE ONE DOOR TO A REAL MODEL, for every eval and recon script that calls one.
//
// WHY THIS EXISTS. OpenAI credits ran out during M22, and the opt-in evals were the likely cause
// (docs/m22-live-checklist.md). Each eval was opt-in by its own flag, and that was not enough:
// several flags set at once, or a trial count raised, is a full pass nobody priced. So:
//
//   1. DRY BY DEFAULT. With no `REAL_MODEL=1`, an eval or script prints how many real calls it
//      would make and roughly what they would cost, and makes none. The per-eval flag
//      (`M23_STATUS_EVAL=1`, ...) still chooses WHICH eval; `REAL_MODEL=1` is what spends.
//   2. A HARD CAP PER RUN — 60 real calls, counted across every test file of one vitest run (they
//      run in separate processes, so the count lives in a folder of slot files, see
//      `FileCallCounter`). Above 60 needs `REAL_MODEL_MAX_CALLS=<n>` AND `REAL_MODEL_ABOVE_CAP=1`.
//   3. A RUNNING COUNT. Every real call prints its number, its cost and the run's total so far.
//
// `REAL_MODEL` is refused if it is written in `.env`: a standing permission in a file is exactly
// how a key that is "always present" became permission to spend it (toolChoice.eval's history).
// It belongs on the command line of the one run that means it.
//
// Not the app's code: nothing under src/ imports this, so the running app is unaffected.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { PLANNER_MODEL as ANTHROPIC_PLANNER_MODEL } from "../../src/core/llm/anthropic.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { PLANNER_MODEL as OPENAI_PLANNER_MODEL } from "../../src/core/llm/openai.ts";
import { estimateCost, parsePriceTable, type PriceTable, type UsageSink } from "../../src/core/llm/usage.ts";
import type { LLMClient } from "../../src/core/types.ts";

export const RUN_FLAG = "REAL_MODEL";
export const MAX_CALLS_FLAG = "REAL_MODEL_MAX_CALLS";
export const ABOVE_CAP_FLAG = "REAL_MODEL_ABOVE_CAP";
export const HARD_CAP = 60;

type Env = Readonly<Record<string, string | undefined>>;

export interface SpendPolicy {
  // True only when `REAL_MODEL=1` was given and nothing below refused it.
  real: boolean;
  cap: number;
  // Why a run that asked to be real is dry instead. null when nothing was refused.
  refused: string | null;
}

// `envFileText` is the raw .env, read separately from the environment: by the time this runs,
// dotenv has already copied .env into `env`, and the two cannot be told apart from there.
export function readSpendPolicy(env: Env, envFileText: string | null): SpendPolicy {
  const asked = env[RUN_FLAG] === "1";

  let cap = HARD_CAP;
  let refused: string | null = null;
  const max = env[MAX_CALLS_FLAG];
  if (max !== undefined && max.trim() !== "") {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1) {
      refused = `${MAX_CALLS_FLAG}=${max} is not a whole number of calls`;
    } else if (n > HARD_CAP && env[ABOVE_CAP_FLAG] !== "1") {
      refused = `${MAX_CALLS_FLAG}=${n} is above the hard cap of ${HARD_CAP}; set ${ABOVE_CAP_FLAG}=1 as well to allow it`;
    } else {
      cap = n;
    }
  }
  if (envFileText !== null && /^\s*REAL_MODEL\w*\s*=/m.test(envFileText)) {
    refused = `${RUN_FLAG} settings must not be in .env — give them on the command line of the run that means it`;
  }
  return { real: asked && refused === null, cap, refused: asked ? refused : null };
}

// What one call is assumed to use, for a dry run's estimate only. From `llm-prices.json`'s
// `dryRunEstimate`, so the assumption is data beside the prices it is multiplied by.
export interface DryEstimate {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export function parseDryEstimate(priceText: string | null): DryEstimate | null {
  if (priceText === null) return null;
  try {
    const block = (JSON.parse(priceText) as Record<string, unknown>)["dryRunEstimate"];
    if (typeof block !== "object" || block === null) return null;
    const { promptTokens, cachedTokens, outputTokens } = block as Record<string, unknown>;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
    return ok(promptTokens) && ok(cachedTokens) && ok(outputTokens)
      ? { promptTokens, cachedTokens, outputTokens }
      : null;
  } catch {
    return null;
  }
}

export function estimateRunCost(
  calls: number,
  model: string,
  prices: PriceTable,
  per: DryEstimate | null,
): number | null {
  if (per === null) return null;
  const one = estimateCost(
    { purpose: "planning", model, promptTokens: per.promptTokens, cachedTokens: per.cachedTokens, reasoningTokens: null, outputTokens: per.outputTokens },
    prices,
  );
  return one === null ? null : one * calls;
}

// --- Counting calls across the processes of one run ----------------------------------------

export interface CallCounter {
  // The number of the call about to be made (1-based), or null when the cap is reached.
  claim(): number | null;
  // What that call cost, once it is known. null: no price for the model.
  addCost(slot: number, costUsd: number | null): void;
  total(): { calls: number; costUsd: number; unpriced: number };
}

export class MemoryCallCounter implements CallCounter {
  private readonly costs = new Map<number, number | null>();
  private claimed = 0;
  constructor(private readonly cap: number) {}

  claim(): number | null {
    if (this.claimed >= this.cap) return null;
    this.claimed += 1;
    this.costs.set(this.claimed, null);
    return this.claimed;
  }
  addCost(slot: number, costUsd: number | null): void {
    this.costs.set(slot, costUsd);
  }
  total(): { calls: number; costUsd: number; unpriced: number } {
    const all = [...this.costs.values()];
    return {
      calls: this.claimed,
      costUsd: all.reduce<number>((sum, c) => sum + (c ?? 0), 0),
      unpriced: all.filter((c) => c === null).length,
    };
  }
}

// One file per call, created with the exclusive flag ("wx"): creating a file that already exists
// fails atomically, so two processes can never claim the same number, and the count can never
// pass the cap however many test files run at once. The file holds that call's cost.
export class FileCallCounter implements CallCounter {
  constructor(
    private readonly dir: string,
    private readonly cap: number,
  ) {}

  claim(): number | null {
    mkdirSync(this.dir, { recursive: true });
    for (let slot = 1; slot <= this.cap; slot += 1) {
      try {
        closeSync(openSync(join(this.dir, `call-${slot}`), "wx"));
        return slot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return null;
  }

  addCost(slot: number, costUsd: number | null): void {
    writeFileSync(join(this.dir, `call-${slot}`), costUsd === null ? "unpriced" : String(costUsd));
  }

  total(): { calls: number; costUsd: number; unpriced: number } {
    let calls = 0;
    let costUsd = 0;
    let unpriced = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith("call-")) continue;
      calls += 1;
      const text = readFileSync(join(this.dir, name), "utf8").trim();
      if (text === "unpriced") unpriced += 1;
      else if (text !== "") costUsd += Number(text) || 0;
    }
    return { calls, costUsd, unpriced };
  }
}

// Which folder is "this run". Vitest runs each test file in a child process of one vitest
// process (the default `forks` pool), so the files of one run share that PARENT's pid; in the
// `threads` pool they share their own. A script run directly is its own run.
//
// A folder older than twelve hours is a previous run whose pid has been reused, and is cleared.
// One younger than that with a reused pid only makes the cap arrive early — never late.
export function runCounterDir(
  env: Env,
  proc: { pid: number; ppid: number; isMainThread: boolean },
  base: string,
  now: number = Date.now(),
): string {
  const key = env["VITEST"] !== undefined && proc.isMainThread ? proc.ppid : proc.pid;
  const dir = join(base, "voice-agent-real-model", `run-${key}`);
  try {
    if (now - statSync(dir).birthtimeMs > 12 * 60 * 60 * 1000) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Not there yet: nothing to clear.
  }
  return dir;
}

// --- The guarded client --------------------------------------------------------------------

export class SpendCapError extends Error {
  constructor(cap: number) {
    super(
      `Stopped: this run has made its ${cap} real-model calls (the cap). Nothing further was sent. ` +
        `To allow more, rerun with ${MAX_CALLS_FLAG}=<n>${cap >= HARD_CAP ? ` and ${ABOVE_CAP_FLAG}=1` : ""}.`,
    );
    this.name = "SpendCapError";
  }
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

// Every call takes a numbered slot BEFORE it is sent; with no slot left it is never sent. When
// the response arrives, its cost goes into the slot and one line is printed.
//
// Sequential use is assumed (every eval awaits each call): two calls in flight at once in one
// process would still be counted and capped correctly, but could print each other's cost.
export function guardClient(options: {
  makeClient: (sink: UsageSink) => LLMClient;
  counter: CallCounter;
  cap: number;
  prices: PriceTable;
  log: (line: string) => void;
}): LLMClient {
  const { counter, cap, prices, log } = options;
  let current = 0;
  const inner = options.makeClient((usage) => {
    const cost = estimateCost(usage, prices);
    counter.addCost(current, cost);
    const run = counter.total();
    log(
      `[real-model] call ${current}/${cap}: ${usage.purpose} ${usage.model}, output ${usage.outputTokens} ` +
        `(reasoning ${usage.reasoningTokens ?? "n/a"}), est ${cost === null ? "no price" : usd(cost)}` +
        ` | this run: ${run.calls} calls, est ${usd(run.costUsd)}${run.unpriced > 0 ? ` + ${run.unpriced} unpriced` : ""}`,
    );
  });
  const claim = (): void => {
    const slot = counter.claim();
    if (slot === null) throw new SpendCapError(cap);
    current = slot;
  };
  return {
    async chooseTool(instruction, context, tools, previousTurn, purpose) {
      claim();
      return inner.chooseTool(instruction, context, tools, previousTurn, purpose);
    },
    async complete(system, user, purpose) {
      claim();
      return inner.complete(system, user, purpose);
    },
  };
}

// --- What each eval and script calls -------------------------------------------------------

export interface RealModelGate {
  real: boolean;
  // The dry-run line, or why a requested real run is not happening. Printed by the caller.
  line: string;
  // The client to use when `real`. Throws if called on a dry gate — a dry run has no client.
  client(makeClient?: (sink: UsageSink) => LLMClient): LLMClient;
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function plannerModel(provider: string | undefined): string {
  return provider === "anthropic" ? ANTHROPIC_PLANNER_MODEL : OPENAI_PLANNER_MODEL;
}

export function realModelGate(options: {
  // What is about to run, e.g. "jobStatus routing eval".
  name: string;
  // The real calls a full run of it makes, before the planner's own retries and the SDK's.
  plannedCalls: number;
  // Whether this eval was chosen at all: its own flag, a provider, a key.
  selected: boolean;
  // The command that runs it for real, for the dry line.
  howToRun: string;
  env?: Env;
  repoRoot?: string;
  log?: (line: string) => void;
}): RealModelGate {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? fileURLToPath(new URL("../..", import.meta.url));
  const log = options.log ?? ((line: string) => console.log(line));
  const policy = readSpendPolicy(env, readOrNull(join(root, ".env")));
  const priceText = readOrNull(join(root, "llm-prices.json"));
  const prices = parsePriceTable(priceText).prices;
  const provider = env["LLM_PROVIDER"];
  const model = plannerModel(provider);
  const cost = estimateRunCost(options.plannedCalls, model, prices, parseDryEstimate(priceText));
  const priced = cost === null ? "cost unknown" : `est ~${usd(cost)}`;

  let real = false;
  let line: string;
  if (!options.selected) {
    line = `[real-model] ${options.name}: dry — ${options.plannedCalls} planned ${model} calls, ${priced}. Not selected. To run: ${options.howToRun}`;
  } else if (policy.refused !== null) {
    line = `[real-model] ${options.name}: NOT RUN — ${policy.refused}. No call was made.`;
  } else if (!policy.real) {
    line = `[real-model] ${options.name}: dry — ${options.plannedCalls} planned ${model} calls, ${priced}. Nothing was called. Add ${RUN_FLAG}=1 to run it (cap ${policy.cap} calls per run).`;
  } else if (options.plannedCalls > policy.cap) {
    line = `[real-model] ${options.name}: NOT RUN — it plans ${options.plannedCalls} calls and this run's cap is ${policy.cap}. No call was made. Lower its trials, or set ${MAX_CALLS_FLAG}.`;
  } else {
    real = true;
    line = `[real-model] ${options.name}: REAL — up to ${options.plannedCalls} ${model} calls, ${priced}, cap ${policy.cap} per run.`;
  }

  return {
    real,
    line,
    client(makeClient) {
      if (!real) throw new Error(`${options.name} is a dry run; it has no model client`);
      return guardClient({
        makeClient: makeClient ?? ((sink) => createLLMClient(provider, sink)),
        counter: new FileCallCounter(
          runCounterDir(env, { pid: process.pid, ppid: process.ppid, isMainThread }, tmpdir()),
          policy.cap,
        ),
        cap: policy.cap,
        prices,
        log,
      });
    },
  };
}
