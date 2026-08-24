import { visionError } from "../errors.ts";
import type { JSONSchema, LocateResult } from "../types.ts";

// Vendor-neutral shaping for the locate call (M15), mirroring core/llm/prompt.ts's role for the
// planner call: the framing and the answer schema live here, and each provider client adapts
// them to its own SDK at the boundary. A second provider gets the same words for free.
//
// THE SCHEMA AND ITS PARSER LIVE IN ONE FILE ON PURPOSE. They are two halves of a single
// contract, and the way this goes wrong is one being edited without the other — a field renamed
// in the schema and still read by the old name parses as "the model answered off-schema" on
// every single call. Side by side, that edit is hard to make and obvious to review.

// What the model is for, and — more importantly — what it must refuse to do.
//
// The last three lines are the load-bearing ones. Everything in core/vision/locate.ts exists
// because a model under pressure would rather produce a plausible box than admit it cannot see
// the thing, and the prompt is the first place to push back on that. The checks are the second.
// Neither is sufficient alone.
export const LOCATE_SYSTEM = [
  "You locate one user-interface element in a screenshot of someone's screen.",
  "You are pointing it out so that THEY can click it. You never click anything, and nothing you",
  "say causes anything to be clicked — an on-screen marker is drawn where you say, and a person",
  "decides what to do about it.",
  "Answer only through the locate_element tool.",
  "Report coordinates in image pixels, with the origin at the top-left of the image, and make",
  "the box tight around the element itself rather than around the panel or window containing it.",
  "Accuracy matters more than helpfulness.",
  "If the element is not visible in this screenshot, answer notFound — do not offer the nearest",
  "thing you can see instead.",
  "If several elements match and you cannot tell which was meant, answer ambiguous and name them.",
  "Never report a box you are not confident in. A confident wrong answer sends someone to the",
  "wrong part of their own screen, which is worse in every case than saying you cannot tell.",
].join(" ");

// The one thing the model may say, and the shape it must say it in. Kept as this repo's own
// vendor-neutral `JSONSchema` (core/types.ts) exactly like a Tool's inputSchema, and adapted to
// the SDK's type at the client boundary — the same seam anthropic.ts/openai.ts already use.
export const LOCATE_TOOL_NAME = "locate_element";

export const LOCATE_TOOL_DESCRIPTION =
  "Report where the requested element is in the screenshot, or that you cannot identify it.";

export const LOCATE_TOOL_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["found", "notFound", "ambiguous"],
      description:
        "found: exactly one element clearly matches. notFound: nothing in this screenshot " +
        "matches. ambiguous: several things match and you cannot tell which was meant.",
    },
    box: {
      type: "object",
      description:
        "Only when outcome is 'found'. The element's bounding box in IMAGE PIXELS, origin at " +
        "the top-left of the image, tight around the element itself.",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["x", "y", "width", "height"],
    },
    label: {
      type: "string",
      description:
        "Only when outcome is 'found'. What the element actually is, as a person would name it " +
        "— its visible text where it has any.",
    },
    candidates: {
      type: "array",
      items: { type: "string" },
      description: "Only when outcome is 'ambiguous'. The competing matches, named.",
    },
    reason: {
      type: "string",
      description:
        "Only when outcome is 'notFound'. One short sentence a person can act on, e.g. " +
        "'there's no browser window open'.",
    },
  },
  required: ["outcome"],
};

// The text that rides alongside the image.
//
// Deliberately minimal: no clipboard, no window title, no previous turn. The planner's own
// prompt carries all of that (core/llm/prompt.ts) and this call has no use for it — but the
// reason to leave it out is not economy, it is that this request already contains a picture of
// the user's screen, and adding everything else the app knows about them to the same payload is
// the opposite of the restraint this capability was gated behind.
export function renderLocateRequest(target: string): string {
  return `Find: ${target.trim()}`;
}

// Turn whatever the model sent into a `LocateResult`, or refuse.
//
// M13's lesson, applied on purpose rather than after a live run: this is ORDINARY BRANCHING, not
// transport, and it decides what the user is told when things go wrong — so it is tested against
// every malformed shape rather than waiting for a real API to produce one.
//
// Every rejection detail here is STRUCTURAL ("no outcome field", "box.x was not a number") and
// never echoes model text back. The message reaches the screen, the response describes a picture
// of the user's screen, and a parser that quoted its input would be a small hole in exactly the
// property this capability was gated on.
export function parseLocateResponse(input: unknown): LocateResult {
  if (typeof input !== "object" || input === null) {
    throw visionError("bad-response", "the answer wasn't an object");
  }
  const payload = input as Record<string, unknown>;
  const outcome = payload["outcome"];

  if (outcome === "notFound") {
    return { kind: "notFound", reason: asString(payload["reason"]) };
  }

  if (outcome === "ambiguous") {
    const raw = payload["candidates"];
    const candidates = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
    return { kind: "ambiguous", candidates };
  }

  if (outcome === "found") {
    const box = payload["box"];
    if (typeof box !== "object" || box === null) {
      // The specific failure worth naming: the model committed to having found something and
      // then did not say where. Treating that as "found" with a zero box would put a marker in
      // the top-left corner of the screen with total confidence.
      throw visionError("bad-response", "it said it found the element but gave no position");
    }
    const fields = box as Record<string, unknown>;
    const x = asFiniteNumber(fields["x"]);
    const y = asFiniteNumber(fields["y"]);
    const width = asFiniteNumber(fields["width"]);
    const height = asFiniteNumber(fields["height"]);
    if (x === null || y === null || width === null || height === null) {
      throw visionError("bad-response", "the position it gave wasn't a set of numbers");
    }
    return { kind: "found", box: { x, y, width, height }, label: asString(payload["label"]) };
  }

  throw visionError(
    "bad-response",
    typeof outcome === "string"
      ? `it answered with an outcome of "${sanitize(outcome)}"`
      : "the answer had no outcome",
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// An unexpected `outcome` is the one piece of model text worth quoting — it is how you find out
// the enum drifted — but it is still model output heading for the screen, so it is clipped and
// stripped to something that cannot carry a payload.
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40);
}
