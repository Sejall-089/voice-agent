import { describe, it, expect } from "vitest";
import {
  DEFAULT_PERCENT,
  DEFAULT_PRESSES,
  MAX_PERCENT,
  MAX_PRESSES,
  MEDIA_KEYS,
  MIN_PERCENT,
  MIN_PRESSES,
  PERCENT_PER_PRESS,
  acceptsRepeat,
  clampPresses,
  isMediaKey,
  pressesFor,
  pressesForPercent,
  sentDescription,
  volumeChangeDescription,
  exceedsVolumeCap,
  sentLabelFor,
  type MediaKey,
} from "../src/core/media.ts";
import { virtualKeyFor } from "../src/main/shell/mediaKeys.ts";

// The media-key mapping and press policy (M18). Both halves are pure, so this file is all
// literals — nothing here asks the code to produce its own input or its own expectation.

describe("the virtual-key table", () => {
  // WRITTEN OUT HERE, NOT IMPORTED. The whole value of this test is that the numbers were
  // typed twice, independently, from Windows' own WinUser.h names — checking the table against
  // itself would only prove it agrees with itself (CLAUDE.md), and the mistake this is actually
  // guarding against is a transposition between two ADJACENT codes.
  const EXPECTED: Record<MediaKey, number> = {
    volumeUp: 0xaf, // VK_VOLUME_UP
    volumeDown: 0xae, // VK_VOLUME_DOWN
    mute: 0xad, // VK_VOLUME_MUTE
    playPause: 0xb3, // VK_MEDIA_PLAY_PAUSE
    next: 0xb0, // VK_MEDIA_NEXT_TRACK
    previous: 0xb1, // VK_MEDIA_PREV_TRACK
  };

  for (const key of MEDIA_KEYS) {
    it(`maps ${key} to 0x${EXPECTED[key].toString(16).toUpperCase()}`, () => {
      expect(virtualKeyFor(key)).toBe(EXPECTED[key]);
    });
  }

  // THE ONE THAT MATTERS MOST. 0xAE and 0xAF are adjacent, so swapping them is both the easiest
  // mistake to make in that table and the most obvious thing to ship — "turn it up" making the
  // room quieter. Asserted as a relationship rather than only as two values, so a future edit
  // that changed both consistently still fails.
  it("cannot have volume up and down the wrong way round", () => {
    expect(virtualKeyFor("volumeUp")).toBe(0xaf);
    expect(virtualKeyFor("volumeDown")).toBe(0xae);
    expect(virtualKeyFor("volumeUp")).not.toBe(virtualKeyFor("volumeDown"));
    // Up is the HIGHER code. A simple, checkable fact about the pair that a swap breaks.
    expect(virtualKeyFor("volumeUp")).toBeGreaterThan(virtualKeyFor("volumeDown"));
  });

  it("gives every key a distinct code", () => {
    const codes = MEDIA_KEYS.map(virtualKeyFor);
    expect(new Set(codes).size).toBe(MEDIA_KEYS.length);
  });

  // Every code is in the range the injector will actually accept. `pressKey` refuses anything
  // outside 1-254, so a table entry outside it would be a tool that always fails.
  it("keeps every code inside the range the injector accepts", () => {
    for (const key of MEDIA_KEYS) {
      const code = virtualKeyFor(key);
      expect(code, key).toBeGreaterThanOrEqual(1);
      expect(code, key).toBeLessThanOrEqual(254);
    }
  });
});

describe("isMediaKey", () => {
  it("accepts the six and nothing else", () => {
    for (const key of MEDIA_KEYS) expect(isMediaKey(key)).toBe(true);
    for (const bad of ["volumeup", "VolumeUp", "volume_up", "stop", "pause", "", "0xAF"]) {
      expect(isMediaKey(bad), bad).toBe(false);
    }
    expect(isMediaKey(undefined)).toBe(false);
    expect(isMediaKey(null)).toBe(false);
    expect(isMediaKey(0xaf)).toBe(false);
  });
});

