import type {
  CapturedContext,
  ConfirmOptions,
  LocalAction,
  OSShell,
} from "../../main/shell/OSShell.ts";
import type { SpeechStore } from "../speechStore.ts";
import type { ActionLog, ActionLogEntry } from "../types.ts";

// What one job sees where a planner expects the shell, the action log and the speech store
// (M23).
//
// THE RULE THESE THREE ENFORCE: a detached job never touches anything in front of the user.
// Not the bar's status, result or thinking lines; not the speaker; not the store behind "read
// me the rest"; not the previous turn. While a job is attached each of these is a plain
// pass-through, so an attached job behaves exactly as an instruction did before M23. The
// moment it is detached, the same calls go to the job's own record and nowhere else.
//
// The check is made PER CALL, not once at construction: a job is detached partway through, by
// a key press, and the planner holding these objects is never told.

// What the facades need to know about their job — a narrow view, so none of them can move it.
export interface JobHandle {
  readonly id: string;
  isAttached(): boolean;
  // Where a detached job's words go: the pill's list.
  record(line: string): void;
  // How this job's next confirm may be shown (JobManager.takeConfirmPermit).
  takeConfirmPermit(): "attached" | "detached" | "none";
  // Has the user cancelled this job?
  isCancelled(): boolean;
}

// The real shell, plus the one indicator that is not part of the OSShell contract.
export type ForegroundShell = OSShell & { showThinking(on: boolean): void };

export class JobShell implements OSShell {
  constructor(
    private readonly real: ForegroundShell,
    private readonly job: JobHandle,
    // Captured when the instruction was given (a promise, because the capture is started at
    // submission and may still be in flight). `getContext` answers with this for the whole
    // life of the job — after a detach, after a thirty-minute wait — and never reads the
    // clipboard again.
    private readonly context: Promise<CapturedContext>,
  ) {
    // Whoever awaits it sees a failed capture; nobody awaiting it must not be a crash.
    this.context.catch(() => undefined);
  }

  registerHotkey(): boolean {
    return false; // a job does not own hotkeys
  }

  getContext(): Promise<CapturedContext> {
    return this.context;
  }

  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }> {
    if (this.job.isAttached()) return this.real.executeAction(action);
    switch (action.kind) {
      case "notify":
        this.job.record(action.payload);
        return Promise.resolve({ ok: true });
      case "speak":
        // Silence, and a success: "the app did not speak" is a supported state (M14).
        return Promise.resolve({ ok: true });
      default:
        // Opening a tab or an app, writing the clipboard, pressing a media key: each acts on
        // the user's screen NOW, and every tool that asks for one is foreground-only, so a
        // detached job should have paused before reaching here. If one arrives anyway it is
        // refused rather than done behind someone's back.
        return Promise.resolve({
          ok: false,
          error: "That needs you at the screen, and this job is running in the background.",
        });
    }
  }

  showInput(): Promise<string> {
    return Promise.resolve(""); // a job never opens the bar for an instruction
  }

  showResult(text: string): void {
    if (this.job.isAttached()) this.real.showResult(text);
    else this.job.record(text);
  }

  showThinking(on: boolean): void {
    if (this.job.isAttached()) this.real.showThinking(on);
  }

  // The confirm gate. EVERY `dangerous` call still ends in the real shell's dialog — this only
  // decides how that dialog is presented, and whether it may open at all.
  confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
    const permit = this.job.takeConfirmPermit();
    if (permit === "attached") return this.real.confirm(message, options).then(this.unlessCancelled);
    if (permit === "detached") {
      // Opened by a click in the pill: not parented to the bar, and the bar is left alone.
      return this.real
        .confirm(message, { ...options, detached: true })
        .then(this.unlessCancelled);
    }
    // No permit: the job was detached without being resumed for this confirm. A dialog must
    // never appear unasked on someone who is doing something else — and "no dialog" can only
    // mean "not approved".
    return Promise.resolve(false);
  }

  // A dialog can be on screen, or queued behind another job's, when its job is cancelled from
  // the pill — the queue has no way to take a request back. So the answer is checked on the
  // way out: a yes given to a job the user has since cancelled is not a yes.
  private readonly unlessCancelled = (approved: boolean): boolean =>
    approved && !this.job.isCancelled();

  askUser(question: string): Promise<string | null> {
    // A detached job cannot ask: the bar is someone else's by now. `null` is the contract's
    // "could not be asked", and the caller does not proceed.
    if (!this.job.isAttached()) return Promise.resolve(null);
    return this.real.askUser(question);
  }
}

// The action log, stamped. Every row says which job wrote it and whether that job was detached
// at that moment, which is what lets `getLast()` leave background rows out of the next
// instruction's "previous turn".
export class JobLog implements ActionLog {
  constructor(
    private readonly real: ActionLog,
    private readonly job: Pick<JobHandle, "id" | "isAttached">,
  ) {}

  logAction(entry: ActionLogEntry): void {
    this.real.logAction({ ...entry, jobId: this.job.id, detached: !this.job.isAttached() });
  }

  logMiss(instruction: string): void {
    // Attached, this is the miss it always was — the ranked backlog of spec §8 included.
    if (this.job.isAttached()) {
      this.real.logMiss(instruction);
      return;
    }
    this.logAction({
      ts: new Date().toISOString(),
      instruction,
      tool: null,
      arguments: null,
      result: null,
      status: "no_tool",
    });
  }

  getLast(): ActionLogEntry | null {
    return this.real.getLast();
  }
}

// "Read me the rest" (M14) is one slot shared by the whole app, and it belongs to whatever the
// user last heard. A detached job is heard by nobody, so it neither fills the slot nor empties it.
export class JobSpeechStore implements SpeechStore {
  constructor(
    private readonly real: SpeechStore,
    private readonly job: Pick<JobHandle, "isAttached">,
  ) {}

  hold(text: string): void {
    if (this.job.isAttached()) this.real.hold(text);
  }

  take(now?: number): string | null {
    return this.job.isAttached() ? this.real.take(now) : null;
  }

  clear(): void {
    if (this.job.isAttached()) this.real.clear();
  }
}
