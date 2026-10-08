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
  // What the last complete() call was actually asked. M10 needs it: the difference between
  // "revise this draft" and "answer this email again" is visible only in the prompt.
  public lastSystemPrompt: string | null = null;
  public lastUserPrompt: string | null = null;
  // The context the planner handed over (M19) — what the model was TOLD about the world.
  public lastContext: CapturedContext | null = null;
  // How many times each half was asked (M19). "The model is consulted ONCE for a chain" and
  // "nothing is rewritten by a model on its way out" are both claims about a count.
  public chooseCalls = 0;
  public completeCalls = 0;

  constructor(
    private readonly choice: ToolChoice,
    private readonly completion: string = "",
  ) {}

  chooseTool(
    _instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    this.chooseCalls += 1;
    this.lastToolsOffered = tools;
    this.lastContext = context;
    this.lastPreviousTurnOffered = previousTurn;
    return Promise.resolve(this.choice);
  }

  complete(system: string, user: string): Promise<string> {
    this.completeCalls += 1;
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    return Promise.resolve(this.completion);
  }
}
