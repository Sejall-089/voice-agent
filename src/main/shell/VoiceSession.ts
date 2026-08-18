import type { AudioClip, Transcriber } from "../../core/types.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

// The dictation capture session (M8). There is only ONE hotkey now: it opens the command
// bar and starts listening at the same time. So this is no longer a toggle — it is a
// session tied to the bar being open, and the bar's own Enter/Escape drive it:
//
//   idle ──begin()──► recording ──finish()──► transcribing ──► idle (returns the transcript)
//                         │  └──90s cap──► stopped ──finish()──► transcribing
//                         └──abandon()──► idle (silent: you started typing instead)
//
// It never calls the planner. main.ts PULLS a transcript with finish() and feeds it to the
// same runInstruction the typed path uses, which is what keeps one planner call site.
//
// No electron import, injected dependencies: the whole thing is testable headless.

const DEFAULT_MAX_RECORDING_MS = 90_000;
const DEFAULT_MIN_CLIP_MS = 300; // shorter than this is a stray keypress, not speech

const NOTHING_HEARD = "I didn't catch that — nothing was recorded.";

export interface VoiceSessionOptions {
  maxRecordingMs?: number;
  minClipMs?: number;
}

export class VoiceSession {
  private state: VoiceState = "idle";
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  // Audio captured by the 90s cap, held until you press Enter (or walk away).
  private heldClip: AudioClip | null = null;

  private readonly maxRecordingMs: number;
  private readonly minClipMs: number;

  constructor(
    private readonly shell: VoiceShell,
    private readonly transcriber: Transcriber,
    options: VoiceSessionOptions = {},
  ) {
    this.maxRecordingMs = options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.minClipMs = options.minClipMs ?? DEFAULT_MIN_CLIP_MS;
  }

  getState(): VoiceState {
    return this.state;
  }

  // Deliberately not `this.state === s`: an early-return guard narrows `this.state` for the
  // rest of the method, and TypeScript cannot see that enter() reassigns it.
  private is(s: VoiceState): boolean {
    return this.state === s;
  }

  // The bar just opened: start listening.
  async begin(): Promise<void> {
    if (!this.is("idle")) return;

    // Flip state BEFORE awaiting the mic: getUserMedia takes a moment, and a keystroke in
    // that window must be able to abandon a session that is already considered live.
    this.enter("recording");
    this.capTimer = setTimeout(() => void this.stopAtCap(), this.maxRecordingMs);

    try {
      await this.shell.startRecording();
    } catch (error) {
      // Only unwind if nothing else moved us on in the meantime.
      if (this.is("recording")) {
        this.enter("idle");
        this.shell.showResult(`Couldn't start recording: ${messageOf(error)}`);
      }
    }
  }

  // Enter was pressed with nothing typed: stop listening and hand back what was said.
  // Returns "" whenever there is nothing to run — abandoned, blank, too short, or failed.
  async finish(): Promise<string> {
    if (this.state === "idle" || this.state === "transcribing") return "";

    const clip = this.state === "stopped" ? this.heldClip : await this.stopRecording();
    this.heldClip = null;
    if (!clip) return "";

    if (clip.durationMs < this.minClipMs || clip.wav.byteLength === 0) {
      return this.giveUp(NOTHING_HEARD);
    }

    this.enter("transcribing");
    let transcript: string;
    try {
      transcript = await this.transcriber.transcribe(clip);
    } catch (error) {
      return this.giveUp(`Couldn't transcribe that: ${messageOf(error)}`);
    }

    const text = transcript.trim();
    if (text.length === 0) return this.giveUp(NOTHING_HEARD);

    this.enter("idle", text);
    return text;
  }

  // You started typing (or hit Escape). Drop the recording and say NOTHING about it —
  // typing is not an error, and a "didn't catch that" here would be noise.
  async abandon(): Promise<void> {
    if (this.state === "idle") return;
    const wasCapturing = this.state === "recording";
    this.heldClip = null;
    this.enter("idle");
    if (wasCapturing) {
      try {
        await this.shell.cancelRecording();
      } catch {
        // The recording is meant to disappear, and it has.
      }
    }
  }

  // The 90s cap: release the microphone, keep the audio. Nothing is transcribed and
  // nothing runs — Enter still submits it, Escape still throws it away. Holding the mic
  // open is the actual harm; spending whisper CPU on audio you may not want is waste.
  private async stopAtCap(): Promise<void> {
    if (!this.is("recording")) return;
    const clip = await this.stopRecording();
    if (!clip) return;
    this.heldClip = clip;
    this.enter("stopped");
  }

  private async stopRecording(): Promise<AudioClip | null> {
    try {
      return await this.shell.stopRecording();
    } catch (error) {
      this.giveUp(`Couldn't finish recording: ${messageOf(error)}`);
      return null;
    }
  }

  // Every failure lands here: back to idle with an honest message, never stuck in a state
  // where the next hotkey press does nothing.
  private giveUp(message: string): string {
    this.enter("idle");
    this.shell.showResult(message);
    return "";
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
