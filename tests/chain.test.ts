import { describe, it, expect } from "vitest";
import {
  MAX_STEPS,
  MIN_PREVIEW_HOLD_MS,
  previewHoldRemaining,
  previewPlan,
  resolveStepArgs,
  spokenPlan,
  stoppedMessage,
  validatePlan,
} from "../src/core/chain.ts";
import { buildRegistry, toToolSchemas } from "../src/core/registry.ts";
import type { PlannedStep } from "../src/core/types.ts";

// The REAL schemas, not hand-written stand-ins. Everything this file asserts about argument
// positions ("start isn't text", "notes is") is only meaningful if it is measured against the
// tools the app actually offers — a fixture written from an assumption would agree with itself
// and catch nothing (CLAUDE.md, "recon before fixtures").
const TOOLS = toToolSchemas(
  buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true }),
);

function step(tool: string, args: Record<string, unknown> = {}, describe = ""): PlannedStep {
  return { tool, arguments: args, describe };
}

describe("validatePlan on plans that can run", () => {
  it("accepts a chain that passes nothing between its steps", () => {
    // The highest-value chain the registry can express, and it needs no cross-step data at all:
    // state flows through DraftStore and the live compose box.
    const plan = [step("draftReply"), step("reviseDraft"), step("sendReply")];

    expect(validatePlan(plan, TOOLS)).toEqual({ ok: true });
  });

  it("accepts a backward reference to the step immediately before", () => {
    const plan = [step("readSchedule"), step("addToPage", { instruction: "{step1}" })];

    expect(validatePlan(plan, TOOLS)).toEqual({ ok: true });
  });

  // THE DECISION THIS FILE EXISTS TO PIN (asked explicitly, so it is a choice and not whatever
  // the substitution loop happens to do).
  //
  // `{stepN}` may name ANY earlier step, not only the immediately preceding one. The case that
  // decides it is real and fits inside the cap: "summarize this, add it to my Notion page, and
  // send the summary to the team" wants step 1 from step 3, because step 2's result is the
  // confirmation sentence "Added to <page>." and not the content. Adjacency-only would make
  // that plan unexpressible while giving the model no way to know it.
  it("accepts step 3 reaching back past step 2 to step 1", () => {
    const plan = [
      step("summarize", {}, "summarize the selection"),
      step("addToPage", { instruction: "{step1}" }, "add it to your Notion page"),
      step("sendMessage", { channel: "#team", notes: "{step1}" }, "send it to the team"),
    ];

    expect(validatePlan(plan, TOOLS)).toEqual({ ok: true });
  });

  it("substitutes that skipped-back reference with step 1's result, not step 2's", () => {
    // Validation accepting it is only half the decision — this is the half that proves the
    // resolver honours the number rather than reaching for "the previous result".
    const resolved = resolveStepArgs({ channel: "#team", notes: "{step1}" }, [
      "THE SUMMARY",
      "Added to My Page.",
    ]);

    expect(resolved).toEqual({ ok: true, args: { channel: "#team", notes: "THE SUMMARY" } });
  });

  it("accepts a plan exactly at the cap", () => {
    const plan = Array.from({ length: MAX_STEPS }, () => step("readSchedule"));

    expect(validatePlan(plan, TOOLS).ok).toBe(true);
  });
});

