import type { CapturedContext, LLMClient, ToolChoice, ToolSchema } from "../src/core/types.ts";

// Deterministic LLM stand-in for tests. Returns a canned tool choice and a canned
// completion — no network, no API key. Records the tools it was offered so specs can
// assert the registry was passed through.
export class FakeLLM implements LLMClient {
  public lastToolsOffered: ToolSchema[] = [];

  constructor(
    private readonly choice: ToolChoice,
    private readonly completion: string = "",
  ) {}

  chooseTool(
    _instruction: string,
    _context: CapturedContext,
    tools: ToolSchema[],
  ): Promise<ToolChoice> {
    this.lastToolsOffered = tools;
    return Promise.resolve(this.choice);
  }

  complete(_system: string, _user: string): Promise<string> {
    return Promise.resolve(this.completion);
  }
}
