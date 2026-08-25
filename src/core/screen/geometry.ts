import type { NativeRect } from "../types.ts";

// Geometry for the UIA path (M16). M16.6 adds the native-pixels → DIP mapping here; this file
// starts with the part core/screen/elements.ts needs, which is describing WHERE a control is in
// words.

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
