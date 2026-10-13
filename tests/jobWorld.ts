import { InMemoryActionLog } from "../src/core/actionLog.ts";
import type { ChainState } from "../src/core/chainState.ts";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { captureContext, Planner } from "../src/core/planner.ts";
import { InMemorySpeechStore } from "../src/core/speechStore.ts";
import type {
  ActionLogEntry,
  CapturedContext,
  LLMClient,
  Memory,
  Tool,
  ToolChoice,
  ToolSchema,
} from "../src/core/types.ts";
import { createJobRunner } from "../src/main/jobs/JobRunner.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { MockShellOptions } from "../src/main/shell/MockShell.ts";

// A whole job system in one process, for the M23 tests: the REAL JobManager, JobRunner,
// Planner, gate, facades and confirm queue, over MockShell. Only three things are stand-ins,
// and each is written to be no more lenient than what it replaces:
//
//   the model     answers by instruction from a script, on a LATER TICK (the real one is a
//                 network call; a synchronous fake could only test call order — CLAUDE.md).
//   the shell     MockShell, with a clipboard a test can CHANGE after submission.
//   Gmail         one boolean, which a test can also change.

// The model's answer for each instruction. An instruction with no entry throws, the way an
// unreachable model does.
export class ScriptedLLM implements LLMClient {
  public chooseCalls = 0;
  public previousTurns: (ActionLogEntry | null)[] = [];
  public contexts: CapturedContext[] = [];
  public menus: ToolSchema[][] = [];

  constructor(private readonly script: Readonly<Record<string, ToolChoice>>) {}

  async chooseTool(
    instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice> {
    this.chooseCalls += 1;
    this.contexts.push(context);
    this.previousTurns.push(previousTurn);
    this.menus.push(tools);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const choice = this.script[instruction];
    if (choice === undefined) throw new Error("model unreachable");
    return choice;
  }

  complete(): Promise<string> {
    return Promise.resolve("");
  }
}

// MockShell with a clipboard that can move, and a count of how often it was read.
export class LiveClipboardShell extends MockShell {
  public clipboard: string | null;
  public contextReads = 0;

  constructor(options: Omit<MockShellOptions, "context"> & { clipboard?: string | null }) {
    super({ ...options, context: { selectedText: null, activeApp: null, activeWindowTitle: null } });
    this.clipboard = options.clipboard ?? null;
  }

  override getContext(): Promise<CapturedContext> {
    this.contextReads += 1;
    return Promise.resolve({
      selectedText: this.clipboard,
      activeApp: null,
      activeWindowTitle: null,
    });
  }
}

// Let everything that is ready to run, run. Several turns of the timer queue, because a job
// crosses the model's tick, the chain's preview and the gate before it settles somewhere.
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// A handle on a promise a test resolves by hand — how a handler is held "mid-step".
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface WorldOptions {
  script: Readonly<Record<string, ToolChoice>>;
  tools: Tool[];
  shell?: Omit<MockShellOptions, "context"> & { clipboard?: string | null };
  maxRunning?: number;
  memory?: Memory;
}

export function jobWorld(options: WorldOptions) {
  const clock = { now: 5_000_000 };
  const shell = new LiveClipboardShell(options.shell ?? {});
  const gmail = { emailOpen: false, hasOpenEmail: () => Promise.resolve(gmail.emailOpen) };
  const log = new InMemoryActionLog();
  const speech = new InMemorySpeechStore();
  const store = new InMemoryJobStore();
  const llm = new ScriptedLLM(options.script);
  let seq = 0;
  const manager = new JobManager({
    store,
    now: () => clock.now,
    newId: () => `job${(seq += 1)}`,
    foregroundFree: () => shell.isForegroundFree(),
    ...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
  });
  // Each job's own chain state, in submission order — so a test can ask two of them at once.
  const chains: ChainState[] = [];

  const run = createJobRunner({
    manager,
    shell,
    log,
    speech,
    capture: () => captureContext(shell, gmail),
    buildPlanner: (parts) => {
      chains.push(parts.chain);
      return new Planner(
        llm,
        parts.shell,
        options.tools,
        (options.memory ?? new NoopMemoryResolver()) as Memory,
        parts.log,
        undefined, // sender
        undefined, // gmail
        undefined, // draft
        undefined, // notion
        undefined, // calendar
        parts.speech,
        undefined, // screen
        undefined, // elements
        undefined, // chooser
        // Never the real clock: a chain holds its preview on screen for a minimum time.
        () => Promise.resolve(),
        parts.chain,
        undefined, // channel directory
        parts.gate,
        manager,
      );
    },
  });

  return { clock, shell, gmail, log, speech, store, llm, manager, chains, run };
}

export type World = ReturnType<typeof jobWorld>;

export const tool = (name: string, input: Record<string, unknown> = {}): ToolChoice => ({
  kind: "tool",
  name,
  input,
});

export const plan = (
  ...steps: { tool: string; arguments?: Record<string, unknown> }[]
): ToolChoice => ({
  kind: "plan",
  steps: steps.map((step) => ({
    tool: step.tool,
    arguments: step.arguments ?? {},
    describe: `do ${step.tool}`,
  })),
});
