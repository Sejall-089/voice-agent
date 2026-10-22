import type { JobState, JobSummary, JobsReader } from "../types.ts";
import type { GateAnswer, JobGate, StepEntry } from "./gate.ts";
import type { JobRecord, JobStore } from "./JobStore.ts";
import { EXPIRY_MS, MAX_RUNNING } from "./messages.ts";

// Every job, what state it is in, and who is allowed to move it (M23).
//
// ONE INSTRUCTION IS ONE JOB. A job runs the same planner an instruction always ran; this class
// never calls a tool and never sees an argument. What it owns is the part the planner cannot:
// how many jobs execute at once, which one the user is in front of, which ones are waiting for
// them, and when a wait has gone on too long.
//
//     submit ─► running ─► done / failed / cancelled
//                 │  ▲
//       no slot   ▼  │ a slot frees
//               queued ─► cancelled
//                 │
//     running ─► needs-you ─► running            (resumed from the pill)
//                    ├──────► expired            (30 minutes, nobody answered — NOT run)
//                    └──────► cancelled
//
//     queued / running / needs-you ─► interrupted   (only ever at startup, by the store)
//
// ATTACHED AND DETACHED. A job starts attached: the user just asked for it and is looking at
// the bar, so it behaves exactly as an instruction did before M23 — foreground-only tools run,
// confirms open at once. Pressing the hotkey for something else DETACHES it. A detached job
// keeps working, but it stops and waits ("needs-you") before anything that needs a person: a
// confirm, or a tool that acts on whatever is on screen at that moment.
//
// PLANNING IS NOT CAPPED; EXECUTING IS. A job is `running` from submission, but holds no slot
// until the planner asks to be admitted — so a status question is answered at once however
// many jobs are busy. A job that is waiting for the user gives its slot back.

export type PauseReason = "confirm" | "foreground-only";

export interface JobView {
  id: string;
  instruction: string;
  kind: "work" | "status";
  state: JobState;
  attached: boolean;
  background: boolean;
  acknowledged: boolean;
  waitingFor: PauseReason | null;
  waitingSince: number | null;
  tool: string | null;
  step: number;
  total: number;
  result: string | null;
  // What a detached job would have put in the bar. In memory only.
  lines: readonly string[];
  updatedAt: number;
  // When the user first saw it in the pill's open list, or null.
  seenAt: number | null;
  // The user asked to cancel it and it has not ended yet (M27): a job mid-step finishes that
  // step first (`cancel`), and until it does the pill says so instead of "Running". In memory
  // only, like `lines`: a job is never resumed after a restart, so nothing needs it saved.
  cancelRequested: boolean;
  // How many of its steps ran (JobRecord.stepsRun): a job cancelled after one did is shown.
  stepsRun: number;
}

// What moved a job off the bar (M25), carried on the "detached" change and written to the log
// line main prints for it — so a job found in the pill can be traced to the press, click or
// submission that put it there. Restoring at startup is not one: it relabels jobs that were live
// as interrupted, already ended, and detaches nothing.
export type DetachTrigger = "hotkey" | "dictation" | "outside-click" | "submit" | "escape";

export type JobChange =
  | { type: "state"; job: JobView; previous: JobState | null }
  | { type: "detached"; job: JobView; trigger: DetachTrigger }
  | { type: "updated"; job: JobView };

export type ResumeResult =
  | "ok"
  // It waited too long; it has just been expired and nothing ran.
  | "expired"
  // It needs the user's screen and the user is in the middle of something else.
  | "busy"
  | "not-waiting";

export interface JobManagerOptions {
  store: JobStore;
  now?: () => number;
  newId?: () => string;
  maxRunning?: number;
  expiryMs?: number;
  // Is the user free to be handed a foreground-only step right now? Asked only when one is
  // resumed from the pill. The shell knows (a capture, a question or a dialog is open).
  foregroundFree?: () => boolean;
}

const STATUS_WINDOW_MS = 30 * 60 * 1000;

