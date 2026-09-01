import type { AudioClip } from "../../core/types.ts";
import type { CapturedContext, LocalAction, OSShell } from "./OSShell.ts";
import type { SpeechShell } from "./SpeechShell.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

export interface MockShellOptions {
  context: CapturedContext;
  inputs?: string[]; // queued return values for showInput()
  confirms?: boolean[]; // queued answers for confirm()
  clips?: AudioClip[]; // queued return values for stopRecording()
  failRecording?: string; // when set, startRecording() rejects with this message
  // When set, play() stays pending until the test calls finishPlayback() or stopPlayback() —
  // the only way to assert what happens DURING an utterance rather than around it.
  holdPlayback?: boolean;
  // The same idea for the confirm dialog (M17), and it exists for the same reason the async
  // `snapshotPointTarget` fake does (CLAUDE.md): a fake that resolves synchronously where the
  // real thing blocks cannot test ordering, only call-sequence.
  //
  // The real `WindowsShell.confirm()` puts a modal dialog on screen and does not return until a
  // person answers it — and the whole M14 §8 guard is about what must be true DURING that wait.
  // With confirms answered instantly there is no "during" to assert on, so a chain test could
  // only ever prove the guard was consulted, never that it held. When set, confirm() stays
  // pending until the test calls answerConfirm().
  holdConfirm?: boolean;
}

// Headless implementation of the OSShell contract (spec.md §4) and the VoiceShell contract
// (M7). Imports no electron, so the whole core + planner + tools + voice state machine run
// under vitest with no desktop and no microphone. Actions, results, and voice states land
// in public arrays for assertions.
export class MockShell implements OSShell, VoiceShell, SpeechShell {
  public readonly results: string[] = [];
  public readonly actions: LocalAction[] = [];
  public readonly confirmMessages: string[] = [];
  public readonly voiceStates: { state: VoiceState; detail?: string }[] = [];
  public readonly thinking: boolean[] = [];
  // narrate() calls (M12: caution-tool narration AND DictationSession's window-title cue
  // share this one list — same channel in the real WindowsShell, so one recording of it here).
  public readonly narrations: string[] = [];
  // Everything the planner asked to be said out loud, in order (M14) — see executeAction below
  // for why this is a list of its own rather than part of `actions`.
  public readonly spoken: string[] = [];
  // Utterances handed to the player, in order, and how many times playback was cut off (M14).
  public readonly played: Uint8Array[] = [];
  public stopPlaybackCalls = 0;
  public recordingsStarted = 0;
  public recordingsStopped = 0;
  public recordingsCancelled = 0;
  // armStopKey/disarmStopKey call counts (M12.1) — a full recording cycle should arm exactly
  // once and disarm exactly once, whatever path it took back to idle.
  public armStopKeyCalls = 0;
  public disarmStopKeyCalls = 0;

  private readonly context: CapturedContext;
  private readonly inputs: string[];
  private readonly confirms: boolean[];
  private readonly clips: AudioClip[];
  private readonly failRecording: string | undefined;
  // Whatever DictationSession last armed via armStopKey() — null once disarmed. Tests fire it
  // with pressStopKey(), the same "simulate the OS/IPC boundary" idea ackVoiceStarted() uses.
  private stopKeyCallback: (() => void | Promise<void>) | null = null;
  private readonly holdPlayback: boolean;
  private pendingPlay: (() => void) | null = null;
  private readonly holdConfirm: boolean;
  private pendingConfirm: ((approved: boolean) => void) | null = null;
  // Mirrors WindowsShell's own `confirmPending`, set synchronously before confirm() awaits
  // anything. It is what the M17 chain tests read to prove the hotkey guard's precondition is
  // actually true while a chain is parked at a dialog.
  private confirmPending = false;

  constructor(options: MockShellOptions) {
    this.context = options.context;
    this.inputs = [...(options.inputs ?? [])];
    this.confirms = [...(options.confirms ?? [])];
    this.clips = [...(options.clips ?? [])];
    this.failRecording = options.failRecording;
    this.holdPlayback = options.holdPlayback ?? false;
    this.holdConfirm = options.holdConfirm ?? false;
  }

  registerHotkey(): boolean {
    // No hotkeys in a headless shell — but nothing ever "fails" here either.
    return true;
  }

  getContext(): Promise<CapturedContext> {
    return Promise.resolve(this.context);
  }

  showInput(): Promise<string> {
    return Promise.resolve(this.inputs.shift() ?? "");
  }

  showResult(text: string): void {
    this.results.push(text);
  }

  // Recorded as a sequence, not a flag: the thing worth asserting is that every `true` is
  // followed by a `false`, on every path out of a planner run.
  showThinking(on: boolean): void {
    this.thinking.push(on);
  }

