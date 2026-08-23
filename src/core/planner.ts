import type { OSShell } from "../main/shell/OSShell.ts";
import { toToolSchemas } from "./registry.ts";
import { UnresolvedReferenceError } from "./errors.ts";
import { UnavailableSender } from "./senders/SlackSender.ts";
import { UnavailableGmail } from "./gmail/UnavailableGmail.ts";
import { UnavailableNotion } from "./notion/UnavailableNotion.ts";
import { InMemoryDraftStore } from "./draft.ts";
import { needsConfirm, needsNarration, resolveRisk } from "./risk.ts";
import type { DraftStore } from "./draft.ts";
import type {
  ActionLog,
  GmailSurface,
  LLMClient,
  Memory,
  MessageSender,
  NotionSurface,
  PlannerOutcome,
  Tool,
  ToolDeps,
  ToolInput,
} from "./types.ts";

const REFUSAL = "I can't do that yet — I don't have a tool for that.";
const TRUNCATED =
  "I couldn't work out what to do — the model ran out of room before it answered. " +
  "Try a shorter, more direct instruction.";

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
    // Same idea for the browser (M10): a planner built without a configured Chrome cannot
    // reach one. The default explains what to set rather than failing obscurely.
    private readonly gmail: GmailSurface = new UnavailableGmail(),
    // Scratch state for the reply being iterated on. Owned by the planner (one per app run),
    // handed to handlers through ToolDeps like every other dependency.
    private readonly draft: DraftStore = new InMemoryDraftStore(),
    // Same idea again for Notion (M11) — the same Chrome, a second app surface in it.
    private readonly notion: NotionSurface = new UnavailableNotion(),
  ) {}

  async run(instruction: string): Promise<PlannerOutcome> {
    // 1. Capture context from the shell.
    const context = await this.shell.getContext();

    // 2. LLM picks a tool (or declines). The previous turn — the planner's one turn of
    //    state — goes along too, so a bare correction ("no, I meant...") has something to
    //    resolve against instead of routing on the current instruction alone.
    const previousTurn = this.log.getLast();
    const choice = await this.llm.chooseTool(
      instruction,
      context,
      toToolSchemas(this.registry),
      previousTurn,
    );

    // 3. Registry check — declined or hallucinated tool → graceful refusal + log a miss.
    //    A TRUNCATED response is handled separately: the model never decided anything, so
    //    calling it "no tool for that" would be a lie about what happened.
    if (choice.kind === "incomplete") {
      return this.refuseIncomplete(instruction, choice.reason);
    }
    if (choice.kind === "none") {
      return this.refuse(instruction, choice.text);
    }
    const tool = this.registry.find((t) => t.name === choice.name);
    if (!tool) {
      return this.refuse(instruction);
    }

    // 4. Resolve vague argument references via memory — unless the tool declares its args are
    //    literals to store rather than references to look up (memory-writing tools). Declarative,
    //    like the risk gates below: the planner reads a property, it never knows the tool.
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

    // The dependency bundle every gate and the handler share. Built HERE, before the gates,
    // because a GUI action's concrete facts — who this reply would actually go to, what is in
    // the box right now — live in the app being acted on, not in the arguments the model
    // proposed. A confirm dialog that could not read them would be describing a guess.
    const deps: ToolDeps = {
      context,
      llm: this.llm,
      shell: this.shell,
      memory: this.memory,
      sender: this.sender,
      gmail: this.gmail,
      notion: this.notion,
      draft: this.draft,
    };

    // 6. What does THIS call cost? Through M12 the answer was a constant the tool carried, and
    //    the two gates below each read it straight off `tool.risk`. M13 made the tier able to
    //    depend on the arguments (a calendar event with guests emails them; the same event
    //    without guests touches nobody), so it is worked out here instead — after memory
    //    resolution and validation, and with `deps`, because a resolver may have to READ the
    //    world to classify the action (moveEvent has to look up whether the event it would move
    //    has guests). Same rule as the two gates it feeds: SAFE work only.
    //
    //    Resolved ONCE and reused by both gates on purpose. Asking twice would let the two
    //    answers disagree — narrating an action and then not confirming it — which is a hole in
    //    the gate rather than a slow path. A resolver that fails escalates rather than
    //    de-escalates; see resolveRisk in core/risk.ts.
    const tier = await resolveRisk(tool.risk, args, deps);

    // 6a. Narration gate — a `caution` tool runs on its own, but must SAY what it is about to
    //     do first (core/risk.ts). Before M10 nothing needed this, because nothing acted inside
    //     another app; opening someone's reply box has no undo, so the announcement is the
    //     protection. It goes out through the `notify` action the OSShell contract has always
    //     had, which is why narration needed no change to that contract.
    //
    //     M11 widened `narrate` to `(args, deps) => string | Promise<string>` — the same
    //     evolution `confirmSummary` underwent in M10, and for the identical reason: a GUI
    //     action's concrete facts (which Notion page this would write to) live in the app
    //     being acted on, not in the model's arguments. Same failure handling as the confirm
    //     gate below: if the tool cannot even say what it is about to do, nothing runs.
    if (needsNarration(tier) && tool.narrate) {
      let narration: string;
      try {
        narration = await tool.narrate(args, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.fail(instruction, tool.name, args, message);
      }
      await this.shell.executeAction({ kind: "notify", payload: narration });
    }

    // 6b. Confirm gate — a call that resolved to `dangerous` must pass shell.confirm() first.
    //    The summary is built from the RESOLVED args (step 4 ran above) and may READ the world
    //    through deps, so the user always approves the concrete action ("Send to #design-team?",
    //    the actual text sitting in the reply box), never the vague one they typed. Generic: the
    //    planner asks the tool how to describe itself; it never knows which tool.
    if (needsConfirm(tier)) {
      let summary: string;
      try {
        summary = tool.confirmSummary
          ? await tool.confirmSummary(args, deps)
          : `Run ${tool.name}?`;
      } catch (error) {
        // If we cannot even describe what would happen, we certainly do not do it.
        const message = error instanceof Error ? error.message : String(error);
        return this.fail(instruction, tool.name, args, message);
      }
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
      const result = await tool.handler(args, deps);

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

  private refuse(
    instruction: string,
    modelText?: string | null,
  ): PlannerOutcome {
    const shown =
      modelText && modelText.trim().length > 0 ? modelText.trim() : REFUSAL;
    this.log.logMiss(instruction);
    this.shell.showResult(shown);
    return { status: "no_tool", tool: null, result: shown };
  }

  // The model ran out of tokens before answering. Nothing was decided, so nothing runs —
  // but the user is told what actually happened rather than being handed the closed-world
  // refusal, which would send them looking for a capability that isn't the problem.
  //
  // Logged with status "no_tool" (the same row shape logMiss writes) but NOT via logMiss()
  // itself: spec §8 defines the miss list as a ranked backlog of tools worth building, and
  // a token-budget failure is not a missing tool. Same status, same table, reason recorded,
  // backlog uncorrupted.
  private refuseIncomplete(
    instruction: string,
    reason: string,
  ): PlannerOutcome {
    const shown = `${TRUNCATED} (${reason})`;
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool: null,
      arguments: null,
      result: shown,
      status: "no_tool",
    });
    this.shell.showResult(shown);
    return { status: "no_tool", tool: null, result: shown };
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
  return required.filter(
    (key) => args[key] === undefined || args[key] === null,
  );
}
