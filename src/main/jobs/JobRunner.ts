import { InMemoryChainState } from "../../core/chainState.ts";
import type { ChainState } from "../../core/chainState.ts";
import type { JobGate } from "../../core/jobs/gate.ts";
import type { JobManager } from "../../core/jobs/JobManager.ts";
import { JobLog, JobShell, JobSpeechStore } from "../../core/jobs/JobShell.ts";
import type { ForegroundShell, JobHandle } from "../../core/jobs/JobShell.ts";
import type { InstructionInput } from "../../core/jobs/JobStore.ts";
import { QUEUED_NOTICE } from "../../core/jobs/messages.ts";
import type { Captured } from "../../core/planner.ts";
import type { SpeechStore } from "../../core/speechStore.ts";
import type { ActionLog, PlannerOutcome } from "../../core/types.ts";
import type { OSShell } from "../shell/OSShell.ts";
import { createRunInstruction, RUN_FAILED } from "../runInstruction.ts";

// One instruction becomes one job (M23). This is the call site that used to be
// `runInstruction(instruction)` and still has its signature: the hotkey handler hands it a
// string and does not learn that anything changed. (M34: and, optionally, whether that string
// was typed or spoken — written to the job's record for a person to read, and never handed to
// the planner.)
//
// What it does for each instruction:
//   1. opens a job, attached, and STARTS CAPTURING CONTEXT AT ONCE — the clipboard and the
//      email-open flag as they are when the instruction is given, not when the job gets a slot;
//   2. builds that job its OWN planner over facades of the shell, the log and the speech store
//      (core/jobs/JobShell.ts), with its own chain state and its own gate — so two jobs cannot
//      share a step counter, and a detached one cannot reach the bar;
//   3. runs it through the same `createRunInstruction` every instruction has gone through
//      since M8, which is what keeps the Thinking… indicator, the `[main]` ground-truth line
//      and the "it threw" report exactly as they were for an attached job;
//   4. records how it ended.
//
// No electron import: the whole thing runs under vitest against MockShell.

// The per-job pieces a planner is built from. Everything else a planner needs (the model, the
// registry, memory, the surfaces) is shared and is the builder's own business.
export interface JobPlannerParts {
  shell: OSShell;
  log: ActionLog;
  chain: ChainState;
  speech: SpeechStore;
  gate: JobGate;
}

export interface JobPlanner {
  run(instruction: string, captured: Captured): Promise<PlannerOutcome>;
}

export interface JobRunnerDeps {
  manager: JobManager;
  // The REAL shell, log and speech store — the ones in front of the user.
  shell: ForegroundShell;
  log: ActionLog;
  speech: SpeechStore;
  // Capture context now (core/planner.ts, `captureContext`, over the real shell and Gmail).
  capture: () => Promise<Captured>;
  buildPlanner: (parts: JobPlannerParts) => JobPlanner;
}

function endStateOf(outcome: PlannerOutcome | undefined): "done" | "failed" | "cancelled" | "expired" {
  if (outcome === undefined) return "failed";
  if (outcome.status === "ok") return "done";
  if (outcome.status === "cancelled") return "cancelled";
  if (outcome.status === "expired") return "expired";
  return "failed";
}

export function createJobRunner(
  deps: JobRunnerDeps,
): (instruction: string, input?: InstructionInput) => Promise<void> {
  const { manager } = deps;

  // Two things the bar has to be told when a job's standing changes, and only then.
  manager.onChange((change) => {
    // Detached: the job no longer speaks through the bar, so the indicator it turned on is
    // turned off here — its own `showThinking(false)`, when the run ends, will go nowhere.
    //
    // (M25) And logged with what did it, so a job found in the pill can be traced live to the
    // press, click or submission that put it there. The instruction is cut to 40 characters.
    if (change.type === "detached") {
      const job = change.job;
      console.log(
        `[main] job ${job.id} detached by ${change.trigger} ("${job.instruction.slice(0, 40)}", ` +
          `${job.state}, step ${job.step}/${job.total})`,
      );
      deps.shell.showThinking(false);
    }
    // Queued while the user is still looking: say so, rather than let "Thinking…" sit there.
    if (change.type === "state" && change.job.state === "queued" && change.job.attached) {
      void deps.shell.executeAction({ kind: "notify", payload: QUEUED_NOTICE });
    }
  });

  return async (instruction: string, input?: InstructionInput): Promise<void> => {
    if (instruction.trim().length === 0) return;

    const id = manager.submit(instruction, input ?? null);
    // Started HERE, synchronously with the submission, and awaited later inside the run — so
    // what is captured is the moment the instruction was given.
    const capturing = deps.capture();
    // If the run never gets as far as awaiting it, a failed capture must not surface as an
    // unhandled rejection on top of the failure that stopped the run.
    capturing.catch(() => undefined);

    const handle: JobHandle = {
      id,
      isAttached: () => manager.isAttached(id),
      record: (line) => manager.appendLine(id, line),
      takeConfirmPermit: () => manager.takeConfirmPermit(id),
      isCancelled: () => manager.isCancelRequested(id),
    };
    const shell = new JobShell(
      deps.shell,
      handle,
      capturing.then((captured) => captured.context),
    );
    const log = new JobLog(deps.log, handle);
    const planner = deps.buildPlanner({
      shell,
      log,
      chain: new InMemoryChainState(),
      speech: new JobSpeechStore(deps.speech, handle),
      gate: manager.gateFor(id),
    });

    let outcome: PlannerOutcome | undefined;
    const run = createRunInstruction(
      {
        run: async (text: string): Promise<PlannerOutcome> => {
          outcome = await planner.run(text, await capturing);
          return outcome;
        },
      },
      shell,
      log,
    );
    await run(instruction);

    // `outcome` undefined means the run threw; `createRunInstruction` has already reported it
    // (to the bar or to the job's record, whichever the job could reach) and logged it.
    manager.finish(id, endStateOf(outcome), outcome === undefined ? RUN_FAILED : outcome.result);
  };
}
