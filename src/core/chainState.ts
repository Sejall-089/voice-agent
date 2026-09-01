// Is a chain running right now, and where has it got to? (M17)
//
// WHY THIS IS A STORE AND `core/draft.ts` / `core/speechStore.ts` ARE THE PRECEDENT — but only
// half of it. Those two exist because state has to survive BETWEEN instructions: a draft the
// user is still tweaking, a remainder an "and the rest?" will ask for. A chain's state does not
// survive anything; it lives and dies inside one `planner.run()`.
//
// What it does need is to be visible from OUTSIDE that call. The hotkey handlers are the whole
// reason: pressing the instruction hotkey partway through a chain would start a second
// concurrent planner run over the top of the first, and dictation would grab the shared
// microphone and type into whatever has focus while the chain is acting inside Chrome. Neither
// handler can see into a running `run()`, so the one fact they need is published here.
//
// WHAT IS DELIBERATELY NOT HERE: THE STEP RESULTS. Those stay in a local inside the run. Putting
// them in a store would make a finished chain's output reachable by the next one, and "step 2
// used the previous instruction's step 1" is precisely the class of bug that has no visible
// symptom until it sends something to the wrong person. The results have no reason to outlive
// the loop that produced them, so they don't.

export interface ChainState {
  // A chain of `total` steps is starting. Must be called BEFORE the first await of the run, so
  // "a chain is running" and "the guards know" can never be observed in different states — the
  // same rule `WindowsShell.confirm()` follows for `confirmPending`, and for the same reason.
  begin(total: number): void;
  // Execution has reached step `n` (1-based). Purely informational: it is what lets a narration
  // say "Step 2 of 3" without the planner threading its own counter through every call.
  step(n: number): void;
  // The chain is over — completed, refused, or thrown. MUST be idempotent and MUST be safe to
  // call when nothing was running, because the only correct place to call it is a `finally`.
  end(): void;
  isRunning(): boolean;
  // Where the chain has got to, or null when none is running.
  position(): { step: number; total: number } | null;
}

export class InMemoryChainState implements ChainState {
  private total = 0;
  private current = 0;

  begin(total: number): void {
    // A `begin` while one is already running would mean the guards failed and two runs are in
    // flight. Overwriting is the honest response — the newer run is the one whose `end()` will
    // fire, and pretending the older one still owns the flag would strand it set forever.
    this.total = Math.max(0, Math.floor(total));
    this.current = this.total > 0 ? 1 : 0;
  }

  step(n: number): void {
    if (this.total === 0) return;
    this.current = Math.min(Math.max(1, Math.floor(n)), this.total);
  }

  end(): void {
    this.total = 0;
    this.current = 0;
  }

  isRunning(): boolean {
    return this.total > 0;
  }

  position(): { step: number; total: number } | null {
    return this.total > 0 ? { step: this.current, total: this.total } : null;
  }
}
