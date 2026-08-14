import Anthropic from "@anthropic-ai/sdk";
import type { CapturedContext, LLMClient, ToolChoice, ToolInput, ToolSchema } from "./types.ts";

// Planner model — pinned by spec.md §3. Do not substitute without asking.
const PLANNER_MODEL = "claude-sonnet-4-6";

// System prompt for the tool-choice call. The registry's descriptions/schemas do the
// real routing work; this just frames the job.
const CHOOSE_SYSTEM = [
  "You are the planner for a desktop assistant.",
  "Pick exactly one tool from the provided tools that best fulfills the user's instruction,",
  "given the on-screen context. If no tool fits, do not call a tool — reply with a short",
  "explanation instead. Never invent a tool that is not in the list.",
].join(" ");

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
  ): Promise<ToolChoice> {
    const response = await this.getClient().messages.create({
      model: PLANNER_MODEL,
      max_tokens: 1024,
      system: CHOOSE_SYSTEM,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Adapt the vendor-neutral JSONSchema to the SDK's InputSchema at this boundary.
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: renderRequest(instruction, context) }],
    });

    for (const block of response.content) {
      if (block.type === "tool_use") {
        return { kind: "tool", name: block.name, input: (block.input ?? {}) as ToolInput };
      }
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

// Serialize the instruction + captured context into the user message.
function renderRequest(instruction: string, context: CapturedContext): string {
  const parts = [`Instruction: ${instruction}`];
  if (context.selectedText) {
    parts.push(`\nSelected text (clipboard):\n${context.selectedText}`);
  }
  if (context.activeWindowTitle) {
    parts.push(`\nActive window: ${context.activeWindowTitle}`);
  }
  return parts.join("\n");
}

// Concatenate all text blocks of a response into a single string.
function joinText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