// RE-JUSTIFIED when the tool's argument became a percent, rather than just re-run.
//
// These tests did not change and they still pass, but WHAT THEY PROVE changed, and that is
// exactly the situation CLAUDE.md says to re-examine rather than tick off. `clampPresses` used
// to be the user-facing rule: the model passed a press count and this decided what it meant.
// It is now unreachable from anything a model says — `systemVolume` converts a percent through
// `pressesForPercent` and sends an already-clamped count. What is left is the SHELL's defence
// in depth, since WindowsShell re-resolves every `mediaKey` action through `pressesFor`.
//
// So these are kept, with their titles changed from "the model" to "a caller", because an
// action arriving with a count no tool would have sent must still not press a key 400 times.
// They are no longer evidence about what a person's words mean — `pressesForPercent`'s tests
// above are the ones that carry that now.
describe("clampPresses (the shell's defence, no longer the user-facing rule)", () => {
  it("defaults when a caller supplied nothing usable", () => {
    // NOT A NUMBER AT ALL means "no answer given", and the answer to that is the default — a
    // different thing from an out-of-range number, which is an answer that needs correcting.
    expect(clampPresses(undefined)).toBe(DEFAULT_PRESSES);
    expect(clampPresses(null)).toBe(DEFAULT_PRESSES);
    expect(clampPresses("5")).toBe(DEFAULT_PRESSES);
    expect(clampPresses(NaN)).toBe(DEFAULT_PRESSES);
    expect(clampPresses(Infinity)).toBe(DEFAULT_PRESSES);
    expect(clampPresses(-Infinity)).toBe(DEFAULT_PRESSES);
    expect(DEFAULT_PRESSES).toBe(5);
  });

  it("clamps an out-of-range number to the nearest end rather than defaulting", () => {
    expect(clampPresses(0)).toBe(1);
    expect(clampPresses(-3)).toBe(1);
    expect(clampPresses(16)).toBe(15);
    expect(clampPresses(100)).toBe(15);
    expect(MIN_PRESSES).toBe(1);
    expect(MAX_PRESSES).toBe(15);
  });

  it("passes an in-range number through", () => {
    expect(clampPresses(1)).toBe(1);
    expect(clampPresses(5)).toBe(5);
    expect(clampPresses(10)).toBe(10);
    expect(clampPresses(15)).toBe(15);
  });

  it("rounds a fraction instead of refusing it", () => {
    expect(clampPresses(2.5)).toBe(3);
    expect(clampPresses(2.4)).toBe(2);
    // Rounding happens BEFORE the clamp, so 0.4 is still a request for a press, not for none.
    expect(clampPresses(0.4)).toBe(1);
    expect(clampPresses(15.6)).toBe(15);
  });
});

