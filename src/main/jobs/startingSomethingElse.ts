// What happens to background work the moment the user starts something else (M23): an
// accepted press of the instruction hotkey or the dictation hotkey, or a new instruction.
//
// Two things, and they belong together because they are the same fact — "the user has moved
// on":
//   1. the job that had the command bar is detached, and carries on in the background;
//   2. the status pill's list, if it was open, closes.
//
// The second was missing. Found live: the list was opened by a click and closed by nothing
// but another click, so it stayed open across every later instruction, as if the app had
// remembered a preference. Whether the list is open is not a preference — it is something the
// user was looking at a moment ago.
//
// Extracted from main.ts so that "the hotkey closes the list" is a test through the real
// hotkey handler and the real pill controller, rather than a line in a file no test can
// import (CLAUDE.md).

import type { DetachTrigger } from "../../core/jobs/JobManager.ts";

export interface StartingSomethingElseDeps {
  jobs: { detachAttached(trigger: DetachTrigger): unknown };
  // The pill's controller, once main has built it — it is built after the hotkeys, so this is
  // asked for at the moment of the press. Null before then, and on an install without a pill.
  pill: () => { collapse(): void } | null;
}

// `trigger` comes from the CALLER — the hotkey handler that accepted the press says which
// hotkey it was (M25), so the word in the detach log is decided where a test can see it.
export function createStartingSomethingElse(
  deps: StartingSomethingElseDeps,
): (trigger: "hotkey" | "dictation") => void {
  return (trigger): void => {
    deps.jobs.detachAttached(trigger);
    deps.pill()?.collapse();
  };
}