  confirm(message: string): Promise<boolean> {
    this.confirmMessages.push(message);
    // Set BEFORE anything awaits, and cleared on every path out — the same discipline
    // WindowsShell.confirm() follows, because "the dialog is up" and "the guard knows" must
    // never be observable in different states.
    this.confirmPending = true;
    if (!this.holdConfirm) {
      this.confirmPending = false;
      return Promise.resolve(this.confirms.shift() ?? false);
    }
    return new Promise<boolean>((resolve) => {
      this.pendingConfirm = resolve;
    });
  }

  // Is a confirm dialog on screen awaiting an answer? The property the M14 §8 hotkey guard
  // reads in the real app (WindowsShell.isConfirmPending), so a test can assert the same thing
  // the running app would.
  isConfirmPending(): boolean {
    return this.confirmPending;
  }

  // Test helper: answer a held dialog, as a person at the keyboard would. Falls back to the
  // queued answers so a test can use `confirms` and `holdConfirm` together.
  answerConfirm(approved?: boolean): void {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    this.confirmPending = false;
    pending?.(approved ?? this.confirms.shift() ?? false);
  }

  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }> {
    // Speech gets its own list rather than joining `actions` (M14), the same way `narrate()`
    // calls already do. Two reasons, and neither is convenience: `actions` means "the local
    // side effects a handler asked for", and a dozen existing tests read it as exactly that
    // ("no dialog and no narration" asserts it is empty) — folding speech in would make every
    // one of them assert something about M14 that they are not about. And an assertion surface
    // that is only ever speech is the one a speech test actually wants.
    if (action.kind === "speak") {
      this.spoken.push(action.payload);
      return Promise.resolve({ ok: true });
    }
    this.actions.push(action);
    return Promise.resolve({ ok: true });
  }

  // --- VoiceShell ---

  startRecording(): Promise<void> {
    // THE invariant, enforced where every path to the microphone passes through rather than at
    // each hotkey (M14). VoiceSession and DictationSession both arrive here, and so will
    // anything written later — binding it to the one chokepoint is the same lesson M8 learned
    // when cleanup bound to a single code path leaked on every other one. WindowsShell mirrors
    // this exactly; it lives in both because a shell is what owns the device.
    this.stopPlayback();
    this.recordingsStarted += 1;
    if (this.failRecording !== undefined) {
      return Promise.reject(new Error(this.failRecording));
    }
    return Promise.resolve();
  }

  // Unqueued clips resolve as silence, which is what an empty capture really is.
  stopRecording(): Promise<AudioClip> {
    this.recordingsStopped += 1;
    return Promise.resolve(this.clips.shift() ?? { wav: new Uint8Array(0), durationMs: 0 });
  }

  cancelRecording(): Promise<void> {
    this.recordingsCancelled += 1;
    return Promise.resolve();
  }

  showVoiceState(state: VoiceState, detail?: string): void {
    this.voiceStates.push(detail === undefined ? { state } : { state, detail });
  }

  // Satisfies DictationShell (M12) alongside VoiceShell, so DictationSession tests can wire
  // up a MockShell exactly the way VoiceSession tests already do.
  narrate(text: string): void {
    this.narrations.push(text);
  }

  // --- DictationShell's stop key (M12.1) ---

  armStopKey(onStop: () => void | Promise<void>): void {
    this.armStopKeyCalls += 1;
    this.stopKeyCallback = onStop;
  }

  disarmStopKey(): void {
    this.disarmStopKeyCalls += 1;
    this.stopKeyCallback = null;
  }

  // --- SpeechShell (M14) ---

  // Resolves immediately unless the test asked for playback to be held, which is how "barge in
  // while something is actually playing" becomes expressible rather than a matter of timing.
  play(wav: Uint8Array): Promise<void> {
    this.played.push(wav);
    if (!this.holdPlayback) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingPlay = resolve;
    });
  }

  // Must leave nothing audible AND must let a held play() resolve — SpeechShell's contract says
  // play() resolves when it is cut off, and a queue drained by awaiting it would otherwise be
  // stranded behind an utterance nobody is even hearing.
  stopPlayback(): void {
    this.stopPlaybackCalls += 1;
    const pending = this.pendingPlay;
    this.pendingPlay = null;
    pending?.();
  }

  // Test helper: let a held utterance finish of its own accord, as the real player would.
  finishPlayback(): void {
    const pending = this.pendingPlay;
    this.pendingPlay = null;
    pending?.();
  }

  // Test helper, not part of any real shell interface: simulates the global Enter press.
  // Returns whatever the armed callback returns, so a test can `await` it even though the
  // production signature is nominally void-returning (see WindowsShell.armStopKey's own note
  // on this — the same widening Tool.narrate/confirmSummary already use).
  pressStopKey(): void | Promise<void> {
    return this.stopKeyCallback?.();
  }
}
