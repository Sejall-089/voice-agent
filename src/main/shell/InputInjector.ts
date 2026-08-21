// The system-wide text-insertion contract (M12). Dictation types into whatever OS window
// currently has focus, in ANY app — there is no CDP-equivalent for that on Windows, so this
// is the primitive Chrome's `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` played for
// Gmail/Notion (spec.md §3, §6b): real device-level input, not a JS/DOM call the target can
// silently ignore.
//
// M11's expensive lesson applies again here, harder: `document.execCommand()` reported
// success on Notion's editor and saved nothing. The reason SendInput is the right primitive
// (over UI Automation's ValuePattern.SetValue, over clipboard+Ctrl+V, over SendKeys) is that
// it has a REAL success signal — it returns the count of events the OS actually accepted —
// and this contract is written so that signal can never be swallowed: `typeText` throws
// rather than returning a boolean, so a short write is a thrown error every caller must
// confront, not a silently-ignorable `{ ok: false }`.
//
// No electron import (same discipline as VoiceShell.ts) — this is main-process wiring, not
// something /core touches.

export interface ForegroundWindow {
  // The raw HWND. Only ever compared for equality (has focus moved since we captured this?)
  // — never rendered, never used as an identity beyond that one check.
  handle: number;
  // Best-effort window title, for narration ("Dictating into — Untitled - Notepad"). Null
  // when the OS could not name it; that is not a reason to refuse, only to narrate blindly.
  title: string | null;
}

export interface InputInjector {
  // A snapshot of whatever currently has OS focus. Null only in the rare case nothing does
  // (bare desktop, a secure-desktop UAC prompt) — callers treat that as "nowhere to type".
  getForegroundWindow(): Promise<ForegroundWindow | null>;

  // Insert text at the caret of whatever currently has OS focus, via SendInput +
  // KEYEVENTF_UNICODE — the same signal a physical keyboard produces, keyboard-layout
  // independent, and correct for supplementary-plane characters (emoji) because a UTF-16
  // surrogate pair is just two consecutive code units, each one its own event.
  //
  // Throws if fewer keystrokes were accepted than requested. This is not a fallback path to
  // recover from — it means the OS refused some of the input (most commonly UIPI blocking an
  // unelevated process from typing into an elevated window), and the honest response is a
  // refusal, never a partially-typed, uncorrectable mess left in the user's document.
  typeText(text: string): Promise<void>;

  // Releases the persistent host process backing this injector. Call once, at app shutdown.
  dispose(): void;
}