// THE UNITS FIX (found by live testing). `systemVolume`'s argument used to be a press count,
// so "turn the volume up by 10" moved the volume by 20%. Every expected value below is written
// as a LITERAL, not computed from PERCENT_PER_PRESS — deriving them from the constant would
// only prove the function agrees with its own arithmetic, and the thing worth pinning is the
// answer a person gets for the number they said.
describe("pressesForPercent", () => {
  it("converts the percent a person said into presses", () => {
    expect(pressesForPercent(10)).toBe(5); // the default-sized nudge
    expect(pressesForPercent(20)).toBe(10); // the bug's original symptom: 10 used to mean 20%
    expect(pressesForPercent(2)).toBe(1);
    expect(pressesForPercent(30)).toBe(15); // exactly the ceiling
  });

  // ROUNDS HALF UP, so 5% -> 2.5 presses -> 3 presses (6%), not 2 (4%). The error is 1% either
  // way, so the tie is broken on which failure is worse: a small request that under-delivers
  // reads as the app having ignored it, while 1% over is inaudible.
  it("rounds half up, so a small request is never swallowed", () => {
    expect(pressesForPercent(5)).toBe(3); // 2.5 -> 3
    expect(pressesForPercent(7)).toBe(4); // 3.5 -> 4
    expect(pressesForPercent(9)).toBe(5); // 4.5 -> 5
    // And rounds DOWN below the halfway point, which is ordinary rounding, not a bias.
    expect(pressesForPercent(4.9)).toBe(2); // 2.45 -> 2
    expect(pressesForPercent(11)).toBe(6); // 5.5 -> 6
  });

  it("never does nothing: anything above zero is at least one press", () => {
    expect(pressesForPercent(1)).toBe(1); // 0.5 -> 1, and the minimum anyway
    expect(pressesForPercent(0.4)).toBe(1); // 0.2 -> 0 -> floored up to the minimum
    expect(pressesForPercent(0)).toBe(1);
    expect(pressesForPercent(-20)).toBe(1); // direction is a separate argument
    expect(MIN_PERCENT).toBe(2);
  });

  it("clamps a percent above the cap instead of refusing it", () => {
    expect(pressesForPercent(31)).toBe(15);
    expect(pressesForPercent(50)).toBe(15);
    expect(pressesForPercent(100)).toBe(15);
    expect(MAX_PERCENT).toBe(30);
  });

  it("defaults when no amount was given", () => {
    expect(pressesForPercent(undefined)).toBe(5);
    expect(pressesForPercent(null)).toBe(5);
    expect(pressesForPercent("10")).toBe(5); // a string is not an amount
    expect(pressesForPercent(NaN)).toBe(5);
    expect(pressesForPercent(Infinity)).toBe(5);
    expect(DEFAULT_PERCENT).toBe(10);
  });

  // The calibration itself, pinned as a literal with its provenance. Measured live: the default
  // 5 presses moved the volume 28→38 and 14→24. If this ever changes, it is the one number to
  // change, and this assertion is what makes that a deliberate edit rather than a silent drift.
  it("records the measured Windows step as 2% per press", () => {
    expect(PERCENT_PER_PRESS).toBe(2);
    expect(DEFAULT_PERCENT).toBe(DEFAULT_PRESSES * PERCENT_PER_PRESS);
    expect(MAX_PERCENT).toBe(MAX_PRESSES * PERCENT_PER_PRESS);
  });
});

describe("acceptsRepeat / pressesFor", () => {
  // The decision this encodes is not cosmetic: a repeat is meaningful for exactly two keys.
  it("allows a repeat only for the volume keys", () => {
    expect(acceptsRepeat("volumeUp")).toBe(true);
    expect(acceptsRepeat("volumeDown")).toBe(true);
    expect(acceptsRepeat("mute")).toBe(false);
    expect(acceptsRepeat("playPause")).toBe(false);
    expect(acceptsRepeat("next")).toBe(false);
    expect(acceptsRepeat("previous")).toBe(false);
  });

  it("honours a count for volume", () => {
    expect(pressesFor("volumeUp", 3)).toBe(3);
    expect(pressesFor("volumeDown", 12)).toBe(12);
    expect(pressesFor("volumeUp", undefined)).toBe(DEFAULT_PRESSES);
    expect(pressesFor("volumeUp", 99)).toBe(MAX_PRESSES);
  });

  // The bug this exists to prevent, stated as the outcome rather than the rule: a mute asked
  // for five times would TOGGLE FIVE TIMES and land back where it started, looking exactly like
  // the app ignoring the request; five `next` presses would skip five tracks, which is not
  // "next" by any reading of the word.
  it("forces a single press for every key where a repeat would be wrong", () => {
    for (const key of ["mute", "playPause", "next", "previous"] as const) {
      expect(pressesFor(key, 5), key).toBe(1);
      expect(pressesFor(key, 15), key).toBe(1);
      expect(pressesFor(key, undefined), key).toBe(1);
      expect(pressesFor(key, 0), key).toBe(1);
    }
  });

  it("never returns a count outside the range the injector will press", () => {
    for (const key of MEDIA_KEYS) {
      for (const requested of [undefined, -5, 0, 1, 7, 15, 16, 1000, 2.5, NaN, "x"]) {
        const presses = pressesFor(key, requested);
        expect(Number.isInteger(presses), `${key} / ${String(requested)}`).toBe(true);
        expect(presses).toBeGreaterThanOrEqual(MIN_PRESSES);
        expect(presses).toBeLessThanOrEqual(MAX_PRESSES);
      }
    }
  });
});

