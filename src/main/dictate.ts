// THE dictation hotkey call site (M12), extracted the same way createRunInstruction is
// (src/main/runInstruction.ts) — one named thing instead of a closure inside
// app.whenReady(), and directly testable without booting electron.
//
// Its one real job is mutual exclusion: DictationSession and VoiceSession share a single
// microphone (one MicRecorder for the renderer window's whole lifetime — recorder.ts) and,
// while dictation is running, the SAME BrowserWindow the instruction bar uses (shown via
// showInactive() so it never steals focus from whatever the user is dictating into). If the
// instruction hotkey fired mid-dictation, `shell.showInput()` would call `window.focus()` and
// yank focus away from the app being dictated into — exactly the failure this feature exists
// to avoid. So each hotkey's handler checks the OTHER session's state before doing anything.

export interface StateHolder {
  getState(): string;
}

export interface Toggleable {
  toggle(): Promise<void>;
}

// The dictation hotkey handler. Blocked (and logged, never silently) whenever the
// instruction bar's own voice capture is mid-flight — they cannot both hold the microphone.
export function createOnDictateHotkey(
  dictation: Toggleable,
  instructionVoice: StateHolder | null,
): () => void {
  return (): void => {
    if (instructionVoice && instructionVoice.getState() !== "idle") {
      console.log("[dictate] hotkey ignored - an instruction is already being captured");
      return;
    }
    void dictation.toggle();
  };
}

// The guard the instruction hotkey's own handler applies before it does anything (called
// from main.ts, not wrapped here, since that handler also owns showInput()/voice.begin()
// wiring this module has no reason to know about).
export function dictationIsBusy(dictation: StateHolder | null): boolean {
  return dictation !== null && dictation.getState() !== "idle";
}
