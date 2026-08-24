import type { SpeechSynthesizer } from "../../core/types.ts";
import type { SpeechShell } from "./SpeechShell.ts";

// Saying things, one at a time, and shutting up the instant you want to talk (M14).
//
// The same shape as VoiceSession and DictationSession — a small state machine in the main
// process, no electron import, fully testable headless — but with the opposite job: those two
// turn sound into text, this turns text into sound.
//
//   idle ──speak()──► synthesizing ──► playing ──► idle
//                          │              │
//                          └──stop()──────┴──► idle (queue cleared, nothing said)
//
// TWO PROPERTIES DO ALL THE WORK HERE.
//
// 1. `speak()` RETURNS IMMEDIATELY. It queues; it does not wait for audio. A `caution` tool
//    narrates and then acts, and if speaking blocked, the app would announce "opening the reply
//    box" and then sit there for two seconds doing nothing before opening it. The announcement
//    is meant to overlap the action — that is what "narrate while acting" means.
//
// 2. `stop()` IS INSTANT AND TOTAL. It clears the queue, stops what is playing, and invalidates
//    work already in flight. This is the barge-in path, and it is not a nicety: the instruction
//    hotkey opens the command bar AND the microphone in the same moment (spec §4a), so an app
//    still talking would be transcribed by whisper into the user's own instruction. "Keep
//    speaking while listening" is not a worse UX, it is a correctness bug.
//
// Nothing here is lost when it is cut off, which is what makes barge-in safe rather than
// destructive: the full text is already on screen (§4d's two-representations decision). Speech
// is the disposable channel.

// If this many utterances are waiting, the app is talking far more than anyone is listening to.
// The OLDEST unsaid ones are dropped rather than the newest: at that point the most recent thing
// is the one still worth hearing, and reading out a backlog is exactly the behaviour "brief
// unless asked" exists to prevent.
const DEFAULT_MAX_QUEUED = 8;

// How long an utterance may sit unsaid before it is dropped instead of spoken.
//
// This is a CORRECTNESS rule, not a performance workaround, and the difference matters. Speech
// describes a moment: "there's a confirmation waiting" is true while the dialog is up and false
// the instant it is answered. A queue that always drains eventually will happily announce a
// state the world has already left — which is what live testing found, hearing the app refer to
// a dialog that had been cancelled five seconds earlier.
//
// Latency is what makes it VISIBLE (the engine reloads its model on every invocation, measured
// at roughly five seconds), but a faster engine would only shrink the window, not close it. The
// fix for the latency is a persistent process, and that is a separate change; the fix for
// saying stale things is to stop saying them.
const DEFAULT_STALE_AFTER_MS = 8_000;

export interface SpeechSessionOptions {
  maxQueued?: number;
  staleAfterMs?: number;
  // Injectable clock, the same seam DraftStore.get(now) and SpeechStore.take(now) already use,
  // so the staleness rule is provable without a test that waits eight seconds.
  now?: () => number;
  // Where a synthesis failure is reported. Injected rather than hardcoded because the honest
  // channel for "I cannot speak" is the screen, and only main.ts knows how to reach it.
  onFailure?: (message: string) => void;
}

export class SpeechSession {
  // Each utterance remembers WHEN it was queued, so one that has been overtaken by events
  // can be dropped instead of spoken. See DEFAULT_STALE_AFTER_MS above.
  private readonly queue: { text: string; at: number }[] = [];
  private draining: Promise<void> | null = null;
  // Bumped by every stop(). Work already in flight compares the value it started with against
  // this one; a mismatch means "you were interrupted, throw it away". A boolean flag could not
  // do this job — two barge-ins in quick succession have to invalidate two different utterances.
  private generation = 0;
  // Whether the last synthesis attempt failed. A misconfigured engine fails on EVERY utterance,
  // and reporting each one would bury the screen in the same message; reporting none would make
  // a broken speaker indistinguishable from a quiet one, which is this project's least favourite
  // failure mode (a dead hotkey looks exactly like a broken app — spec §4a).
  private reportedFailure = false;

  private readonly maxQueued: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly onFailure: (message: string) => void;

  constructor(
    private readonly shell: SpeechShell,
    private readonly synthesizer: SpeechSynthesizer,
    options: SpeechSessionOptions = {},
  ) {
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.onFailure =
      options.onFailure ??
      ((message) => console.error(`[SpeechSession] ${message}`));
  }

  // Is anything queued or being said right now? The shell asks, so it can avoid hiding the bar
  // out from under an utterance the user is still hearing.
  isSpeaking(): boolean {
    return this.draining !== null;
  }

  // Queue one utterance. Deliberately `void`, not `Promise<void>` — see property 1 above. A
  // caller that awaited this would reintroduce exactly the blocking it exists to avoid.
  speak(text: string): void {
    if (text.trim().length === 0) return; // the engine exits non-zero on empty input

    this.queue.push({ text, at: this.now() });
    while (this.queue.length > this.maxQueued) this.queue.shift();

    if (this.draining === null) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  // Barge-in. Everything unsaid is dropped, what is playing is cut off, and anything mid-flight
  // is invalidated. Safe to call when nothing is happening.
  stop(): void {
    this.generation += 1;
    this.queue.length = 0;
    this.shell.stopPlayback();
  }

  // Test seam: wait for the queue to empty. Production never needs this — nothing is allowed to
  // block on speech — which is exactly why it has to be exposed for the tests that assert what
  // was said.
  async settled(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const mine = this.generation;
      const queued = this.queue.shift();
      if (queued === undefined) break;

      // Overtaken by events while it waited. Saying it now would describe a world that has
      // already moved on, which is worse than saying nothing.
      if (this.now() - queued.at > this.staleAfterMs) continue;
      const text = queued.text;

      let wav: Uint8Array;
      try {
        wav = await this.synthesizer.synthesize(text);
      } catch (error) {
        // One bad utterance must not wedge everything behind it. This is M12's lesson from the
        // other side: there, a short SendInput return had to become a loud error rather than a
        // silent partial write; here, a failure has to be loud AND survivable, because the next
        // thing in the queue may be a confirm question.
        this.report(messageOf(error));
        continue;
      }

      // Interrupted while the engine was working. Playing this now would be the app answering a
      // question the user has already moved on from — the audio equivalent of a stale write.
      if (mine !== this.generation) continue;

      this.reportedFailure = false;
      try {
        await this.shell.play(wav);
      } catch (error) {
        // The contract says play() resolves rather than rejects, but a shell is real code and
        // this loop is the one thing that must not die.
        this.report(messageOf(error));
      }
    }
  }

  private report(message: string): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    this.onFailure(`Couldn't say that out loud: ${message}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
