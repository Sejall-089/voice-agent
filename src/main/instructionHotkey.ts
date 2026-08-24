import { toSpokenLine } from "../core/speech.ts";
import { dictationIsBusy, type StateHolder } from "./dictate.ts";

// THE instruction hotkey handler, extracted from main.ts the same way createOnDictateHotkey and
// createRunInstruction were, and for the same reason: importing main.ts boots electron, so
// anything left inside it is untestable by construction.
//
// That is not an abstract concern here. This file exists because the M14 §8 guard below was
// designed, approved, and then never built — and nothing failed, because there was no test that
// could have failed. It was found by a person driving the real app, which is the most expensive
// way to find a missing `if`.

// What a confirm dialog waiting on screen gets answered with. Deliberately not silence: this
// project's stated worst failure is a hotkey that does nothing, because a dead hotkey and a
// broken app look identical from the outside (spec §4a).
export const CONFIRM_WAITING =
  "There's a confirmation waiting — answer it on screen.";

export interface InstructionHotkeyShell {
  isConfirmPending(): boolean;
  narrate(text: string): void;
  showInput(): Promise<string>;
  // M15. Take down the pointing marker, if there is one. A no-op on an install with vision off,
  // and on one where nothing has been pointed at.
  clearPointer(): void;
}

export interface VoiceLike {
  begin(): Promise<void>;
  finish(): Promise<string>;
}

export interface SpeakerLike {
  speak(text: string): void;
  stop(): void;
}

export interface InstructionHotkeyDeps {
  shell: InstructionHotkeyShell;
  dictation: StateHolder | null;
  voice: VoiceLike | null;
  speech: SpeakerLike | null;
  runInstruction: (instruction: string) => Promise<void>;
}

export function createOnInstructionHotkey(deps: InstructionHotkeyDeps): () => void {
  const { shell, dictation, voice, speech, runInstruction } = deps;

  return (): void => {
    // 1. Dictation and the instruction bar share one microphone AND, while dictation is
    //    running, the same window (shown via showInactive() so it never steals focus from
    //    whatever is being dictated into) — showInput() calling window.focus() mid-dictation
    //    would defeat the entire point. See dictate.ts for the reverse guard.
    if (dictationIsBusy(dictation)) {
      console.log("[main] instruction hotkey ignored - dictation is in progress");
      return;
    }

    // 2. A `dangerous` action is on screen waiting for a yes or no (M14 §8).
    //
    //    Without this, the press starts a SECOND concurrent planner run while the first is
    //    still parked at the confirm gate — and it does real damage on the way: showInput()
    //    calls window.focus(), taking focus off the dialog, and window.show() re-registers the
    //    global Escape that confirm() deliberately released so the dialog's own cancel would
    //    work. Confirmed live: a createEvent invite sat unanswered while a whole second
    //    instruction ran, was spoken, and was displayed over it.
    //
    //    Answering a confirm BY VOICE is deliberately not the fix. That would put speech
    //    recognition on the one gate that must never be bypassed, and a mishearing there is a
    //    worse trade than an incomplete conversational loop — it gets its own milestone with a
    //    real fail-closed design, or it does not happen.
    if (shell.isConfirmPending()) {
      console.log("[main] instruction hotkey ignored - a confirmation is waiting");
      shell.narrate(CONFIRM_WAITING);
      // Through the same cleaner every other utterance goes through, so this line cannot be
      // the one that sends an em dash to the engine.
      speech?.speak(toSpokenLine(CONFIRM_WAITING));
      return;
    }

    // 3. Barge-in. Here as well as in startRecording() on purpose: this fires the instant the
    //    key is pressed, while the microphone takes 160-680ms to warm up, so the app goes
    //    quiet when you reach for it rather than when the mic is ready.
    speech?.stop();

    // 4. And the marker goes with it (M15). A pointing overlay answers a question asked at a
    //    moment; reaching for the hotkey is the clearest possible signal that the moment has
    //    passed. Deliberately AFTER both guards above: a press that was ignored changed nothing,
    //    and should not silently clear the answer to the question still on screen.
    shell.clearPointer();

    void (async () => {
      const typed = shell.showInput(); // resolves on Enter/Escape with whatever was typed
      void voice?.begin(); // ...and it is already listening

      const text = await typed;
      // Nothing typed means you dictated, and Enter was the "stop talking" gesture. If you
      // typed (or dismissed the bar), the session was already abandoned and answers "".
      const instruction =
        text.trim().length > 0 ? text : ((await voice?.finish()) ?? "");

      await runInstruction(instruction);
    })();
  };
}
