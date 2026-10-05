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
