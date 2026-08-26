import { describe, expect, it } from "vitest";
import { overlayParams } from "../src/main/screen/PointerOverlay.ts";
import type { PointerTarget, ScreenRect } from "../src/core/types.ts";

// THE STALE-BY-ONE BUG, as a property that can fail (M16.11).
//
// Found by hand, and it is the worst bug this milestone produced: every NEW question drew the
// PREVIOUS question's marker, and only repeating a question verbatim produced the right one.
// Dangerous in a way "always wrong" is not — a first answer looks authoritative, and nothing on
// screen suggests it is stale.
//
// The cause was that the marker's position travelled in the URL HASH, and a hash-only change is
// a same-document navigation: Chromium never reloads, so overlay.html's script — which reads its
// position once, at load — never re-ran.
//
// WHY NOTHING CAUGHT IT. The bug lived entirely in the difference between two URLs, and nothing
// in the suite could see a URL. It also could not be caught by reading the app's own logs, which
// is how M16.11's earlier checks were verified: the planner computed the RIGHT answer and logged
// it correctly every time. The failure was purely in what got rendered. That is the lesson worth
// keeping — a log line proves what the app DECIDED, never what the user SAW.
//
// `overlayParams` exists so the two properties that were violated are assertable here, with no
// electron and no desktop.

const rect = (x: number, y: number, width: number, height: number): ScreenRect =>
  ({ x, y, width, height }) as ScreenRect;

const target = (r: ScreenRect, label = "File"): PointerTarget => ({ rect: r, label });

const ORIGIN = { x: 0, y: 0 };

describe("overlayParams", () => {
  it("makes coordinates relative to the display the window sits on", () => {
    // The overlay window covers one display, so the page needs window-relative numbers. A
    // second monitor at DIP x=1280 must not push the marker 1280px off its own window.
    const params = overlayParams(target(rect(1400, 90, 60, 30)), { x: 1280, y: 0 }, 1);
    expect(params.get("x")).toBe("120");
    expect(params.get("y")).toBe("90");
    expect(params.get("w")).toBe("60");
    expect(params.get("h")).toBe("30");
  });

  it("carries the label", () => {
    expect(overlayParams(target(rect(1, 2, 3, 4), "Advice.txt"), ORIGIN, 1).get("label")).toBe(
      "Advice.txt",
    );
  });

  // THE REGRESSION TEST. Two calls must never produce the same query string — not even when the
  // question, the rect and the label are all identical — because an identical URL is what let
  // Chromium skip the reload.
  it("never produces the same query string twice, even for an identical marker", () => {
    const same = target(rect(3, 33, 41, 32), "File");
    const first = overlayParams(same, ORIGIN, 1).toString();
    const second = overlayParams(same, ORIGIN, 2).toString();

    expect(first).not.toBe(second);
  });

  it("differs across the exact alternating sequence that reproduced the bug", () => {
    // "where is the File menu" -> "point at the Advice.txt tab" -> repeat -> back to File.
    // Under the old hash-based scheme, calls 2, 3 and 5 rendered the previous answer.
    const file = target(rect(3, 33, 41, 32), "File");
    const tab = target(rect(303, 1, 80, 32), "Advice.txt. Unmodified.");

    const urls = [file, tab, tab, file, file].map((t, index) =>
      overlayParams(t, ORIGIN, index + 1).toString(),
    );

    expect(new Set(urls).size).toBe(urls.length);
  });

  it("puts the nonce in the parameters, so it reaches the URL at all", () => {
    // A nonce computed and then dropped would leave the bug in place while looking fixed.
    expect(overlayParams(target(rect(1, 2, 3, 4)), ORIGIN, 7).get("n")).toBe("7");
  });
});
