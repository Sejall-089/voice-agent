import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { needsConfirm, needsNarration } from "../src/core/risk.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, Tool, ToolInput } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// The 4-tier model itself (M10, core/risk.ts): what each tier makes the planner do, and the
// registry-wide invariants that must never quietly regress. The specific tools are tested
// elsewhere — this file is about the gate.

function toolWithRisk(risk: Tool["risk"], ran: string[]): Tool {
  return {
    name: "probe",
    description: "test double",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk,
    narrate: (): string => "about to do the thing",
    confirmSummary: (_args: ToolInput): string => "do the thing?",
    handler: (): Promise<string> => {
      ran.push("handler");
      return Promise.resolve("done");
    },
  };
}

function run(risk: Tool["risk"], confirms: boolean[] = []) {
  const ran: string[] = [];
  const tool = toolWithRisk(risk, ran);
  const shell = new MockShell({ context: NO_CONTEXT, confirms });
  const planner = new Planner(
    new FakeLLM({ kind: "tool", name: "probe", input: {} }),
    shell,
    [tool],
    new NoopMemoryResolver(),
    new InMemoryActionLog(),
  );
  return { ran, shell, planner };
}

describe("the tiers", () => {
  it("maps each tier to exactly one behaviour", () => {
    expect([needsNarration("safe"), needsConfirm("safe")]).toEqual([false, false]);
    expect([needsNarration("reversible"), needsConfirm("reversible")]).toEqual([false, false]);
    expect([needsNarration("caution"), needsConfirm("caution")]).toEqual([true, false]);
    expect([needsNarration("dangerous"), needsConfirm("dangerous")]).toEqual([false, true]);
  });

  it("runs safe and reversible tools with no dialog and no narration", async () => {
    for (const risk of ["safe", "reversible"] as const) {
      const { ran, shell, planner } = run(risk);
      await planner.run("go");
      expect(ran).toEqual(["handler"]);
      expect(shell.confirmMessages).toHaveLength(0);
      expect(shell.actions).toHaveLength(0);
    }
  });

  it("narrates a caution tool and runs it anyway — announcing is not asking", async () => {
    const { ran, shell, planner } = run("caution");

    await planner.run("go");

    expect(shell.actions).toContainEqual({ kind: "notify", payload: "about to do the thing" });
    expect(shell.confirmMessages).toHaveLength(0);
    expect(ran).toEqual(["handler"]);
  });

  it("stops a dangerous tool dead when the answer is no", async () => {
    const { ran, shell, planner } = run("dangerous", [false]);

    const outcome = await planner.run("go");

    expect(shell.confirmMessages).toEqual(["do the thing?"]);
    expect(ran).toEqual([]); // the handler was never entered
    expect(outcome.status).toBe("cancelled");
  });

  it("defaults a dangerous tool to no when the shell has nothing queued", async () => {
    // MockShell answers `false` to an unqueued confirm on purpose. A gate that fired on silence
    // would be worse than no gate, because it would look like one.
    const { ran, planner } = run("dangerous");
    expect((await planner.run("go")).status).toBe("cancelled");
    expect(ran).toEqual([]);
  });
});

describe("registry invariants", () => {
  const all = buildRegistry({ gmail: true });

  it("gives every tool a tier", () => {
    for (const tool of all) {
      expect(["safe", "reversible", "caution", "dangerous"]).toContain(tool.risk);
    }
  });

  // The one that must never regress: anything that can put words in front of another human
  // without a way to take them back has to be gated. If a future tool sends something and this
  // list is not updated, this fails.
  it("gates every tool that can send something irreversibly", () => {
    const gated = all.filter((tool) => tool.risk === "dangerous").map((tool) => tool.name);
    expect(gated.sort()).toEqual(["sendMessage", "sendReply"]);
  });

  it("gives every dangerous tool a way to describe what it is about to do", () => {
    for (const tool of all.filter((t) => t.risk === "dangerous")) {
      expect(tool.confirmSummary, `${tool.name} has no confirmSummary`).toBeTypeOf("function");
    }
  });

  it("gives every caution tool something to say before it acts", () => {
    for (const tool of all.filter((t) => t.risk === "caution")) {
      expect(tool.narrate, `${tool.name} has no narration`).toBeTypeOf("function");
    }
  });
});