describe("sentLabelFor", () => {
  // These reach the user, so they are pinned as literals. Every one is phrased as a thing SENT,
  // because nothing in this app can read the volume back or ask what is playing.
  it("describes what was sent, never a resulting state", () => {
    expect(sentLabelFor("volumeUp")).toBe("volume up");
    expect(sentLabelFor("volumeDown")).toBe("volume down");
    expect(sentLabelFor("mute")).toBe("mute");
    // Deliberately not "play/pause": a slash is ASCII so nothing strips it, and Piper would
    // voice it as a word. See the note in core/media.ts.
    expect(sentLabelFor("playPause")).toBe("play or pause");
    expect(sentLabelFor("next")).toBe("next track");
    expect(sentLabelFor("previous")).toBe("previous track");
  });

  it("gives every key a label, and none of them claims a state", () => {
    for (const key of MEDIA_KEYS) {
      const label = sentLabelFor(key);
      expect(label.length, key).toBeGreaterThan(0);
      // "now playing", "is muted", "volume is 40%" — none of these can be known.
      expect(label, key).not.toMatch(/now|playing|is |%|\d/);
      // No slash, for the speech reason above.
      expect(label, key).not.toContain("/");
    }
  });

  describe("sentDescription", () => {
    // RE-JUSTIFIED when the volume wording moved to percent. This used to pin "Sent volume up 5
    // times"; no tool produces a press count any more, so the count parameter is gone and what
    // is left is the single-press keys. Up and down are `volumeChangeDescription`'s, below.
    it("is 'Sent' plus the label, with no count", () => {
      expect(sentDescription("mute")).toBe("Sent mute");
      expect(sentDescription("playPause")).toBe("Sent play or pause");
      expect(sentDescription("next")).toBe("Sent next track");
      expect(sentDescription("previous")).toBe("Sent previous track");
    });

    // RE-JUSTIFIED, not just re-run. This sweep used to forbid "%" outright, across every key,
    // and that rule was the only thing standing between a volume result and "now at 40%". The
    // volume sentences now legitimately contain "%", so the blanket ban cannot be the level
    // rule any more. It is kept here for what it still distinguishes - a toggle or a transport
    // key claiming a state - and the level rule is restated properly below, for the sentences
    // that can actually break it.
    it("never claims a level or a playback state", () => {
      for (const key of MEDIA_KEYS) {
        const text = sentDescription(key);
        expect(text, text).toMatch(/^Sent /);
        expect(text, text).not.toMatch(/%|\d|now|playing|muted|unmuted/i);
        // Plain ASCII only - the strict FakeSynthesizer rejects anything else, and the real
        // engine mis-decodes it (M14).
        expect(text, text).toMatch(/^[ -~]+$/);
      }
    });
  });

  describe("volumeChangeDescription", () => {
    // The sentences, as literals. The percent is presses x 2 - what was SENT.
    it("reports the change that was sent, in percent, always with 'about'", () => {
      expect(volumeChangeDescription("volumeUp", 5, undefined)).toBe("Volume up about 10%");
      expect(volumeChangeDescription("volumeUp", 5, 10)).toBe("Volume up about 10%");
      expect(volumeChangeDescription("volumeDown", 5, undefined)).toBe("Volume down about 10%");
      // Asked for 5; 3 presses went out; the sentence says 6.
      expect(volumeChangeDescription("volumeDown", 3, 5)).toBe("Volume down about 6%");
      expect(volumeChangeDescription("volumeUp", 1, 1)).toBe("Volume up about 2%");
    });

    it("says so when the request was capped, quoting what was asked for", () => {
      expect(volumeChangeDescription("volumeUp", 15, 80)).toBe(
        "Volume up about 30% (my limit per request, you asked for 80%)",
      );
      expect(volumeChangeDescription("volumeDown", 15, 100)).toBe(
        "Volume down about 30% (my limit per request, you asked for 100%)",
      );
      // Exactly the limit withheld nothing, so there is nothing to explain.
      expect(volumeChangeDescription("volumeUp", 15, 30)).toBe("Volume up about 30%");
    });

    // The boundary is decided on PRESSES, by the same rounding the conversion uses: a request
    // counts as capped exactly when `pressesForPercent` had to cut it down.
    it("calls a request capped exactly when the conversion cut it down", () => {
      for (const percent of [0, 1, 5, 29, 30, 30.9, 31, 32, 80, 1000]) {
        const uncapped = Math.round(percent / 2);
        expect(exceedsVolumeCap(percent), String(percent)).toBe(uncapped > 15);
        expect(exceedsVolumeCap(percent), String(percent)).toBe(
          pressesForPercent(percent) < uncapped,
        );
      }
      for (const junk of [undefined, null, "80", Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(exceedsVolumeCap(junk), String(junk)).toBe(false);
      }
    });

    // THE NO-LEVEL RULE, restated for sentences that are allowed to contain a percent.
    //
    // What it has to DISTINGUISH is a change from a level: "about 10%" is the size of the step
    // that was sent; "now at 40%" and "to 50%" are readings of the volume, which nothing in
    // this app can take. So the rule is not "no %" any more but: every number in the sentence
    // is either the step ("about N%", where N is exactly presses x 2) or the user's own request
    // quoted back ("you asked for N%"). Remove those two forms and no digit and no "%" may be
    // left - which is what "now at 40%", "to 50%" or "40% volume" would leave behind.
    const LEVEL_WORDING = /\bnow\b|\b(?:to|at|is|reached|level)\b[^%]*\d+\s*%|\bset to\b/i;

    function strayNumbers(text: string): string {
      return text.replace(/\babout \d+%/g, "").replace(/\byou asked for \d+%/g, "");
    }

    it("states a change and never a resulting level, for every press count and request", () => {
      for (const key of ["volumeUp", "volumeDown"] as const) {
        for (let presses = 1; presses <= 15; presses += 1) {
          for (const requested of [undefined, 1, 5, 10, 30, 31, 50, 80, 100]) {
            const text = volumeChangeDescription(key, presses, requested);
            expect(text, text).toMatch(/^Volume (up|down) about \d+%/);
            expect(text, text).toContain(`about ${presses * 2}%`);
            expect(text, text).not.toMatch(LEVEL_WORDING);
            expect(strayNumbers(text), text).not.toMatch(/\d|%/);
            expect(text, text).toMatch(/^[ -~]+$/);
          }
        }
      }
    });

    // The rule above is only worth having if it can fail. These are the sentences it exists to
    // forbid, checked against the same two predicates - and the allowed ones beside them, so
    // the test proves it tells the two apart rather than rejecting everything with a "%".
    it("the rule itself rejects level wording and accepts change wording", () => {
      const forbidden = [
        "Volume up, now at 40%",
        "Volume is now 40%",
        "Volume up to 50%",
        "Volume set to 50%",
        "Volume up about 10%, now 40%",
        "Volume at 40%",
        "Volume up about 10% to 40%",
      ];
      for (const text of forbidden) {
        expect(LEVEL_WORDING.test(text), text).toBe(true);
        expect(strayNumbers(text), text).toMatch(/\d|%/);
      }

      const allowed = [
        "Volume up about 10%",
        "Volume down about 6%",
        "Volume up about 30% (my limit per request, you asked for 80%)",
      ];
      for (const text of allowed) {
        expect(LEVEL_WORDING.test(text), text).toBe(false);
        expect(strayNumbers(text), text).not.toMatch(/\d|%/);
      }
    });
  });
});