const TERMINAL: readonly JobState[] = ["done", "failed", "cancelled", "expired", "interrupted"];

// What may follow what. Anything else is ignored rather than thrown: the commonest "illegal"
// move is a planner run reporting its outcome for a job the user already cancelled, and that
// must be a no-op, not a crash in a `finally`.
const LEGAL: Readonly<Record<JobState, readonly JobState[]>> = {
  running: ["queued", "needs-you", "done", "failed", "cancelled"],
  queued: ["running", "cancelled", "failed"],
  "needs-you": ["running", "expired", "cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
  expired: [],
  interrupted: [],
};

interface Live extends JobRecord {
  attached: boolean;
  lines: string[];
  cancelRequested: boolean;
  // Holds one of the executing slots.
  slot: boolean;
  // An attached job is doing something that must not be walked away from: a foreground-only
  // step, or the stretch between "a confirm is needed" and the dialog being answered.
  holdsForeground: boolean;
  // The step being run asked for the foreground itself (`Tool.background`), as opposed to
  // holding it only until its confirm dialog is answered.
  stepForegroundOnly: boolean;
  // How the next confirm this job asks for may be shown: with the user present, from a pill
  // click, or not at all.
  confirmPermit: "attached" | "detached" | null;
  wake: ((answer: GateAnswer) => void) | null;
  // Whether a step has been entered (M25). Until then the job has only planned — it has told
  // nobody anything and changed nothing — so Escape may cancel it outright; after, it detaches.
  started: boolean;
}

export class JobManager implements JobsReader {
  private readonly jobs = new Map<string, Live>();
  private readonly waitingForSlot: Live[] = [];
  private readonly listeners = new Set<(change: JobChange) => void>();
  private readonly store: JobStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxRunning: number;
  private readonly expiryMs: number;
  private readonly foregroundFree: () => boolean;
  private counter = 0;

  constructor(options: JobManagerOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newId =
      options.newId ?? (() => `job-${this.now().toString(36)}-${(this.counter += 1).toString(36)}`);
    this.maxRunning = options.maxRunning ?? MAX_RUNNING;
    this.expiryMs = options.expiryMs ?? EXPIRY_MS;
    this.foregroundFree = options.foregroundFree ?? (() => true);
  }

  // --- Startup ---

  // Relabel whatever was live when the app last stopped, then bring back what the user has
  // not been shown. Nothing here can run a tool: an interrupted job has no gate, no planner
  // and no way to be resumed.
  restore(): number {
    const now = this.now();
    const interrupted = this.store.markInterrupted(now);
    for (const record of this.store.loadUnacknowledged(now - 24 * 60 * 60 * 1000)) {
      this.jobs.set(record.id, {
        ...record,
        attached: false,
        lines: [],
        cancelRequested: false,
        slot: false,
        holdsForeground: false,
        stepForegroundOnly: false,
        confirmPermit: null,
        wake: null,
        // Every restored job has already ended; nothing about it is cancellable by Escape.
        started: true,
      });
    }
    return interrupted;
  }

  // --- Submission ---

  // A new job, attached. Only one job is attached at a time: whatever was attached before is
  // detached first (the hotkey has normally done that already).
  submit(instruction: string): string {
    this.detachAttached("submit");
    // The backstop for a refusal. If the job that had the bar could not be detached (it holds
    // the foreground — the hotkey guards should never have let a submission through), the new
    // job does not get the bar as well: two attached jobs would both write to it. It starts
    // in the background instead.
    const barIsTaken = this.hasAttached();
    const now = this.now();
    const job: Live = {
      id: this.newId(),
      instruction,
      kind: "work",
      state: "running",
      background: barIsTaken,
      acknowledged: false,
      createdAt: now,
      updatedAt: now,
      step: 0,
      total: 0,
      tool: null,
      pauseReason: null,
      pauseSince: null,
      inFlightTool: null,
      inFlightStep: null,
      result: null,
      seenAt: null,
      stepsRun: 0,
      attached: !barIsTaken,
      lines: [],
      cancelRequested: false,
      slot: false,
      holdsForeground: false,
      stepForegroundOnly: false,
      confirmPermit: null,
      wake: null,
      started: false,
    };
    this.jobs.set(job.id, job);
    this.store.save(job);
    this.emit({ type: "state", job: view(job), previous: null });
    return job.id;
  }

  // The planner run is over. `state` is where the job ends; ignored if it already ended
  // another way (cancelled from the pill while its last step was finishing, say).
  finish(id: string, state: "done" | "failed" | "cancelled" | "expired", result: string | null): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    job.holdsForeground = false;
    job.confirmPermit = null;
    job.inFlightTool = null;
    job.inFlightStep = null;
    if (TERMINAL.includes(job.state)) {
      // Already ended another way — expired, or cancelled from the pill — and the run has now
      // caught up with it. The state stands; what the run had to say about it (how much of
      // the plan ran before it stopped) is kept if nothing else was.
      if (job.result === null) job.result = result;
      this.touch(job);
      return;
    }
    // A queued or waiting job that is being finished from outside cannot move straight to
    // `done`; only the states LEGAL allows.
    if (job.result === null) job.result = result;
    // A run that ended while its job was still queued or waiting broke somewhere it should
    // not have; it is recorded as a failure rather than left live for ever.
    if (!this.move(job, state)) this.move(job, "failed");
  }

  // --- The gate the planner asks ---

  gateFor(id: string): JobGate {
    return {
      admit: (plan) => this.admit(id, plan),
      enterStep: (step) => this.enterStep(id, step),
      leaveStep: () => this.leaveStep(id),
      beforeConfirm: () => this.beforeConfirm(id),
      handlerStarting: () => this.handlerStarting(id),
      handlerFinished: () => this.handlerFinished(id),
    };
  }

  private admit(
    id: string,
    plan: { tools: readonly string[]; statusOnly: boolean },
  ): Promise<GateAnswer> {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL.includes(job.state)) return Promise.resolve("cancelled");
    if (job.cancelRequested) return Promise.resolve("cancelled");
    job.total = plan.tools.length;
    job.tool = plan.tools[0] ?? null;

    // A status question: no slot, and from here on it is not a job anyone is told about.
    if (plan.statusOnly) {
      job.kind = "status";
      this.touch(job);
      return Promise.resolve("go");
    }
    if (job.slot) return Promise.resolve("go");
    if (this.slotsInUse() < this.maxRunning) {
      job.slot = true;
      this.touch(job);
      return Promise.resolve("go");
    }
    const waiting = new Promise<GateAnswer>((resolve) => {
      job.wake = resolve;
    });
    this.waitingForSlot.push(job);
    this.move(job, "queued");
    return waiting;
  }

  private enterStep(id: string, step: StepEntry): Promise<GateAnswer> {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL.includes(job.state)) return Promise.resolve("cancelled");
    if (job.cancelRequested) return Promise.resolve("cancelled");
    job.started = true;
    job.step = step.index;
    job.total = step.total;
    job.tool = step.tool;
    job.stepForegroundOnly = step.foregroundOnly;
    this.touch(job);

    if (!step.foregroundOnly) return Promise.resolve("go");
    if (job.attached) {
      job.holdsForeground = true;
      return Promise.resolve("go");
    }
    // Nobody is there. `resume` re-attaches the job before it wakes it, so by the time this
    // answers "go" the user is present again.
    return this.pause(job, "foreground-only").then((answer) => {
      if (answer === "go") job.holdsForeground = true;
      return answer;
    });
  }

  private leaveStep(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    job.holdsForeground = false;
    job.stepForegroundOnly = false;
    job.confirmPermit = null;
  }

  private beforeConfirm(id: string): Promise<{ answer: GateAnswer; waited: boolean }> {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL.includes(job.state) || job.cancelRequested) {
      return Promise.resolve({ answer: "cancelled", waited: false });
    }
    if (job.attached) {
      // From here until the dialog is answered the job may not be detached: the summary is
      // about to be built and shown, and a dialog must never open on someone who has just
      // pressed the hotkey to do something else.
      job.holdsForeground = true;
      job.confirmPermit = "attached";
      return Promise.resolve({ answer: "go", waited: false });
    }
    return this.pause(job, "confirm").then((answer) => {
      if (answer === "go") job.confirmPermit = "detached";
      return { answer, waited: true };
    });
  }

  private handlerStarting(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    // The dialog, if there was one, has been answered: the job may be walked away from again
    // unless the step itself needs the screen.
    job.confirmPermit = null;
    if (!job.stepForegroundOnly) job.holdsForeground = false;
    job.inFlightTool = job.tool;
    job.inFlightStep = job.step;
    // Written BEFORE the handler is called. That ordering is the whole point of the marker.
    this.store.save(job);
  }

  private handlerFinished(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    job.inFlightTool = null;
    job.inFlightStep = null;
    // Returned or threw: either way it was called, and something may have happened (M27).
    job.stepsRun += 1;
    this.store.save(job);
  }

  // --- How a job's confirm may be shown ---

  // Asked by the job's shell at the moment a dialog is about to open, and consumed by it.
  // "none" means no dialog may open: the job was detached without having been resumed for
  // this confirm, and an unsolicited dialog is exactly what detaching is a promise against.
  takeConfirmPermit(id: string): "attached" | "detached" | "none" {
    const job = this.jobs.get(id);
    if (job === undefined || job.confirmPermit === null) return "none";
    const permit = job.confirmPermit;
    job.confirmPermit = null;
    // An "attached" permit cannot outlive the job being attached: from the moment it is issued
    // until the step ends the job holds the foreground, and `detachAttached` refuses it.
    return permit;
  }

  // --- The user ---

  isAttached(id: string): boolean {
    return this.jobs.get(id)?.attached === true;
  }

  // Has the user cancelled this job? Asked by the job's shell after a confirm dialog is
  // answered: a dialog can be open (or queued behind another) when its job is cancelled from
  // the pill, and a yes given to it afterwards must not run anything.
  isCancelRequested(id: string): boolean {
    const job = this.jobs.get(id);
    return job === undefined || job.cancelRequested || job.state === "cancelled";
  }

  // The tool the ATTACHED job is on right now, or null when no job has the bar.
  attachedTool(): string | null {
    for (const job of this.jobs.values()) {
      if (job.attached && !TERMINAL.includes(job.state)) return job.tool;
    }
    return null;
  }

  // Is the attached job doing something that must not be interrupted by a new instruction?
  attachedBlocks(): boolean {
    for (const job of this.jobs.values()) {
      if (job.attached && !TERMINAL.includes(job.state) && job.holdsForeground) return true;
    }
    return false;
  }

  // Is any job still attached and working? (Whether the foreground is taken.)
  hasAttached(): boolean {
    for (const job of this.jobs.values()) {
      if (job.attached && !TERMINAL.includes(job.state)) return true;
    }
    return false;
  }

  // The user has started something else. Whatever was attached carries on without the bar.
  // Refused (false) while it holds the foreground — the caller should have asked
  // `attachedBlocks()` first, and this is the backstop. `trigger` says what did it (M25).
  detachAttached(trigger: DetachTrigger): boolean {
    let detached = false;
    for (const job of this.jobs.values()) {
      if (!job.attached || TERMINAL.includes(job.state)) continue;
      if (job.holdsForeground) return false;
      job.attached = false;
      job.background = true;
      this.touch(job, false);
      this.emit({ type: "detached", job: view(job), trigger });
      detached = true;
    }
    return detached;
  }

  // Escape, while a job is attached (M25 Fix 2). Escape means "never mind" everywhere else in
  // this app, and before M25 it only hid the bar: the job went on, popped the bar back up with
  // its answer, spoke it, and opened a dangerous confirm on someone who had just said never mind.
  //   - Not started (still planning, or queued for a slot): CANCELLED, silently. It also stops
  //     being attached, so its "Cancelled before it started" goes to its own record — nothing
  //     re-shows the bar or speaks — and a cancelled job is never in the pill.
  //   - Started (a step has been entered): DETACHED, with trigger "escape" — it may already
  //     have done something, so it is not stopped blind; it goes to the pill, silent, with its
  //     Cancel button.
  //   - Holding the foreground (a foreground-only step, or its confirm is up): left alone.
  //     Today's behaviour — and with a confirm up, Escape is the dialog's own Cancel anyway.
  //     No check of its own: a job only holds the foreground once a step has been entered, so it
  //     has started, and `detachAttached` refuses it (an explicit check here was dead code — the
  //     M25 mutation pass removed it and nothing changed).
  escapeAttached(): "cancelled" | "detached" | "none" {
    for (const job of this.jobs.values()) {
      if (!job.attached || TERMINAL.includes(job.state)) continue;
      if (!job.started) {
        job.attached = false;
        this.cancel(job.id);
        return "cancelled";
      }
      return this.detachAttached("escape") ? "detached" : "none";
    }
    return "none";
  }

  // The pill's button for a waiting job. For a confirm this only lets the job go on to OPEN
  // THE DIALOG; it approves nothing. For a foreground-only step it re-attaches the job.
  resume(id: string): ResumeResult {
    const job = this.jobs.get(id);
    if (job === undefined || job.state !== "needs-you" || job.wake === null) return "not-waiting";
    // Checked HERE, at the click, and not once the dialog is open: from this point the
    // user's answer is what decides.
    if (this.isOverdue(job)) {
      this.expire(job);
      return "expired";
    }
    if (job.pauseReason === "foreground-only") {
      if (this.hasAttached() || !this.foregroundFree()) return "busy";
      job.attached = true;
    }
    const wake = job.wake;
    job.wake = null;
    job.pauseReason = null;
    job.pauseSince = null;
    // The user just acted on this job, so it does not queue behind the cap.
    job.slot = true;
    this.move(job, "running");
    wake("go");
    return "ok";
  }

  // Stop a job. Waiting or queued: at once, and its step never runs. Mid-step: the step in
  // flight is left to finish (a handler cannot be un-called) and nothing after it starts.
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL.includes(job.state)) return false;
    job.cancelRequested = true;
    if (job.state === "queued" || job.state === "needs-you") {
      const wake = job.wake;
      job.wake = null;
      job.pauseReason = null;
      job.pauseSince = null;
      this.move(job, "cancelled");
      wake?.("cancelled");
    } else {
      this.touch(job);
    }
    return true;
  }

  // Dismissed from the pill. Only something that has ended can be.
  acknowledge(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined || !TERMINAL.includes(job.state)) return false;
    job.acknowledged = true;
    this.touch(job);
    return true;
  }

  // The user has SEEN these jobs: the pill's list was open with them in it. Recorded once per
  // job — the first time — and saved with it, so the clock it starts survives a restart and a
  // second look does not restart it. Only a job that has ended can be seen in this sense; a
  // live one is not waiting to be noticed. Returns how many were newly marked.
  //
  // `updatedAt` is deliberately NOT touched: it is when the job ended, and the status answer
  // and the done-fade both read it as that.
  markSeen(ids: readonly string[]): number {
    let marked = 0;
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job === undefined || job.seenAt !== null || !TERMINAL.includes(job.state)) continue;
      job.seenAt = this.now();
      this.store.save(job);
      this.emit({ type: "updated", job: view(job) });
      marked += 1;
    }
    return marked;
  }

  // Every wait that has gone on too long becomes `expired`, and its step is not run. Called on
  // a timer; `resume` makes the same check at the click, so a late timer cannot let one through.
  expireDue(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "needs-you" && this.isOverdue(job)) {
        this.expire(job);
        count += 1;
      }
    }
    return count;
  }

  // What a detached job would have shown in the bar goes here instead.
  appendLine(id: string, text: string): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    job.lines.push(text);
    // Bounded: a job is at most three steps, but a narration per step plus results adds up.
    while (job.lines.length > 12) job.lines.shift();
    this.emit({ type: "updated", job: view(job) });
  }

  // --- Reading ---

  // Everything the pill may draw: background work, not yet dismissed.
  views(): JobView[] {
    return [...this.jobs.values()]
      .filter((job) => job.kind === "work" && job.background && !job.acknowledged)
      .map(view);
  }

  get(id: string): JobView | null {
    const job = this.jobs.get(id);
    return job === undefined ? null : view(job);
  }

  // JobsReader — what `jobStatus` answers from. The same set the pill draws.
  // A job that ended more than half an hour ago is no longer an answer to "are they done yet".
  list(): readonly JobSummary[] {
    const since = this.now() - STATUS_WINDOW_MS;
    return this.views()
      .filter((job) => !TERMINAL.includes(job.state) || job.updatedAt >= since)
      .map((job) => ({
        id: job.id,
        instruction: job.instruction,
        state: job.state,
        waitingFor: job.waitingFor,
        tool: job.tool,
      }));
  }

  onChange(listener: (change: JobChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Internals ---

  private pause(job: Live, reason: PauseReason): Promise<GateAnswer> {
    job.pauseReason = reason;
    job.pauseSince = this.now();
    const waiting = new Promise<GateAnswer>((resolve) => {
      job.wake = resolve;
    });
    this.move(job, "needs-you");
    return waiting;
  }

  private isOverdue(job: Live): boolean {
    return job.pauseSince !== null && this.now() - job.pauseSince >= this.expiryMs;
  }

  private expire(job: Live): void {
    const wake = job.wake;
    job.wake = null;
    job.pauseReason = null;
    job.pauseSince = null;
    this.move(job, "expired");
    wake?.("expired");
  }

  private slotsInUse(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.slot) count += 1;
    return count;
  }

  private move(job: Live, next: JobState): boolean {
    if (!LEGAL[job.state].includes(next)) return false;
    const previous = job.state;
    job.state = next;
    if (next !== "running") job.slot = false;
    if (TERMINAL.includes(next)) {
      job.holdsForeground = false;
      job.confirmPermit = null;
      const queued = this.waitingForSlot.indexOf(job);
      if (queued !== -1) this.waitingForSlot.splice(queued, 1);
    }
    this.touch(job, false);
    this.emit({ type: "state", job: view(job), previous });
    this.startQueued();
    return true;
  }

  // Hand free slots to the jobs that have waited longest.
  private startQueued(): void {
    while (this.waitingForSlot.length > 0 && this.slotsInUse() < this.maxRunning) {
      const next = this.waitingForSlot.shift();
      if (next === undefined || next.state !== "queued") continue;
      const wake = next.wake;
      next.wake = null;
      next.slot = true;
      this.move(next, "running");
      // `move` cleared the slot only for non-running states, so it is still held here.
      wake?.("go");
    }
  }

  private touch(job: Live, announce = true): void {
    job.updatedAt = this.now();
    this.store.save(job);
    if (announce) this.emit({ type: "updated", job: view(job) });
  }

  private emit(change: JobChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // A listener is the pill or the chime. Neither may be able to break a job.
      }
    }
  }
}

function view(job: Live): JobView {
  return {
    id: job.id,
    instruction: job.instruction,
    kind: job.kind,
    state: job.state,
    attached: job.attached,
    background: job.background,
    acknowledged: job.acknowledged,
    waitingFor: job.pauseReason,
    waitingSince: job.pauseSince,
    tool: job.tool,
    step: job.step,
    total: job.total,
    result: job.result,
    lines: [...job.lines],
    updatedAt: job.updatedAt,
    seenAt: job.seenAt,
    cancelRequested: job.cancelRequested,
    stepsRun: job.stepsRun,
  };
}
