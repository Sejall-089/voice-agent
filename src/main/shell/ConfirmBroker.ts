// One confirm dialog at a time (M23).
//
// Through M22 there could only ever be one: a single planner run, parked at a single gate, and
// a boolean on the shell (`confirmPending`) saying so. With several jobs alive that boolean is
// wrong in a specific way — two confirms overlapping, the first to be answered clears the flag
// while the second dialog is still on screen, and both hotkeys come back to life over it.
//
// So the flag is replaced by a queue that owns the fact. Every confirm in the app, attached or
// detached, is a request here; exactly one is PRESENTED at a time, the rest wait their turn,
// and "is a confirm pending" is answered from the queue rather than remembered beside it.
//
// IT APPROVES NOTHING. A request resolves true only when the presenter — the shell's real
// dialog — resolved true. A presenter that throws or rejects REJECTS the request, as a dialog
// that failed always has: that is neither a yes nor a "the user said no", and the caller's run
// fails as an error rather than being logged as a cancellation nobody made. Either way the
// queue moves on — one broken dialog must not strand the ones behind it.
//
// No electron here: both shells use this same class, so the mock cannot be more lenient about
// ordering than the real one (CLAUDE.md).

interface Waiting<Request> {
  request: Request;
  resolve: (approved: boolean) => void;
  reject: (error: unknown) => void;
}

export class ConfirmBroker<Request> {
  private readonly queue: Waiting<Request>[] = [];
  private current: Waiting<Request> | null = null;

  constructor(
    // Show ONE dialog and resolve with its answer.
    private readonly present: (request: Request) => Promise<boolean>,
    // After that dialog is gone and before its asker hears the answer: the shell's own
    // tidying (re-arm Escape, bring the bar back). Runs with `current()` already null, so
    // anything it asks about pending state sees the dialog as over.
    private readonly settled: (request: Request) => void = () => undefined,
  ) {}

  // Queue a confirm. If nothing is being shown it is presented NOW, synchronously, before
  // this returns — so "a dialog is up" and "the guards know" can never be seen in different
  // states, the rule `WindowsShell.confirm()` has followed since M14.
  request(request: Request): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  // Is a confirm on screen, or waiting for the one that is? Both hotkey guards read this.
  isPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  // The request being shown right now, or null.
  showing(): Request | null {
    return this.current?.request ?? null;
  }

  private pump(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.current = next;

    let shown: Promise<boolean>;
    try {
      shown = this.present(next.request);
    } catch (error) {
      shown = Promise.reject(error);
    }
    const finish = (deliver: () => void): void => {
      this.current = null;
      try {
        this.settled(next.request);
      } catch {
        // Tidying up must not be able to turn an answer into no answer.
      }
      deliver();
      this.pump();
    };
    void shown.then(
      (approved) => finish(() => next.resolve(approved === true)),
      (error: unknown) => finish(() => next.reject(error)),
    );
  }
}
