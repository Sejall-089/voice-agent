import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMUsage, UsageSink } from "../src/core/llm/usage.ts";
import type { LLMClient, ToolChoice } from "../src/core/types.ts";
import {
  FileCallCounter,
  HARD_CAP,
  MemoryCallCounter,
  SpendCapError,
  guardClient,
  readSpendPolicy,
  realModelGate,
  runCounterDir,
} from "./eval/realModel.ts";

// THE SPEND GUARD every real-model eval and recon script goes through (tests/eval/realModel.ts).
//
// The provider here is a FAKE that reports usage the way the real clients do — through the sink
// it was built with, after its response — so the cost lines and totals are checked against
// numbers, with no network. Whether a real run really stops at the cap, across the processes
// vitest runs test files in, is a fact about processes and is checked by a script against a
// local counting server, not here.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PRICES = { "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 } };

// A provider that answers instantly-but-later and reports one fixed usage per call.
class FakeProvider implements LLMClient {
  public calls = 0;
  constructor(private readonly sink: UsageSink) {}

  async chooseTool(): Promise<ToolChoice> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.sink(this.usage("planning"));
    return { kind: "tool", name: "summarize", input: {} };
  }

  async complete(_system: string, _user: string, purpose: LLMUsage["purpose"] = "complete"): Promise<string> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.sink(this.usage(purpose));
    return "done";
  }

  private usage(purpose: LLMUsage["purpose"]): LLMUsage {
    return { purpose, model: "gpt-5", promptTokens: 6800, cachedTokens: 6500, reasoningTokens: 832, outputTokens: 912 };
  }
}

const CONTEXT = { selectedText: null, activeApp: null, activeWindowTitle: null };

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "real-model-guard-"));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the policy: dry unless asked, and a hard cap", () => {
  it("is dry by default, with nothing refused", () => {
    expect(readSpendPolicy({}, null)).toEqual({ real: false, cap: HARD_CAP, refused: null });
    expect(HARD_CAP).toBe(60);
  });

  it("runs real only for REAL_MODEL=1 exactly", () => {
    expect(readSpendPolicy({ REAL_MODEL: "1" }, null)).toEqual({ real: true, cap: 60, refused: null });
    expect(readSpendPolicy({ REAL_MODEL: "true" }, null).real).toBe(false);
    expect(readSpendPolicy({ REAL_MODEL: "yes" }, null).real).toBe(false);
  });

  it("takes a lower cap on its own", () => {
    expect(readSpendPolicy({ REAL_MODEL: "1", REAL_MODEL_MAX_CALLS: "10" }, null)).toEqual({ real: true, cap: 10, refused: null });
  });

  it("refuses a cap above 60 without the second flag — and runs NOTHING rather than 60", () => {
    const policy = readSpendPolicy({ REAL_MODEL: "1", REAL_MODEL_MAX_CALLS: "100" }, null);
    expect(policy.real).toBe(false);
    expect(policy.refused).toMatch(/above the hard cap of 60; set REAL_MODEL_ABOVE_CAP=1/);
  });

  it("allows a cap above 60 with REAL_MODEL_ABOVE_CAP=1", () => {
    expect(
      readSpendPolicy({ REAL_MODEL: "1", REAL_MODEL_MAX_CALLS: "100", REAL_MODEL_ABOVE_CAP: "1" }, null),
    ).toEqual({ real: true, cap: 100, refused: null });
  });

  it("refuses a cap that is not a whole number of calls", () => {
    for (const bad of ["abc", "0", "-5", "2.5"]) {
      expect(readSpendPolicy({ REAL_MODEL: "1", REAL_MODEL_MAX_CALLS: bad }, null).real).toBe(false);
    }
  });

  it("refuses REAL_MODEL written in .env — a standing permission in a file is not a request", () => {
    // dotenv has already copied .env into the environment, so the env alone looks like a request.
    const policy = readSpendPolicy({ REAL_MODEL: "1" }, "LLM_PROVIDER=openai\nREAL_MODEL=1\n");
    expect(policy.real).toBe(false);
    expect(policy.refused).toMatch(/must not be in \.env/);
    // Any REAL_MODEL_* setting in the file, too.
    expect(readSpendPolicy({ REAL_MODEL: "1" }, "  REAL_MODEL_MAX_CALLS = 500").real).toBe(false);
    // A .env that only mentions it in a comment or another key is fine.
    expect(readSpendPolicy({ REAL_MODEL: "1" }, "# REAL_MODEL=1 is set on the command line\nNOT_REAL_MODEL=1").real).toBe(true);
  });
});

