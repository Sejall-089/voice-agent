// Type-only, so this file stays a pure contract with no runtime dependency on /core - the
// names and press limits are core's to own (M18), the keycodes are the shell's.
import type { MediaKey } from "../../core/media.ts";

// The portability contract (spec.md §4). The core NEVER calls OS APIs directly —
// it only calls these methods. Porting to another OS = reimplementing this interface.

export interface CapturedContext {
  selectedText: string | null; // v0: current clipboard contents
  activeApp: string | null; // optional (active-win); may be null
  activeWindowTitle: string | null;
  // M19. True when Gmail reports a message open that this app could read. NOT captured by the
  // shell — the planner adds it from the Gmail surface (core/contextHints.ts) — and absent
  // means "not known to be open", never "known to be closed". A bare fact on purpose: no
  // subject, no sender, nothing the email's author wrote ever reaches the planning prompt.
  emailOpen?: boolean;
}

export type LocalAction =
  | { kind: "openUrl"; payload: string }
  | { kind: "copyToClipboard"; payload: string }
  | { kind: "notify"; payload: string }
  // M14. Say this out loud. An ACTION rather than a method on this interface, for the same
  // reason narration is one: the core asks the shell to do a thing, and whether this install
  // can actually speak is the shell's business, not the planner's. A shell with no synthesizer
  // accepts it and does nothing — exactly as `notify` did for every milestone before M10 had
  // anything to narrate. The payload is already speakable (core/speech.ts); nothing downstream
  // rewrites it.
  | { kind: "speak"; payload: string }
  // M18. Start an installed application. THE PAYLOAD IS THE NAME THE USER SAID — not a path,
  // not a command, not a protocol URI. The shell owns the catalog (`core/apps.ts` for the
  // names, `appLaunch.ts` for the commands) and resolves the name against it, so the only
  // thing crossing this boundary from the model's side is a string a person uttered.
  //
  // That asymmetry with `openUrl` is deliberate. `openUrl` carries a resolved URL because a
  // URL is a value the model can legitimately know and the shell can validate on sight; a
  // command line is neither — there is no check that distinguishes a reasonable one from a
  // harmful one, so the model never gets to write one. Same rule as `pointAt`'s coordinates,
  // which come from the OS and never from a model (§6d).
  | { kind: "openApp"; payload: string }
  // M18. Press a media key - system volume, or whatever owns the Windows media session. The
  // same shape of contract as `openApp` above: the payload is ONE OF SIX NAMES
  // (`core/media.ts`), and the virtual-key code it becomes lives in
  // `src/main/shell/mediaKeys.ts`, where the model cannot reach it.
  //
  // `count` is a REQUEST, not an instruction. The shell resolves it through
  // `pressesFor(key, count)`, which clamps it to 1-15 and forces 1 for every key where a
  // repeat is meaningless or harmful - `mute` and `playPause` are toggles that would land back
  // where they started, and five `next` presses skip five tracks, which is not "next" by any
  // reading of the word. See core/media.ts.
  | { kind: "mediaKey"; payload: MediaKey; count?: number };

export interface OSShell {
  // Returns false when the OS refused the combo — another app already owns it. The caller
  // decides what to do about it; silently doing nothing is not an option, because a dead
  // hotkey is indistinguishable from a broken app.
  registerHotkey(combo: string, onTrigger: () => void): boolean;
  getContext(): Promise<CapturedContext>;
  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }>;
  showInput(): Promise<string>; // opens command bar, resolves with typed text
  showResult(text: string): void; // result popup
  confirm(message: string): Promise<boolean>; // yes/no dialog for `dangerous` actions (core/risk.ts)
}
