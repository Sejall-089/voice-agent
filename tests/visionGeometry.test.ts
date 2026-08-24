import { describe, it, expect } from "vitest";
import {
  centreOf,
  describePosition,
  toScreenRect,
} from "../src/core/vision/geometry.ts";
import type { DisplayBounds, ElementBox, Screenshot } from "../src/core/types.ts";

// The image-pixels → screen-DIP mapping (M15).
//
// EVERY EXPECTED VALUE IN THIS FILE IS HAND-COMPUTED AND WRITTEN AS A LITERAL. Not one of them
// is produced by asking the code, or the runtime, to work out its own input — that is M14's
// lesson generalized. There, a rule was anchored on the date shape node's ICU produced, it
// silently stopped matching under electron's, and every test still passed because the test had
// asked the runtime for its own fixture. A geometry test that computes `1200 * 1280 / 1568` in
// the assertion proves only that the formula agrees with itself; it would pass just as happily
// with the scale factor applied upside down.
//
// The numbers below come from scripts/screen-recon.mjs's real measurements: 1280x720 DIP at
// scaleFactor 1.5, captured at 1920x1080 native, downscaled to 1568x882 before sending.

function shotOn(display: DisplayBounds, width: number, height: number): Screenshot {
  return { png: new Uint8Array(0), width, height, display };
}

// This machine, as recon measured it: 1280x720 DIP, and the 1568-long-edge frame the app sends.
const THIS_MACHINE = shotOn({ id: 1, x: 0, y: 0, width: 1280, height: 720 }, 1568, 882);

