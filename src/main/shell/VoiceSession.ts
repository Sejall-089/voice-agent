import type { AudioClip, Transcriber } from "../../core/types.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

// The tap-to-toggle state machine (M7). ONE hotkey drives all of it, so the current state
// — not timing, not how long the key was held — decides what a press means:
//
//   idle ──press──► recording ──press──► transcribing ──► idle
//                       └────── 90s cap ──────┘
//
// It is a plain class with injected dependencies and no electron import, so the whole
// toggle behaviour is testable headless, exactly like the planner.
//
// What it deliberately does NOT do: talk to the planner. It hands the transcript to the
// `onTranscript` callback main.ts gives it — the same callback the typed path uses — so
// there is only ever one planner call site.

const DEFAULT_MAX_RECORDING_MS = 90_000; // an accidental left-open recording stops itself
const DEFAULT_MIN_CLIP_MS = 300; // shorter than this is a stray double-tap, not speech

const NOTHING_HEARD = "I didn't catch that — nothing was recorded.";

export interface VoiceSessionOptions {
  maxRecordingMs?: number;
  minClipMs?: number;
}

export class VoiceSession {
  private state: VoiceState = "idle";
  private capTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly maxRecordingMs: number;
  private readonly minClipMs: number;

  constructor(
    private readonly shell: VoiceShell,
    private readonly transcriber: Transcriber,
    // Where a finished transcript goes. main.ts passes the same function the typed path
    // uses, which is what makes voice "just another way to produce the string".
    private readonly onTranscript: (text: string) => Promise<void>,
    options: VoiceSessionOptions = {},
  ) {
    this.maxRecordingMs = options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.minClipMs = options.minClipMs ?? DEFAULT_MIN_CLIP_MS;
  }

  getState(): VoiceState {
    return this.state;
  }

  // The single hotkey entry point. Branches on state — never on timing.
  async toggle(): Promise<void> {
    switch (this.state) {
      case "idle":
        return this.start();
      case "recording":
        return this.stopAndTranscribe();
      case "transcribing":
        // Decided behaviour: a press while whisper is still running is IGNORED. Starting a
        // fresh capture here would race the transcript already in flight, and the user has
        // no way to tell which one produced the action. The bar reads "Transcribing…", so
        // the no-op is visible rather than mysterious.
        return;
    }
  }

  // Escape while recording: throw the audio away, run nothing.
  async cancel(): Promise<void> {
    if (this.state !== "recording") return;
    this.enter("idle");
    try {
      await this.shell.cancelRecording();
    } catch {
      // Nothing to report: the user asked for this recording to disappear, and it has.
    }
  }

  private async start(): Promise<void> {
    // Flip the state BEFORE awaiting the mic. getUserMedia takes a moment, and a double-tap
    // during that window must read as start-then-stop, never as two overlapping captures.
    this.enter("recording");
    this.capTimer = setTimeout(() => void this.autoStop(), this.maxRecordingMs);

    try {
      await this.shell.startRecording();
    } catch (error) {
      // Only unwind if that second tap didn't already move us on.
      if (this.state === "recording") {
        this.enter("idle");
        this.shell.showResult(`Couldn't start recording: ${messageOf(error)}`);
      }
    }
  }

  // The recording cap. Runs the SAME path as a manual second press, so a forgotten
  // recording still transcribes and still acts — it just stops deciding for itself when.
  private async autoStop(): Promise<void> {
    if (this.state !== "recording") return;
    await this.stopAndTranscribe();
  }

  private async stopAndTranscribe(): Promise<void> {
    this.enter("transcribing"); // also clears the cap timer

    let clip: AudioClip;
    try {
      clip = await this.shell.stopRecording();
    } catch (error) {
      return this.abort(`Couldn't finish recording: ${messageOf(error)}`);
    }

    if (clip.durationMs < this.minClipMs || clip.wav.byteLength === 0) {
      return this.abort(NOTHING_HEARD);
    }

    let transcript: string;
    try {
      transcript = await this.transcriber.transcribe(clip);
    } catch (error) {
      return this.abort(`Couldn't transcribe that: ${messageOf(error)}`);
    }

    const text = transcript.trim();
    if (text.length === 0) {
      return this.abort(NOTHING_HEARD);
    }

    // Back to idle BEFORE handing the transcript on. The planner call is slow and may open
    // a confirm dialog; the hotkey has to be live again the moment voice's own work is
    // done, and a hung planner must never strand the session mid-state.
    this.enter("idle", text);
    try {
      await this.onTranscript(text);
    } catch (error) {
      this.shell.showResult(`Something went wrong: ${messageOf(error)}`);
    }
  }

  // Every failure lands here: back to idle, say why. There is no path that leaves the
  // session in a state where the hotkey does nothing.
  private abort(message: string): void {
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
