import type { PlannerOutcome } from "../core/types.ts";

// THE planner call site, extracted so it is one named thing rather than a closure inside
// app.whenReady(). Typed text and dictated text both arrive here, which is what lets voice
// exist without /core knowing about it — and now it is also directly testable, since
// importing main.ts would boot electron.

export interface ThinkingShell {
  // Turns the bar's "Thinking…" indicator on and off.
  showThinking(on: boolean): void;
}

export interface PlannerLike {
  run(instruction: string): Promise<PlannerOutcome>;
}

export function createRunInstruction(
  planner: PlannerLike,
  shell: ThinkingShell,
): (instruction: string) => Promise<void> {
  return async (instruction: string): Promise<void> => {
    if (instruction.trim().length === 0) return;

    // A planner run is 6-13s, almost all of it waiting on the model, and the bar showed
    // nothing at all during it — a wait that looks identical to a hang. This does not make
    // anything faster; it makes the time legible.
    shell.showThinking(true);
    try {
      await planner.run(instruction); // captures context, plans, and shows the result
    } finally {
      // finally, not after: a thrown planner must not leave the bar claiming to think
      // forever. There is no path out of here that keeps the indicator up.
      shell.showThinking(false);
    }
  };
}
