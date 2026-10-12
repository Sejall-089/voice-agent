import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_FAILED, createRunInstruction } from "../src/main/runInstruction.ts";
import type { PlannerOutcome } from "../src/core/types.ts";

// M22 prompt 11, live finding: with the model unreachable, `Planner.decide` threw an OpenAI
// "Connection error"; the hotkey runs the instruction fire-and-forget, so the rejection was lost —
// an UnhandledPromiseRejectionWarning in the console and NOTHING in the bar. A run that throws is
// now reported in fixed words, and the console names the error's class only.

const TOKEN = "xoxb-test-OFFLINE-SECRET-6060";

// Shaped like the real OpenAI SDK error, which is a subclass with its own name.
class APIConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APIConnectionError";
  }
}

function shell() {
  const results: string[] = [];
  const thinking: boolean[] = [];
  return {
    results,
    thinking,
    showThinking: (on: boolean): void => {
      thinking.push(on);
    },
    showResult: (text: string): void => {
      results.push(text);
    },
  };
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" "));
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run that throws is reported, not lost", () => {
  it.each([
    { label: "an SDK connection error", error: new APIConnectionError(`Connection error. Bearer ${TOKEN} https://api.openai.com/v1`), cls: "APIConnectionError" },
    { label: "a plain TypeError", error: new TypeError(`fetch failed for https://slack.com/api with Bearer ${TOKEN}`), cls: "TypeError" },
    { label: "a thrown string", error: `raw ${TOKEN}`, cls: "string" },
  ])("$label: the fixed message in the bar, the class name on the console, no token", async ({ error, cls }) => {
    const lines = captureConsole();
    const s = shell();
    const planner = { run: (): Promise<PlannerOutcome> => Promise.reject(error) };

    await expect(createRunInstruction(planner, s)("send it")).resolves.toBeUndefined();

    expect(s.results).toEqual([RUN_FAILED]);
    expect(RUN_FAILED).toBe(
      "I couldn't finish that: something went wrong before anything was done. Check your connection and try again.",
    );
    expect(lines).toEqual([`[main] error: ${cls}`]);
    // The indicator still goes off.
    expect(s.thinking).toEqual([true, false]);
    // Nothing of the error's own text anywhere.
    for (const text of [...s.results, ...lines]) {
      for (const forbidden of [TOKEN, "Bearer", "https://", "Connection error", "fetch failed"]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it("shows nothing extra when the run succeeds", async () => {
    const lines = captureConsole();
    const s = shell();
    const outcome: PlannerOutcome = { status: "ok", tool: "summarize", result: "SUMMARY" };
    await createRunInstruction({ run: () => Promise.resolve(outcome) }, s)("summarize");
    expect(s.results).toEqual([]);
    expect(lines.some((line) => line.startsWith("[main] error:"))).toBe(false);
  });
});
