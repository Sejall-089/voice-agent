import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, ToolChoice } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// Same wiring the real app uses, with the LLM and shell swapped for test doubles.
function harness(choice: ToolChoice, completion: string, selectedText: string | null) {
  const shell = new MockShell({ context: contextWith(selectedText) });
  const llm = new FakeLLM(choice, completion);
  const log = new InMemoryActionLog();
  const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);
  return { shell, llm, log, planner };
}

describe("rewrite (M2)", () => {
  it("rewrites the selection and copies the result to the clipboard", async () => {
    const { shell, log, planner } = harness(
      { kind: "tool", name: "rewrite", input: { tone: "formal" } },
      "REWRITTEN",
      "hey can u send me that thing",
    );

    const outcome = await planner.run("rewrite this more formally");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("rewrite");
    // The physical side effect went through the shell — not just a returned string.
    expect(shell.actions).toContainEqual({ kind: "copyToClipboard", payload: "REWRITTEN" });
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "rewrite" });
  });

  it("refuses when there is no selected text to rewrite", async () => {
    const { shell, planner } = harness(
      { kind: "tool", name: "rewrite", input: {} },
      "unused",
      null,
    );

    const outcome = await planner.run("rewrite this");

    expect(outcome.status).toBe("error");
    expect(shell.actions).toHaveLength(0);
  });
});

describe("openTarget (M2)", () => {
  it("opens a URL the LLM resolved on its own", async () => {
    const { shell, log, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "youtube", url: "https://youtube.com" } },
      "",
      null,
    );

    const outcome = await planner.run("open youtube");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toContainEqual({ kind: "openUrl", payload: "https://youtube.com/" });
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "openTarget" });
  });

  it("opens a bare URL the user typed directly", async () => {
    const { shell, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "github.com/anthropics" } },
      "",
      null,
    );

    const outcome = await planner.run("open github.com/anthropics");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toContainEqual({
      kind: "openUrl",
      payload: "https://github.com/anthropics",
    });
  });

  // The M2 restraint: a vague personal reference passes through the (no-op) memory resolver
  // unchanged, and the handler must refuse rather than invent a URL. M3's resolver makes this
  // case succeed with zero changes to openTarget.ts or planner.ts.
  it("does NOT fabricate a URL for an unresolvable 'my X' reference", async () => {
    const { shell, planner } = harness(
      { kind: "tool", name: "openTarget", input: { target: "my dashboard" } },
      "",
      null,
    );

    const outcome = await planner.run("open my dashboard");

    // M6: unresolved references are `refused`, and the message is shown verbatim — no
    // "Something went wrong:" wrapper.
    expect(outcome.status).toBe("refused");
    expect(shell.actions).toHaveLength(0); // nothing was opened
    expect(outcome.result).toContain("my dashboard");
    expect(shell.results[0]).toMatch(/don't know what "my dashboard" refers to/i);
    expect(shell.results[0]).not.toMatch(/something went wrong/i);
  });
});

describe("registry routing (M2)", () => {
  it("offers exactly the registered tools to the LLM", async () => {
    const { llm, planner } = harness(
      { kind: "tool", name: "summarize", input: {} },
      "SUMMARY",
      "some text",
    );

    await planner.run("summarize this");

    // The invariant is "the planner offers the registry" — not a hardcoded list. Asserting it
    // against the registry itself means adding a tool never breaks this test.
    expect(llm.lastToolsOffered.map((t) => t.name)).toEqual(registry.map((t) => t.name));
    expect(llm.lastToolsOffered.length).toBeGreaterThan(1); // it must actually be choosing
  });
});
