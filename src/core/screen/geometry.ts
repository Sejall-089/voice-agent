import type { DisplayBounds, NativeRect, ScreenRect } from "../types.ts";

// Geometry for the UIA path (M16): native screen pixels → DIP, and describing where a control is
// in words.
//
// THE ONE PIECE OF ARITHMETIC IN THIS MILESTONE THAT IS SILENTLY WRONG RATHER THAN LOUDLY WRONG.
// A bad mapping does not throw — it puts a confident marker somewhere the user was not asking
// about. M15 lost a debugging session to exactly this class of bug in the other direction, and
// the shape of the risk is unchanged even though the code is not.

// Native pixels → DIP.
//
// UI Automation answers in PHYSICAL screen pixels (measured — scripts/uia-recon.ps1, with
// `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` set first, without which Windows lies to
// the process and hands back 1280x720 for a 1920x1080 panel). The overlay places windows in DIP.
// On the machine this was measured on those two spaces differ by 1.5x, so the conversion is not
// a formality that happens to be the identity.
//
// DERIVED FROM THE TWO SPACES IT SPANS, never from a stored ratio — the same discipline M15's
// image-pixels → DIP mapping used, and for the same reason. `DisplayBounds` carries both the DIP
// rectangle and the physical one, and the scale falls out of them:
//
//     display.width / display.nativeWidth
//
// A `scaleFactor` field would be an invitation to write `x / scaleFactor`, which is right on one
// display and wrong the moment there are two. It is not in the type, so it cannot be spelled.
//
// THE ORIGIN IS TRANSLATED, NOT JUST SCALED. `nativeX`/`nativeY` are subtracted before scaling
// and the DIP origin added after, because a second monitor sits at a non-zero offset in BOTH
// spaces and those offsets are not related by this display's scale factor. On a single display
// at (0,0) every one of those terms is zero, which is exactly why this needs writing down rather
// than discovering later — the wrong version passes every test that can be run here.
export function toScreenRect(rect: NativeRect, display: DisplayBounds): ScreenRect {
  const sx = display.width / display.nativeWidth;
  const sy = display.height / display.nativeHeight;

  const horizontal = edges(rect.x - display.nativeX, rect.width, sx, display.x);
  const vertical = edges(rect.y - display.nativeY, rect.height, sy, display.y);

  // The one cast in the file, and the reason `ScreenRect` is branded at all: this function is
  // the only thing allowed to mint one, so a native rect cannot reach the overlay by accident.
  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.extent,
    height: vertical.extent,
  } as ScreenRect;
}

// Round the EDGES, then derive the size from them — never round position and size independently.
// `Math.round(x) + Math.round(width)` can land a pixel away from `Math.round(x + width)`, and on
// a 20px icon that is the difference between a marker that frames the control and one that clips
// it. Carried over verbatim from M15's geometry, which is the one part of it that was right.
function edges(
  start: number,
  extent: number,
  scale: number,
  origin: number,
): { start: number; extent: number } {
  const left = Math.round(origin + start * scale);
  const right = Math.round(origin + (start + extent) * scale);
  return { start: left, extent: Math.max(1, right - left) };
}

const ROWS = ["top", "middle", "bottom"] as const;
const COLUMNS = ["left", "centre", "right"] as const;

// Which third of `extent` does `value` fall in? Clamped, so a rect whose centre sits fractionally
// outside the frame still gets a sensible word rather than an undefined one.
//
// (core/vision/geometry.ts has the same three-bucket helper for the vision path. The duplication
// is deliberate and temporary: that file is deleted at M16.10, and merging them now would mean
// editing a module that is on its way out.)
function bucket(value: number, extent: number): 0 | 1 | 2 {
  if (extent <= 0) return 1;
  const third = value / extent;
  if (third < 1 / 3) return 0;
  if (third < 2 / 3) return 1;
  return 2;
}

// "top left", "middle", "bottom right" — a control's position WITHIN ITS WINDOW.
//
// THIS IS THE FIELD THAT MAKES THE INVERSION WORK. It is computed by code from the UIA rect and
// handed to the model as context, which is what lets someone say "the button next to the address
// bar" or "the one on the far right" and be understood — WITHOUT the model ever emitting a
// coordinate. The model reads position; it never reports it. M15 had that backwards, and
// measured the cost: the model was confident and wrong about position on dense UI.
//
// Relative to the WINDOW rather than the screen on purpose. The candidate list is scoped to one
// window (see core/types.ts's WindowElements), so "top left" has to mean "top left of the thing
// we are talking about". On a maximized window the two coincide; on a small dialog in the corner
// of a large screen they do not, and the window is the frame of reference the user shares.
export function positionIn(rect: NativeRect, window: NativeRect): string {
  const centreX = rect.x + rect.width / 2 - window.x;
  const centreY = rect.y + rect.height / 2 - window.y;
  const row = ROWS[bucket(centreY, window.height)] ?? "middle";
  const column = COLUMNS[bucket(centreX, window.width)] ?? "centre";

  if (row === "middle" && column === "centre") return "middle";
  if (row === "middle") return column;
  if (column === "centre") return row;
  return `${row} ${column}`;
}
