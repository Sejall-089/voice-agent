import type { OSShell } from "../main/shell/OSShell.ts";
import { toToolSchemas } from "./registry.ts";
import { UserFixableError } from "./errors.ts";
import { UnavailableSender } from "./senders/SlackSender.ts";
import { UnavailableGmail } from "./gmail/UnavailableGmail.ts";
import { UnavailableNotion } from "./notion/UnavailableNotion.ts";
import { UnavailableCalendar } from "./calendar/UnavailableCalendar.ts";
import { UnavailableScreen } from "./screen/UnavailableScreen.ts";
import { UnavailableElements } from "./screen/UnavailableElements.ts";
import { UnavailableChooser } from "./screen/UnavailableChooser.ts";
import { InMemoryDraftStore } from "./draft.ts";
import { InMemorySpeechStore } from "./speechStore.ts";
import { needsConfirm, needsNarration, resolveRisk } from "./risk.ts";
import { toSpokenConfirm, toSpokenNarration, toSpokenResult } from "./speech.ts";
import {
  previewHoldRemaining,
  previewPlan,
  resolveStepArgs,
  spokenPlan,
  stoppedMessage,
  validatePlan,
} from "./chain.ts";
import { InMemoryChainState } from "./chainState.ts";
import type { ChainState } from "./chainState.ts";
import type { DraftStore } from "./draft.ts";
import type { SpokenText } from "./speech.ts";
import type { SpeechStore } from "./speechStore.ts";
import type {
  ActionLog,
  ActionStatus,
  CalendarSurface,
  CapturedContext,
  GmailSurface,
  LLMClient,
  Memory,
  MessageSender,
  NotionSurface,
  PlannedStep,
  PlannerOutcome,
  ScreenSurface,
  ElementSurface,
  ElementChooser,
  Tool,
  ToolDeps,
  ToolInput,
} from "./types.ts";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REFUSAL = "I can't do that yet — I don't have a tool for that.";
const TRUNCATED =
  "I couldn't work out what to do — the model ran out of room before it answered. " +
  "Try a shorter, more direct instruction.";
// What a cancelled step contributes as a stop reason. The `cancelled` outcome carries no
// message of its own (there is nothing to explain — the user just said no), but a chain still
// has to account for the steps that consequently did not run.
const DECLINED = "You didn't approve that, so I stopped there.";

// Where one call sits, and therefore how it reports itself (M17). A single instruction and a
// step inside a chain run the SAME code; this is the whole of the difference between them.
interface StepPosition {
  // Prefixed to the narration and the confirm summary. Empty outside a chain.
  label: string;
  // Say the result out loud? False for a chain's intermediate steps — see `runStep`.
  speak: boolean;
  // Show and speak a FAILURE here? False inside a chain, where `runChain` composes one message
  // about the whole plan instead of letting the tool's refusal and the accounting arrive as two.
  report: boolean;
}

