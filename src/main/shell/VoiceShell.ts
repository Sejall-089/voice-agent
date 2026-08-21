import type { AudioClip } from "../../core/types.ts";

// The voice side of the shell (M7). Deliberately NOT part of OSShell: OSShell is the
// contract /core depends on (spec.md §4), and the core brain has no business knowing a
// microphone exists. Voice capture is main-process wiring, so it gets its own parallel
// contract here. WindowsShell implements both; a future Mac shell would too.
// "inserting" (M12): shared with DictationSession, which reuses this exact state machine —
// idle -> recording -> transcribing -> inserting -> idle — and the same showVoiceState/
// hasUnsubmittedAudio/pinnedAgainstBlur plumbing WindowsShell already has for voice, rather
// than a second parallel "busy" concept. The two are mutually exclusive at runtime (they
// share the one MicRecorder in the renderer — main.ts enforces this), so one field safely
// serves both.
export type VoiceState = "idle" | "recording" | "stopped" | "transcribing" | "inserting";

export interface VoiceShell {
  startRecording(): Promise<void>;
  // Stops capture and resolves with what was recorded.
  stopRecording(): Promise<AudioClip>;
  // Stops capture and throws the audio away — no transcript, no action.
  cancelRecording(): Promise<void>;
  // The "you are being recorded" cue. `detail` carries the transcript on the way back to
  // idle, so the user sees what was heard before the action runs.
  showVoiceState(state: VoiceState, detail?: string): void;
  // Already on OSShell — listed so VoiceSession can report failures without depending on
  // the whole OSShell surface. Any real shell satisfies it for free.
  showResult(text: string): void;
}
