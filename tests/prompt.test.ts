import { describe, it, expect } from "vitest";
import { CHOOSE_SYSTEM, renderNow, renderRequest } from "../src/core/llm/prompt.ts";
import type { ActionLogEntry, CapturedContext } from "../src/core/types.ts";

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// A fixed instant, so every assertion below is about the FORMAT and never about today.
// 2026-08-23T09:48:29Z is a Sunday.
const INSTANT = Date.parse("2026-08-23T09:48:29Z");

// M13 added a clock to the prompt. Until now nothing needed one: every tool operated on text
// the user had already selected, so the model never had to know what day it was. A calendar
// tool takes an exact instant and the MODEL is what turns "tomorrow at 3" into one — which it
// cannot do without being told the current time and, crucially, the offset.

describe("renderNow", () => {
  it("gives an ISO instant with a real offset, plus the weekday and zone", () => {
    expect(renderNow(INSTANT, "Asia/Kolkata")).toBe(
      "2026-08-23T15:18:29+05:30 (Sunday, Asia/Kolkata)",
    );
  });

  it("renders the same instant differently in a different zone", () => {
    // Same moment, a different local wall-clock time AND a different calendar day. This is
    // exactly the mistake the offset exists to prevent.
    expect(renderNow(INSTANT, "America/Los_Angeles")).toBe(
      "2026-08-23T02:48:29-07:00 (Sunday, America/Los_Angeles)",
    );
    expect(renderNow(INSTANT, "Pacific/Auckland")).toBe(
      "2026-08-23T21:48:29+12:00 (Sunday, Pacific/Auckland)",
    );
  });

  it("writes UTC as +00:00 rather than leaving the offset off", () => {
    // Intl reports plain "GMT" here. An offset-less timestamp would be the one case where the
    // model has to assume, so it gets written out explicitly.
    expect(renderNow(INSTANT, "UTC")).toBe("2026-08-23T09:48:29+00:00 (Sunday, UTC)");
  });

  it("writes midnight as 00, not 24", () => {
    const midnight = Date.parse("2026-08-23T00:00:00Z");
    expect(renderNow(midnight, "UTC")).toContain("T00:00:00");
  });
});

describe("renderRequest", () => {
  it("puts the current time first, as a standing fact", () => {
    const rendered = renderRequest("what's on tomorrow", NO_CONTEXT, null, INSTANT, "UTC");

    expect(rendered.startsWith("Current time: 2026-08-23T09:48:29+00:00 (Sunday, UTC)")).toBe(
      true,
    );
    expect(rendered).toContain("Instruction: what's on tomorrow");
  });

  it("still carries the previous turn and the context alongside it", () => {
    const previous: ActionLogEntry = {
      ts: "2026-08-23T09:00:00Z",
      instruction: "open my dashboard",
      tool: "openTarget",
      arguments: { target: "dashboard" },
      result: "opened https://example.com",
      status: "ok",
    };
    const context: CapturedContext = {
      selectedText: "some notes",
      activeApp: null,
      activeWindowTitle: "Inbox",
    };

    const rendered = renderRequest("no, the other one", context, previous, INSTANT, "UTC");

    expect(rendered).toContain("Current time:");
    expect(rendered).toContain("Previous turn");
    expect(rendered).toContain("some notes");
    expect(rendered).toContain("Active window: Inbox");
  });

  it("uses the real clock when no instant is passed", () => {
    // Production calls it with three arguments; the default must be a live clock, not a
    // constant that would quietly freeze every calendar instruction to one date.
    const before = Date.now();
    const rendered = renderRequest("go", NO_CONTEXT, null);
    const stamp = /Current time: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/.exec(
      rendered,
    );

    expect(stamp).not.toBeNull();
    const parsed = Date.parse(stamp?.[1] ?? "");
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("the system prompt", () => {
  it("tells the model to resolve relative dates from that clock rather than guess", () => {
    expect(CHOOSE_SYSTEM).toContain("current local time");
    expect(CHOOSE_SYSTEM).toContain("never guess a date");
  });
});

// M17 changed a RULE in this prompt: "pick exactly one tool" became "pick one tool, unless the
// instruction genuinely needs several, in which case call `plan`". Per CLAUDE.md, a rule change
// means re-justifying the tests around it rather than re-running them — the clock test above
// still passes, but it passes for reasons that have nothing to do with the new rule, so it
// cannot tell a correct implementation from a broken one here.
//
// What these have to DISTINGUISH is the lopsidedness. A prompt that merely mentions `plan` would
// satisfy "the model can chain now" and quietly make chaining the habit — a two-step plan where
// one tool would do turns a 6-second answer into a 20-second one, and every extra step is
// another gate the user has to sit through. So each test below asserts a piece of the framing
// that a naive "you may use several tools" rewrite would fail.
describe("the system prompt on chaining (M17)", () => {
  it("restates one-tool as the DEFAULT, not merely as one of the options", () => {
    expect(CHOOSE_SYSTEM).toMatch(/almost every instruction is one tool/i);
    expect(CHOOSE_SYSTEM).toMatch(/one tool is what you should reach for/i);
  });

  it("puts the default BEFORE the capability, so the frame is set before `plan` is offered", () => {
    // Ordering is the assertion, and it is the thing a rewrite is most likely to lose: a prompt
    // that leads with "you can run several tools" and qualifies it afterwards reads as
    // permission with a caveat, not as an exception to a rule.
    const theDefault = CHOOSE_SYSTEM.indexOf("Almost every instruction is one tool");
    const theCapability = CHOOSE_SYSTEM.indexOf("`plan`");

    expect(theDefault).toBeGreaterThan(-1);
    expect(theCapability).toBeGreaterThan(-1);
    expect(theDefault).toBeLessThan(theCapability);
  });

  it("fences the capability rather than merely permitting it", () => {
    expect(CHOOSE_SYSTEM).toMatch(/when — and only when/i);
    expect(CHOOSE_SYSTEM).toMatch(/never put a single step in a plan/i);
  });

  it("states the prompt-chaining contract: no second consultation", () => {
    // A model that expects a follow-up turn plans "then send it to whoever replied", and nothing
    // downstream can rescue that. The arguments have to be writable now.
    expect(CHOOSE_SYSTEM).toMatch(/not be consulted\s+again/i);
    expect(CHOOSE_SYSTEM).toMatch(/cannot write down now/i);
  });

  it("never mentions the gates, so the model cannot plan around them", () => {
    // The tiers and the confirm gate are the planner's business and fire per step on resolved
    // arguments. A model told about them might start optimizing for fewer dialogs.
    expect(CHOOSE_SYSTEM).not.toMatch(/confirm|dangerous|risk tier/i);
  });
});