describe("the guarded client: counts before it calls, stops at the cap", () => {
  const guarded = (cap: number, lines: string[]) => {
    let provider: FakeProvider | null = null;
    const client = guardClient({
      makeClient: (sink) => (provider = new FakeProvider(sink)),
      counter: new MemoryCallCounter(cap),
      cap,
      prices: PRICES,
      log: (line) => lines.push(line),
    });
    return { client, provider: () => provider! };
  };

  it("makes exactly `cap` calls, and the next is never sent", async () => {
    const lines: string[] = [];
    const { client, provider } = guarded(3, lines);

    for (let i = 0; i < 3; i += 1) await client.chooseTool("x", CONTEXT, [], null);
    await expect(client.chooseTool("x", CONTEXT, [], null)).rejects.toBeInstanceOf(SpendCapError);
    await expect(client.complete("s", "u")).rejects.toThrow(/made its 3 real-model calls \(the cap\)\. Nothing further was sent/);

    // The point: the provider was asked 3 times, not 4 or 5.
    expect(provider().calls).toBe(3);
  });

  it("prints a running count and cost for every call", async () => {
    const lines: string[] = [];
    const { client } = guarded(60, lines);

    await client.chooseTool("x", CONTEXT, [], null, "planning");
    await client.complete("s", "u", "format");

    // 300 x 1.25 + 6500 x 0.125 + 912 x 10 per million = $0.0103075 a call.
    expect(lines).toEqual([
      "[real-model] call 1/60: planning gpt-5, output 912 (reasoning 832), est $0.0103 | this run: 1 calls, est $0.0103",
      "[real-model] call 2/60: format gpt-5, output 912 (reasoning 832), est $0.0103 | this run: 2 calls, est $0.0206",
    ]);
  });

  it("passes the purpose through untouched", async () => {
    const seen: LLMUsage["purpose"][] = [];
    const client = guardClient({
      makeClient: (sink) => new FakeProvider((usage) => (seen.push(usage.purpose), sink(usage))),
      counter: new MemoryCallCounter(5),
      cap: 5,
      prices: PRICES,
      log: () => undefined,
    });
    await client.complete("s", "u", "summarize");
    expect(seen).toEqual(["summarize"]);
  });
});

