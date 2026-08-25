import { describe, it, expect } from "vitest";
import {
  checkLocation,
  MAX_FRAME_FRACTION,
  MIN_BOX_AREA,
  SMALL_TARGET_PX,
} from "../src/core/vision/locate.ts";
import { ElementNotFoundError } from "../src/core/errors.ts";
import type { LocateResult, Screenshot } from "../src/core/types.ts";

// The deterministic gate (M15). This is the file that decides whether a model's guess becomes a
// marker on someone's screen, so it is tested against every shape of wrong answer rather than
// against the happy path plus a shrug.
//
// The frame is the one the app actually sends: a 1568x882 downscale of this machine's display.

const SHOT: Screenshot = {
  png: new Uint8Array(0),
  width: 1568,
  height: 882,
  display: { id: 1, x: 0, y: 0, width: 1280, height: 720 },
};

const FRAME_AREA = 1568 * 882; // 1,382,976

function found(
  box: { x: number; y: number; width: number; height: number },
  label = "Send",
): LocateResult {
  return { kind: "found", box, label };
}

// Assert both the type and the reason, not just that it threw. A test that only checks "an
// error came out" passes just as happily when the wrong refusal is produced, and the three
// refusals say genuinely different things to the user.
function refusal(run: () => unknown): ElementNotFoundError {
  try {
    run();
  } catch (error) {
    if (error instanceof ElementNotFoundError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the location was accepted");
}

describe("an answer we can act on", () => {
  it("passes a plausible box straight through", () => {
    const result = checkLocation(found({ x: 1200, y: 100, width: 120, height: 40 }), SHOT, "the send button");
    expect(result).toEqual({
      box: { x: 1200, y: 100, width: 120, height: 40 },
      label: "Send",
    });
  });

  it("falls back to the user's own words when the model labelled nothing", () => {
    const result = checkLocation(found({ x: 10, y: 10, width: 50, height: 50 }, "   "), SHOT, "  the send button  ");
    expect(result.label).toBe("the send button");
  });

  it("accepts a real-sized element flush against the edge of the screen", () => {
    // A panel or a wide button really does sit at the very corner sometimes, and really does
    // come back reported a pixel or two past it. Refusing here would be a silly way to be
    // principled. Sized well above SMALL_TARGET_PX so this test is purely about the edge-
    // tolerance clamp, not entangled with the small-target gate below.
    const result = checkLocation(
      found({ x: 1500, y: 700, width: 80, height: 60 }),
      SHOT,
      "the panel",
    );
    // Clamped back into the frame rather than refused.
    expect(result.box).toEqual({ x: 1500, y: 700, width: 68, height: 60 });
  });
});

describe("the model said it could not find it", () => {
  it("quotes what the user asked for", () => {
    const error = refusal(() =>
      checkLocation({ kind: "notFound", reason: "" }, SHOT, "the send button"),
    );
    expect(error.refusal).toBe("not-found");
    expect(error.message).toBe(`I couldn't find "the send button" on your screen.`);
  });

  it("appends the model's own reason when it gave one", () => {
    const error = refusal(() =>
      checkLocation(
        { kind: "notFound", reason: "I can't see a browser window open." },
        SHOT,
        "the send button",
      ),
    );
    expect(error.message).toBe(
      `I couldn't find "the send button" on your screen — I can't see a browser window open.`,
    );
  });
});

describe("the model found several", () => {
  it("names them rather than picking one", () => {
    const error = refusal(() =>
      checkLocation(
        { kind: "ambiguous", candidates: ["Send", "Send later", "Send and archive"] },
        SHOT,
        "the send button",
      ),
    );
    expect(error.refusal).toBe("ambiguous");
    expect(error.message).toBe(
      `I can see more than one thing that could be "the send button": Send, Send later and ` +
        `Send and archive. Which one?`,
    );
  });

  it("still refuses when it could not even name them", () => {
    const error = refusal(() =>
      checkLocation({ kind: "ambiguous", candidates: ["", "  "] }, SHOT, "a button"),
    );
    expect(error.refusal).toBe("ambiguous");
    expect(error.message).toBe(
      `I can see more than one thing that could be "a button". Can you be more specific?`,
    );
  });
});

// The cases that matter most: the model DID answer, confidently, and the answer is not one we
// will act on. Each of these is a real hedging or coordinate-space failure, not a hypothetical.
describe("an answer we refuse to act on", () => {
  it("refuses a box that runs off the frame by more than the edge tolerance", () => {
    // 1% of 1568 is ~15px of slack. 200px past the edge means the model was answering in some
    // other coordinate space — most likely the native 1920x1080 we downscaled away from.
    const error = refusal(() =>
      checkLocation(found({ x: 1700, y: 100, width: 120, height: 40 }), SHOT, "the send button"),
    );
    expect(error.refusal).toBe("untrustworthy");
  });

  it("refuses a box positioned in the ORIGINAL native resolution", () => {
    // The concrete version of the above, and the single likeliest real failure: coordinates for
    // the 1920x1080 capture arriving against the 1568x882 frame we actually sent. It is exactly
    // the class of bug that produces a confident marker in the wrong place.
    const error = refusal(() =>
      checkLocation(found({ x: 1850, y: 1000, width: 60, height: 30 }), SHOT, "the close button"),
    );
    expect(error.refusal).toBe("untrustworthy");
  });

  it("refuses a negative origin beyond tolerance", () => {
    const error = refusal(() =>
      checkLocation(found({ x: -100, y: 10, width: 50, height: 50 }), SHOT, "the menu"),
    );
    expect(error.refusal).toBe("untrustworthy");
  });

  it("refuses a box covering the whole frame — the hedge", () => {
    const error = refusal(() =>
      checkLocation(found({ x: 0, y: 0, width: 1568, height: 882 }), SHOT, "the send button"),
    );
    expect(error.refusal).toBe("untrustworthy");
  });

  it("refuses just over the frame-fraction ceiling and accepts just under it", () => {
    // Half the frame is the line. A 1568-wide strip is over it at 442 tall and under at 440.
    const over = { x: 0, y: 0, width: 1568, height: 442 };
    const under = { x: 0, y: 0, width: 1568, height: 440 };
    expect(over.width * over.height).toBeGreaterThan(FRAME_AREA * MAX_FRAME_FRACTION);
    expect(under.width * under.height).toBeLessThan(FRAME_AREA * MAX_FRAME_FRACTION);

    expect(refusal(() => checkLocation(found(over), SHOT, "the toolbar")).refusal).toBe(
      "untrustworthy",
    );
    expect(checkLocation(found(under), SHOT, "the toolbar").box).toEqual(under);
  });

  it("refuses a degenerate sliver via MIN_BOX_AREA, below the small-target gate entirely", () => {
    // 7x7 = 49, under the 64 floor. This box is small enough that it would ALSO trip
    // SMALL_TARGET_PX (below), but MIN_BOX_AREA is checked first and produces the more specific
    // "untrustworthy" verdict for anything this degenerate — "imprecise" is reserved for a box
    // that looks like a real, if small, control (see the next test).
    expect(MIN_BOX_AREA).toBe(64);
    expect(refusal(() => checkLocation(found({ x: 10, y: 10, width: 7, height: 7 }), SHOT, "the dot")).refusal).toBe(
      "untrustworthy",
    );
  });

  it("refuses a well-formed but small box as 'imprecise', not 'untrustworthy'", () => {
    // 8x8 = 64 area, exactly clearing MIN_BOX_AREA — so before M15.1 this box was ACCEPTED. It
    // is still a perfectly plausible little control, which is exactly the case the size gate
    // exists for: nothing about its SHAPE is wrong, it is simply too small to trust the model's
    // aim on (see SMALL_TARGET_PX's own comment for the measurement behind that).
    const error = refusal(() => checkLocation(found({ x: 10, y: 10, width: 8, height: 8 }), SHOT, "the dot"));
    expect(error.refusal).toBe("imprecise");
    expect(error.message).toBe(
      `I can see something that's probably "the dot", but it's small enough on screen that I ` +
        `can't point at it reliably — you may need to find it and click it yourself.`,
    );
  });

  it("draws the line at SMALL_TARGET_PX on the box's SHORTER side", () => {
    expect(SMALL_TARGET_PX).toBe(40);
    // Wide but short — a slim horizontal control (a scrollbar handle, a thin toolbar strip).
    // Area is comfortably above MIN_BOX_AREA in both cases, so this isolates the new gate from
    // the old one: only the shorter side crossing 40 should change the verdict.
    expect(
      refusal(() => checkLocation(found({ x: 100, y: 100, width: 200, height: 39 }), SHOT, "the strip"))
        .refusal,
    ).toBe("imprecise");
    expect(
      checkLocation(found({ x: 100, y: 100, width: 200, height: 40 }), SHOT, "the strip").box,
    ).toEqual({ x: 100, y: 100, width: 200, height: 40 });
  });

  it("composes with edge-clamping: a small box flush against the edge is still refused", () => {
    // The original close-button case from before M15.1 — proves the two gates run in the right
    // order: EDGE_TOLERANCE clamps the box back into the frame first, and the small-target check
    // then judges the CLAMPED size, not the raw one, so a small element right at the edge is
    // still correctly refused rather than slipping through because its pre-clamp width (12) once
    // looked bigger than its post-clamp width (8).
    const error = refusal(() =>
      checkLocation(found({ x: 1560, y: -2, width: 12, height: 24 }), SHOT, "the close button"),
    );
    expect(error.refusal).toBe("imprecise");
  });

  it("refuses a zero or negative sized box", () => {
    expect(refusal(() => checkLocation(found({ x: 10, y: 10, width: 0, height: 40 }), SHOT, "x")).refusal).toBe(
      "untrustworthy",
    );
    expect(refusal(() => checkLocation(found({ x: 10, y: 10, width: -40, height: 40 }), SHOT, "x")).refusal).toBe(
      "untrustworthy",
    );
  });

  it("refuses non-finite numbers", () => {
    // Unreachable through JSON, reachable through a fake or a future provider — and every
    // comparison in the bounds check is false against NaN, so without an explicit guard this
    // would sail through as a valid box.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        refusal(() => checkLocation(found({ x: bad, y: 10, width: 40, height: 40 }), SHOT, "x")).refusal,
      ).toBe("untrustworthy");
      expect(
        refusal(() => checkLocation(found({ x: 10, y: 10, width: bad, height: 40 }), SHOT, "x")).refusal,
      ).toBe("untrustworthy");
    }
  });

  it("says the same thing for every untrustworthy shape", () => {
    // One wording, because the user cannot act on the difference between "the box was too big"
    // and "the box was off the frame" — both mean "I don't trust this and I'm not pointing".
    const message = refusal(() =>
      checkLocation(found({ x: 0, y: 0, width: 1568, height: 882 }), SHOT, "the send button"),
    ).message;
    expect(message).toBe(
      `I found something that might be "the send button", but the position I got back doesn't ` +
        `look right — I'd rather not point at the wrong thing.`,
    );
  });
});
