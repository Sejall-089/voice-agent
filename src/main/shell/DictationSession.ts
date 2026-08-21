import type { AudioClip, Transcriber } from "../../core/types.ts";
import type { ForegroundWindow, InputInjector } from "./InputInjector.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

// System-wide dictation (M12): hold nothing, tap a SEPARATE hotkey to start, tap it again to
// stop-and-type into whatever OS window currently has focus — in ANY app, not just this one.
//
// Deliberately NOT the instruction bar's model. That one hotkey (M8) works because Enter is
// already there once the bar is open and focused (spec.md §4a) — but the bar stealing focus
// is exactly what dictation must never do (it is about the app you are ALREADY in), so
// there is nothing for an "Enter" gesture to land on. This is M7's original toggle shape
// instead, one tap to start and one to finish, reused for a different target.
//
//   idle ──toggle()──► recording ──toggle()──► transcribing ──► inserting ──► idle
//            │              └──cap (30s)──► stopped ──toggle()──►┘
//            └──abandon()──► idle (silent, mirrors VoiceSession)
//
// Shares WindowsShell's existing voiceState field and showVoiceState/hasUnsubmittedAudio/
// pinnedAgainstBlur plumbing with VoiceSession rather than adding a parallel "busy" concept
// (see VoiceShell.ts's note on "inserting") — the two are mutually exclusive at runtime
// because they share the one microphone (main.ts arbitrates), so one field safely serves
// both machines.
//
// No electron import — same discipline as VoiceSession — so this runs headless under vitest.

const DEFAULT_MAX_RECORDING_MS = 30_000; // a SAFETY CEILING for a forgotten stop-tap, not a
// typical session length: dictation's normal ending is the second tap, and 30s is short
// enough on purpose — unlike the instruction bar's 90s cap, a dictation take runs silently
// in the background with no bar to look at, so a stray hotkey press that is never followed
// up should not hold someone's microphone open for a minute and a half. Flagged in the M12
// plan as a value that may need adjusting after real live use — hence a named, tunable
// constant rather than a literal.
const DEFAULT_MIN_CLIP_MS = 300; // shorter than this is a stray keypress, not speech

const NOTHING_HEARD = "I didn't catch that — nothing was typed.";

export interface DictationSessionOptions {
  maxRecordingMs?: number;
  minClipMs?: number;
}

// The shell surface dictation needs: the same microphone primitives VoiceShell already
// defines, plus `narrate` (WindowsShell.narrate — the same commandbar:status channel M10
// wired for `caution`-tool narration) to name the window it is about to type into before it
// types into it.
export interface DictationShell extends VoiceShell {
  narrate(text: string): void;
}

export class DictationSession {
  private state: VoiceState = "idle";
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  // Audio captured by the 30s cap, held until the next tap (or abandon()).
  private heldClip: AudioClip | null = null;
  // Where focus was when recording began — re-checked right before typing, so a focus
  // change while speaking or transcribing refuses rather than typing into the wrong window.
  private target: ForegroundWindow | null = null;

  private readonly maxRecordingMs: number;
  private readonly minClipMs: number;

  constructor(
    private readonly shell: DictationShell,
    private readonly transcriber: Transcriber,
    private readonly injector: InputInjector,
    options: DictationSessionOptions = {},
  ) {
    this.maxRecordingMs = options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.minClipMs = options.minClipMs ?? DEFAULT_MIN_CLIP_MS;
  }

  getState(): VoiceState {
    return this.state;
  }

  private is(s: VoiceState): boolean {
    return this.state === s;
  }

  // The dictation hotkey. idle -> start listening; recording/stopped -> stop and type;
  // transcribing/inserting -> already running, ignored (nothing safe to interrupt mid-flight).
  async toggle(): Promise<void> {
    if (this.is("idle")) {
      await this.begin();
      return;
    }
    if (this.is("recording") || this.is("stopped")) {
      await this.stopAndType();
    }
    // transcribing / inserting: a repeat tap while already committed to acting is ignored,
    // not queued — there is nothing safe to do with a second tap once typing may already be
    // under way.
  }

