// Mouse presses anywhere on screen, for the status pill (M27, fix B). The pill cannot take
// focus (M23: it must never take the keyboard from whatever the user is typing into), so it never
// blurs, and nothing tells it the user clicked elsewhere. This is what does: while the pill's list
// is open, and only then, something watches the mouse buttons and reports each press with where
// the pointer was.
//
// Mouse buttons ONLY. A key press — a hotkey included — is not a press; nor is a window hiding
// itself or a dialog opening. Measured on the real thing: scripts/pill-outside-click-recon.cjs.
//
// No electron import (same discipline as InputInjector.ts): the real one is
// WindowsPointerWatcher, and the pill's controller is tested against a fake of this.

// Where the pointer was at the press, in the same space electron gives a window's bounds in
// (DIP on the primary display — measured by the recon: a press inside the pill was inside its
// `getBounds()`, 4 of 4).
export interface PointerPoint {
  x: number;
  y: number;
}

export interface PointerPressSource {
  // Start whatever does the watching, BEFORE it is first needed: the real one is a PowerShell
  // host that takes about 1.5 s to start (measured), and a list opened by a click must be watched
  // from that click, not 1.5 s after it. Resolves once it can watch; rejects with an Error if it
  // cannot. Calling it again returns the same promise.
  prepare(): Promise<void>;
  // Report every mouse press from now on, until `stop`. A press made BEFORE this call — the click
  // that opened the list — is never reported.
  watch(onPress: (point: PointerPoint) => void): void;
  // Stop watching. Nothing is reported after this, and nothing is polled.
  stop(): void;
  // Told once if, after `prepare` resolved, it stops being able to watch (its host died).
  onFailure(listener: (reason: string) => void): void;
  dispose(): void;
}
