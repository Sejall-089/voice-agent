import { describe, it, expect } from "vitest";
import { createRunInstruction } from "../src/main/runInstruction.ts";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, PlannerOutcome } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

// The one planner call site, and the "Thinking…" indicator that wraps it. The indicator is
// pure perception — it makes no run faster — so the only thing worth asserting is that it
// is never left on, on any path out.

const CONTEXT: CapturedContext = {
  selectedText: "a long article about otters",
  activeApp: null,
  activeWindowTitle: null,
};

describe("createRunInstruction (the single planner call site)", () => {
  it("turns the indicator on before the run and off after it", async () => {
    const shell = new MockShell({ context: CONTEXT });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "SUMMARY");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    await createRunInstruction(planner, shell)("summarize this");

    expect(shell.thinking).toEqual([true, false]);
    expect(shell.results).toContain("SUMMARY");
  });

  it("turns the indicator off even when the planner throws", async () => {
    // A bar stuck on "Thinking…" forever is worse than no indicator at all: it would claim
    // work is happening when nothing is.
    const shell = new MockShell({ context: CONTEXT });
    const exploding = {
      run: (): Promise<PlannerOutcome> => Promise.reject(new Error("planner exploded")),
    };

    await expect(createRunInstruction(exploding, shell)("summarize this")).rejects.toThrow(
      "planner exploded",
    );

    expect(shell.thinking).toEqual([true, false]);
  });

  it("does not show the indicator when there is nothing to run", async () => {
    // An empty instruction is the normal outcome of dismissing the bar, or of typing
    // nothing and pressing Enter. It must not flash an indicator for a run that never
    // happens.
    const shell = new MockShell({ context: CONTEXT });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "SUMMARY");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);
    const run = createRunInstruction(planner, shell);

    await run("");
    await run("   ");

    expect(shell.thinking).toEqual([]);
    expect(log.entries).toHaveLength(0);
  });

  it("shows it for a dictated instruction exactly as for a typed one", async () => {
    // Voice produces a string and hands it here; nothing downstream can tell the
    // difference, and neither can the indicator.
    const shell = new MockShell({ context: CONTEXT });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "SUMMARY");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    await createRunInstruction(planner, shell)("summarize this"); // as if transcribed

    expect(shell.thinking).toEqual([true, false]);
  });
});
