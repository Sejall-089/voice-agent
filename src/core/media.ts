// The media keys this app can press, and how many times (M18).
//
// THE NAMES AND THE LIMITS LIVE HERE; WHAT WINDOWS CALLS THEM LIVES IN THE SHELL
// (`src/main/shell/mediaKeys.ts`). Exactly the split `core/apps.ts` and `appLaunch.ts` already
// use, for the same reason: the model's entire contribution is choosing one of six names, and
// the virtual-key code it turns into is never something a model supplies. `/core` stays
// OS-agnostic — there is not a keycode in this file.
//
// WHAT THESE TOOLS ACTUALLY CONTROL, stated here because the naming depends on it: the SYSTEM,
// not Spotify. A media key goes to whichever application currently owns the Windows media
// session, which may be Spotify, may be a YouTube tab, and may be nothing at all. Volume keys
// move the whole machine's output level. None of that is Spotify-specific, so none of these are
// named as though it were — and the tools' result text says what was SENT rather than what
// happened, because nothing here can read back a result.

// Derived from the list so the two can never disagree: adding a key here is what adds it to the
// type, and `src/main/shell/mediaKeys.ts` then fails to compile until it has a code for it.
export const MEDIA_KEYS = [
  "volumeUp",
  "volumeDown",
  "mute",
  "playPause",
  "next",
  "previous",
] as const;

export type MediaKey = (typeof MEDIA_KEYS)[number];

export function isMediaKey(value: unknown): value is MediaKey {
  return typeof value === "string" && (MEDIA_KEYS as readonly string[]).includes(value);
}

// How many presses one request may ask for.
//
// Windows moves the system volume by roughly 2% per press of the volume keys, so the default of
// 5 is about a 10% step — a noticeable change that is not a jolt. The ceiling exists because
// "turn it up" must not be able to become a 100-press sweep: each press is a real synthetic key
// event with a real 40ms gap after it (see WindowsInputInjector's CHUNK_DELAY_MS and the
// key-repeat corruption M12.1 found), so 15 is already more than half a second of held
// keyboard, and the honest answer to "turn it way up" is to ask twice.
export const MIN_PRESSES = 1;
export const MAX_PRESSES = 15;
export const DEFAULT_PRESSES = 5;

// Settle how many presses a request means.
//
// TWO DIFFERENT KINDS OF BAD INPUT, DELIBERATELY ANSWERED DIFFERENTLY. A value that is not a
// usable number at all — absent, a string, NaN — means THE MODEL DID NOT SAY, and the answer is
// the default. A number outside the range means it DID say, and said something out of bounds, so
// it is clamped to the nearest end. Collapsing the two would turn "turn it up by 40" into the
// default 5, which is a quieter wrong answer than clamping to the maximum it will actually do.
//
// Fractions are rounded rather than refused: `2.5` is a model being loose about a number, not a
// request that cannot be honoured, and a refusal there would be pedantry the user pays for.
export function clampPresses(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PRESSES;
  const whole = Math.round(value);
  if (whole < MIN_PRESSES) return MIN_PRESSES;
  if (whole > MAX_PRESSES) return MAX_PRESSES;
  return whole;
}

// Whether pressing this key several times means anything.
//
// IT ONLY DOES FOR VOLUME, and getting this wrong is a real bug rather than a tidiness issue.
// `mute` is a TOGGLE: five presses land exactly where they started, so a repeated mute looks
// like the app doing nothing. `playPause` is the same. `next` five times skips five tracks,
// which is not "next" by any reading of the word. So a repeat is honoured for the two keys
// where it is the whole point and forced to one everywhere else — enforced in the shell as well
// as in the tool, because an action arriving with a count the tool would never have sent should
// still not skip five tracks.
export function acceptsRepeat(key: MediaKey): boolean {
  return key === "volumeUp" || key === "volumeDown";
}

// The presses a given key and requested count actually resolve to. One function so the tool and
// the shell cannot disagree about it.
export function pressesFor(key: MediaKey, requested: unknown): number {
  return acceptsRepeat(key) ? clampPresses(requested) : 1;
}

// How each key is described after the fact, for the one sentence the user reads.
//
// IN CORE RATHER THAN BESIDE THE KEYCODES, because the tools build their result text and
// `/core` must not import from `src/main/` at runtime (spec.md §10). It belongs here anyway:
// what to CALL the thing is no more OS-specific than the six names above it.
//
// Every phrase is a thing SENT, never a resulting state, and that wording is load-bearing
// rather than modest: nothing in this app can read the system volume back or ask what is
// playing. "Volume is now 40%" would be a guess dressed as a fact, and "Now playing" would be
// a claim about an application we never spoke to.
//
// NOTE `playPause` IS "play or pause", NOT "play/pause". A slash is printable ASCII, so
// nothing in the speech path strips it (core/speech.ts maps dashes, arrows and quotes but has
// no rule for it) and Piper would voice it as a word. That is M14's "a URL read character by
// character is unbearable" lesson in miniature, so the slash is avoided at the source.
const SENT_LABELS: Record<MediaKey, string> = {
  volumeUp: "volume up",
  volumeDown: "volume down",
  mute: "mute",
  playPause: "play or pause",
  next: "next track",
  previous: "previous track",
};

export function sentLabelFor(key: MediaKey): string {
  return SENT_LABELS[key];
}

// The whole sentence a tool returns. One place, so `systemVolume` and `mediaControl` cannot
// drift into describing the same action two ways.
//
// "Sent volume up 5 times" / "Sent volume up" / "Sent mute". Plain ASCII throughout: an "x5"
// written with a multiplication sign would be rejected by the strict FakeSynthesizer and
// mis-decoded by the real engine, which is precisely the en-dash bug M14 found.
export function sentDescription(key: MediaKey, presses: number): string {
  const label = sentLabelFor(key);
  return presses > 1 ? `Sent ${label} ${presses} times` : `Sent ${label}`;
}
