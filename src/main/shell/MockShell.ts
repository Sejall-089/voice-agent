import type { AudioClip } from "../../core/types.ts";
import { BUILT_IN_CATALOG, createAppLauncher, type AppLauncher } from "./appLaunch.ts";
import { pressesFor } from "../../core/media.ts";
import { virtualKeyFor } from "./mediaKeys.ts";
import { approveLabel } from "./confirmLabel.ts";
import type { CapturedContext, ConfirmOptions, LocalAction, OSShell } from "./OSShell.ts";
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
  // Queued answers for askUser(): a string is what was typed ("" included), null is a question
  // dismissed. An empty queue answers null — nobody answered, and a fake must not invent one.
  asks?: (string | null)[];
  // The same hold, for the same reason, for a question: the real `WindowsShell.askUser()` stays
  // pending until a person types a line, and both hotkey guards are about what must be true
  // DURING that wait. When set, askUser() stays pending until the test calls answerAsk().
  holdAsk?: boolean;
  // When set, a `mediaKey` action fails with this message (M18) — the short-write / UIPI-blocked
  // case the real host reports as `KEY ERR`.
  failMediaKeyWith?: string;
  // How long the fake injector pretends the OS took, per press. Non-zero by default: see
  // `pressKeys` below for why a synchronous fake here would be a weaker test than it looks.
  mediaKeyDelayMs?: number;
}

// Headless implementation of the OSShell contract (spec.md §4) and the VoiceShell contract
// (M7). Imports no electron, so the whole core + planner + tools + voice state machine run
// under vitest with no desktop and no microphone. Actions, results, and voice states land
// in public arrays for assertions.
export class MockShell implements OSShell, VoiceShell, SpeechShell {
  public readonly results: string[] = [];
  public readonly actions: LocalAction[] = [];
  public readonly confirmMessages: string[] = [];
  // What the approve button said for each of those dialogs, in the same order — one entry per
  // entry in `confirmMessages`.
  public readonly confirmLabels: string[] = [];
  // Every question that was actually PUT, in order. One refused because the shell was busy is
  // not here: it was never shown to anyone.
  public readonly questions: string[] = [];
  // How many times a waiting question was asked to take focus back (the instruction hotkey).
  public askFocusCalls = 0;
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
  // Every command or protocol URI an `openApp` action actually reached the OS with (M18), in
  // order. Separate from `actions`, which records the NAME that was asked for — the gap
  // between the two is where the catalog does its work, and a test that only saw one of them
  // could not tell "resolved Spotify to its protocol handler" from "passed the word through".
  public readonly launched: string[] = [];
  // Every (virtual key, press count) pair that actually reached the "OS" (M18), in order, and
  // recorded only AFTER the fake injector's delay. `actions` holds what was ASKED FOR — the
  // media-key NAME and the requested count — and this holds what it resolved to. The gap
  // between them is where the keycode table and the repeat policy do their work, so a test
  // that saw only one of the two could not tell a correct mapping from a pass-through.
  public readonly pressed: { vk: number; count: number }[] = [];
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
  private readonly asks: (string | null)[];
  private readonly holdAsk: boolean;
  private pendingAsk: ((answer: string | null) => void) | null = null;
  // Mirrors WindowsShell's `pendingAsk !== null`, and is set as synchronously as that is.
  private askPending = false;
  // THE SAME LAUNCHER THE REAL SHELL BUILDS, over THE SAME built-in catalog — only the `io` is
  // faked (CLAUDE.md: "a fake must never be more lenient than the real thing"). The temptation
  // here was to let `executeAction` record an `openApp` action and return `{ ok: true }` the
  // way it does for every other kind, which is exactly the shape of fake that M13's
  // `FakeCalendar` was: lenient where the real thing is strict, and therefore blind to the one
  // bug it existed to catch. An unknown app name has to fail HERE, with the real matching rules
  // and the real refusal message, or `openApp`'s refusal path is never tested at all.
  private readonly apps: AppLauncher = createAppLauncher(BUILT_IN_CATALOG, {
    spawn: (command: string): Promise<void> => {
      this.launched.push(command);
      return Promise.resolve();
    },
    openExternal: (uri: string): Promise<void> => {
      this.launched.push(uri);
      return Promise.resolve();
    },
  });

  private readonly failMediaKeyWith: string | undefined;
  private readonly mediaKeyDelayMs: number;

