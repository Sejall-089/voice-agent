import OpenAI from "openai";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  ToolChoice,
  ToolInput,
  ToolSchema,
} from "./types.ts";

// Planner model — pinned by spec.md §3. Do not substitute without asking.
const PLANNER_MODEL = "gpt-5";

// System prompt for the tool-choice call. The registry's descriptions/schemas do the
// real routing work; this just frames the job.
const CHOOSE_SYSTEM = [
  "You are the planner for a desktop assistant.",
  "Pick exactly one tool from the provided tools that best fulfills the user's instruction,",
  "given the on-screen context. If no tool fits, do not call a tool — reply with a short",
  "explanation instead. Never invent a tool that is not in the list.",
  "You may also be shown the previous turn (the last instruction, tool, and result). Use it",
  "ONLY to resolve a correction or a pronoun reference in the CURRENT instruction ('no, I",
  "meant...', 'actually...', 'that's wrong'). Otherwise ignore it and treat the current",
  "instruction as an independent request.",
].join(" ");

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

// Serialize the instruction + captured context (+ previous turn, if any) into the user message.
function renderRequest(
  instruction: string,
  context: CapturedContext,
  previousTurn: ActionLogEntry | null,
): string {
  const parts: string[] = [];
  if (previousTurn) {
    parts.push(`${renderPreviousTurn(previousTurn)}\n`);
  }
  parts.push(`Instruction: ${instruction}`);
  if (context.selectedText) {
    parts.push(`\nSelected text (clipboard):\n${context.selectedText}`);
  }
  if (context.activeWindowTitle) {
    parts.push(`\nActive window: ${context.activeWindowTitle}`);
  }
  return parts.join("\n");
}

// A short, bounded description of the previous turn — enough to resolve a correction,
// not so much that one verbose prior result balloons every subsequent prompt.
function renderPreviousTurn(entry: ActionLogEntry): string {
  const toolPart = entry.tool ? `called \`${entry.tool}\`` : "found no matching tool";
  const argsPart = entry.arguments ? ` with ${JSON.stringify(entry.arguments)}` : "";
  const resultPart = entry.result ? ` → ${preview(entry.result)}` : "";
  return (
    `Previous turn (for resolving corrections/pronouns only — otherwise ignore):\n` +
    `Instruction: "${entry.instruction}" — ${toolPart}${argsPart}${resultPart}`
  );
}

function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
