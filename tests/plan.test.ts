import { describe, it, expect } from "vitest";
import {
  MAX_DESCRIBE_CHARS,
  PLAN_TOOL,
  PLAN_TOOL_NAME,
  PLAN_UNREADABLE,
  parsePlan,
} from "../src/core/llm/plan.ts";

// M17. `parsePlan` answers ONE question — did the model return the structure we asked for? —
// and every test here is about that and nothing else. Whether the named tools exist, whether
// there are too many steps, and whether the `{stepN}` references point backwards belong to
// core/chain.ts, and tests/chain.test.ts is where those live. The split is the point: a garbled
// response and a plan we decline to run have to reach the user as different sentences.

describe("the plan meta-tool's schema", () => {
  it("tells the model not to wrap a single step in a plan", () => {
    // The one instruction that keeps the single-step path — which every one of the existing
    // tests exercises — from being routed through the chain machinery for no reason.
    expect(PLAN_TOOL.description).toMatch(/never wrap one step in a plan/i);
    expect(PLAN_TOOL.description).toMatch(/call that tool directly/i);
  });

  it("documents the {stepN} convention, including that it reaches back past one step", () => {
    // The decision this pins: N may name ANY earlier step, not only the immediately preceding
    // one. "summarize this, add it to Notion, and send the summary to the team" wants step 1
    // from step 3, because step 2's result is the confirmation sentence and not the content.
    // If the description ever stops saying so, the model has no way to know it is allowed.
    expect(PLAN_TOOL.description).toContain("{step1}");
    expect(PLAN_TOOL.description).toMatch(/any step before the current one, not only the one just before/i);
  });

  it("states the cap, so the model is not left to discover it by being refused", () => {
    expect(PLAN_TOOL.description).toMatch(/at most 3 steps/i);
  });

  it("says the model will not be asked again", () => {
    // The prompt-chaining contract, stated where the model can act on it: it must not plan a
    // step whose arguments it cannot write down now, because there is no second consultation.
    expect(PLAN_TOOL.description).toMatch(/not be asked again/i);
  });

  it("requires a tool, arguments and a describe on every step", () => {
    const steps = PLAN_TOOL.inputSchema.properties["steps"] as {
      items: { required: string[] };
    };
    expect(steps.items.required).toEqual(["tool", "arguments", "describe"]);
  });
});

describe("parsePlan on a well-formed plan", () => {
  it("reads the steps in the order they were given", () => {
    const steps = parsePlan({
      steps: [
        { tool: "draftReply", arguments: {}, describe: "write the reply" },
        { tool: "sendReply", arguments: {}, describe: "send it" },
      ],
    });

    expect(steps?.map((s) => s.tool)).toEqual(["draftReply", "sendReply"]);
    expect(steps?.map((s) => s.describe)).toEqual(["write the reply", "send it"]);
  });

  it("carries a {stepN} placeholder through untouched", () => {
    // Substitution is core/chain.ts's job, at execution time. Anything resolved here would be
    // resolved before the earlier step had run, which is the one thing that must never happen.
    const steps = parsePlan({
      steps: [
        { tool: "readSchedule", arguments: {}, describe: "read it" },
        { tool: "addToPage", arguments: { notes: "{step1}" }, describe: "file it" },
      ],
    });

    expect(steps?.[1]?.arguments["notes"]).toBe("{step1}");
  });
});

describe("parsePlan being lenient where the schema is strict", () => {
  it("defaults missing arguments to an empty object", () => {
    // `readSchedule` requires none. Failing a whole plan over an omitted empty object would be
    // refusing something that is not a mistake.
    const steps = parsePlan({ steps: [{ tool: "readSchedule", describe: "read it" }] });

    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.arguments).toEqual({});
  });

  it("defaults a missing describe to empty, leaving the fallback to chain.ts", () => {
    // A missing describe costs a nicer preview, not correctness.
    const steps = parsePlan({ steps: [{ tool: "readSchedule", arguments: {} }] });

    expect(steps?.[0]?.describe).toBe("");
  });

  it("clips an over-long describe at the boundary rather than at each render site", () => {
    // Untrusted model text that gets displayed AND spoken. Bounding it once, where it enters,
    // is what stops a 400-word "phrase" reaching the synthesizer.
    const long = "x".repeat(MAX_DESCRIBE_CHARS + 50);
    const steps = parsePlan({ steps: [{ tool: "readSchedule", arguments: {}, describe: long }] });

    const describe = steps?.[0]?.describe ?? "";
    expect(describe.length).toBeLessThanOrEqual(MAX_DESCRIBE_CHARS + 1); // +1 for the ellipsis
    expect(describe.endsWith("…")).toBe(true);
  });
});

describe("parsePlan on something that is not a plan", () => {
  it("rejects a non-object", () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan("steps")).toBeNull();
    expect(parsePlan(7)).toBeNull();
  });

  it("rejects a missing or non-array steps field", () => {
    expect(parsePlan({})).toBeNull();
    expect(parsePlan({ steps: "draftReply then sendReply" })).toBeNull();
    expect(parsePlan({ steps: { tool: "draftReply" } })).toBeNull();
  });

  it("rejects an empty plan", () => {
    // A model that called `plan` with nothing in it did not decline to act — it failed to
    // answer, and gets told so rather than being reported as a missing capability.
    expect(parsePlan({ steps: [] })).toBeNull();
  });

  it("rejects a step with no tool name — there is no sane guess for which tool was meant", () => {
    expect(parsePlan({ steps: [{ arguments: {}, describe: "do the thing" }] })).toBeNull();
    expect(parsePlan({ steps: [{ tool: "", arguments: {} }] })).toBeNull();
    expect(parsePlan({ steps: [{ tool: "   ", arguments: {} }] })).toBeNull();
    expect(parsePlan({ steps: [{ tool: 42, arguments: {} }] })).toBeNull();
  });

  it("rejects arguments that are not an object, an array included", () => {
    // Arrays are objects to `typeof`, and an array where an argument bag belongs is exactly the
    // malformed answer worth catching.
    expect(parsePlan({ steps: [{ tool: "readSchedule", arguments: ["from"] }] })).toBeNull();
    expect(parsePlan({ steps: [{ tool: "readSchedule", arguments: "from=today" }] })).toBeNull();
  });

  it("rejects a non-string describe", () => {
    expect(parsePlan({ steps: [{ tool: "readSchedule", arguments: {}, describe: 3 }] })).toBeNull();
  });

  it("fails the WHOLE plan when one step is bad, rather than dropping that step", () => {
    // Dropping it would silently turn what the user asked for into something shorter that still
    // runs — the partial silent continuation this milestone refuses everywhere else.
    const steps = parsePlan({
      steps: [
        { tool: "draftReply", arguments: {}, describe: "write the reply" },
        { tool: null, arguments: {}, describe: "???" },
        { tool: "sendReply", arguments: {}, describe: "send it" },
      ],
    });

    expect(steps).toBeNull();
  });
});

describe("the unreadable-plan message", () => {
  it("does not claim the capability is missing", () => {
    // Same reasoning as refuseIncomplete's own sentence: telling someone "I have no tool for
    // that" when the truth is "my answer came back garbled" sends them debugging the wrong
    // thing. It says what happened and what to try.
    expect(PLAN_UNREADABLE).not.toMatch(/don't have a tool/i);
    expect(PLAN_UNREADABLE).toMatch(/several steps/i);
    expect(PLAN_UNREADABLE).toMatch(/again|separate instructions/i);
  });

  it("names the meta-tool consistently", () => {
    expect(PLAN_TOOL.name).toBe(PLAN_TOOL_NAME);
  });
});
