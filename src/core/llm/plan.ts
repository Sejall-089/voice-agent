import type { PlannedStep, ToolInput, ToolSchema } from "../types.ts";

// The `plan` meta-tool (M17) — how one planning call returns SEVERAL tools in a fixed order.
//
// WHY A META-TOOL RATHER THAN SEVERAL tool_use BLOCKS. Both providers can emit more than one
// tool call in a single response, and block order would have given us a sequence for free. Two
// things ruled it out. Parallel tool use is trained for INDEPENDENT work — a model asked for a
// dependent chain emits the first call and waits for its result, which is exactly the shape this
// milestone is not building — so the feature would simply under-trigger. And the dependency
// between steps would have been implicit in block order rather than stated, leaving nowhere to
// document the `{stepN}` convention the steps rely on.
//
// A meta-tool states the order, is the same shape for both providers (`anthropic.ts` and
// `openai.ts` each append this schema and call `parsePlan` — the vendor-neutral half stays here,
// per the rule that a thin transport still gets its classification logic tested), and leaves the
// SINGLE-STEP PATH COMPLETELY UNTOUCHED: an instruction that needs one tool still comes back as
// `{ kind: "tool" }` and runs the exact code it ran before this file existed.
//
// It is deliberately NOT in the registry. It has no handler and no risk tier, so
// `registry.find(t => t.name === name)` can never resolve it and the closed world of §6 is
// intact — a model that names `plan` as a STEP inside a plan is refused by the ordinary
// unknown-tool check, with no special case anywhere.

export const PLAN_TOOL_NAME = "plan";

// The cap on a step's `describe`. This is untrusted model text that gets displayed and spoken,
// so it is bounded where it ENTERS the app rather than at each of the places that render it.
// Roughly a phrase; the preview is a list of these and has to stay glanceable.
export const MAX_DESCRIBE_CHARS = 80;

// What the user is told when the model called `plan` but what came back was not a plan. Its own
// sentence rather than the closed-world refusal, for the same reason `refuseIncomplete` has one:
// "I have no tool for that" would send someone looking for a missing capability when the truth
// is that the model garbled its answer and retrying will probably work.
export const PLAN_UNREADABLE =
  "I worked out that this needs several steps, but couldn't read the plan I came up with. " +
  "Try saying it again, or as separate instructions.";

// The schema the providers are shown. `steps` is an array of objects rather than parallel arrays
// of names and arguments, so a step cannot be half-specified by construction.
export const PLAN_TOOL: ToolSchema = {
  name: PLAN_TOOL_NAME,
  description:
    "Run several of the other tools in a fixed order, as one instruction. Use this ONLY when " +
    "one instruction genuinely needs more than one tool — 'reply to this and send it', " +
    "'check my schedule and add it to my Notion page'. If a single tool does the job, call " +
    "that tool directly instead; never wrap one step in a plan. At most 3 steps. Every step " +
    "must name a tool from the list you were given, with the arguments that tool's own schema " +
    "asks for. A later step can use an earlier step's result: put {step1} (or {step2}, and so " +
    "on) inside a TEXT argument and it will be replaced with everything that step produced. " +
    "You may reference any step before the current one, not only the one just before it. You " +
    "will not be asked again once you answer — the steps run exactly as written here, so do " +
    "not plan anything whose arguments you cannot state now.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "The steps, in the order they should run. At most 3.",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description: "The name of the tool to run, exactly as it appears in your tool list.",
            },
            arguments: {
              type: "object",
              description:
                "The arguments for that tool, matching its own input schema. A string argument " +
                "may contain {stepN} to use an earlier step's whole result.",
            },
            describe: {
              type: "string",
              description:
                "A short phrase describing this step for the user, in the imperative — " +
                "'read tomorrow's schedule', 'add it to your Notion page'. This is read out " +
                "before anything runs, so it may be vague where the real argument is not " +
                "known yet ('email the 3pm attendee').",
            },
          },
          required: ["tool", "arguments", "describe"],
        },
      },
    },
    required: ["steps"],
  },
};

