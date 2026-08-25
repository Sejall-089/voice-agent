import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_FRAME,
  OPENAI_FRAME,
  targetSize,
} from "../src/core/vision/frame.ts";

// What size frame goes to the model (M15) — the arithmetic that decides what every coordinate
// MEANS.
//
// This exists because getting it wrong is silent. The provider rescales the image on its way in
// and the model answers in the space it was given; send a size the provider will change and
// every box comes back offset by that factor, with nothing thrown and no symptom except a marker
// in the wrong place. Measured against a fixture with known element positions: a 1568x823 frame
// sent to OpenAI produced 4/4 boxes OUTSIDE the target button, and 4/4 inside once the frame was
// pre-sized to 1463x768.
//
// Every expectation below is hand-computed, for the same reason the geometry tests' are.

describe("the measured provider rules", () => {
  it("sizes an OpenAI frame to a shortest side of exactly 768", () => {
    // 1568x823 -> scale 768/823 = 0.93317 -> 1463x768. This is the pair the live probe ran on.
    expect(targetSize(1568, 823, OPENAI_FRAME)).toEqual({ width: 1463, height: 768 });
  });

  it("sizes a 16:9 display the same way", () => {
    // 1920x1080 -> 768/1080 = 0.71111 -> 1365x768.
    expect(targetSize(1920, 1080, OPENAI_FRAME)).toEqual({ width: 1365, height: 768 });
  });

  it("caps an Anthropic frame on the LONG edge instead", () => {
    // A different rule, not a different number — 1920x1080 -> 1568/1920 -> 1568x882.
    expect(targetSize(1920, 1080, ANTHROPIC_FRAME)).toEqual({ width: 1568, height: 882 });
  });

  it("keeps the two rules genuinely different", () => {
    // If these ever coincide, someone has quietly made one provider's measurement stand in for
    // the other's — which is exactly the assumption this milestone got caught by.
    const openai = targetSize(1920, 1080, OPENAI_FRAME);
    const anthropic = targetSize(1920, 1080, ANTHROPIC_FRAME);
    expect(openai).not.toEqual(anthropic);
  });
});

describe("what it refuses to do", () => {
  it("never upscales a display that is already small enough", () => {
    // 1024x600's shortest side is already under 768. Enlarging would invent detail and make the
    // request bigger for nothing.
    expect(targetSize(1024, 600, OPENAI_FRAME)).toEqual({ width: 1024, height: 600 });
    expect(targetSize(800, 600, ANTHROPIC_FRAME)).toEqual({ width: 800, height: 600 });
  });

  it("leaves an exactly-sized frame alone rather than re-rounding it", () => {
    // A no-op resize would still cost a resample, and rounding twice is how a frame drifts a
    // pixel away from the size its coordinates were computed against.
    expect(targetSize(1463, 768, OPENAI_FRAME)).toEqual({ width: 1463, height: 768 });
  });

  it("passes the size straight through when no rule is set", () => {
    expect(targetSize(1234, 567, {})).toEqual({ width: 1234, height: 567 });
  });
});

describe("both rules at once", () => {
  it("takes the more restrictive of the two", () => {
    // A very wide display: shortest-side-768 would leave it 2731px wide, which the long-edge cap
    // then has to bring down. The tighter rule has to win, or one of the two is a lie.
    const both = { shortEdge: 768, longEdge: 1568 };
    // 3840x1080: shortEdge scale 768/1080 = 0.7111; longEdge scale 1568/3840 = 0.40833. Smaller
    // wins -> 1568x441.
    expect(targetSize(3840, 1080, both)).toEqual({ width: 1568, height: 441 });
  });

  it("handles a portrait frame, where shortest and longest swap axes", () => {
    // 768x1366 is portrait: the SHORT side is the width. 768/768 = 1, so nothing changes under
    // the OpenAI rule even though the long edge is well past 1568's cousin.
    expect(targetSize(768, 1366, OPENAI_FRAME)).toEqual({ width: 768, height: 1366 });
    // Under Anthropic's long-edge rule the same frame does shrink: 1568/1366 > 1, so no change.
    expect(targetSize(768, 1366, ANTHROPIC_FRAME)).toEqual({ width: 768, height: 1366 });
    // ...but a taller one does: 1000x2000 -> 1568/2000 = 0.784 -> 784x1568.
    expect(targetSize(1000, 2000, ANTHROPIC_FRAME)).toEqual({ width: 784, height: 1568 });
  });
});
