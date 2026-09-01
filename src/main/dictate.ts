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
//
// M12.1 (Enter replaces the same-hotkey stop, see DictationSession.ts) widened the dictation
// side of this: since Enter is now a shared trigger both flows can reach for, the dictation
// hotkey must also be blocked while the instruction bar is simply OPEN (a pending
// showInput(), even with no voice activity — e.g. mid-typing, after commandbar:typing already
// abandoned voice) — not just while voice itself is recording. Otherwise the bar's own
// Enter-to-submit and dictation's Enter-to-finish could both fire from one keypress.

export interface StateHolder {
  getState(): string;
}

export interface Startable {
  begin(): Promise<void>;
}

// The dictation hotkey handler. Blocked (and logged, never silently) whenever the instruction
// bar is busy in the sense `busyState` reports — see combineInstructionBusy below for what
// "busy" means once Enter is a shared trigger.
export function createOnDictateHotkey(
  dictation: Startable,
  busyState: StateHolder | null,
): () => void {
  return (): void => {
    if (busyState && busyState.getState() !== "idle") {
      console.log("[dictate] hotkey ignored - an instruction is already being captured");
      return;
    }
    void dictation.begin();
  };
}

// The guard the instruction hotkey's own handler applies before it does anything (called
// from main.ts, not wrapped here, since that handler also owns showInput()/voice.begin()
// wiring this module has no reason to know about).
export function dictationIsBusy(dictation: StateHolder | null): boolean {
  return dictation !== null && dictation.getState() !== "idle";
}

export interface InputCapturing {
  isInputCapturing(): boolean;
  // M14 §8: a confirm dialog awaiting an answer blocks this hotkey too. Dictation would grab
  // the shared microphone and type into whatever has focus — which, with a modal dialog up,
  // is the dialog.
  isConfirmPending(): boolean;
}

// Just enough of core/chainState.ts's ChainState to guard on (M17), declared here the same way
// `StateHolder` and `InputCapturing` are: what this file needs, not where it comes from.
export interface ChainRunning {
  isRunning(): boolean;
}

// Combines "is voice mid-capture" with "is the instruction bar open at all" into the single
// StateHolder createOnDictateHotkey expects. Necessary now that Enter is a shared global
// trigger (M12.1): the bar's own Enter-to-submit and dictation's Enter-to-finish must never
// both be live at once, so the dictation hotkey has to stay blocked for the bar's ENTIRE open
// lifetime, not just the portion where voice happens to still be recording.
//
// M17 adds the chain. A chain acts inside Chrome for the length of three steps, and dictation
// would grab the shared microphone and start typing into whatever holds focus while it does —
// which, mid-chain, is very likely the reply box the chain is in the middle of writing. Same
// reasoning as the confirm case above, over a much longer window.
export function combineInstructionBusy(
  voice: StateHolder | null,
  shell: InputCapturing,
  chain: ChainRunning | null = null,
): StateHolder {
  return {
    getState: () => {
      if (shell.isConfirmPending()) return "confirming";
      if (chain?.isRunning() === true) return "chaining";
      if (shell.isInputCapturing()) return "capturing";
      return voice ? voice.getState() : "idle";
    },
  };
}
