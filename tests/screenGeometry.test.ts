import { describe, expect, it } from "vitest";
import { positionIn, toScreenRect } from "../src/core/screen/geometry.ts";
import { buildCandidates } from "../src/core/screen/elements.ts";
import { TREES } from "./FakeElements.ts";
import type { DisplayBounds, NativeRect } from "../src/core/types.ts";

// Native screen pixels → DIP (M16.6).
//
// EVERY EXPECTED VALUE HERE IS HAND-COMPUTED AND WRITTEN AS A LITERAL. Not one is produced by
// asking the code, or the runtime, for its own input — M14's lesson, generalized: a geometry
// test that computes `454 * 1280 / 1920` in its own assertion proves only that the formula
// agrees with itself, and would pass just as happily with the scale applied upside down.
//
// THE DISPLAY BELOW IS THE 1.5x ONE, DELIBERATELY. It is the machine `npx electron` reported
// this session — 1280x720 DIP, scaleFactor 1.5, 1920x1080 native, `dipToScreenPoint(+100,+100)
// = 150,150` — and it is the same scaled display that made M15's geometry the risky case. A
// 1:1 display would make this mapping look like the identity function, which is precisely the
// bug it is most likely to have.
const SCALED_150: DisplayBounds = {
  id: 3136901802,
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
  nativeX: 0,
  nativeY: 0,
  nativeWidth: 1920,
  nativeHeight: 1080,
};

describe("toScreenRect on the 150%-scaled display", () => {
  //   4 * 1280/1920 =  2.6667 ->  3;   66 * 1280/1920 = 44;  width 41
  //  49 *  720/1080 = 32.6667 -> 33;   97 *  720/1080 = 64.6667 -> 65;  height 32
  it("maps Notepad's File menu", () => {
    const file: NativeRect = { x: 4, y: 49, width: 62, height: 48 };
    expect(toScreenRect(file, SCALED_150)).toEqual({ x: 3, y: 33, width: 41, height: 32 });
  });

  //  454 * 2/3 = 302.6667 -> 303;  574 * 2/3 = 382.6667 -> 383;  width 80
  //    1 * 2/3 =   0.6667 ->   1;   49 * 2/3 =  32.6667 ->  33;  height 32
  it("maps Notepad's Advice.txt tab", () => {
    const tab: NativeRect = { x: 454, y: 1, width: 120, height: 48 };
    expect(toScreenRect(tab, SCALED_150)).toEqual({ x: 303, y: 1, width: 80, height: 32 });
  });

  //    9 * 2/3 =   6;  138 * 2/3 =  92;  width 86
  //  123 * 2/3 =  82;  190 * 2/3 = 126.6667 -> 127;  height 45
  it("maps Explorer's New button", () => {
    const newButton: NativeRect = { x: 9, y: 123, width: 129, height: 67 };
    expect(toScreenRect(newButton, SCALED_150)).toEqual({ x: 6, y: 82, width: 86, height: 45 });
  });

  it("is NOT the identity — the whole point of testing on a scaled display", () => {
    const rect: NativeRect = { x: 600, y: 300, width: 120, height: 60 };
    const mapped = toScreenRect(rect, SCALED_150);
    expect(mapped).toEqual({ x: 400, y: 200, width: 80, height: 40 });
    expect(mapped.x).not.toBe(rect.x);
  });

  it("maps the far corner to the far corner", () => {
    const corner: NativeRect = { x: 1900, y: 1060, width: 20, height: 20 };
    // 1900 * 2/3 = 1266.6667 -> 1267;  1920 * 2/3 = 1280;  width 13
    // 1060 * 2/3 =  706.6667 ->  707;  1080 * 2/3 =  720;  height 13
    expect(toScreenRect(corner, SCALED_150)).toEqual({
      x: 1267,
      y: 707,
      width: 13,
      height: 13,
    });
  });
});

