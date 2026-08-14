import type { OSShell } from "../main/shell/OSShell.ts";
import { toToolSchemas } from "./registry.ts";
import { UnresolvedReferenceError } from "./errors.ts";
import { UnavailableSender } from "./senders/SlackSender.ts";
import type {
  ActionLog,
  LLMClient,
  Memory,
  MessageSender,
  PlannerOutcome,
  Tool,
  ToolInput,
} from "./types.ts";

const REFUSAL = "I can't do that yet — I don't have a tool for that.";

// The planner loop (spec.md §5). It is generic: it never names a specific tool. The LLM
// PROPOSES a tool; the planner DISPOSES — registry check, resolve, validate, confirm gate,
// execute, record. Dependencies are injected so the whole loop runs headless in tests.
export class Planner {
  constructor(
    private readonly llm: LLMClient,
    private readonly shell: OSShell,
    private readonly registry: Tool[],
    private readonly memory: Memory,
    private readonly log: ActionLog,
    // Optional with a safe default: a planner built without a sender cannot send anything.
    private readonly sender: MessageSender = new UnavailableSender(),
  ) {}

  async run(instruction: string): Promise<PlannerOutcome> {
    // 1. Capture context from the shell.
    const context = await this.shell.getContext();

    // 2. LLM picks a tool (or declines).
    const choice = await this.llm.chooseTool(instruction, context, toToolSchemas(this.registry));

    // 3. Registry check — declined or hallucinated tool → graceful refusal + log a miss.
    if (choice.kind === "none") {
      return this.refuse(instruction);
    }
    const tool = this.registry.find((t) => t.name === choice.name);
    if (!tool) {
      return this.refuse(instruction);
    }

    // 4. Resolve vague argument references via memory — unless the tool declares its args are
    //    literals to store rather than references to look up (memory-writing tools). Declarative,
    //    like the irreversible gate below: the planner reads a property, it never knows the tool.
    const args: ToolInput =
      tool.resolvesReferences === false
        ? choice.input
        : await this.memory.resolveArgs(choice.input);

    // 5. Validate — required args present and concrete (generic; no tool-specific logic).
    const missing = missingRequired(tool, args);
    if (missing.length > 0) {
      return this.fail(
        instruction,
        tool.name,
        args,
        `Missing required information: ${missing.join(", ")}.`,
      );
    }

    // 6. Confirm gate — irreversible tools must pass shell.confirm() before running.
    //    The summary is built from the RESOLVED args (step 4 ran above), so the user always
    //    approves the concrete action ("Send to #design-team?"), never the vague one they typed.
    //    Generic: the planner asks the tool how to describe itself; it never knows which tool.
    if (tool.irreversible) {
      const summary = tool.confirmSummary ? tool.confirmSummary(args) : `Run ${tool.name}?`;
      const approved = await this.shell.confirm(summary);
      if (!approved) {
        this.log.logAction({
          ts: new Date().toISOString(),
          instruction,
          tool: tool.name,
          arguments: args,
          result: null,
          status: "cancelled",
        });
        return { status: "cancelled", tool: tool.name, result: null };
      }
    }

    // 7. Execute the handler.
    try {
      const result = await tool.handler(args, {
        context,
        llm: this.llm,
        shell: this.shell,
        memory: this.memory,
        sender: this.sender,
      });

      // 8. Record + show.
      this.log.logAction({
        ts: new Date().toISOString(),
        instruction,
        tool: tool.name,
        arguments: args,
        result,
        status: "ok",
      });
      this.shell.showResult(result);
      return { status: "ok", tool: tool.name, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "I don't know what you mean" is an honest refusal, not a malfunction. Show it as the
      // tool worded it — no "Something went wrong" wrapper — and log it as `refused`.
      // Generic: the planner distinguishes the error TYPE, never the tool.
      if (error instanceof UnresolvedReferenceError) {
        return this.refuseUnresolved(instruction, tool.name, args, message);
      }
      return this.fail(instruction, tool.name, args, message);
    }
  }

  private refuse(instruction: string): PlannerOutcome {
    this.log.logMiss(instruction);
    this.shell.showResult(REFUSAL);
    return { status: "no_tool", tool: null, result: REFUSAL };
  }

  // An unresolved reference: the request was understood, we just don't know the fact yet.
  private refuseUnresolved(
    instruction: string,
    tool: string,
    args: ToolInput,
    message: string,
  ): PlannerOutcome {
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool,
      arguments: args,
      result: message,
      status: "refused",
    });
    this.shell.showResult(message); // verbatim — the tool already phrased it for a human
    return { status: "refused", tool, result: message };
  }

  private fail(
    instruction: string,
    tool: string,
    args: ToolInput,
    message: string,
  ): PlannerOutcome {
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool,
      arguments: args,
      result: message,
      status: "error",
    });
    const shown = `Something went wrong: ${message}`;
    this.shell.showResult(shown);
    return { status: "error", tool, result: message };
  }
}

// Generic required-argument check driven by each tool's own inputSchema.
function missingRequired(tool: Tool, args: ToolInput): string[] {
  const required = tool.inputSchema.required ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}
