import { toSpokenLine } from "./speech.ts";
import type { PlannedStep, ToolInput, ToolSchema } from "./types.ts";

// The pure half of a chained run (M17): is this plan runnable, what does a step's arguments
// actually resolve to, and what does the user get told about it.
//
// Everything here is a decision, not an effect — no shell, no LLM, no clock. The planner does
// the running; this decides what may run and how it is described. Same split `core/screen/`
// uses (a deterministic gate beside a transport) and `core/speech.ts` uses (pure derivation
// beside a synthesizer), and for the same reason: the half that can be wrong is the half worth
// testing, and it is the half that has no excuse for needing a live run to prove.

// The hard cap on a chain. Exceeding it is a NAMED REFUSAL, never a silent truncation and never
// a guess at which steps mattered most — dropping step 3 of a 4-step plan would do something
// the user did not ask for while reporting success.
//
// Three, because that is what the registry can actually express: the longest genuinely useful
// chain in it is draftReply → reviseDraft → sendReply, and the discussion that scoped this
// milestone said "2-3 known steps". A cap that is larger than anything real would only ever be
// hit by a model that had misunderstood the request.
export const MAX_STEPS = 3;

// `{step1}` — a whole earlier result, dropped into a text argument.
//
// Detection is LENIENT on purpose while the documented form is strict. `{ step 1 }` is not what
// the prompt asks for, but a near-miss that went undetected would sail through validation as a
// literal and end up inside an email as the characters "{ step 1 }". Catching the loose forms
// means they are either substituted correctly or refused by name, and never silently sent.
const PLACEHOLDER = /\{\s*step\s*(\d+)\s*\}/gi;

export type PlanCheck = { ok: true } | { ok: false; reason: string };

export type ArgCheck =
  | { ok: true; args: ToolInput }
  | { ok: false; reason: string };

// Can this plan run at all? Asked ONCE, before anything happens.
//
// Everything checkable without running anything is checked here, and that is deliberate: the
// plan is narrated to the user before step 1 executes, and narrating a plan that was always
// going to die on step 2 for a structural reason would be announcing something untrue. The
// failures that CANNOT be known in advance — a tool refusing, a step producing nothing to pass
// on — stop the chain mid-flight instead, with the accounting `stoppedMessage` writes.
export function validatePlan(
  steps: readonly PlannedStep[],
  tools: readonly ToolSchema[],
): PlanCheck {
  // Defensive: `parsePlan` already rejects an empty plan as unreadable. Reachable when a plan
  // is constructed directly rather than parsed — which is exactly what the tests do.
  if (steps.length === 0) {
    return { ok: false, reason: "I ended up with no steps to run." };
  }

  if (steps.length > MAX_STEPS) {
    return {
      ok: false,
      reason:
        `That works out as ${steps.length} steps, and I only run up to ${MAX_STEPS} in one go. ` +
        `Try it as separate instructions.`,
    };
  }

  for (const [index, step] of steps.entries()) {
    const schema = tools.find((tool) => tool.name === step.tool);
    if (schema === undefined) {
      // The same closed-world rule the single-tool path applies, at every position in the plan.
      // `plan` itself is caught here for free: it is not in the registry, so a plan that tried
      // to nest a plan is refused with no special case anywhere.
      return {
        ok: false,
        reason:
          `My plan for that used a tool I don't have ("${step.tool}"), so I didn't start it.`,
      };
    }

    const references = placeholdersIn(step.arguments);
    for (const { step: n, key } of references) {
      // BACKWARD ONLY, AND THAT IS THE DECISION. `n` may name ANY earlier step, not just the
      // one immediately before — "summarize this, add it to Notion, and send the summary to the
      // team" wants step 1 from step 3, because step 2's result is the confirmation sentence
      // "Added to <page>." and not the content. Restricting to adjacency would make that plan
      // unexpressible while giving the model no way to know it.
      //
      // What is forbidden is FORWARD or SELF: a step cannot use a result that does not exist
      // when it runs. Checking it here rather than at substitution time is what lets the whole
      // plan be refused before it is narrated.
      if (n < 1 || n > steps.length) {
        return {
          ok: false,
          reason:
            `Step ${index + 1} of my plan referred to a step ${n} that isn't in it, ` +
            `so I didn't start it.`,
        };
      }
      if (n > index) {
        return {
          ok: false,
          reason:
            `Step ${index + 1} of my plan needed step ${n}'s result, which hasn't happened ` +
            `by then, so I didn't start it.`,
        };
      }

      // A whole result substituted into an argument that isn't text. `createEvent`'s `start`
      // wants an ISO instant; a schedule listing pasted there would reach the user as a
      // confusing date error from deep inside the tool instead of as "I planned that wrong".
      //
      // LIMIT, STATED: only TOP-LEVEL properties are type-checked. A placeholder nested inside
      // an array or object (`attendees: ["{step1}"]`) is allowed through and left to the tool's
      // own argument validation, which already refuses with a UserFixableError. Reasoning about
      // `items` schemas is more machinery than the case has ever justified.
      const declared = declaredType(schema, key);
      if (declared !== null && declared !== "string") {
        return {
          ok: false,
          reason:
            `Step ${index + 1} of my plan put step ${n}'s result into "${key}", which isn't ` +
            `text, so I didn't start it.`,
        };
      }
    }
  }

  return { ok: true };
}