describe("the rounding rule", () => {
  // Rounding the EDGES:  x 1200 -> 800, right 1321 -> 881, width = 81.
  // Rounding the SIZE:   round(121 * 2/3) = round(80.6667) = 81.  Same here — so the case below
  // is chosen to make the two disagree.
  it("derives width from rounded edges, not by rounding the width", () => {
    //   x     100 * 2/3 =  66.6667 ->  67
    //   right 201 * 2/3 = 134      -> 134   => width 67
    //   rounding the size instead: round(101 * 2/3) = round(67.3333) = 67 ... still equal,
    //   so use a case where the fractional parts split:
    //   x     101 * 2/3 =  67.3333 ->  67
    //   right 202 * 2/3 = 134.6667 -> 135   => width 68
    //   rounding the size: round(101 * 2/3) = 67.  DIFFERENT.
    const rect: NativeRect = { x: 101, y: 0, width: 101, height: 10 };
    const mapped = toScreenRect(rect, SCALED_150);
    expect(mapped.x).toBe(67);
    expect(mapped.width).toBe(68);
    expect(mapped.x + mapped.width).toBe(135);
  });

  it("never produces a zero-sized rect, so a tiny control is still visible", () => {
    const speck: NativeRect = { x: 300, y: 300, width: 1, height: 1 };
    const mapped = toScreenRect(speck, SCALED_150);
    expect(mapped.width).toBe(1);
    expect(mapped.height).toBe(1);
  });

  it("keeps a 20px icon from collapsing", () => {
    // The size M15's SMALL_TARGET_PX gate refused outright. Here it maps to 13 DIP and is fine —
    // an exact rect has no size-based confidence problem.
    const icon: NativeRect = { x: 500, y: 500, width: 20, height: 20 };
    expect(toScreenRect(icon, SCALED_150)).toEqual({ x: 333, y: 333, width: 14, height: 14 });
  });
});

// The case that cannot be measured on this machine, and therefore the case most likely to be
// wrong. Every term that is zero on a single display at (0,0) is non-zero here.
describe("a second monitor", () => {
  // Physically to the right of the 1920px primary, at 100% scale, so DIP x=1280 (the primary is
  // 1280 DIP wide) while its PHYSICAL origin is 1920.
  const SECOND: DisplayBounds = {
    id: 2,
    x: 1280,
    y: 0,
    width: 1920,
    height: 1080,
    nativeX: 1920,
    nativeY: 0,
    nativeWidth: 1920,
    nativeHeight: 1080,
  };

  it("translates the physical origin before scaling, and adds the DIP origin after", () => {
    // A control 100px into the second monitor, physically at 2020.
    //   (2020 - 1920) * 1920/1920 = 100;  + 1280 = 1380
    //   (  50 -    0) * 1080/1080 =  50;  +    0 =   50
    const rect: NativeRect = { x: 2020, y: 50, width: 200, height: 40 };
    expect(toScreenRect(rect, SECOND)).toEqual({ x: 1380, y: 50, width: 200, height: 40 });
  });

  it("would be wrong if the origin were scaled instead of translated", () => {
    // The bug this guards: `x * scale + display.x` without subtracting nativeX would give
    // 2020 * 1 + 1280 = 3300 — a marker 1920 DIP off the right of the desktop, drawn with total
    // confidence. On a single display at (0,0) the two formulas agree exactly, which is why this
    // needed writing down rather than discovering later.
    const rect: NativeRect = { x: 2020, y: 50, width: 200, height: 40 };
    expect(toScreenRect(rect, SECOND).x).not.toBe(3300);
  });

  it("handles a monitor to the LEFT, at a negative DIP origin", () => {
    const left: DisplayBounds = {
      id: 3,
      x: -1280,
      y: 0,
      width: 1280,
      height: 720,
      nativeX: -1920,
      nativeY: 0,
      nativeWidth: 1920,
      nativeHeight: 1080,
    };
    //   (-1820 + 1920) * 2/3 = 66.6667 -> 67;  + (-1280) = -1213
    //   (-1820 + 1920 + 150) * 2/3 = 166.6667 -> 167;  + (-1280) = -1113;  width 100
    const rect: NativeRect = { x: -1820, y: 0, width: 150, height: 60 };
    const mapped = toScreenRect(rect, left);
    expect(mapped.x).toBe(-1213);
    expect(mapped.width).toBe(100);
  });
});

// End to end on the real fixtures: a candidate's rect survives the whole path and lands
// somewhere on the display it came from.
describe("real candidates map onto the display", () => {
  it("puts every Explorer candidate inside the 1280x720 DIP desktop", () => {
    for (const candidate of buildCandidates(TREES["explorer"]!)) {
      const rect = toScreenRect(candidate.rect, SCALED_150);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1281);
      expect(rect.y + rect.height).toBeLessThanOrEqual(721);
    }
  });
});

describe("positionIn", () => {
  const win: NativeRect = { x: 0, y: 0, width: 900, height: 900 };

  it.each([
    ["top left", { x: 10, y: 10, width: 50, height: 50 }],
    ["top right", { x: 800, y: 10, width: 50, height: 50 }],
    ["bottom left", { x: 10, y: 800, width: 50, height: 50 }],
    ["middle", { x: 425, y: 425, width: 50, height: 50 }],
  ])("describes %s", (expected, rect) => {
    expect(positionIn(rect as NativeRect, win)).toBe(expected);
  });

  it("is relative to the WINDOW, not the screen", () => {
    const dialog: NativeRect = { x: 1400, y: 800, width: 300, height: 200 };
    expect(positionIn({ x: 1410, y: 810, width: 40, height: 20 }, dialog)).toBe("top left");
  });
});
