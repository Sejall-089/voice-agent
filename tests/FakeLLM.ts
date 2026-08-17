import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  ToolChoice,
  ToolSchema,
} from "../src/core/types.ts";

// Deterministic LLM stand-in for tests. Returns a canned tool choice and a canned
// completion — no network, no API key. Records the tools (and previous turn) it was
// offered so specs can assert the registry — and the planner's one turn of state — were
// passed through.
export class FakeLLM implements LLMClient {
  public lastToolsOffered: ToolSchema[] = [];
  public lastPreviousTurnOffered: ActionLogEntry | null = null;

  constructor(
    private readonly choice: ToolChoice,
    private readonly completion: string = "",
  ) {}

  chooseTool(
    _instruction: string,
    _context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    this.lastToolsOffered = tools;
    this.lastPreviousTurnOffered = previousTurn;
    return Promise.resolve(this.choice);
  }

  complete(_system: string, _user: string): Promise<string> {
    return Promise.resolve(this.completion);
  }
}