describe("toScreenRect", () => {
  it("is the identity when the image is already in DIP at the origin", () => {
    const shot = shotOn({ id: 1, x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080);
    const box: ElementBox = { x: 100, y: 200, width: 50, height: 30 };
    expect(toScreenRect(box, shot)).toEqual({ x: 100, y: 200, width: 50, height: 30 });
  });

  // 1200 * 1280/1568 = 979.5918 -> 980;  1320 * 1280/1568 = 1077.5510 -> 1078;  width 98
  //  100 *  720/882  =  81.6327 ->  82;   140 *  720/882  =  114.2857 ->  114;  height 32
  it("maps a downscaled frame back onto a 150%-scaled display", () => {
    const box: ElementBox = { x: 1200, y: 100, width: 120, height: 40 };
    expect(toScreenRect(box, THIS_MACHINE)).toEqual({
      x: 980,
      y: 82,
      width: 98,
      height: 32,
    });
  });

  // 784 * 1536/1568 = 768 exactly;  884 * 1536/1568 = 865.9592 -> 866;  width 98
  // 441 *  864/882  = 432 exactly;  541 *  864/882  = 529.9592 -> 530;  height 98
  it("maps onto a 125%-scaled display", () => {
    const shot = shotOn({ id: 2, x: 0, y: 0, width: 1536, height: 864 }, 1568, 882);
    const box: ElementBox = { x: 784, y: 441, width: 100, height: 100 };
    expect(toScreenRect(box, shot)).toEqual({ x: 768, y: 432, width: 98, height: 98 });
  });

  // A second monitor to the LEFT of the primary, so its origin is negative — the case that
  // breaks any implementation that scales the origin instead of adding it.
  //   -1920 + 0                    = -1920
  //   -1920 + 100 * 1920/1568      = -1920 + 122.4490 = -1797.5510 -> -1798;  width 122
  //           50 * 1080/882        =   61.2245 -> 61;  height 61
  it("handles a display at a negative origin", () => {
    const shot = shotOn({ id: 3, x: -1920, y: 0, width: 1920, height: 1080 }, 1568, 882);
    const box: ElementBox = { x: 0, y: 0, width: 100, height: 50 };
    expect(toScreenRect(box, shot)).toEqual({ x: -1920, y: 0, width: 122, height: 61 });
  });

  // A second monitor to the right AND lower down, at a different resolution again.
  //   1920 + 784 * 2560/1568 = 1920 + 1280      = 3200
  //   1920 + 794 * 2560/1568 = 1920 + 1296.3265 = 3216.3265 -> 3216;  width 16
  //    300 + 441 * 1440/882  =  300 +  720      = 1020
  //    300 + 451 * 1440/882  =  300 +  736.3265 = 1036.3265 -> 1036;  height 16
  it("handles a display offset in both axes", () => {
    const shot = shotOn({ id: 4, x: 1920, y: 300, width: 2560, height: 1440 }, 1568, 882);
    const box: ElementBox = { x: 784, y: 441, width: 10, height: 10 };
    expect(toScreenRect(box, shot)).toEqual({ x: 3200, y: 1020, width: 16, height: 16 });
  });

  // THE ROUNDING RULE, pinned with the case that distinguishes it.
  //
  // Rounding the edges:  1200 -> 980, 1321 -> 1078, width = 98.
  // Rounding the size:   round(121 * 1280/1568) = round(98.7755) = 99.
  //
  // Two different answers from the same input, and the second one is the wrong edge. On a small
  // control that pixel is the difference between framing the button and clipping it, which is
  // why the implementation derives extent from edges rather than scaling it directly.
  it("derives width from rounded edges, not by rounding the width", () => {
    const box: ElementBox = { x: 1200, y: 100, width: 121, height: 40 };
    const rect = toScreenRect(box, THIS_MACHINE);
    expect(rect.x).toBe(980);
    expect(rect.width).toBe(98);
    expect(rect.x + rect.width).toBe(1078);
  });

  it("never produces a zero-sized rect, so a degenerate box is still visible", () => {
    const box: ElementBox = { x: 100, y: 100, width: 0, height: 0 };
    expect(toScreenRect(box, THIS_MACHINE)).toEqual({ x: 82, y: 82, width: 1, height: 1 });
  });

  it("maps the far corner to the far corner", () => {
    const box: ElementBox = { x: 1468, y: 782, width: 100, height: 100 };
    // 1468 * 1280/1568 = 1198.3673 -> 1198;  1568 * 1280/1568 = 1280;  width 82
    //  782 *  720/882  =  638.3673 ->  638;   882 *  720/882  =  720;  height 82
    expect(toScreenRect(box, THIS_MACHINE)).toEqual({
      x: 1198,
      y: 638,
      width: 82,
      height: 82,
    });
  });
});

describe("centreOf", () => {
  it("is the middle of the box", () => {
    expect(centreOf({ x: 100, y: 200, width: 50, height: 30 })).toEqual({ x: 125, y: 215 });
  });

  it("keeps the half-pixel rather than rounding it away", () => {
    expect(centreOf({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

// Thirds of a 1568x882 frame: x < 522.67 | < 1045.33 | else.  y < 294 | < 588 | else.
describe("describePosition", () => {
  it("names all nine regions", () => {
    const at = (x: number, y: number): string =>
      describePosition({ x, y, width: 2, height: 2 }, THIS_MACHINE);

    expect(at(50, 50)).toBe("the top left of your screen");
    expect(at(783, 50)).toBe("the top of your screen");
    expect(at(1450, 40)).toBe("the top right of your screen");
    expect(at(30, 430)).toBe("the left of your screen");
    expect(at(783, 440)).toBe("the middle of your screen");
    expect(at(1450, 440)).toBe("the right of your screen");
    expect(at(30, 830)).toBe("the bottom left of your screen");
    expect(at(783, 830)).toBe("the bottom of your screen");
    expect(at(1530, 830)).toBe("the bottom right of your screen");
  });

  it("reads the box's centre, not its corner", () => {
    // A wide banner starting at the far left but centred in the frame is "the top", not
    // "the top left" — the corner would say otherwise.
    const banner: ElementBox = { x: 0, y: 10, width: 1568, height: 60 };
    expect(describePosition(banner, THIS_MACHINE)).toBe("the top of your screen");
  });
});