describe("validatePlan on plans that must be refused before anything runs", () => {
  it("refuses more steps than the cap, by name rather than by truncating", () => {
    // Dropping the tail would do something the user did not ask for and report success.
    const plan = Array.from({ length: MAX_STEPS + 1 }, () => step("readSchedule"));

    const check = validatePlan(plan, TOOLS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/only run up to 3/i);
    expect(check.ok === false && check.reason).toMatch(/separate instructions/i);
  });

  it("refuses a tool that is not in the registry it was given", () => {
    const check = validatePlan([step("sendEmail", { to: "alex@example.com" })], TOOLS);

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("sendEmail");
  });

  it("refuses a nested plan with no special case for it", () => {
    // `plan` is deliberately absent from the registry, so the ordinary unknown-tool check is
    // the whole defence. If it ever gained a registry entry this test is what would fail.
    const check = validatePlan([step("readSchedule"), step("plan")], TOOLS);

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("plan");
  });

  it("refuses a tool the registry was not built with, even though it exists in the codebase", () => {
    // The closed world is the MENU THE MODEL SAW, not every tool that has a file. A plan naming
    // a calendar tool on a machine with no calendar configured is refused, not attempted.
    const withoutCalendar = toToolSchemas(buildRegistry({ gmail: true }));

    const check = validatePlan([step("readSchedule")], withoutCalendar);
    expect(check.ok).toBe(false);
  });

  it("refuses a forward reference", () => {
    const plan = [step("addToPage", { instruction: "{step2}" }), step("readSchedule")];

    const check = validatePlan(plan, TOOLS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/hasn't happened/i);
  });

  it("refuses a self reference", () => {
    const plan = [step("readSchedule"), step("addToPage", { instruction: "{step2}" })];

    const check = validatePlan(plan, TOOLS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/hasn't happened/i);
  });

  it("refuses a reference to step 1 from step 1", () => {
    const check = validatePlan([step("addToPage", { instruction: "{step1}" })], TOOLS);

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/hasn't happened/i);
  });

  it("refuses a reference to a step that isn't in the plan at all", () => {
    const plan = [step("readSchedule"), step("addToPage", { instruction: "{step9}" })];

    const check = validatePlan(plan, TOOLS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/isn't in it/i);
  });

  it("refuses a whole result substituted into an argument that isn't text", () => {
    // `readSchedule.limit` is declared `number`. A schedule listing pasted there would surface
    // as a confusing error from inside the tool rather than as "I planned that wrong".
    const check = validatePlan(
      [step("summarize"), step("readSchedule", { limit: "{step1}" })],
      TOOLS,
    );

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/isn't text/i);
    expect(check.ok === false && check.reason).toContain("limit");
  });

  it("does NOT refuse a text argument that merely holds structured-looking data", () => {
    // The precondition for the test above, and the case that stops it passing under an
    // implementation that refuses every placeholder. `createEvent.start` wants an ISO instant
    // and would be a terrible place for a schedule listing — but it is DECLARED `string`, so
    // this rule has nothing to say about it and the tool's own `requiredInstant` is what
    // refuses. The rule checks the declared type; it does not judge the content.
    const createEvent = TOOLS.find((tool) => tool.name === "createEvent");
    const start = createEvent?.inputSchema.properties["start"] as { type: string };
    const readSchedule = TOOLS.find((tool) => tool.name === "readSchedule");
    const limit = readSchedule?.inputSchema.properties["limit"] as { type: string };

    expect(start.type).toBe("string"); // the one that passes
    expect(limit.type).toBe("number"); // the one that is refused

    const check = validatePlan(
      [step("readSchedule"), step("createEvent", { title: "Recap", start: "{step1}" })],
      TOOLS,
    );
    expect(check.ok).toBe(true);
  });

  it("catches a loose placeholder rather than letting it through as literal text", () => {
    // `{ step 2 }` is not the documented form. Detecting it leniently means it is refused by
    // name; ignoring it would put the characters "{ step 2 }" inside a Slack message.
    const plan = [step("sendMessage", { channel: "#team", notes: "here: { step 2 }" })];

    const check = validatePlan(plan, TOOLS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/hasn't happened|isn't in it/i);
  });

  it("refuses an empty plan", () => {
    expect(validatePlan([], TOOLS).ok).toBe(false);
  });
});

describe("resolveStepArgs", () => {
  it("leaves arguments with no placeholder exactly as they were", () => {
    const args = { channel: "#team", notes: "hello", limit: 3, attendees: ["a@b.com"] };

    expect(resolveStepArgs(args, ["earlier"])).toEqual({ ok: true, args });
  });

  it("substitutes every occurrence, including inside arrays", () => {
    const resolved = resolveStepArgs(
      { notes: "{step1} and again {step1}", tags: ["{step2}"] },
      ["ONE", "TWO"],
    );

    expect(resolved).toEqual({
      ok: true,
      args: { notes: "ONE and again ONE", tags: ["TWO"] },
    });
  });

  it("does not re-scan what it substituted in", () => {
    // A schedule that happens to contain the characters "{step2}" is DATA, not an instruction.
    // One pass over the original string is what makes that structural rather than a rule.
    const resolved = resolveStepArgs({ notes: "{step1}" }, ["a note mentioning {step2}", "TWO"]);

    expect(resolved).toEqual({ ok: true, args: { notes: "a note mentioning {step2}" } });
  });

  it("stops the chain when the step it references produced nothing", () => {
    // Not knowable at validation time — this is a state of the world, so it stops the chain
    // mid-flight rather than refusing the plan up front.
    const resolved = resolveStepArgs({ notes: "{step1}" }, ["   "]);

    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toMatch(/didn't produce anything/i);
    expect(resolved.ok === false && resolved.reason).toContain("Step 1");
  });

  it("resolves the loose form it detects, rather than detecting it and then ignoring it", () => {
    expect(resolveStepArgs({ notes: "{ step 1 }" }, ["ONE"])).toEqual({
      ok: true,
      args: { notes: "ONE" },
    });
  });
});

describe("the plan preview", () => {
  const plan = [
    step("readSchedule", {}, "read tomorrow's schedule"),
    step("addToPage", {}, "add it to your Notion page"),
  ];

  it("numbers the steps on screen", () => {
    expect(previewPlan(plan)).toBe(
      "Two steps:\n1. Read tomorrow's schedule\n2. Add it to your Notion page",
    );
  });

  it("falls back to the tool name when the model omitted a description", () => {
    // Verbatim, NOT capitalized: this one is an identifier, and "ReadSchedule" is a different
    // string from the one in the registry — the sort of small lie that sends someone looking
    // for a tool that doesn't exist.
    expect(previewPlan([step("readSchedule")])).toBe("One step:\n1. readSchedule");
  });

  it("says the plan as one line, in order", () => {
    expect(spokenPlan(plan)).toBe(
      "Two steps. First, read tomorrow's schedule. Then, add it to your Notion page.",
    );
  });

  it("cleans each description, so no em dash reaches the engine", () => {
    // Model-authored text going straight to a synthesizer M14 established garbles dashes.
    const spoken = spokenPlan([
      step("readSchedule", {}, "check the 3pm slot"),
      step("sendMessage", {}, "email Alex — the 3pm attendee"),
    ]);

    expect(spoken).not.toContain("—");
    expect(spoken).toContain("Alex");
  });
});

describe("the stopped-chain accounting", () => {
  const plan = [
    step("readSchedule", {}, "read tomorrow's schedule"),
    step("addToPage", {}, "add it to your Notion page"),
    step("sendMessage", {}, "tell the team"),
  ];

  it("leads with the tool's own words", () => {
    // Every refusal path in the planner shows a UserFixableError verbatim, because the tool is
    // the only thing that knows what would fix it. Bookkeeping must not get in front of it.
    const message = stoppedMessage(plan, 1, "Your Notion page isn't open.");

    expect(message.startsWith("Your Notion page isn't open.")).toBe(true);
  });

  it("says how much ran and how much did not", () => {
    const message = stoppedMessage(plan, 1, "Your Notion page isn't open.");

    expect(message).toContain("already done step 1 of 3");
    expect(message).toContain("steps 2 and 3 didn't run");
  });

  it("gets the singular and plural right at the other end of the chain", () => {
    const message = stoppedMessage(plan, 2, "Slack rejected that.");

    expect(message).toContain("already done steps 1 and 2 of 3");
    expect(message).toContain("step 3 didn't run");
  });

  it("says plainly that nothing ran when the first step is the one that failed", () => {
    const message = stoppedMessage(plan, 0, "Your calendar isn't connected yet.");

    expect(message).toBe(
      "Your calendar isn't connected yet. That was step 1 of 3, so nothing in the plan ran.",
    );
  });

  it("keeps the accounting in the SAME paragraph as the reason", () => {
    // A blank line would make toSpokenResult speak only the reason and offer to read "the
    // rest", turning how-much-ran into something the user has to ask for.
    expect(stoppedMessage(plan, 1, "Nope.")).not.toContain("\n\n");
  });

  it("adds a terminal stop to a reason that lacks one, so the two don't run together", () => {
    expect(stoppedMessage(plan, 1, "Nope")).toContain("Nope. I'd already done");
  });
});

// M17 LIVE-TESTING FIX. Confirmed reproducible: on a 3-step chain where every step's own work
// finishes fast (no real waiting), the plan-preview text was replaced by step 1's result in
// well under a second — not enough time to read it. Speech was never affected (the audio plays
// out at its own pace in the background regardless of how fast the planner races ahead); this
// is screen-only, and this is the fix for it.
describe("previewHoldRemaining", () => {
  it("asks for the full hold when shown and now are the same instant", () => {
    expect(previewHoldRemaining(1000, 1000)).toBe(MIN_PREVIEW_HOLD_MS);
  });

  it("asks for less once some real time has already passed", () => {
    // A chain whose narration/gates genuinely took 400ms should only wait out the remainder,
    // never punished with the full hold on top of work it already did.
    expect(previewHoldRemaining(1000, 1400)).toBe(MIN_PREVIEW_HOLD_MS - 400);
  });

  it("asks for nothing once the hold has already elapsed", () => {
    // A step 1 that involved a genuinely slow real API call, or a confirm dialog someone took a
    // while to answer, must never be delayed FURTHER on top of that real wait.
    expect(previewHoldRemaining(1000, 1000 + MIN_PREVIEW_HOLD_MS)).toBe(0);
  });

  it("never goes negative when more time has passed than the hold requires", () => {
    expect(previewHoldRemaining(1000, 1000 + MIN_PREVIEW_HOLD_MS + 5000)).toBe(0);
  });

  it("treats an impossible negative gap the same as zero elapsed, rather than a longer wait", () => {
    // Defensive: `now` should never be before `shownAt` in the real app (Date.now() is
    // monotonic in practice here), but a clock oddity must not ask for MORE than the full hold.
    expect(previewHoldRemaining(1000, 900)).toBe(MIN_PREVIEW_HOLD_MS);
  });
});
