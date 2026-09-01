import OpenAI from "openai";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  ToolChoice,
  ToolInput,
  ToolSchema,
} from "../types.ts";
import { CHOOSE_SYSTEM, renderRequest } from "./prompt.ts";
import { PLAN_TOOL, PLAN_TOOL_NAME, PLAN_UNREADABLE, parsePlan } from "./plan.ts";

// Model for this provider (spec.md §3). Provider itself is chosen via LLM_PROVIDER —
// see factory.ts.
const PLANNER_MODEL = "gpt-5";

// Reasoning tokens come out of the same allowance as the tool call itself (§3a).
const CHOOSE_MAX_TOKENS = 4096;

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
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const message = choice?.message;
    const call = message?.tool_calls?.[0];
    if (call && call.type === "function") {
      // Arguments arrive as a JSON STRING here, unlike Anthropic's already-parsed object — so
      // this provider has one failure the other does not: a truncated or malformed string.
      //
      // Only the PLAN path swallows it. On the single-tool path `JSON.parse` throwing is the
      // behaviour every milestone since M2 has shipped, and quietly turning it into empty
      // arguments would convert a loud failure into a "missing required information" refusal
      // that names the wrong problem. A malformed plan, by contrast, has a sentence written for
      // exactly this — from where the user sits, "couldn't read the plan" is what happened.
      if (call.function.name === PLAN_TOOL_NAME) {
        const steps = parsePlan(safeParse(call.function.arguments));
        return steps === null
          ? { kind: "none", text: PLAN_UNREADABLE }
          : { kind: "plan", steps };
      }
      return { kind: "tool", name: call.function.name, input: JSON.parse(call.function.arguments || "{}") as ToolInput };
    }

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
