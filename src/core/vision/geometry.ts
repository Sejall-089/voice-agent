import type { ElementBox, Screenshot, ScreenRect } from "../types.ts";

// Image pixels → screen DIP. The one piece of arithmetic in this milestone that is silently
// wrong rather than loudly wrong when it is wrong: a bad mapping does not throw, it puts a
// confident marker 200 pixels from the button.
//
// THE MAPPING IS DERIVED FROM THE IMAGE, NOT FROM THE SCALE FACTOR. Recon (scripts/
// screen-recon.mjs) measured this machine at 1280x720 DIP, scaleFactor 1.5, captured at
// 1920x1080 native — and then the app downscales that to 1568x882 before sending it. Three
// different pixel spaces are live at once, and only one ratio spans the two that matter:
//
//     display.width (DIP) / shot.width (image px)
//
// At native resolution that ratio happens to equal 1/scaleFactor, which is exactly what makes
// `x / scaleFactor` so tempting and so dangerous: it is correct right up until the downscale
// that every real request goes through. `Screenshot.display` deliberately carries no
// `scaleFactor` field so the wrong version cannot be written (see core/types.ts).

// Round the EDGES, then derive the size from them — never round position and size
// independently. `Math.round(x) + Math.round(width)` can land a pixel away from
// `Math.round(x + width)`, and on a small control that is the difference between a marker that
// frames the button and one that clips it.
function edges(start: number, extent: number, scale: number, origin: number) {
  const left = Math.round(origin + start * scale);
  const right = Math.round(origin + (start + extent) * scale);
  return { start: left, extent: Math.max(1, right - left) };
}

export function toScreenRect(box: ElementBox, shot: Screenshot): ScreenRect {
  const { display } = shot;
  const sx = display.width / shot.width;
  const sy = display.height / shot.height;

  const horizontal = edges(box.x, box.width, sx, display.x);
  const vertical = edges(box.y, box.height, sy, display.y);

  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.extent,
    height: vertical.extent,
  };
}

// The centre of a box, in image pixels. Used for the position phrase below and for the
// "is this even on the image" check in locate.ts.
export function centreOf(box: ElementBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const ROWS = ["top", "middle", "bottom"] as const;
const COLUMNS = ["left", "centre", "right"] as const;

// "the top right of your screen".
//
// This exists so the RESULT SENTENCE stands on its own. The overlay is the disposable channel
// and the text is the durable one (spec §4d's two-representations rule): if the marker is
// missed, dismissed, or spoken rather than seen, "Pointing at Send — the top right of your
// screen" still tells the user where to look. It is derived from the box the app is actually
// pointing at, so the words and the marker can never describe different places.
export function describePosition(box: ElementBox, shot: Screenshot): string {
  const centre = centreOf(box);
  const row = ROWS[bucket(centre.y, shot.height)] ?? "middle";
  const column = COLUMNS[bucket(centre.x, shot.width)] ?? "centre";

  if (row === "middle" && column === "centre") return "the middle of your screen";
  if (row === "middle") return `the ${column} of your screen`;
  if (column === "centre") return `the ${row} of your screen`;
  return `the ${row} ${column} of your screen`;
}

// Which third of `extent` does `value` fall in? Clamped, so a box whose centre sits fractionally
// outside the frame still gets a sensible word rather than an undefined one.
function bucket(value: number, extent: number): 0 | 1 | 2 {
  if (extent <= 0) return 1;
  const third = value / extent;
  if (third < 1 / 3) return 0;
  if (third < 2 / 3) return 1;
  return 2;
}
