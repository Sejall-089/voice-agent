// Every sentence the job machinery says about itself (M23). Fixed text built from counts and
// tool NAMES from the registry — never from an instruction, an argument or a result, all of
// which can carry words someone else wrote.

export const EXPIRY_MS = 30 * 60 * 1000;
export const MAX_RUNNING = 3;

// What an expired pause leaves as the step's result, in the log and in the job record.
export const EXPIRED =
  "That waited 30 minutes for you and nobody answered, so it expired. It was not run.";

export const CANCELLED_BEFORE_START = "Cancelled before it started. Nothing was run.";
export const CANCELLED_BY_YOU = "You cancelled that, so I stopped there.";

export const QUEUED_NOTICE =
  "Three jobs are already running, so this one is queued. It starts when one of them finishes.";

// A detached job reached something that needs the user's screen. Said when the pill's resume
// is refused because the user is in the middle of something else.
export const FOREGROUND_BUSY = "Finish what's open in the bar first, then resume this.";

// What a job cut off by the app closing says. WHICH sentence depends on whether a handler had
// been started and not finished — the only case in which a side effect could have happened
// (CLAUDE.md, M21: "it may have gone through" belongs only where it could have).
export function interruptedText(record: {
  step: number;
  total: number;
  tool: string | null;
  inFlightTool: string | null;
  inFlightStep: number | null;
}): string {
  if (record.inFlightTool !== null && record.inFlightStep !== null) {
    return (
      `Interrupted: the app closed while step ${record.inFlightStep} of ${record.total} ` +
      `(${record.inFlightTool}) was running. It may or may not have gone through. ` +
      "Check before trying again."
    );
  }
  if (record.step === 0 || record.tool === null) {
    return "Interrupted: the app closed before anything was run. Nothing was sent.";
  }
  const earlier = record.step > 1 ? " The steps before it had finished." : "";
  return (
    `Interrupted: the app closed before step ${record.step} of ${record.total} ` +
    `(${record.tool}) ran. Nothing was sent by that step.${earlier}`
  );
}
