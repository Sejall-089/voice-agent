// What Windows calls each media key (M18). The shell half of `core/media.ts`.
//
// IMPORTS NO ELECTRON, for the reason `appLaunch.ts` does not: the mapping is ordinary logic,
// and CLAUDE.md's rule is that the testable part comes apart from the transport. The transport
// here is `WindowsInputInjector.pressKey`, which is injected everywhere this is used.
//
// These are the standard Windows virtual-key codes (`VK_VOLUME_*` / `VK_MEDIA_*` in
// WinUser.h). They are written here as literals and asserted in tests/mediaKeys.test.ts as
// INDEPENDENTLY-WRITTEN literals rather than by importing this table — checking a table against
// itself only proves it agrees with itself (CLAUDE.md). The pairs that matter most are
// 0xAE/0xAF: volume down and up are adjacent codes, so a transposition is both the easiest
// mistake to make here and the most obviously wrong thing to ship.

import type { MediaKey } from "../../core/media.ts";

// `Record<MediaKey, number>` makes this EXHAUSTIVE AT COMPILE TIME: adding a key to
// `MEDIA_KEYS` in core breaks this file until it has a code, which is strictly stronger than
// `appLaunch.ts`'s module-level throw and needs no runtime check at all.
const VIRTUAL_KEYS: Record<MediaKey, number> = {
  volumeUp: 0xaf, // VK_VOLUME_UP
  volumeDown: 0xae, // VK_VOLUME_DOWN
  mute: 0xad, // VK_VOLUME_MUTE
  playPause: 0xb3, // VK_MEDIA_PLAY_PAUSE
  next: 0xb0, // VK_MEDIA_NEXT_TRACK
  previous: 0xb1, // VK_MEDIA_PREV_TRACK
};

export function virtualKeyFor(key: MediaKey): number {
  return VIRTUAL_KEYS[key];
}

// How this key is described after the fact, for the one sentence the user reads.
//
// Phrased as what was SENT, never as a resulting state, and that wording is load-bearing
// rather than cautious: nothing in this app can read the system volume back or ask what is
// playing. "Volume is now 40%" would be a guess dressed as a fact, and "Now playing" would be
// a claim about an application we never spoke to.
const SENT_LABELS: Record<MediaKey, string> = {
  volumeUp: "volume up",
  volumeDown: "volume down",
  mute: "mute",
  playPause: "play/pause",
  next: "next track",
  previous: "previous track",
};

export function sentLabelFor(key: MediaKey): string {
  return SENT_LABELS[key];
}
