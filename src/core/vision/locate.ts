import { ElementNotFoundError } from "../errors.ts";
import type { ElementBox, LocateResult, Screenshot } from "../types.ts";

// The deterministic gate between what the vision model said and what the app will point at.
//
// This file is M15's equivalent of gmailScript.ts's role+accessible-name resolution, and it
// exists for exactly the same reason. M10's rule was: a control we cannot resolve is never
// clicked. The DOM gave that rule something checkable to work with. Pixels do not — so the
// checkability has to be manufactured here, out of properties a wrong answer tends to violate:
//
//   * a box that runs off the edge of the frame means the model was not answering in the
//     coordinate space we handed it, so nothing else it said can be trusted either;
//   * a box covering half the screen is a model hedging by boxing a whole window, which reads
//     as an answer and is not one;
//   * a box of eight pixels is pointing at nothing.
//
// None of these prove the answer is right. All of them catch answers that are certainly wrong,
// and every one of them REFUSES rather than clamping toward a plausible-looking marker. The
// asymmetry is deliberate: an unhelpful refusal costs the user a rephrase, a confident wrong
// marker costs them a click on something they did not intend.

// How far outside the frame a box may stray before the whole answer is suspect, as a fraction
// of the frame's own dimensions. Not zero: an element flush against the edge of the screen is
// routinely reported a pixel or two past it, and refusing to point at the window close button
// would be a silly way to be principled. 1% of a 1568px frame is ~15px — enough for estimation
// slop at the edge, nowhere near enough to hide an answer in a different coordinate space.
export const EDGE_TOLERANCE = 0.01;

// The largest share of the frame a single pointable element may occupy.
//
// The failure this catches is a model that cannot find the thing and boxes the entire window
// rather than saying so — which comes back at 90-100% of the frame. 50% leaves enormous headroom
// for genuinely large targets (a compose box, a video player, a full-width toolbar) while still
// catching the hedge with no ambiguity. Tightening it would start refusing real answers; the
// point is to catch certainty, not to second-guess.
export const MAX_FRAME_FRACTION = 0.5;

// The smallest box worth pointing at, in image pixels squared. Below roughly an 8x8 square the
// model is not identifying a control, and a marker there tells the user nothing.
export const MIN_BOX_AREA = 64;

export interface Located {
  box: ElementBox;
  label: string;
}

// Validate what came back, or refuse. `target` is the user's own wording, so every refusal can
// quote the thing they actually asked for rather than a paraphrase.
export function checkLocation(
  result: LocateResult,
  shot: Screenshot,
  target: string,
): Located {
  const quoted = JSON.stringify(target.trim());

  if (result.kind === "notFound") {
    // The model's own reason is appended when it gave one, because "there's no browser window
    // open" is worth far more than "I couldn't find it" — but it is appended, never substituted,
    // so the sentence still names what was asked for even when the reason is unhelpful.
    const because = result.reason.trim();
    throw new ElementNotFoundError(
      "not-found",
      because.length > 0
        ? `I couldn't find ${quoted} on your screen — ${endSentence(because)}`
        : `I couldn't find ${quoted} on your screen.`,
    );
  }

  if (result.kind === "ambiguous") {
    // Zero or many matches is not an answer — the same default-deny rule CalendarSurface.
    // findEvent applies, and for the same reason: picking one for the user is a decision they
    // did not delegate. The candidates are named so the rephrase is one word, not a guessing game.
    const named = result.candidates.map((c) => c.trim()).filter((c) => c.length > 0);
    throw new ElementNotFoundError(
      "ambiguous",
      named.length > 0
        ? `I can see more than one thing that could be ${quoted}: ${list(named)}. Which one?`
        : `I can see more than one thing that could be ${quoted}. Can you be more specific?`,
    );
  }

  const box = result.box;

  // Defensive, and cheap. JSON cannot carry NaN or Infinity, so the real transport should never
  // produce one — but this function is also the thing a fake, a future provider, or a replayed
  // fixture goes through, and a non-finite number would otherwise sail through every comparison
  // below (they are all false against NaN) and reach the arithmetic as a silently valid box.
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    throw untrustworthy(quoted);
  }
  if (box.width <= 0 || box.height <= 0) {
    throw untrustworthy(quoted);
  }

  const slackX = shot.width * EDGE_TOLERANCE;
  const slackY = shot.height * EDGE_TOLERANCE;
  const strays =
    box.x < -slackX ||
    box.y < -slackY ||
    box.x + box.width > shot.width + slackX ||
    box.y + box.height > shot.height + slackY;
  if (strays) {
    throw untrustworthy(quoted);
  }

  // Inside the tolerance, so trim it back to the frame. Clamping here rather than earlier is the
  // point: a box is only clamped once we have already decided the answer is credible, so this
  // can never rescue an answer that was wrong.
  const clamped = clampToFrame(box, shot);

  const area = clamped.width * clamped.height;
  if (area < MIN_BOX_AREA) {
    throw untrustworthy(quoted);
  }
  if (area > shot.width * shot.height * MAX_FRAME_FRACTION) {
    throw untrustworthy(quoted);
  }

  return {
    box: clamped,
    // A missing label is not a reason to refuse — we know where the thing is, which is what was
    // asked. Fall back to the user's own words so the marker is never captioned with nothing.
    label: result.label.trim().length > 0 ? result.label.trim() : target.trim(),
  };
}

function untrustworthy(quoted: string): ElementNotFoundError {
  return new ElementNotFoundError(
    "untrustworthy",
    `I found something that might be ${quoted}, but the position I got back doesn't look ` +
      `right — I'd rather not point at the wrong thing.`,
  );
}

function clampToFrame(box: ElementBox, shot: Screenshot): ElementBox {
  const left = Math.max(0, Math.min(box.x, shot.width));
  const top = Math.max(0, Math.min(box.y, shot.height));
  const right = Math.max(left, Math.min(box.x + box.width, shot.width));
  const bottom = Math.max(top, Math.min(box.y + box.height, shot.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// The model was asked for "one short sentence" and is under no obligation to punctuate it. Every
// other message this app puts on screen ends in a full stop, and one that does not reads as
// truncated — as though the app was cut off mid-explanation, which is precisely the wrong
// impression to give while declining to do something.
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// "Send", "Send and Discard", "Send, Discard and Attach".
function list(items: string[]): string {
  if (items.length === 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}