describe("the call counter shared by every file of one run", () => {
  it("never hands out more than the cap, however many counters share the folder", () => {
    const dir = tempDir();
    // Three "test files" of one run, claiming in turn.
    const counters = [new FileCallCounter(dir, 5), new FileCallCounter(dir, 5), new FileCallCounter(dir, 5)];
    const slots: (number | null)[] = [];
    for (let round = 0; round < 3; round += 1) for (const counter of counters) slots.push(counter.claim());

    expect(slots.filter((slot) => slot !== null).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(slots.filter((slot) => slot === null)).toHaveLength(4);
    expect(readdirSync(dir)).toHaveLength(5);
  });

  it("totals the cost every file wrote", () => {
    const dir = tempDir();
    const a = new FileCallCounter(dir, 60);
    const b = new FileCallCounter(dir, 60);
    a.addCost(a.claim()!, 0.01);
    b.addCost(b.claim()!, 0.02);
    b.addCost(b.claim()!, null);

    const total = a.total();
    expect(total.calls).toBe(3);
    expect(total.costUsd).toBeCloseTo(0.03, 10);
    expect(total.unpriced).toBe(1);
  });

  it("is one folder per vitest run (the parent process), and per process for a script", () => {
    const base = tempDir();
    const worker = { pid: 200, ppid: 100, isMainThread: true };
    expect(runCounterDir({ VITEST: "true" }, worker, base)).toBe(join(base, "voice-agent-real-model", "run-100"));
    expect(runCounterDir({ VITEST: "true" }, { ...worker, isMainThread: false }, base)).toBe(
      join(base, "voice-agent-real-model", "run-200"),
    );
    expect(runCounterDir({}, worker, base)).toBe(join(base, "voice-agent-real-model", "run-200"));
  });

  it("clears a folder older than twelve hours (a reused pid), and keeps a fresh one", () => {
    const base = tempDir();
    const dir = join(base, "voice-agent-real-model", "run-7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "call-1"), "0.01");
    const born = statSync(dir).birthtimeMs;

    runCounterDir({}, { pid: 7, ppid: 1, isMainThread: true }, base, born + 60_000);
    expect(readdirSync(dir)).toEqual(["call-1"]);

    runCounterDir({}, { pid: 7, ppid: 1, isMainThread: true }, base, born + 13 * 60 * 60 * 1000);
    // Birthtime cannot be set portably, so the clock is passed in instead.
    expect(() => readdirSync(dir)).toThrow();
  });
});

describe("the gate each eval and script asks", () => {
  // A repo with the committed price table and no .env.
  const fakeRepo = (envText?: string): string => {
    const root = tempDir();
    copyFileSync(join(REPO, "llm-prices.json"), join(root, "llm-prices.json"));
    if (envText !== undefined) writeFileSync(join(root, ".env"), envText);
    return root;
  };
  const gate = (env: Record<string, string>, options: { selected?: boolean; planned?: number; envText?: string } = {}) =>
    realModelGate({
      name: "some eval",
      plannedCalls: options.planned ?? 10,
      selected: options.selected ?? true,
      howToRun: "SOME_EVAL=1 REAL_MODEL=1 npx vitest run some.eval.test.ts",
      env: { LLM_PROVIDER: "openai", ...env },
      repoRoot: fakeRepo(options.envText),
      log: () => undefined,
    });

  it("is dry by default, and says the call count and estimated cost", () => {
    const dry = gate({});
    expect(dry.real).toBe(false);
    // 10 calls x (850 x 1.25 + 5950 x 0.125 + 900 x 10) per million = $0.1081.
    expect(dry.line).toBe(
      "[real-model] some eval: dry — 10 planned gpt-5 calls, est ~$0.1081. Nothing was called. Add REAL_MODEL=1 to run it (cap 60 calls per run).",
    );
    expect(() => dry.client()).toThrow(/dry run; it has no model client/);
  });

  it("is dry when the eval was not selected, even with REAL_MODEL=1", () => {
    const unselected = gate({ REAL_MODEL: "1" }, { selected: false });
    expect(unselected.real).toBe(false);
    expect(unselected.line).toMatch(/Not selected\. To run: SOME_EVAL=1 REAL_MODEL=1/);
  });

  it("is real only when selected AND REAL_MODEL=1", () => {
    const real = gate({ REAL_MODEL: "1" });
    expect(real.real).toBe(true);
    expect(real.line).toMatch(/REAL — up to 10 gpt-5 calls, est ~\$0\.1081, cap 60 per run/);
  });

  it("refuses up front an eval that plans more calls than the cap", () => {
    const big = gate({ REAL_MODEL: "1" }, { planned: 61 });
    expect(big.real).toBe(false);
    expect(big.line).toMatch(/NOT RUN — it plans 61 calls and this run's cap is 60\. No call was made/);
  });

  it("refuses when REAL_MODEL is in the repo's .env", () => {
    const fromFile = gate({ REAL_MODEL: "1" }, { envText: "REAL_MODEL=1\n" });
    expect(fromFile.real).toBe(false);
    expect(fromFile.line).toMatch(/NOT RUN — REAL_MODEL settings must not be in \.env/);
  });

  it("the committed price table carries the dry-run assumption", () => {
    const parsed = JSON.parse(readFileSync(join(REPO, "llm-prices.json"), "utf8")) as Record<string, unknown>;
    expect(parsed["dryRunEstimate"]).toEqual({ promptTokens: 6800, cachedTokens: 5950, outputTokens: 900 });
  });
});

describe("nothing reaches a real model without the gate", () => {
  // Every eval and script that can build a real client must also ask the gate. A new eval that
  // calls `createLLMClient()` directly fails here, before it ever spends anything.
  const REAL_CLIENT = /createLLMClient\(|new OpenAILLMClient\(|new AnthropicLLMClient\(|from "openai"|@anthropic-ai\/sdk|api\.openai\.com|api\.anthropic\.com/;

  const filesUnder = (dir: string, match: RegExp): string[] =>
    readdirSync(join(REPO, dir), { recursive: true, withFileTypes: false })
      .map(String)
      .filter((name) => match.test(name))
      .map((name) => join(dir, name));

  const candidates = [
    ...filesUnder("tests/eval", /\.ts$/),
    ...filesUnder("scripts", /\.(ts|mjs|cjs|js)$/),
  ].filter((file) => !file.endsWith("realModel.ts"));

  it("finds the files it is checking", () => {
    expect(candidates.length).toBeGreaterThan(20);
  });

  for (const file of candidates) {
    it(`${file.replace(/\\/g, "/")}`, () => {
      const text = readFileSync(join(REPO, file), "utf8");
      if (REAL_CLIENT.test(text)) {
        expect(text, `${file} builds a model client without realModelGate`).toMatch(/realModelGate\(/);
      }
    });
  }

  it("every client built in a gated file is built INSIDE gate.client(...)", () => {
    for (const file of candidates) {
      const text = readFileSync(join(REPO, file), "utf8");
      // createLLMClient is used only by the gate itself now.
      expect(text, file).not.toMatch(/createLLMClient\(/);
      // A direct client is allowed only as the factory handed to the gate.
      for (const match of text.matchAll(/new (OpenAI|Anthropic)LLMClient\(/g)) {
        const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
        expect(before, file).toMatch(/\.client\(\(sink\) => $/);
      }
    }
  });
});
