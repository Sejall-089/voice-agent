import OpenAI from "openai";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  ToolChoice,
  ToolSchema,
} from "../types.ts";
import { CHOOSE_SYSTEM, renderRequest } from "./prompt.ts";
import { PLAN_TOOL, PLAN_TOOL_NAME } from "./plan.ts";
import { classifyToolCalls, type RawToolCall } from "./toolChoice.ts";

// Model for this provider (spec.md §3). Provider itself is chosen via LLM_PROVIDER —
// see factory.ts.
const PLANNER_MODEL = "gpt-5";

// Reasoning tokens come out of the same allowance as the tool call itself (§3a).
//
// Raised 4096 → 8192 at M17 live testing. gpt-5's reasoning tokens are the primary pressure on
// this budget, and a `plan` response asks for materially more of them than a single tool call:
// the model has to decide WHETHER to chain at all against a prompt deliberately weighted toward
// not doing so, then work out step order, then keep to the plan tool's own stated 3-step cap —
// on top of a structurally bigger JSON output (several steps, each its own tool/arguments/
// describe). Confirmed live: six varied attempts at a 4-step chain (already over that cap) all
// exhausted the budget before a complete `plan` tool call ever formed. Never misclassified —
// `finish_reason === "length"` still catches it cleanly as `incomplete`, the same distinct
// outcome the original M9 budget fix produced — but `validatePlan`'s own step-cap refusal was
// never reached, which left that refusal path provably safe from fixtures but genuinely
// unexercised by a real model. Whether 8192 is enough headroom is itself a live-only fact —
// request shaping, not classification, per CLAUDE.md — so this is a considered raise, not a
// proven-sufficient one; re-test live before trusting it.
const CHOOSE_MAX_TOKENS = 8192;

// A JSON string that may not be JSON. Returns null rather than throwing, so the caller can
// report a malformed plan as one — `parsePlan(null)` is already null, so the two failures
// converge on one message without a second branch.
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

// Real LLM client. The planner and handlers only see the LLMClient interface, so tests
// swap in a fake with no network/API key.
export class OpenAILLMClient implements LLMClient {
  private readonly apiKey: string | undefined;
  private client: OpenAI | null = null;

  constructor(apiKey: string | undefined = process.env["OPENAI_API_KEY"]) {
    // Read (but never log) the key. Missing key is surfaced later as a friendly error
    // inside chooseTool/complete, so the app doesn't crash at startup (spec.md §10).
    this.apiKey = apiKey;
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is missing — add it to your .env file.");
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async chooseTool(
    instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    const response = await this.getClient().chat.completions.create({
      model: PLANNER_MODEL,
      // Headroom, not a target: gpt-5 is a reasoning model and its reasoning tokens are
      // spent from THIS budget before any tool call is emitted. At 1024 a long reasoning
      // pass could consume the lot and return no tool call at all, which used to be
      // indistinguishable from the model declining. The model does not spend to fill a
      // cap, so raising it costs nothing on a normal run.
      max_completion_tokens: CHOOSE_MAX_TOKENS,
      messages: [
        { role: "system", content: CHOOSE_SYSTEM },
        { role: "user", content: renderRequest(instruction, context, previousTurn) },
      ],
      // The registry's tools, plus the `plan` meta-tool (M17) — see the note in anthropic.ts
      // for why it is appended here and never added to the registry.
      tools: [...tools, PLAN_TOOL].map((t) => ({
        type: "function",
        // Adapt the vendor-neutral JSONSchema to the SDK's function schema at this boundary.
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as unknown as OpenAI.FunctionParameters,
        },
      })),
      // NOT set to `parallel_tool_calls: false`, unlike the `disable_parallel_tool_use` flag
      // added to the Anthropic client for the same bug. That flag is a plain, stable, documented
      // field there; this SDK's own type docs carry no equivalent reassurance for gpt-5's
      // reasoning-model family, and OpenAI has previously rejected this parameter outright for
      // some reasoning models rather than silently ignoring it. Guessing wrong here would turn
      // a rare silent-drop into every OpenAI-configured install failing every call — strictly
      // worse than the bug being fixed. Left as a live-testable question rather than a guess;
      // the classification fix below closes the actual hole regardless of whether this is ever
      // set.
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const message = choice?.message;

    // Every function-type call the model returned, in order. `type === "function"` narrows the
    // SDK's tool-call union the same way the removed single-call check used to.
    const rawCalls: { name: string; arguments: string }[] = [];
    for (const call of message?.tool_calls ?? []) {
      if (call.type === "function") {
        rawCalls.push({ name: call.function.name, arguments: call.function.arguments });
      }
    }

    // M17 LIVE-TESTING BUG, FIXED: this used to read `tool_calls?.[0]` only, silently dropping
    // any further calls in the same response. See core/llm/toolChoice.ts for the full account
    // and why the fix lives there. Decoding happens HERE, not inside `classifyToolCalls`,
    // because how a decoding FAILURE is handled deliberately differs by call name (see below) —
    // and, with more than one call, decoding is skipped entirely on purpose, so a malformed
    // SECOND call's JSON can never throw before the multi-call refusal is even decided.
    const calls: RawToolCall[] =
      rawCalls.length === 1
        ? [
            {
              name: rawCalls[0]!.name,
              input:
                // Arguments arrive as a JSON STRING here, unlike Anthropic's already-parsed
                // object — so this provider has one failure the other does not: a truncated or
                // malformed string.
                //
                // Only the PLAN path swallows it. On the ORDINARY-tool path `JSON.parse`
                // throwing is the behaviour every milestone since M2 has shipped, and quietly
                // turning it into empty arguments would convert a loud failure into a "missing
                // required information" refusal that names the wrong problem. A malformed plan,
                // by contrast, has a sentence written for exactly this — from where the user
                // sits, "couldn't read the plan" is what happened. Both are UNCHANGED by this
                // fix; only the ">1 calls" case is new.
                rawCalls[0]!.name === PLAN_TOOL_NAME
                  ? safeParse(rawCalls[0]!.arguments)
                  : (JSON.parse(rawCalls[0]!.arguments || "{}") as unknown),
            },
          ]
        : rawCalls.map((call) => ({ name: call.name, input: null }));

    const classified = classifyToolCalls(calls);
    if (classified !== null) return classified;

    // No tool call AND the response was cut off: the model ran out of budget rather than
    // deciding anything. Report it as its own outcome so the planner can say so honestly
    // instead of claiming there is no tool for the job.
    if (choice?.finish_reason === "length") {
      const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens;
      return {
        kind: "incomplete",
        reason:
          `the model hit its ${CHOOSE_MAX_TOKENS}-token limit before choosing a tool` +
          (reasoning ? ` (${reasoning} spent on reasoning)` : ""),
      };
    }

    return { kind: "none", text: message?.content ?? null };
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.getClient().chat.completions.create({
      model: PLANNER_MODEL,
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return (response.choices[0]?.message.content ?? "").trim();
  }
}