// The worked example (M19): one real three-step chain, spelled out with real tool names.
//
// WHY IT EXISTS. Live testing since M17 has found models reluctant to reach for `plan` at all —
// the prompt is deliberately lopsided toward one tool, and the description above explains the
// mechanism without ever showing a finished plan. An instruction like "file this bug email in
// Linear and tell the team" needs the things that description only states in the abstract: a
// read whose result is passed on as `{step1}`, and an argument the model must write ITSELF,
// now, because it will never see the email. Whether the example actually moves a real model is
// a live-only fact (docs/M19-live-checklist.md) — the tests pin that it is offered, not that it
// works.
//
// WHY IT IS CONDITIONAL. The description tells the model every step must name a tool from the
// list it was given, and an example naming `linear__create_issue` on an install with no Linear
// would be the description contradicting itself — and inviting a plan that `validatePlan` then
// refuses as naming a tool the app does not have. So the example is appended only when every
// tool it names is on THIS run's menu, and the base schema is untouched otherwise.
const EXAMPLE_TOOLS = ["readEmail", "linear__create_issue", "sendMessage"] as const;

const WORKED_EXAMPLE =
  " A worked example — 'file this bug email in Linear and tell the bugs channel' is three " +
  "steps: (1) readEmail with no arguments; (2) linear__create_issue with a `title` you write " +
  "yourself from what the user said (you will not see the email) and `description` set to " +
  '"{step1}"; (3) sendMessage with the channel the user named and `notes` set to ' +
  '"New bug filed: {step2}".';

// The `plan` schema for one run: `PLAN_TOOL`, plus the worked example when this menu can run it.
export function planToolFor(tools: readonly ToolSchema[]): ToolSchema {
  const runnable = EXAMPLE_TOOLS.every((name) => tools.some((tool) => tool.name === name));
  return runnable
    ? { ...PLAN_TOOL, description: PLAN_TOOL.description + WORKED_EXAMPLE }
    : PLAN_TOOL;
}

// Is this even a plan? SHAPE ONLY — deliberately not policy.
//
// This answers "did the model return the structure we asked for", and nothing else. Whether the
// tools exist, whether there are too many steps, and whether the `{stepN}` references point
// backwards are all questions about whether a plan is RUNNABLE, and they live in
// `core/chain.ts` with the rest of the gate. Keeping the split means a garbled response and a
// plan we decline to run produce different messages, which is the difference between "say that
// again" and "I don't chain that many steps".
//
// Lenient where the schema is strict, on purpose: `arguments` and `describe` are defaulted
// rather than rejected when missing. A model that omits `arguments` on `readSchedule` (which
// requires none) has not made a mistake worth failing an entire plan over, and a missing
// `describe` costs a nicer preview, not correctness — `core/chain.ts` falls back to the tool
// name. What CANNOT be defaulted is `tool`: there is no sane guess for which tool was meant.
export function parsePlan(input: unknown): PlannedStep[] | null {
  if (!isRecord(input)) return null;

  const raw = input["steps"];
  if (!Array.isArray(raw)) return null;
  // Zero steps is not a plan. Reported as unreadable rather than refused, because a model that
  // called `plan` with nothing in it did not decide against acting — it failed to answer.
  if (raw.length === 0) return null;

  const steps: PlannedStep[] = [];
  for (const entry of raw) {
    const step = parseStep(entry);
    // ONE BAD STEP FAILS THE WHOLE PLAN. Dropping it would silently change what the user asked
    // for into something shorter that still runs, which is the "partial silent continuation"
    // this milestone refuses everywhere else.
    if (step === null) return null;
    steps.push(step);
  }
  return steps;
}

function parseStep(entry: unknown): PlannedStep | null {
  if (!isRecord(entry)) return null;

  const tool = entry["tool"];
  if (typeof tool !== "string" || tool.trim().length === 0) return null;

  const args = entry["arguments"];
  if (args !== undefined && !isRecord(args)) return null;

  const describe = entry["describe"];
  if (describe !== undefined && typeof describe !== "string") return null;

  return {
    tool: tool.trim(),
    arguments: (args ?? {}) as ToolInput,
    describe: clip(typeof describe === "string" ? describe.trim() : ""),
  };
}

function clip(text: string): string {
  return text.length > MAX_DESCRIBE_CHARS
    ? `${text.slice(0, MAX_DESCRIBE_CHARS).trimEnd()}…`
    : text;
}

// Arrays are objects to `typeof`, and a step array where an object belongs is exactly the kind
// of malformed answer this file exists to catch.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
