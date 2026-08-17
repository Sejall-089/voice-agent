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

// Model for this provider (spec.md §3). Provider itself is chosen via LLM_PROVIDER —
// see factory.ts.
const PLANNER_MODEL = "gpt-5";

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
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: CHOOSE_SYSTEM },
        { role: "user", content: renderRequest(instruction, context, previousTurn) },
      ],
      tools: tools.map((t) => ({
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

    const message = response.choices[0]?.message;
    const call = message?.tool_calls?.[0];
    if (call && call.type === "function") {
      return { kind: "tool", name: call.function.name, input: JSON.parse(call.function.arguments || "{}") as ToolInput };
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