// The shape every milestone before M17 had, and the shape a lone instruction still has.
const SINGLE: StepPosition = { label: "", speak: true, report: true };

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
    // And again for the calendar (M13) — not a browser this time, an API. The default rejects
    // with a NAMED auth failure rather than a bare error, so "not connected" reads as something
    // to fix rather than something broken.
    private readonly calendar: CalendarSurface = new UnavailableCalendar(),
    // M14. Scratch state again, like `draft`: what the app held back the last time it spoke a
    // summary rather than the whole thing, so an "and the rest?" follow-up has something to
    // answer from. One per app run, in memory only.
    private readonly speech: SpeechStore = new InMemorySpeechStore(),
    // M15/M16. The screen surface — the overlay, and the display lookup that feeds the
    // coordinate conversion. Same rule as every surface above: an unavailable default means a
    // tool can never reach a screen this install was not configured for.
    private readonly screen: ScreenSurface = new UnavailableScreen(),
    // M16. Reading a window's controls and asking a model which one was meant fail differently
    // and are fixed differently, so they are two parameters rather than one bundle — the same
    // split every surface pair above uses.
    private readonly elements: ElementSurface = new UnavailableElements(),
    private readonly chooser: ElementChooser = new UnavailableChooser(),
    // M16. The settle loop's delay, injected so it is a dependency rather than a wall-clock
    // fact. Tests pass one that resolves immediately.
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    // M17. Whether a chain is running, and where it has got to. Injected rather than owned
    // outright because the HOTKEY HANDLERS read it — main.ts hands the same instance to the
    // planner and to both guards, which is the only way a handler outside this class can know
    // that a `run()` is partway through a sequence. See core/chainState.ts.
    private readonly chain: ChainState = new InMemoryChainState(),
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
      return await this.refuseIncomplete(instruction, choice.reason);
    }
    if (choice.kind === "none") {
      return await this.refuse(instruction, choice.text);
    }
    // 3a. A chained plan (M17). Its own branch, and everything below step 3 is shared with it:
    //     `runChain` calls the SAME `runStep` this path does, once per step, so a step inside a
    //     chain goes through memory resolution, validation, tier resolution and both gates in
    //     exactly the order a lone instruction does. There is deliberately no second
    //     implementation of the gate for chains to drift away from.
    if (choice.kind === "plan") {
      return await this.runChain(instruction, choice.steps, context);
    }
    const tool = this.registry.find((t) => t.name === choice.name);
    if (!tool) {
      return await this.refuse(instruction);
    }

    return await this.runStep(instruction, tool, choice.input, context, SINGLE);
  }

  // ONE step: everything from memory resolution to the recorded outcome. Extracted at M17 so a
  // chain runs the identical code a single instruction does — see `runChain`.
  //
  // `step` says where this call sits. `SINGLE` is the shape every milestone before M17 had, and
  // it must stay behaviourally identical: no prefix, the result is spoken, and a failure is
  // shown and said here. Inside a chain the reporting moves out to `runChain`, which has to
  // compose one message about the whole plan rather than emitting two about the same event.
  private async runStep(
    instruction: string,
    tool: Tool,
    proposed: ToolInput,
    context: CapturedContext,
    step: StepPosition,
  ): Promise<PlannerOutcome> {
    // 4. Resolve vague argument references via memory — unless the tool declares its args are
    //    literals to store rather than references to look up (memory-writing tools). Declarative,
    //    like the risk gates below: the planner reads a property, it never knows the tool.
    const args: ToolInput =
      tool.resolvesReferences === false
        ? proposed
        : await this.memory.resolveArgs(proposed);

    // 5. Validate — required args present and concrete (generic; no tool-specific logic).
    const missing = missingRequired(tool, args);
    if (missing.length > 0) {
      return await this.fail(
        instruction,
        tool.name,
        args,
        `Missing required information: ${missing.join(", ")}.`,
        step.report,
      );
    }

    // The dependency bundle every gate and the handler share. Built HERE, before the gates,
    // because a GUI action's concrete facts — who this reply would actually go to, what is in
    // the box right now — live in the app being acted on, not in the arguments the model
    // proposed. A confirm dialog that could not read them would be describing a guess.
    // `tier: null` here is not a placeholder — it is the truth for the one caller that sees it.
    // A `RiskPolicy` resolver is what DECIDES the tier, so it necessarily runs before there is
    // one, and must not be able to read a stale answer while deciding.
    const classifying: ToolDeps = {
      context,
      llm: this.llm,
      shell: this.shell,
      memory: this.memory,
      sender: this.sender,
      gmail: this.gmail,
      notion: this.notion,
      draft: this.draft,
      calendar: this.calendar,
      speech: this.speech,
      screen: this.screen,
      elements: this.elements,
      chooser: this.chooser,
      sleep: this.sleep,
      tier: null,
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
    const tier = await resolveRisk(tool.risk, args, classifying);

    // Everything downstream of the decision is told what it was. A handler whose tier was
    // decided by reading the world needs this to notice the world moving under it between the
    // classification and the act.
    const deps: ToolDeps = { ...classifying, tier };

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
        return await this.failOrRefuse(instruction, tool.name, args, error, step.report);
      }
      // Prefixed inside a chain ("Step 2 of 3: "). The status line is a single slot, so without
      // it the plan preview is replaced by a narration with no indication of where in the plan
      // it belongs — and a chain's whole premise is that the user can follow along.
      const announced = `${step.label}${narration}`;
      await this.shell.executeAction({ kind: "notify", payload: announced });
      await this.say(toSpokenNarration(announced));
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
        return await this.failOrRefuse(instruction, tool.name, args, error, step.report);
      }
      // Prefixed inside a chain, like the narration above and for a sharper reason: a confirm
      // dialog that appears with no warning partway through a plan is the single most confusing
      // moment this feature can produce. The prefix goes in FRONT, which keeps the decisive
      // fact ("Send this reply to...") in the first paragraph that toSpokenConfirm speaks.
      const asked = `${step.label}${summary}`;
      // Before the dialog, deliberately. Once showMessageBox is up it owns the user's
      // attention, and a question asked after the thing it is about has appeared is not a
      // question. Only the first paragraph is spoken — never the draft body (core/speech.ts).
      await this.say(toSpokenConfirm(asked));

      const approved = await this.shell.confirm(asked);
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
      // Worked out BEFORE the result is shown, so a tool whose speakResult throws fails the
      // run rather than leaving the screen and the voice disagreeing about what happened.
      const spoken = tool.speakResult
        ? await tool.speakResult(result, args, deps)
        : toSpokenResult(result);

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
      // SPOKEN ONLY WHEN IT IS THE ANSWER. Inside a chain the intermediate steps are shown but
      // not said: mid-chain the app is working rather than answering, and `toSpokenResult`'s
      // "want me to read the rest?" offer would be a lie when the hotkey that would answer it
      // is deliberately blocked for the duration of the chain.
      //
      // `spoken` is still COMPUTED above for every step, and that is not waste — it preserves
      // the invariant that a tool whose `speakResult` throws fails the step rather than leaving
      // the screen and the voice disagreeing. Skipping `say` also leaves the SpeechStore alone,
      // so an "and the rest?" after the chain refers to the chain's actual answer.
      if (step.speak) await this.say(spoken);
      return { status: "ok", tool: tool.name, result };
    } catch (error) {
      return await this.failOrRefuse(instruction, tool.name, args, error, step.report);
    }
  }

  // A chained plan (M17): one planning call, a fixed sequence, deterministic execution.
  //
  // The model is NOT consulted again from here. Everything below is code deciding what may run
  // and what the user is told — which is the line between this milestone and the agent loop that
  // comes after it.
  private async runChain(
    instruction: string,
    steps: readonly PlannedStep[],
    context: CapturedContext,
  ): Promise<PlannerOutcome> {
    // Everything structurally knowable is settled BEFORE the plan is narrated. Announcing a
    // plan and then dying on step 2 because step 2 named a tool that does not exist would have
    // told the user something untrue at the one moment they were counting on it.
    const check = validatePlan(steps, toToolSchemas(this.registry));
    if (!check.ok) {
      return await this.refusePlan(instruction, steps.length, check.reason);
    }

    // A one-step "plan". The prompt tells the model not to do this twice over, but if it does,
    // running it as an ordinary single call is better than narrating "One step:" at someone —
    // and it cannot carry a placeholder, because validation refuses a step referring to itself.
    const only = steps.length === 1 ? steps[0] : undefined;
    if (only !== undefined) {
      const tool = this.registry.find((t) => t.name === only.tool);
      // Validation established this; the check is for the type system, not for the world.
      if (tool === undefined) return await this.refuse(instruction);
      return await this.runStep(instruction, tool, only.arguments, context, SINGLE);
    }

    // Set before the first await, so "a chain is running" and "the hotkey guards know" can
    // never be observed in different states — WindowsShell.confirm()'s own rule for
    // `confirmPending`, applied to the flag that has to hold for very much longer.
    this.chain.begin(steps.length);
    try {
      // Decision 2: the whole plan, up front, for transparency. NOT approval — the gates still
      // fire per step, on real arguments, when execution reaches them.
      const previewShownAt = Date.now();
      await this.shell.executeAction({ kind: "notify", payload: previewPlan(steps) });
      await this.say(toSpokenNarration(spokenPlan(steps)));

      // LIVE-TESTING FIX: hold the preview on screen for a minimum read time before step 1 may
      // replace it. Without this, a chain whose steps all finish fast (no real waiting between
      // them) let step 1's own narration or result overwrite the preview in well under a
      // second — readable on a screen only if you already knew what it was going to say. The
      // wait is ADAPTIVE (core/chain.ts's `previewHoldRemaining`): it only makes up whatever is
      // left of MIN_PREVIEW_HOLD_MS, so a step 1 that is already slow for a real reason is never
      // delayed further. Speech is unaffected either way — see MIN_PREVIEW_HOLD_MS's own note
      // for why the spoken side never had this bug.
      const holdRemaining = previewHoldRemaining(previewShownAt, Date.now());
      if (holdRemaining > 0) await this.sleep(holdRemaining);

      // The results of the steps that have run, in order. A LOCAL, deliberately: nothing
      // outside this loop has any business reading them, and a store would let one chain's
      // output reach the next one (core/chainState.ts).
      const results: string[] = [];

      for (const [index, step] of steps.entries()) {
        this.chain.step(index + 1);
        const tool = this.registry.find((t) => t.name === step.tool);
        if (tool === undefined) return await this.refuse(instruction);

        // Substituted HERE — after the earlier steps have actually run, and before this step's
        // own gate. The confirm dialog therefore describes the real argument, never a
        // placeholder and never a guess at what an earlier step would produce.
        const resolved = resolveStepArgs(step.arguments, results);
        if (!resolved.ok) {
          // No step ran, so nothing has logged this: record it before reporting it.
          this.log.logAction({
            ts: new Date().toISOString(),
            instruction,
            tool: step.tool,
            arguments: step.arguments,
            result: resolved.reason,
            status: "refused",
          });
          return await this.stopChain(steps, index, resolved.reason, "refused", step.tool);
        }

        const position: StepPosition = {
          label: `Step ${index + 1} of ${steps.length}: `,
          speak: index === steps.length - 1,
          report: false,
        };
        const outcome = await this.runStep(
          instruction,
          tool,
          resolved.args,
          context,
          position,
        );

        // STOP ON REFUSAL, never partial silent continuation (decision 5). Anything that is not
        // a clean success ends the chain where it stands — a tool's own refusal, a zero-match,
        // a cancelled confirm, a thrown error. The step has already logged itself.
        if (outcome.status !== "ok") {
          const reason = outcome.result ?? DECLINED;
          return await this.stopChain(steps, index, reason, outcome.status, tool.name);
        }
        results.push(outcome.result ?? "");
      }

      // The last step's result is already on screen and already spoken — it IS the answer, so
      // there is nothing further to announce. What the outcome adds is the accounting, for the
      // one line of ground truth in runInstruction.ts.
      const last = steps[steps.length - 1];
      return {
        status: "ok",
        tool: last?.tool ?? null,
        result: results[results.length - 1] ?? null,
        chain: { completed: steps.length, total: steps.length },
      };
    } finally {
      // In the `finally`, not after: a chain that THREW must not leave the hotkeys blocked
      // forever with nothing running. Same reasoning as confirm()'s own finally.
      this.chain.end();
    }
  }

  // The plan itself could not run — too many steps, a tool that isn't on the menu, a reference
  // pointing forwards. Nothing has happened and nothing was announced.
  //
  // Logged as `refused` with no tool, and deliberately NOT through `logMiss`: spec §8 defines
  // the miss list as a ranked backlog of tools worth building, and "that was four steps" is not
  // a missing tool. Same status, same table, backlog uncorrupted — the precedent
  // `refuseIncomplete` set for exactly this reason.
  private async refusePlan(
    instruction: string,
    total: number,
    reason: string,
  ): Promise<PlannerOutcome> {
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool: null,
      arguments: null,
      result: reason,
      status: "refused",
    });
    this.shell.showResult(reason);
    await this.say(toSpokenResult(reason));
    return {
      status: "refused",
      tool: null,
      result: reason,
      chain: { completed: 0, total },
    };
  }

  // A chain that stopped partway. ONE message, composed here rather than left to the step —
  // which is why a step inside a chain runs with `report: false`. The tool's own words lead;
  // the accounting of what did and didn't run follows in the same paragraph (core/chain.ts).
  private async stopChain(
    steps: readonly PlannedStep[],
    stoppedAt: number,
    reason: string,
    status: ActionStatus,
    tool: string,
  ): Promise<PlannerOutcome> {
    const message = stoppedMessage(steps, stoppedAt, reason);
    this.shell.showResult(message);
    await this.say(toSpokenResult(message));
    return {
      status,
      tool,
      result: message,
      chain: { completed: stoppedAt, total: steps.length },
    };
  }

  // Say it, and remember anything held back so "read them out" has an answer (M14).
  //
  // Empty text is SILENCE, not an utterance: the real engine exits non-zero on it, so emitting
  // the action anyway would turn "there was nothing to say" into an error in the log. The
  // remainder is stored even when it will never be asked for — it costs one assignment, and the
  // alternative is the planner guessing at what the user is about to say next.
  private async say(spoken: SpokenText): Promise<void> {
    if (spoken.remainder !== null) this.speech.hold(spoken.remainder);
    else this.speech.clear();

    if (spoken.text.trim().length === 0) return;
    await this.shell.executeAction({ kind: "speak", payload: spoken.text });
  }

  // Is this a malfunction, or a state of the world the user can change?
  //
  // "I don't know what you mean" and "I'm not connected to your calendar yet" are honest
  // refusals, not breakages: they get shown exactly as the tool worded them — no "Something
  // went wrong" wrapper — and logged as `refused`. Generic, and deliberately so: the planner
  // distinguishes the error TYPE (`UserFixableError`), never the tool that threw it.
  //
  // M10 did this for `UnresolvedReferenceError` alone, in one place — the handler's catch.
  // M13 widened it on both axes: any `UserFixableError`, from any of the three places a tool
  // can now fail. A calendar that isn't connected fails at NARRATION, before a handler is ever
  // reached, and telling someone "something went wrong" when the answer is "paste a token into
  // .env" would send them debugging the wrong thing.
  //
  // `report` is M17's one addition: false inside a chain, where the failure is not the whole
  // story and `runChain` composes a single message that leads with this same text. The
  // classification and the LOG ROW are unchanged either way — what a chain suppresses is the
  // duplicate announcement, never the record.
  private async failOrRefuse(
    instruction: string,
    tool: string,
    args: ToolInput,
    error: unknown,
    report = true,
  ): Promise<PlannerOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UserFixableError) {
      return await this.refuseUserFixable(instruction, tool, args, message, report);
    }
    return await this.fail(instruction, tool, args, message, report);
  }

  private async refuse(
    instruction: string,
    modelText?: string | null,
  ): Promise<PlannerOutcome> {
    const shown =
      modelText && modelText.trim().length > 0 ? modelText.trim() : REFUSAL;
    this.log.logMiss(instruction);
    this.shell.showResult(shown);
    await this.say(toSpokenResult(shown));
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
  private async refuseIncomplete(
    instruction: string,
    reason: string,
  ): Promise<PlannerOutcome> {
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
    await this.say(toSpokenResult(shown));
    return { status: "no_tool", tool: null, result: shown };
  }

  // The request was understood; something about the world stops it. The message is the tool's
  // own, because the tool is the only thing that knows what would fix it.
  private async refuseUserFixable(
    instruction: string,
    tool: string,
    args: ToolInput,
    message: string,
    report = true,
  ): Promise<PlannerOutcome> {
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool,
      arguments: args,
      result: message,
      status: "refused",
    });
    if (report) {
      this.shell.showResult(message); // verbatim — the tool already phrased it for a human
      await this.say(toSpokenResult(message));
    }
    return { status: "refused", tool, result: message };
  }

  private async fail(
    instruction: string,
    tool: string,
    args: ToolInput,
    message: string,
    report = true,
  ): Promise<PlannerOutcome> {
    this.log.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool,
      arguments: args,
      result: message,
      status: "error",
    });
    const shown = `Something went wrong: ${message}`;
    if (report) {
      this.shell.showResult(shown);
      await this.say(toSpokenResult(shown));
    }
    // The CHAIN gets the wrapped sentence too, not the bare message: `stoppedMessage` leads with
    // whatever it is handed, and "Something went wrong: ..." is what a person needs to see.
    return { status: "error", tool, result: report ? message : shown };
  }
}

// Generic required-argument check driven by each tool's own inputSchema.
function missingRequired(tool: Tool, args: ToolInput): string[] {
  const required = tool.inputSchema.required ?? [];
  return required.filter(
    (key) => args[key] === undefined || args[key] === null,
  );
}
