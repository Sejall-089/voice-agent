import { PLAN_TOOL_NAME, PLAN_UNREADABLE, parsePlan } from "./plan.ts";
import type { ToolChoice, ToolInput } from "../types.ts";

// Turning a provider's raw tool-call answer into a ToolChoice — pulled OUT of anthropic.ts and
// openai.ts so it is TESTED directly rather than left inside the transport. Per CLAUDE.md: "only
// a live run can prove it" excuses request SHAPING, not error/outcome CLASSIFICATION — and
// deciding what a chooseTool response MEANS is classification, with no excuse to go untested.
// (This file exists because that lesson was learned the expensive way a second time: M17 live
// testing found a real bug living in exactly this untested gap — see MULTIPLE_TOOL_CALLS below.)
//
// Vendor-neutral by construction: Anthropic's `response.content` tool_use blocks and OpenAI's
// `message.tool_calls` array are each flattened to `RawToolCall[]` in their own file, so one
// function classifies both providers' answers identically and the two can never drift apart on
// what "the model answered with more than one thing" means.
export interface RawToolCall {
  name: string;
  // Already decoded to a usable value. Anthropic hands this over pre-parsed; OpenAI must
  // JSON.parse a string first, and how a decoding FAILURE is handled deliberately differs by
  // whether the call is `plan` or an ordinary tool (see openai.ts's own comment) — so that
  // decision stays in each provider file, and only an already-decoded value reaches here.
  input: unknown;
}

// What the user is told when a single chooseTool response tried to decide more than one thing.
//
// A REAL, OBSERVED failure, not a hypothetical: M17 live testing hit it twice on one repeated
// instruction. Once, the model wrapped everything correctly through `plan` but put a bogus
// `multi_tool_use.parallel` tool name INSIDE one of the plan's steps — caught cleanly by
// `validatePlan`'s ordinary unknown-tool check, exactly as designed. The other time, the model
// answered with the real `readSchedule` call ALONGSIDE something else in the same response —
// most likely that same hallucinated wrapper, or a genuine native parallel tool call — and the
// two provider clients used to just keep the FIRST call and silently discard the rest with no
// signal anywhere: no refusal, no narration, no log line, nothing. The spinner just stopped.
//
// That silent-drop is the actual bug. This app's whole contract is "one chooseTool call produces
// exactly one decision" (a single tool, or — since M17 — a single `plan`), and it is enforced
// everywhere else in this codebase by refusing loudly the moment that contract is violated. A
// second (or third) tool call arriving in the same response violates it just as much as an
// unregistered tool name does, and must be refused the same way — never truncated to "whichever
// one happened to come first."
export const MULTIPLE_TOOL_CALLS =
  "I tried to decide more than one thing in a single step, and I don't run that safely. " +
  "Ask for one thing, or say it as a single request I can plan as steps.";

// null means "the model made no tool call at all" — the caller's own provider-specific
// decline/truncation handling (stop_reason, finish_reason) takes over from there, because that
// classification genuinely differs by provider and belongs in the transport, not here.
export function classifyToolCalls(calls: readonly RawToolCall[]): ToolChoice | null {
  if (calls.length === 0) return null;

  // MORE THAN ONE. Refused by name rather than truncated to the first — the fix this file
  // exists for. Checked BEFORE touching `.input` on purpose: with more than one call, a
  // provider may not even have attempted to decode the others (see openai.ts), so nothing here
  // may assume `.input` is safe to read when this branch fires.
  if (calls.length > 1) {
    return { kind: "none", text: MULTIPLE_TOOL_CALLS };
  }

  const call = calls[0];
  if (call === undefined) return null; // unreachable given the checks above; keeps TS satisfied

  if (call.name === PLAN_TOOL_NAME) {
    const steps = parsePlan(call.input);
    return steps === null ? { kind: "none", text: PLAN_UNREADABLE } : { kind: "plan", steps };
  }

  return { kind: "tool", name: call.name, input: (call.input ?? {}) as ToolInput };
}
