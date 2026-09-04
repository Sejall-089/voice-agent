import Anthropic from "@anthropic-ai/sdk";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  ToolChoice,
  ToolSchema,
} from "../types.ts";
import { CHOOSE_SYSTEM, renderRequest } from "./prompt.ts";
import { PLAN_TOOL } from "./plan.ts";
import { classifyToolCalls } from "./toolChoice.ts";

// Model for this provider (spec.md §3). Provider itself is chosen via LLM_PROVIDER —
// see factory.ts.
const PLANNER_MODEL = "claude-sonnet-4-6";

// Headroom for any preamble the model writes before the tool_use block (§3a). A cap the
// model does not reach costs nothing.
const CHOOSE_MAX_TOKENS = 4096;

// Real LLM client. The planner and handlers only see the LLMClient interface, so tests
// swap in a fake with no network/API key.
export class AnthropicLLMClient implements LLMClient {
  private readonly apiKey: string | undefined;
  private client: Anthropic | null = null;

  constructor(apiKey: string | undefined = process.env["ANTHROPIC_API_KEY"]) {
    // Read (but never log) the key. Missing key is surfaced later as a friendly error
    // inside chooseTool/complete, so the app doesn't crash at startup (spec.md §10).
    this.apiKey = apiKey;
  }

  private getClient(): Anthropic {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is missing — add it to your .env file.");
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async chooseTool(
    instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    const response = await this.getClient().messages.create({
      model: PLANNER_MODEL,
      max_tokens: CHOOSE_MAX_TOKENS,
      system: CHOOSE_SYSTEM,
      // The registry's tools, plus the `plan` meta-tool (M17). Appended HERE rather than in the
      // registry because it has no handler and no risk tier — keeping it out of `registry` is
      // what stops `plan` ever resolving as a step inside a plan.
      tools: [...tools, PLAN_TOOL].map((t) => ({
        name: t.name,
        description: t.description,
        // Adapt the vendor-neutral JSONSchema to the SDK's InputSchema at this boundary.
        input_schema: t.inputSchema as unknown as Anthropic.Tool.InputSchema,
      })),
      tool_choice: {
        type: "auto",
        // Ask the API not to hand back more than one tool_use block at all. A model that
        // decides several things at once should use `plan`, not native parallel tool use — and
        // this is a request-level ask, not a guarantee (a model can still name a bogus tool
        // INSIDE a `plan` step, which `core/chain.ts`'s `validatePlan` already catches). The
        // `classifyToolCalls` check below is what actually enforces the contract regardless of
        // whether the API honours this flag.
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: renderRequest(instruction, context, previousTurn) }],
    });

    // M17 LIVE-TESTING BUG, FIXED: this used to `return` on the FIRST tool_use block found,
    // silently discarding any further blocks in the same response. A model that answered with a
    // real tool call ALONGSIDE something else — a hallucinated wrapper, or a genuine second
    // parallel call `disable_parallel_tool_use` didn't prevent — had the extra call vanish with
    // no refusal, no narration, no log line: the first tool ran, and the run just ended. See
    // core/llm/toolChoice.ts for the fix and why it lives there rather than here.
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
    );
    const classified = classifyToolCalls(
      toolUseBlocks.map((block) => ({ name: block.name, input: block.input ?? {} })),
    );
    if (classified !== null) return classified;

    // Truncated before it got to a tool_use block — a budget failure, not a decision.
    // Same distinction as the OpenAI client; the planner treats both identically.
    if (response.stop_reason === "max_tokens") {
      return {
        kind: "incomplete",
        reason: `the model hit its ${CHOOSE_MAX_TOKENS}-token limit before choosing a tool`,
      };
    }

    return { kind: "none", text: joinText(response.content) };
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.getClient().messages.create({
      model: PLANNER_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });
    return joinText(response.content);
  }
}

// Concatenate all text blocks of a response into a single string.
function joinText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
