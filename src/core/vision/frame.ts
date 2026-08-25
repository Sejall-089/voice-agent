// What size frame to send the vision model, and why it is not a free choice (M15).
//
// THIS IS A MEASURED FINDING, NOT A TUNING KNOB. Providers rescale images on their way in, and
// the model answers coordinates in the space it was GIVEN, not the space we sent. Get this wrong
// and nothing throws: every box comes back offset by the resize factor, and the marker lands
// confidently in the wrong place.
//
// Measured against a fixture with known element positions (a compose window with Send and
// Discard side by side):
//
//   sent 1568x823 to OpenAI  ->  4/4 boxes landed OUTSIDE the target button, ~36px high
//   sent 1463x768 to OpenAI  ->  4/4 boxes landed inside the correct button
//
// 1463x768 is 1568x823 scaled so its SHORTEST side is 768 — which is exactly what OpenAI's
// `detail: "high"` path does to the image itself. Pre-sizing it removes the mismatch at source
// instead of compensating for it with a correction constant that would silently rot if the
// provider's rule changed.
//
// Normalised 0-1 coordinates were tried as the alternative fix and were WORSE: 2/4, and both
// failures landed on a different button entirely.
export interface FramePolicy {
  // Scale so the shortest side is exactly this, when either dimension exceeds it.
  shortEdge?: number;
  // Scale so the longest side is at most this.
  longEdge?: number;
}

// OpenAI, `detail: "high"`: the image is scaled so its shortest side is 768. Match it exactly.
export const OPENAI_FRAME: FramePolicy = { shortEdge: 768 };

// Anthropic resizes images past roughly 1568 on the long edge. UNVERIFIED against a real key —
// Anthropic billing was blocked when this was measured, so unlike the OpenAI number above this
// one is read from documentation rather than from a fixture. Treat it as a starting point for
// whoever runs the recon, not as a measurement.
export const ANTHROPIC_FRAME: FramePolicy = { longEdge: 1568 };

// The size to render a capture at. Pure, so the arithmetic that decides every coordinate's
// meaning is testable without a screen.
//
// Never upscales: a display smaller than the target is already in a space the model can work in,
// and enlarging it would invent detail while making the request bigger.
export function targetSize(
  width: number,
  height: number,
  policy: FramePolicy,
): { width: number; height: number } {
  const scales: number[] = [];
  if (policy.shortEdge !== undefined) {
    scales.push(policy.shortEdge / Math.min(width, height));
  }
  if (policy.longEdge !== undefined) {
    scales.push(policy.longEdge / Math.max(width, height));
  }
  if (scales.length === 0) return { width, height };

  // The most restrictive rule wins, and we never grow.
  const scale = Math.min(1, ...scales);
  if (scale === 1) return { width, height };
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}
