import type { JobState } from "../types.ts";

// The needs-you chime (M23): one short sound when a job starts waiting for the user.
//
// The sound is a bundled file and playing it involves no speech engine and no network. What
// is here is the DECISION, which is the part that can be wrong: when to play, when to hold it,
// when to drop it. All of it is pure or runs on an injected clock, and audio only ever leaves
// through the `play` it is handed — a fake in every test.
//
//   - Only `needs-you`. A job finishing or failing is not announced: the pill shows it, and a
//     sound for every completion is exactly what a background job is supposed to spare you.
//   - Never over the microphone or the app's own voice. Whisper would transcribe it into an
//     instruction or a dictation, and it would talk over a sentence in progress. While any of
//     those is active the chime is DEFERRED, not dropped.
//   - A deferred chime plays once, afterwards — and only if something is STILL waiting. If
//     every job that wanted it was approved, cancelled or expired in the meantime, there is
//     nothing left to call attention to.
//   - Several jobs pausing together are one chime, not a peal.

// Jobs that start waiting within this long of the last chime are covered by it.
export const COALESCE_MS = 2_000;

export type ChimeDecision = "play" | "defer" | "skip";

export interface ChimeInput {
  // The state the job has just entered, and the one it left.
  state: JobState;
  previous: JobState | null;
  muted: boolean;
  // Dictation, an instruction recording, or the app speaking is in progress.
  busy: boolean;
  // When a chime last played, or null. And now.
  lastPlayedAt: number | null;
  now: number;
}

// Should a job's change of state make a sound? Pure.
export function shouldChime(input: ChimeInput): ChimeDecision {
  if (input.state !== "needs-you" || input.previous === "needs-you") return "skip";
  if (input.muted) return "skip";
  if (input.lastPlayedAt !== null && input.now - input.lastPlayedAt < COALESCE_MS) return "skip";
  if (input.busy) return "defer";
  return "play";
}

export interface ChimeDeps {
  play: () => void;
  isMuted: () => boolean;
  isBusy: () => boolean;
  // Is this job waiting for the user right now?
  isWaiting: (jobId: string) => boolean;
  now?: () => number;
}

// Holds the two pieces of state the decision needs between calls: when a chime last played,
// and which jobs are owed one.
export class Chime {
  private lastPlayedAt: number | null = null;
  private readonly deferred = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ChimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  // A job changed state.
  onJobState(jobId: string, state: JobState, previous: JobState | null): ChimeDecision {
    const decision = shouldChime({
      state,
      previous,
      muted: this.deps.isMuted(),
      busy: this.deps.isBusy(),
      lastPlayedAt: this.lastPlayedAt,
      now: this.now(),
    });
    if (decision === "play") this.play();
    if (decision === "defer") this.deferred.add(jobId);
    return decision;
  }

  // Called on a timer, and whenever the microphone or the speaker goes quiet: is a held chime
  // now due? Returns true when it played.
  flush(): boolean {
    if (this.deferred.size === 0) return false;
    if (this.deps.isBusy()) return false;
    const owed = [...this.deferred];
    this.deferred.clear();
    // Muted in the meantime: the chimes that were held are dropped, not saved up.
    if (this.deps.isMuted()) return false;
    // Dropped unless a job that asked for it is still waiting. One chime, however many are.
    if (!owed.some((jobId) => this.deps.isWaiting(jobId))) return false;
    this.play();
    return true;
  }

  hasDeferred(): boolean {
    return this.deferred.size > 0;
  }

  private play(): void {
    this.lastPlayedAt = this.now();
    this.deps.play();
  }
}
