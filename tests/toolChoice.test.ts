import { describe, it, expect } from "vitest";
import { MULTIPLE_TOOL_CALLS, classifyToolCalls } from "../src/core/llm/toolChoice.ts";
import { PLAN_TOOL_NAME, PLAN_UNREADABLE } from "../src/core/llm/plan.ts";

// M17 live-testing bug: a single instruction, run twice, produced two different outcomes. Once,
// the model wrapped everything through `plan` but named a bogus `multi_tool_use.parallel` tool
// inside one of its steps — caught cleanly by validatePlan's own unknown-tool check (already
// covered by tests/chain.test.ts). The other time, the model answered with a REAL tool call
// (readSchedule) alongside something else in the same response, and the two provider clients
// used to keep only the first and silently discard the rest — no refusal, no narration, no log
// line. The spinner just stopped. This file is the fix: the classification decision pulled out
// of anthropic.ts/openai.ts and tested directly, per CLAUDE.md's "thin transport still needs
// error tests" — deciding what a response MEANS is classification, not request shaping.

describe("classifyToolCalls on zero calls", () => {
  it("returns null so the caller's own decline/truncation handling takes over", () => {
    expect(classifyToolCalls([])).toBeNull();
  });
});

describe("classifyToolCalls on exactly one call — unchanged from before this fix", () => {
  it("returns an ordinary tool call", () => {
    expect(classifyToolCalls([{ name: "readSchedule", input: { limit: 5 } }])).toEqual({
      kind: "tool",
      name: "readSchedule",
      input: { limit: 5 },
    });
  });

  it("defaults a missing/undefined input to an empty object", () => {
    expect(classifyToolCalls([{ name: "readSchedule", input: undefined }])).toEqual({
      kind: "tool",
      name: "readSchedule",
      input: {},
    });
  });

  it("parses a well-formed plan", () => {
    const result = classifyToolCalls([
      {
        name: PLAN_TOOL_NAME,
        input: { steps: [{ tool: "readThing", arguments: {}, describe: "read it" }] },
      },
    ]);

    expect(result).toEqual({
      kind: "plan",
      steps: [{ tool: "readThing", arguments: {}, describe: "read it" }],
    });
  });

  it("reports a malformed plan as unreadable, not as a missing capability", () => {
    const result = classifyToolCalls([{ name: PLAN_TOOL_NAME, input: { steps: "not an array" } }]);

    expect(result).toEqual({ kind: "none", text: PLAN_UNREADABLE });
  });
});

// THE BUG THIS FILE FIXES.
describe("classifyToolCalls on more than one call", () => {
  it("refuses rather than silently keeping the first and dropping the rest", () => {
    const result = classifyToolCalls([
      { name: "readSchedule", input: {} },
      { name: "multi_tool_use.parallel", input: { tool_uses: [] } },
    ]);

    expect(result).toEqual({ kind: "none", text: MULTIPLE_TOOL_CALLS });
  });

  it("refuses even when EVERY call is a real, registered tool", () => {
    // Not just a hallucination guard — this app's contract is one decision per chooseTool call,
    // and genuine native parallel tool calling violates that just as much as a fabricated one.
    const result = classifyToolCalls([
      { name: "readSchedule", input: {} },
      { name: "recall", input: { subject: "the team" } },
    ]);

    expect(result).toEqual({ kind: "none", text: MULTIPLE_TOOL_CALLS });
  });

  it("refuses even when one of the calls is `plan` itself", () => {
    const result = classifyToolCalls([
      { name: PLAN_TOOL_NAME, input: { steps: [] } },
      { name: "readSchedule", input: {} },
    ]);

    expect(result).toEqual({ kind: "none", text: MULTIPLE_TOOL_CALLS });
  });

  it("never reads a later call's input, so a provider may leave it undecoded", () => {
    // openai.ts skips JSON.parse entirely once it sees more than one call, specifically so a
    // malformed second call's arguments string can never throw before this refusal is decided.
    // A getter that throws on access proves nothing here was read — defined directly on the
    // object, since spreading a getter (`{ ...poisoned }`) invokes it immediately at
    // construction time and would poison the test itself rather than the code under test.
    const poisoned: { name: string; input: unknown } = {
      name: "sendMessage",
      get input(): never {
        throw new Error("must not be read when there is more than one call");
      },
    };
    const calls = [{ name: "readSchedule", input: {} }, poisoned];

    expect(() => classifyToolCalls(calls)).not.toThrow();
    expect(classifyToolCalls(calls)).toEqual({ kind: "none", text: MULTIPLE_TOOL_CALLS });
  });

  it("names the message so both providers can never drift onto different wording", () => {
    expect(MULTIPLE_TOOL_CALLS).toMatch(/more than one|one thing/i);
    expect(MULTIPLE_TOOL_CALLS).not.toMatch(/don't have a tool/i); // this is not a missing capability
  });
});
