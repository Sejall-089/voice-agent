import type {
  LocateResult,
  Screenshot,
  VisionLocator,
} from "../src/core/types.ts";

// Deterministic stand-in for the vision model (M15) — no network, no API key, no image.
//
// WHAT THIS FAKE DELIBERATELY DOES NOT DO: it does not go through `parseLocateResponse`, and it
// does not share a line of code with `AnthropicVisionLocator`. It hands back `LocateResult`s
// directly. M13's rule is that a fake written in terms of the code under test only proves the
// code agrees with itself — `FakeCalendar` matched substrings where Google ANDs its terms, and
// the bug it existed to catch was invisible underneath it. So the wire-shape parsing is tested
// separately against literal payloads (tests/visionPrompt.test.ts) and this fake exercises the
// layer above it.
//
// THE ANSWERS IT REPLAYS ARE NOT ALL WELL-BEHAVED, and that is the point. A model that returns a
// tidy box for everything is not the model this code has to survive: scripts/vision-recon.mjs
// exists to find out what the real one does when the thing is not on screen (V2) or when several
// things match (V3), and until it has been run against a real key, the adversarial cases below
// are the honest stand-in for "we do not yet know that it declines".
export class FakeVisionLocator implements VisionLocator {
  // What it was asked, in order — so a test can prove the target text and the actual captured
  // frame both reached the model, rather than assuming the wiring.
  public readonly asked: { target: string; shot: Screenshot }[] = [];

  private readonly answers: LocateResult[];
  private readonly failure: Error | undefined;

  constructor(answers: LocateResult | LocateResult[], failure?: Error) {
    this.answers = Array.isArray(answers) ? [...answers] : [answers];
    this.failure = failure;
  }

  // A locator that always throws — an unreachable API, a rejected key.
  static failing(error: Error): FakeVisionLocator {
    return new FakeVisionLocator([], error);
  }

  locate(shot: Screenshot, target: string): Promise<LocateResult> {
    this.asked.push({ target, shot });
    if (this.failure) return Promise.reject(this.failure);
    // Running out of canned answers means the test asked more than it set up. Falling back to a
    // plausible box would quietly turn that into a passing test about nothing.
    const next = this.answers.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`FakeVisionLocator: no answer queued for ${target}`));
    }
    return Promise.resolve(next);
  }
}

// Named fixtures for the shapes that matter, so the tests read as scenarios rather than as
// coordinate soup. All are in the 1568x882 image space of tests/FakeScreen.ts's RECON_SHOT.
export const VISION: Record<string, LocateResult> = {
  // A send button in the top right — the demo case.
  sendButton: { kind: "found", box: { x: 1200, y: 100, width: 120, height: 40 }, label: "Send" },
  // Nothing matched, with a reason worth repeating to the user.
  notFound: { kind: "notFound", reason: "there's no browser window open" },
  // Several matched.
  ambiguous: { kind: "ambiguous", candidates: ["Send", "Send later"] },
  // The hedge: asked to find something it cannot see, it boxes the entire screen. This is the
  // failure the deterministic gate exists for.
  wholeScreen: { kind: "found", box: { x: 0, y: 0, width: 1568, height: 882 }, label: "the window" },
  // Coordinates for the 1920x1080 capture, against the 1568x882 frame we actually sent — the
  // likeliest coordinate-space mistake, and one that would otherwise land a confident marker in
  // the wrong place.
  nativeCoordinates: {
    kind: "found",
    box: { x: 1850, y: 1000, width: 60, height: 30 },
    label: "Close",
  },
};