  constructor(options: MockShellOptions) {
    this.context = options.context;
    this.inputs = [...(options.inputs ?? [])];
    this.confirms = [...(options.confirms ?? [])];
    this.clips = [...(options.clips ?? [])];
    this.failRecording = options.failRecording;
    this.holdPlayback = options.holdPlayback ?? false;
    this.holdConfirm = options.holdConfirm ?? false;
    this.asks = [...(options.asks ?? [])];
    this.holdAsk = options.holdAsk ?? false;
    this.failMediaKeyWith = options.failMediaKeyWith;
    this.mediaKeyDelayMs = options.mediaKeyDelayMs ?? 1;
  }

  // The fake injector, inline rather than a separate class because it is three lines and one
  // decision — but that decision matters, so it is written out rather than defaulted.
  //
  // ASYNC, WITH A REAL DELAY, AND IT RECORDS ONLY AFTER THE DELAY. The real
  // `WindowsInputInjector.pressKey` is a round trip to a PowerShell host that sleeps 40ms
  // between presses; a fake that resolved in the same tick could only ever prove the CALL
  // happened, never that the PRESS landed before whatever else the test cares about. M16.9
  // shipped a real bug straight through a test that made exactly that substitution — a
  // synchronous fake for an async read — and a human at the keyboard found it two milestones
  // later (CLAUDE.md).
  //
  // It rejects with a BARE `Error`, which is what the real implementation throws on a short
  // write. Verified against it rather than assumed: `typeText` throws a bare Error too, so
  // there is no typed-error family here to drift away from.
  private async pressKeys(vk: number, count: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.mediaKeyDelayMs));
    if (this.failMediaKeyWith !== undefined) throw new Error(this.failMediaKeyWith);
    this.pressed.push({ vk, count });
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

  confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
    this.confirmMessages.push(message);
    // Through the SAME function the real shell uses, so what is recorded is the label Windows
    // would show — default and blank-label fallback included — and never a more lenient one.
    this.confirmLabels.push(approveLabel(options));
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

  askUser(question: string): Promise<string | null> {
    // The real shell will not ask while something else has the user's attention: it answers
    // null and touches nothing. Mirrored for the two such states this mock can be in, so a test
    // cannot pass here on a question the app would never have shown.
    if (this.confirmPending || this.askPending) return Promise.resolve(null);

    this.questions.push(question);
    // Set BEFORE anything awaits and cleared on every path out — confirm()'s own discipline.
    this.askPending = true;
    if (!this.holdAsk) {
      this.askPending = false;
      return Promise.resolve(this.asks.shift() ?? null);
    }
    return new Promise<string | null>((resolve) => {
      this.pendingAsk = resolve;
    });
  }

  // Is a question open, waiting for a typed answer? What both hotkey guards read in the real
  // app (WindowsShell.isAskPending).
  isAskPending(): boolean {
    return this.askPending;
  }

  // Test helper: answer a held question, as a person at the keyboard would — a line of text
  // ("" is a real answer), or null for Escape. With no argument it falls back to the queue, so
  // `asks` and `holdAsk` can be used together, exactly like answerConfirm().
  answerAsk(answer?: string | null): void {
    const pending = this.pendingAsk;
    this.pendingAsk = null;
    this.askPending = false;
    pending?.(answer !== undefined ? answer : (this.asks.shift() ?? null));
  }

  // The instruction hotkey's response to a waiting question. Counted, because "it refocused the
  // question" is the one thing that press is supposed to do.
  focusAsk(): void {
    if (this.askPending) this.askFocusCalls += 1;
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
    // M18. Recorded like any other side effect, and then actually RESOLVED — so an unknown
    // name comes back `{ ok: false }` here just as it would on Windows. See the `apps` field.
    if (action.kind === "openApp") return this.apps.launch(action.payload);
    // M18. Resolved through the SAME `pressesFor` and `virtualKeyFor` the real shell uses, so
    // the mock is never more lenient than Windows (CLAUDE.md): a `mute` asked for five times
    // is recorded as one press here exactly as it would be pressed once there, and a thrown
    // short write comes back as { ok: false } with the host's message rather than as a
    // rejection no caller expects.
    if (action.kind === "mediaKey") {
      const presses = pressesFor(action.payload, action.count);
      return this.pressKeys(virtualKeyFor(action.payload), presses).then(
        () => ({ ok: true }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
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