// Substitute the results of steps that have ALREADY RUN into this step's arguments.
//
// Called by the planner at the moment execution reaches this step and before its gate fires —
// which is the whole safety property of the template approach. The confirm dialog and the
// narration describe the real, concrete argument, never a placeholder and never a guess; and
// the model, having answered once, is not consulted again to produce it.
//
// `results` is indexed from zero, so step 1's result is `results[0]`.
export function resolveStepArgs(args: ToolInput, results: readonly string[]): ArgCheck {
  let failure: string | null = null;

  const substitute = (text: string): string =>
    text.replace(PLACEHOLDER, (all, digits: string) => {
      const n = Number(digits);
      const result = results[n - 1];
      // Validation has already established that `n` names an earlier step, so a miss here means
      // that step ran and produced nothing usable — a real state of the world, not a plan error.
      if (result === undefined || result.trim().length === 0) {
        failure ??= `Step ${n} didn't produce anything to pass on, so I stopped there.`;
        return all;
      }
      return result;
    });

  // ONE PASS, never a re-scan of what was substituted in. A schedule that happens to contain the
  // characters "{step1}" is data, not an instruction — `String.replace` with a function walks
  // the original string, so substituted text is never itself searched for placeholders.
  const resolved = mapStrings(args, substitute);
  return failure === null ? { ok: true, args: resolved } : { ok: false, reason: failure };
}

// The whole plan, on screen, before any of it runs. Decision 2 of the milestone: transparency,
// not approval — the gates still fire per step, on real arguments, when execution gets there.
export function previewPlan(steps: readonly PlannedStep[]): string {
  // Capitalized only when it is the model's PHRASE. The fallback is a tool name — an identifier
  // — and "ReadSchedule" is a different string from the one in the registry, which is exactly
  // the sort of small lie that sends someone looking for a tool that doesn't exist.
  const lines = steps.map((step, index) => {
    const described = step.describe.trim();
    const label = described.length > 0 ? capitalize(described) : step.tool;
    return `${index + 1}. ${label}`;
  });
  return [`${countWord(steps.length)} ${plural(steps.length, "step")}:`, ...lines].join("\n");
}

// The same plan, said out loud. Returns a plain string; the planner runs it through
// `toSpokenNarration`, which applies the same length cap every other narration lives under.
//
// Each description goes through the shared cleaner rather than being spoken raw: it is model
// text, and a describe containing an em dash or a bullet would otherwise reach the engine as
// the one thing M14 established it garbles.
export function spokenPlan(steps: readonly PlannedStep[]): string {
  const parts = steps.map((step, index) => {
    const said = toSpokenLine(labelFor(step));
    return index === 0 ? `First, ${said}` : `Then, ${said}`;
  });
  return [`${countWord(steps.length)} ${plural(steps.length, "step")}.`, ...parts].join(" ");
}

// How long the plan preview must stay on screen before anything may replace it — a live-testing
// finding, not part of the original design. A 3-step chain of fast steps (fake calendar, fake
// Notion, no real network latency) replaced the preview with step 1's result in well under a
// second: nothing throttled the SCREEN to the pace a person reads at, only to the pace the code
// ran at. The SPOKEN narration was never affected by the same bug — `executeAction({kind:
// "speak"})` returns once an utterance is QUEUED, not once it has been heard (core/planner.ts's
// `say`), so the audio plays out at its own pace in the background regardless of how fast the
// planner races through the steps afterward. This constant is the screen's equivalent of that
// already-correct behaviour, not a change to speech.
export const MIN_PREVIEW_HOLD_MS = 2500;

