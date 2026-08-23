import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import {
  declaredTiers,
  highestTier,
  needsConfirm,
  needsNarration,
  type Risk,
} from "../src/core/risk.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, Tool, ToolDeps, ToolInput } from "../src/core/types.ts";
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

// --- Argument-dependent tiers (M13, core/risk.ts) ---
//
// Through M12 a tier was a constant the tool carried. Calendar broke that: attendees are
// emailed the instant an event is created or moved, so the same tool is routine for a solo
// event and high-stakes for one with guests, and only the ARGUMENTS separate the two. These
// tests are about the mechanism, not about calendar — the probe tool below has no idea what a
// calendar is.

function policyTool(
  tiers: readonly Risk[],
  resolve: (args: ToolInput, deps: ToolDeps) => Risk | Promise<Risk>,
  ran: string[],
): Tool {
  return {
    ...toolWithRisk("safe", ran),
    risk: { tiers, resolve },
  };
}

function runPolicy(tool: Tool, ran: string[], confirms: boolean[] = []) {
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

describe("a tier that depends on the arguments", () => {
  const BOTH: readonly Risk[] = ["caution", "dangerous"];

  it("narrates and runs when the same tool resolves to caution", async () => {
    const ran: string[] = [];
    const tool = policyTool(BOTH, () => "caution", ran);

    const { shell, planner } = runPolicy(tool, ran);
    await planner.run("go");

    expect(shell.actions).toContainEqual({ kind: "notify", payload: "about to do the thing" });
    expect(shell.confirmMessages).toHaveLength(0);
    expect(ran).toEqual(["handler"]);
  });

  it("confirms — and stops on no — when that same tool resolves to dangerous", async () => {
    const ran: string[] = [];
    const tool = policyTool(BOTH, () => "dangerous", ran);

    const { shell, planner } = runPolicy(tool, ran, [false]);
    const outcome = await planner.run("go");

    expect(shell.confirmMessages).toEqual(["do the thing?"]);
    expect(shell.actions).toHaveLength(0); // it never narrated — this was the asking path
    expect(ran).toEqual([]);
    expect(outcome.status).toBe("cancelled");
  });

  it("reads the arguments, not the tool, to decide", async () => {
    const ran: string[] = [];
    const tool: Tool = {
      ...policyTool(BOTH, (args) => (args["guests"] === true ? "dangerous" : "caution"), ran),
    };
    const shell = new MockShell({ context: NO_CONTEXT, confirms: [false] });
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name: "probe", input: { guests: true } }),
      shell,
      [tool],
      new NoopMemoryResolver(),
      new InMemoryActionLog(),
    );

    await planner.run("go");

    expect(shell.confirmMessages).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  // Fail-closed. A classifier that breaks must not be able to talk the planner OUT of a gate.
  it("escalates to the worst declared tier when the resolver throws", async () => {
    const ran: string[] = [];
    const tool = policyTool(
      BOTH,
      () => {
        throw new Error("calendar unreachable");
      },
      ran,
    );

    const { shell, planner } = runPolicy(tool, ran, [false]);
    const outcome = await planner.run("go");

    // Not `safe`, and not the tool's gentler tier — the confirm gate fired.
    expect(shell.confirmMessages).toEqual(["do the thing?"]);
    expect(ran).toEqual([]);
    expect(outcome.status).toBe("cancelled");
  });

  it("escalates when the resolver returns a tier it never declared", async () => {
    const ran: string[] = [];
    // Deliberately lying: "safe" is not in `tiers`, so it is not an answer this tool is
    // allowed to give, and taking it at its word would be a hole in the gate.
    const tool = policyTool(BOTH, () => "safe" as Risk, ran);

    const { shell, planner } = runPolicy(tool, ran, [false]);
    await planner.run("go");

    expect(shell.confirmMessages).toEqual(["do the thing?"]);
    expect(ran).toEqual([]);
  });

  // Both gates read ONE answer. Asking twice would let them disagree — narrate the action and
  // then skip the confirm — which is a hole in the gate rather than a slow path.
  it("resolves the tier exactly once per run", async () => {
    const ran: string[] = [];
    let calls = 0;
    const tool = policyTool(
      BOTH,
      () => {
        calls += 1;
        return "dangerous";
      },
      ran,
    );

    const { planner } = runPolicy(tool, ran, [true]);
    await planner.run("go");

    expect(calls).toBe(1);
    expect(ran).toEqual(["handler"]);
  });

  it("names the worst tier a tool could ever reach without calling anything", () => {
    expect(highestTier(["caution", "dangerous"])).toBe("dangerous");
    expect(highestTier(["safe", "caution"])).toBe("caution");
    expect(highestTier([])).toBe("safe");
    // A plain tier declares exactly itself — every pre-M13 tool is untouched by this.
    expect(declaredTiers("caution")).toEqual(["caution"]);
    expect(declaredTiers({ tiers: ["caution", "dangerous"], resolve: () => "caution" })).toEqual([
      "caution",
      "dangerous",
    ]);
  });
});