  private async begin(): Promise<void> {
    // Captured BEFORE the microphone opens (which takes a moment), and BEFORE anything is
    // narrated — the whole point is knowing where text will land before you speak, not after.
    try {
      this.target = await this.injector.getForegroundWindow();
    } catch {
      this.target = null;
    }

    this.enter("recording");
    this.shell.narrate(`Dictating into — ${this.target?.title ?? "the focused window"}`);
    this.capTimer = setTimeout(() => void this.stopAtCap(), this.maxRecordingMs);

    try {
      await this.shell.startRecording();
    } catch (error) {
      if (this.is("recording")) {
        this.enter("idle");
        this.shell.showResult(`Couldn't start recording: ${messageOf(error)}`);
      }
    }
  }

  private async stopAndType(): Promise<void> {
    const clip = this.is("stopped") ? this.heldClip : await this.stopRecording();
    this.heldClip = null;
    if (!clip) return;

    if (clip.durationMs < this.minClipMs || clip.wav.byteLength === 0) {
      this.giveUp(NOTHING_HEARD);
      return;
    }

    this.enter("transcribing");
    let transcript: string;
    try {
      transcript = await this.transcriber.transcribe(clip);
    } catch (error) {
      this.giveUp(`Couldn't transcribe that: ${messageOf(error)}`);
      return;
    }

    const text = transcript.trim();
    if (text.length === 0) {
      this.giveUp(NOTHING_HEARD);
      return;
    }

    // Re-check focus immediately before typing — the entire capture (speaking, whisper) took
    // real time, and the one thing worse than refusing is typing a paragraph of dictated text
    // into a window the user has since moved on from, with no undo.
    let current: ForegroundWindow | null;
    try {
      current = await this.injector.getForegroundWindow();
    } catch {
      current = null;
    }
    if (!this.focusUnchanged(current)) {
      this.giveUp(`Focus moved before I could type that — nothing was typed. You said: "${text}"`);
      return;
    }

    this.enter("inserting");
    try {
      await this.injector.typeText(text);
    } catch (error) {
      this.giveUp(`${messageOf(error)} Nothing was typed. You said: "${text}"`);
      return;
    }

    this.enter("idle", text);
    this.shell.showResult(`Typed: "${text}"`);
  }

  private focusUnchanged(current: ForegroundWindow | null): boolean {
    // No captured target (couldn't read it at begin()) means there is nothing to compare
    // against — refuse rather than guess it is safe to type.
    if (this.target === null || current === null) return false;
    return current.handle === this.target.handle;
  }

  // You hit Escape, clicked away, or the window closed. Silent, like VoiceSession's abandon —
  // an explicit cancel is not an error.
  async abandon(): Promise<void> {
    if (this.is("idle")) return;
    const wasCapturing = this.is("recording");
    this.heldClip = null;
    this.target = null;
    this.enter("idle");
    if (wasCapturing) {
      try {
        await this.shell.cancelRecording();
      } catch {
        // The recording is meant to disappear, and it has.
      }
    }
  }

  // The 30s cap: release the microphone, keep the audio, act on neither. Mirrors
  // VoiceSession's stopAtCap() exactly, for the same reason — holding the mic open is the
  // actual harm; spending whisper CPU (or typing) on a take the user has not asked to finish
  // yet would be worse.
  private async stopAtCap(): Promise<void> {
    if (!this.is("recording")) return;
    const clip = await this.stopRecording();
    if (!clip) return;
    this.heldClip = clip;
    this.enter("stopped");
    this.shell.narrate("Recording paused at 30s — tap again to type it, or Esc to discard.");
  }

  private async stopRecording(): Promise<AudioClip | null> {
    try {
      return await this.shell.stopRecording();
    } catch (error) {
      this.giveUp(`Couldn't finish recording: ${messageOf(error)}`);
      return null;
    }
  }

  private giveUp(message: string): void {
    this.enter("idle");
    this.shell.showResult(message);
  }

  private enter(state: VoiceState, detail?: string): void {
    if (this.capTimer !== null) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
    this.state = state;
    this.shell.showVoiceState(state, detail);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