// How much LONGER the preview must stay up, given the instant it was shown and the current one.
// Pure and separately testable, mirroring `core/llm/prompt.ts`'s `renderNow(now, zone)` split:
// the planner reads `Date.now()` at both ends (once right before narrating the preview, once
// right before it would let step 1 begin) and calls this; tests supply two literals.
//
// ADAPTIVE rather than a flat pause, on purpose: a chain whose narration and gates already
// consumed the whole hold in genuine real time waits nothing further, so a naturally slow step 1
// (a real API call, a real confirm dialog) is never punished with an extra fixed delay on top of
// work it was already going to do.
export function previewHoldRemaining(shownAt: number, now: number): number {
  // Clamped at BOTH ends: never negative (the hold is already satisfied), and never more than
  // the hold itself (a `now` before `shownAt` — a clock oddity, never expected in practice since
  // Date.now() is monotonic here — must not ask for longer than the preview was ever meant to
  // stay up for).
  return Math.min(MIN_PREVIEW_HOLD_MS, Math.max(0, MIN_PREVIEW_HOLD_MS - (now - shownAt)));
}

// The new sentence shape decision 5 asks for: how much of the plan happened, and how much did
// not. Nothing before this milestone needed it, because nothing before it could stop halfway.
//
// The TOOL'S OWN WORDS COME FIRST. Every refusal path in the planner shows a `UserFixableError`
// verbatim because the tool is the only thing that knows what would fix it, and burying that
// behind bookkeeping would answer a question the user has not asked yet. The accounting follows
// in the same paragraph, deliberately — a blank line would make `toSpokenResult` speak only the
// first half and offer to read "the rest", turning the accounting into something the user has
// to ask for.
//
// `stoppedAt` is the ZERO-BASED index of the step that failed, so it is also the number of
// steps that completed.
export function stoppedMessage(
  steps: readonly PlannedStep[],
  stoppedAt: number,
  reason: string,
): string {
  const total = steps.length;
  const notRun = range(stoppedAt + 1, total);
  const said = endStop(reason);

  if (stoppedAt <= 0) {
    return `${said} That was step 1 of ${total}, so nothing in the plan ran.`;
  }

  const done = range(1, stoppedAt);
  return (
    `${said} I'd already done ${stepWord(done)} ${numberList(done)} of ${total}, ` +
    `but ${stepWord(notRun)} ${numberList(notRun)} didn't run.`
  );
}

// --- Internals ---

// What to call a step. The model authors it; the tool name is the fallback, because a missing
// describe should cost a less friendly preview and never an empty line in a numbered list.
function labelFor(step: PlannedStep): string {
  return step.describe.trim().length > 0 ? step.describe.trim() : step.tool;
}

interface Reference {
  step: number;
  // The TOP-LEVEL argument this reference was found under, for the type check and for naming it
  // in a refusal. A nested reference reports the top-level key it lives beneath.
  key: string;
}

function placeholdersIn(args: ToolInput): Reference[] {
  const found: Reference[] = [];
  for (const [key, value] of Object.entries(args)) {
    forEachString(value, (text) => {
      for (const match of text.matchAll(PLACEHOLDER)) {
        found.push({ step: Number(match[1]), key });
      }
    });
  }
  return found;
}

// The declared JSON-Schema type of a top-level property, or null when the tool didn't declare
// one. Read defensively: `properties` is `Record<string, unknown>` by contract, so nothing here
// may assume a shape it has not checked.
function declaredType(schema: ToolSchema, key: string): string | null {
  const property = schema.inputSchema.properties[key];
  if (typeof property !== "object" || property === null) return null;
  const type = (property as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

function forEachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) forEachString(item, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) forEachString(item, visit);
  }
}

// Rebuild the argument bag with every string passed through `transform`, structure preserved.
function mapStrings(args: ToolInput, transform: (text: string) => string): ToolInput {
  const out: ToolInput = {};
  for (const [key, value] of Object.entries(args)) out[key] = mapValue(value, transform);
  return out;
}

function mapValue(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapValue(item, transform));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapValue(item, transform);
    return out;
  }
  return value;
}

const COUNTS = ["No", "One", "Two", "Three", "Four", "Five"];

function countWord(n: number): string {
  return COUNTS[n] ?? String(n);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function stepWord(numbers: readonly number[]): string {
  return plural(numbers.length, "step");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// "2" · "2 and 3" · "2, 3 and 4". No Oxford comma, matching calendar/format.ts's own list style.
function numberList(numbers: readonly number[]): string {
  if (numbers.length <= 1) return String(numbers[0] ?? "");
  const head = numbers.slice(0, -1).join(", ");
  return `${head} and ${numbers[numbers.length - 1]}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

// A terminal stop, so the tool's own sentence and the accounting that follows are not spoken as
// one run-on line. Mirrors `core/speech.ts`'s private `sentence` — duplicated rather than
// exported, because that one is about making a fragment speakable and this one is about joining
// two written sentences, and they would drift apart the moment either changed.
function endStop(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
