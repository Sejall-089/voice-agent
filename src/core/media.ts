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
// The ceiling exists because "turn it up" must not be able to become a 100-press sweep: each
// press is a real synthetic key event with a real 40ms gap after it (see
// WindowsInputInjector's CHUNK_DELAY_MS and the key-repeat corruption M12.1 found), so 15 is
// already more than half a second of held keyboard, and the honest answer to "turn it way up"
// is to ask twice.
export const MIN_PRESSES = 1;
export const MAX_PRESSES = 15;
export const DEFAULT_PRESSES = 5;

// --- Percent, which is what a person means (fixed after live testing) ---

// How far one press of the volume key moves the system volume.
//
// THIS IS THE WINDOWS DEFAULT AS MEASURED ON ONE MACHINE, NOT A UNIVERSAL CONSTANT. Live
// testing measured the default 5 presses moving the volume 28→38 and 14→24 — 2% per press,
// in both directions, on that hardware. Windows' own step is a registry/driver detail and some
// audio drivers and keyboards do their own thing, so this is a calibration, not a law. If the
// step turns out to differ on another machine, THIS is the one number to change.
export const PERCENT_PER_PRESS = 2;

// The most a single request can move it: 15 presses at 2% each.
export const MAX_PERCENT = MAX_PRESSES * PERCENT_PER_PRESS;
// What one press buys, which is also the smallest change that can be asked for.
export const MIN_PERCENT = MIN_PRESSES * PERCENT_PER_PRESS;
// The step when no amount is given, in the units a person thinks in.
export const DEFAULT_PERCENT = DEFAULT_PRESSES * PERCENT_PER_PRESS;

// Turn the amount A PERSON SAID into key presses.
//
// THE BUG THIS FIXES, found by live testing and worth recording because it was invisible to
// every test: the tool used to take `presses` directly, so "turn the volume up by 10" had the
// model pass 10, and 10 presses moved the volume by 20%. The model was not wrong and the code
// was not wrong — they disagreed about the UNIT. Nobody says "turn it up by ten key presses";
// they mean ten percent. So the argument is now a percent and the conversion lives here, where
// it is one rounded division instead of an assumption spread across a prompt.
//
// ROUNDING IS HALF-UP (`Math.round`), so a requested 5% becomes 3 presses (6%) rather than 2
// (4%). Either way the error is 1%, so the tie is broken on which failure is worse: a small
// request that under-delivers reads as the app having ignored it, which is the complaint M12.2
// fixed in dictation for the same reason. Over-delivering by 1% is inaudible.
//
// A value that is not a usable number means THE MODEL DID NOT SAY, and the answer is the
// default — the same split `clampPresses` makes, and for the same reason: "turn it up" with no
// amount is a complete request, not a malformed one.
export function pressesForPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return DEFAULT_PRESSES;
  const presses = Math.round(percent / PERCENT_PER_PRESS);
  if (presses < MIN_PRESSES) return MIN_PRESSES;
  if (presses > MAX_PRESSES) return MAX_PRESSES;
  return presses;
}

// Settle how many PRESSES a press count means.
//
// NOTE WHAT THIS IS AND IS NOT, because its role narrowed when the tool's argument became a
// percent. This is no longer the user-facing rule — `pressesForPercent` below is. Nothing a
// model says reaches this function any more: `systemVolume` converts a percent to presses and
// the already-clamped result travels on the action. What is left is the SHELL's defence in
// depth (WindowsShell's `mediaKey` case re-resolves every action through `pressesFor`), so an
// action arriving with a count no tool would have sent still cannot press a key 400 times.
//
// TWO DIFFERENT KINDS OF BAD INPUT, DELIBERATELY ANSWERED DIFFERENTLY. A value that is not a
// usable number at all — absent, a string, NaN — means NOTHING WAS SAID, and the answer is the
// default. A number outside the range is a count that was given and is out of bounds, so it is
// clamped to the nearest end rather than discarded.
//
// Fractions are rounded rather than refused: `2.5` is a caller being loose about a number, not a
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
// "Sent mute" / "Sent play or pause" / "Sent next track" — the single-press keys. A volume
// CHANGE is described by `volumeChangeDescription` below instead, in the unit a person asked
// in. Plain ASCII throughout: the first draft's multiplication sign was rejected by the strict
// FakeSynthesizer and mis-decoded by the real engine, which is precisely the en-dash bug M14
// found.
export function sentDescription(key: MediaKey): string {
  return `Sent ${sentLabelFor(key)}`;
}

// Whether a requested percent is more than one request can deliver. Decided on the PRESS COUNT
// it converts to, by the same rounding `pressesForPercent` uses, so the two cannot disagree
// about a value near the boundary (30.4% is 15 presses and is not "capped"; 31% is 16 and is).
export function exceedsVolumeCap(percent: unknown): percent is number {
  return (
    typeof percent === "number" &&
    Number.isFinite(percent) &&
    Math.round(percent / PERCENT_PER_PRESS) > MAX_PRESSES
  );
}

// The sentence `systemVolume` returns for up and down.
//
// IN PERCENT, BECAUSE THAT IS THE UNIT THE REQUEST CAME IN. This used to read "Sent volume up 5
// times", which answered "turn it up by 10" with a number the user never said and had to
// multiply to check — the units bug again, on the way out instead of the way in.
//
// THE PERCENT SHOWN IS presses x PERCENT_PER_PRESS: what was actually SENT, not what was asked
// for. "By 5" sends 3 presses and so reads "about 6%". And it is always "about", because 2% per
// press was measured on one machine (see PERCENT_PER_PRESS) and nothing here can check it.
//
// IT IS STILL A CHANGE AND NEVER A LEVEL. "Volume up about 10%" is the size of the step that
// was sent; "now at 40%" or "to 50%" would be a reading of the volume, which this app cannot
// take. tests/mediaKeys.test.ts holds that line: every number in the sentence must be the step
// or the user's own request quoted back, and nothing else.
//
// A capped request says so, with the number the user asked for, so "turn it up by 80" moving
// 30% does not read as the app having misheard.
//
// "%" RATHER THAN "percent": printable ASCII, so nothing in the speech path touches it, and
// Piper's phonemizer was asked directly — "10%" and "10 percent" produce identical phonemes.
// The parentheses become a comma in core/speech.ts, as every aside does.
export function volumeChangeDescription(
  key: "volumeUp" | "volumeDown",
  presses: number,
  requestedPercent: unknown,
): string {
  const direction = key === "volumeUp" ? "up" : "down";
  const sent = `Volume ${direction} about ${presses * PERCENT_PER_PRESS}%`;
  return exceedsVolumeCap(requestedPercent)
    ? `${sent} (my limit per request, you asked for ${Math.round(requestedPercent)}%)`
    : sent;
}
