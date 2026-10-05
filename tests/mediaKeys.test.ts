import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRESSES,
  MAX_PRESSES,
  MEDIA_KEYS,
  MIN_PRESSES,
  acceptsRepeat,
  clampPresses,
  isMediaKey,
  pressesFor,
  sentDescription,
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

describe("clampPresses", () => {
  it("defaults when the model said nothing usable", () => {
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
    it("says how many times only when it was more than once", () => {
      expect(sentDescription("volumeUp", 5)).toBe("Sent volume up 5 times");
      expect(sentDescription("volumeDown", 2)).toBe("Sent volume down 2 times");
      expect(sentDescription("volumeUp", 1)).toBe("Sent volume up");
      expect(sentDescription("mute", 1)).toBe("Sent mute");
      expect(sentDescription("next", 1)).toBe("Sent next track");
    });

    // The invariant behind all of them: a result may say what was SENT and must never imply a
    // level or a playback state, because neither can be read back.
    it("never claims a level or a playback state", () => {
      for (const key of MEDIA_KEYS) {
        for (const presses of [1, 5, 15]) {
          const text = sentDescription(key, presses);
          expect(text, text).toMatch(/^Sent /);
          expect(text, text).not.toMatch(/%|now playing|is playing|muted|unmuted/i);
          // Plain ASCII only - the strict FakeSynthesizer rejects anything else, and the real
          // engine mis-decodes it (M14).
          expect(text, text).toMatch(/^[ -~]+$/);
        }
      }
    });
  });
});
