import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

describe("Planner (M1: general path with summarize on the menu)", () => {
  it("routes to summarize, runs it, and shows the summary", async () => {
    const shell = new MockShell({
      context: contextWith("A very long article about otters and their habitats..."),
    });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "SUMMARY");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    const outcome = await planner.run("summarize this");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("summarize");
    expect(shell.results).toContain("SUMMARY");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "summarize" });
    // The registry (not a hardcoded list) was offered to the LLM.
    expect(llm.lastToolsOffered.map((t) => t.name)).toContain("summarize");
  });

  it("refuses gracefully and logs a miss when the LLM declines", async () => {
    const shell = new MockShell({ context: contextWith("some text") });
    const llm = new FakeLLM({ kind: "none", text: "I don't think I can help with that." });
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    const outcome = await planner.run("book me a flight to Tokyo");

    expect(outcome.status).toBe("no_tool");
    expect(shell.results[0]).toMatch(/can't do that yet/i);
    expect(log.misses).toContain("book me a flight to Tokyo");
    expect(shell.actions).toHaveLength(0);
  });

  it("refuses a hallucinated tool the registry check rejects", async () => {
    const shell = new MockShell({ context: contextWith("some text") });
    const llm = new FakeLLM({ kind: "tool", name: "does_not_exist", input: {} });
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    const outcome = await planner.run("do the impossible");

    expect(outcome.status).toBe("no_tool");
    expect(shell.results[0]).toMatch(/can't do that yet/i);
    expect(log.misses).toContain("do the impossible");
  });

  it("reports an error (not a crash) when the handler throws", async () => {
    // No selected text → the summarize handler throws; the planner records error + shows it.
    const shell = new MockShell({ context: contextWith(null) });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "unused");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    const outcome = await planner.run("summarize this");

    expect(outcome.status).toBe("error");
    expect(shell.results[0]).toMatch(/something went wrong/i);
    expect(log.entries[0]).toMatchObject({ status: "error", tool: "summarize" });
  });

  it("distinguishes a truncated response from a refusal, and keeps it out of the miss backlog", async () => {
    // The model ran out of tokens before deciding anything. Telling the user "I don't have
    // a tool for that" would send them looking for a capability that isn't the problem,
    // and filing it as a miss would corrupt the "what to build next" list (spec §8).
    const shell = new MockShell({ context: contextWith("some text") });
    const llm = new FakeLLM({
      kind: "incomplete",
      reason: "the model hit its 4096-token limit before choosing a tool",
    });
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    const outcome = await planner.run("summarize this");

    expect(outcome.status).toBe("no_tool");
    expect(outcome.tool).toBeNull();
    expect(shell.results[0]).toMatch(/ran out of room/i);
    expect(shell.results[0]).not.toMatch(/don't have a tool/i);
    expect(shell.results[0]).toMatch(/4096-token limit/); // the actionable detail survives
    expect(shell.actions).toHaveLength(0); // nothing ran

    // Logged as a miss by STATUS, with the reason — but not in the build-next backlog.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: "no_tool", tool: null });
    expect(log.misses).toHaveLength(0);
  });

  it("passes the previous turn to chooseTool, so a bare correction has something to resolve against", async () => {
    const shell = new MockShell({ context: contextWith("some text") });
    const llm = new FakeLLM({ kind: "tool", name: "summarize", input: {} }, "SUMMARY");
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

    // First run: nothing logged yet, so there's no previous turn to offer.
    await planner.run("summarize this");
    expect(llm.lastPreviousTurnOffered).toBeNull();

    // Second run: the FIRST run's own logged entry is what's offered this time.
    await planner.run("no I meant this");
    expect(llm.lastPreviousTurnOffered).toMatchObject({
      instruction: "summarize this",
      tool: "summarize",
      status: "ok",
    });
  });
});