describe("registry invariants", () => {
  // The WHOLE menu, every optional surface switched on. An invariant that only inspected the
  // tools this machine happens to have configured would go quiet exactly when a new integration
  // was added — which is the moment it is most worth having.
  const all = buildRegistry({ gmail: true, notion: true, calendar: true });

  // Every invariant below asks about the whole MENU, so each one reads `declaredTiers` rather
  // than the tier of one particular call. That is what declaring `tiers` up front buys: "could
  // this tool ever be dangerous?" stays answerable without running anything, which is the only
  // way an invariant can be checked at all.
  it("gives every tool a tier", () => {
    for (const tool of all) {
      const tiers = declaredTiers(tool.risk);
      expect(tiers.length, `${tool.name} declares no tier`).toBeGreaterThan(0);
      for (const tier of tiers) {
        expect(["safe", "reversible", "caution", "dangerous"]).toContain(tier);
      }
    }
  });

  // The one that must never regress: anything that can put words in front of another human
  // without a way to take them back has to be gated. If a future tool sends something and this
  // list is not updated, this fails. "Can ever be dangerous" is the right question now that a
  // tool can be dangerous on only some of its calls.
  it("gates every tool that can send something irreversibly", () => {
    const gated = all
      .filter((tool) => declaredTiers(tool.risk).includes("dangerous"))
      .map((tool) => tool.name);
    // createEvent and moveEvent join the list in M13 — not because they always email someone,
    // but because they CAN, and that is the question an invariant has to ask.
    expect(gated.sort()).toEqual(["createEvent", "moveEvent", "sendMessage", "sendReply"]);
  });

  // New in M13, and only meaningful now that a tool can land on either tier: a tool that can be
  // caution AND dangerous needs both a way to announce itself and a way to ask, because which
  // one it will need is not known until the call is made.
  it("gives a tool that can go either way both a narration and a confirm summary", () => {
    const eitherWay = all.filter((tool) => {
      const tiers = declaredTiers(tool.risk);
      return tiers.includes("caution") && tiers.includes("dangerous");
    });

    expect(eitherWay.map((tool) => tool.name).sort()).toEqual(["createEvent", "moveEvent"]);
    for (const tool of eitherWay) {
      expect(tool.narrate, `${tool.name} has no narration`).toBeTypeOf("function");
      expect(tool.confirmSummary, `${tool.name} has no confirmSummary`).toBeTypeOf("function");
    }
  });

  it("gives every dangerous tool a way to describe what it is about to do", () => {
    for (const tool of all.filter((t) => declaredTiers(t.risk).includes("dangerous"))) {
      expect(tool.confirmSummary, `${tool.name} has no confirmSummary`).toBeTypeOf("function");
    }
  });

  it("gives every caution tool something to say before it acts", () => {
    for (const tool of all.filter((t) => declaredTiers(t.risk).includes("caution"))) {
      expect(tool.narrate, `${tool.name} has no narration`).toBeTypeOf("function");
    }
  });
});
