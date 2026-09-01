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
      const outcome = await planner.run(instruction); // captures context, plans, shows the result
      // ONE LINE OF GROUND TRUTH, added at M16.11.
      //
      // Until now the only place an outcome appeared was the command bar, in the renderer — and
      // the bar's own accessibility tree exposes nothing but "Chrome Legacy Window", so there
      // was no way to see what the app had decided except by watching the screen. That is how
      // the M16.9 snapshot bug survived: it produced a perfectly reasonable refusal naming the
      // wrong window, and nothing recorded which window it had actually read.
      //
      // Deliberately the OUTCOME and not the instruction: what was typed may be personal, and
      // the action log already records that with the user's consent. This is what the app did.
      //
      // M17 adds how much of a CHAIN ran, because `refused` alone cannot tell a plan that died
      // on step 1 from one that died on step 3 — and live testing has to be able to tell those
      // apart. Absent entirely for a single-step run, which is what every line before this
      // milestone was.
      const chain = outcome.chain ? ` (chain ${outcome.chain.completed}/${outcome.chain.total})` : "";
      console.log(`[main] ${outcome.status}${chain}: ${outcome.result ?? ""}`);
    } finally {
      // finally, not after: a thrown planner must not leave the bar claiming to think
      // forever. There is no path out of here that keeps the indicator up.
      shell.showThinking(false);
    }
  };
}
