import { describe, it, expect } from "vitest";
import {
  LOCATE_SYSTEM,
  LOCATE_TOOL_SCHEMA,
  parseLocateResponse,
  renderLocateRequest,
} from "../src/core/vision/prompt.ts";
import { VisionError } from "../src/core/errors.ts";

// The locate call's shaping and its response parser (M15).
//
// The parser half is ORDINARY BRANCHING that decides what the user is told when the model
// answers off-schema — which is exactly the half M13 shipped untested on the grounds that "only
// a live run can prove it", and exactly the half whose bugs the first live run found. So it is
// tested here against every malformed shape, with no network and no SDK.

function badResponse(run: () => unknown): VisionError {
  try {
    run();
  } catch (error) {
    if (error instanceof VisionError) return error;
    throw error;
  }
  throw new Error("expected a VisionError, but the response was accepted");
}

describe("the request", () => {
  it("carries the target and nothing else", () => {
    expect(renderLocateRequest("  the send button  ")).toBe("Find: the send button");
  });

  it("sends no context beyond the target", () => {
    // Not economy — restraint. This payload already contains a picture of the user's screen;
    // the clipboard, the window title and the previous turn have no business riding along with
    // it. If this ever starts interpolating CapturedContext, that is a decision to argue for,
    // not one to arrive at by accident.
    const rendered = renderLocateRequest("the send button");
    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).not.toMatch(/clipboard|window|previous/i);
  });
});

describe("the system prompt", () => {
  it("tells the model it is not the one clicking", () => {
    expect(LOCATE_SYSTEM).toMatch(/never click|You never click/i);
  });

  it("pushes back on guessing, which is what the checks exist to catch", () => {
    expect(LOCATE_SYSTEM).toMatch(/notFound/);
    expect(LOCATE_SYSTEM).toMatch(/ambiguous/);
    expect(LOCATE_SYSTEM).toMatch(/not confident/i);
  });

  it("names the coordinate space the parser and geometry both assume", () => {
    expect(LOCATE_SYSTEM).toMatch(/image pixels/i);
    expect(LOCATE_SYSTEM).toMatch(/top-left/i);
  });
});

describe("the answer schema", () => {
  it("requires an outcome and nothing else", () => {
    expect(LOCATE_TOOL_SCHEMA.required).toEqual(["outcome"]);
  });

  it("offers exactly the three outcomes the parser handles", () => {
    const outcome = LOCATE_TOOL_SCHEMA.properties["outcome"] as { enum: string[] };
    expect(outcome.enum).toEqual(["found", "notFound", "ambiguous"]);
    // The schema and the parser are one contract in one file; this is the assertion that fails
    // if somebody edits one half of it.
    for (const value of outcome.enum) {
      expect(() => parseLocateResponse({ outcome: value, box: { x: 0, y: 0, width: 1, height: 1 } })).not.toThrow();
    }
  });
});

describe("parsing a well-formed answer", () => {
  it("reads a found box", () => {
    expect(
      parseLocateResponse({
        outcome: "found",
        box: { x: 1200, y: 100, width: 120, height: 40 },
        label: "Send",
      }),
    ).toEqual({
      kind: "found",
      box: { x: 1200, y: 100, width: 120, height: 40 },
      label: "Send",
    });
  });

  it("reads notFound with its reason", () => {
    expect(parseLocateResponse({ outcome: "notFound", reason: "no browser window is open" })).toEqual({
      kind: "notFound",
      reason: "no browser window is open",
    });
  });

  it("reads ambiguous with its candidates", () => {
    expect(parseLocateResponse({ outcome: "ambiguous", candidates: ["Send", "Send later"] })).toEqual({
      kind: "ambiguous",
      candidates: ["Send", "Send later"],
    });
  });

  it("tolerates a missing label, reason, or candidate list", () => {
    expect(parseLocateResponse({ outcome: "found", box: { x: 0, y: 0, width: 8, height: 8 } })).toEqual({
      kind: "found",
      box: { x: 0, y: 0, width: 8, height: 8 },
      label: "",
    });
    expect(parseLocateResponse({ outcome: "notFound" })).toEqual({ kind: "notFound", reason: "" });
    expect(parseLocateResponse({ outcome: "ambiguous" })).toEqual({ kind: "ambiguous", candidates: [] });
  });

  it("drops non-string candidates rather than failing the whole answer", () => {
    expect(parseLocateResponse({ outcome: "ambiguous", candidates: ["Send", 7, null, "Discard"] })).toEqual({
      kind: "ambiguous",
      candidates: ["Send", "Discard"],
    });
  });
});

describe("parsing an answer we cannot act on", () => {
  it("refuses a non-object", () => {
    for (const bad of [null, undefined, "found", 42, []]) {
      // An array is an object to typeof, so it reaches the property reads and falls out at the
      // outcome check — either way it must not be accepted.
      expect(badResponse(() => parseLocateResponse(bad)).reason).toBe("bad-response");
    }
  });

  it("refuses an unknown outcome, and quotes it so enum drift is visible", () => {
    const error = badResponse(() => parseLocateResponse({ outcome: "maybe" }));
    expect(error.message).toContain(`an outcome of "maybe"`);
  });

  it("refuses a missing outcome", () => {
    expect(badResponse(() => parseLocateResponse({ box: { x: 1, y: 1, width: 1, height: 1 } })).message).toContain(
      "no outcome",
    );
  });

  // The specific failure worth its own message: it committed to having found something and then
  // did not say where. Read as a zero box, that becomes a confident marker in the corner.
  it("refuses 'found' with no box", () => {
    const error = badResponse(() => parseLocateResponse({ outcome: "found", label: "Send" }));
    expect(error.message).toContain("gave no position");
  });

  it("refuses a box with a missing or non-numeric field", () => {
    const cases = [
      { x: 1, y: 1, width: 1 },
      { x: "1", y: 1, width: 1, height: 1 },
      { x: null, y: 1, width: 1, height: 1 },
      { x: 1, y: 1, width: 1, height: "40px" },
    ];
    for (const box of cases) {
      expect(badResponse(() => parseLocateResponse({ outcome: "found", box })).message).toContain(
        "wasn't a set of numbers",
      );
    }
  });

  it("never echoes model text back to the screen", () => {
    // The response describes a picture of the user's screen. A parser that quoted its input into
    // a user-visible error would be a small hole in exactly the property this capability was
    // gated behind — so the one quoted field is stripped to a harmless token.
    const error = badResponse(() =>
      parseLocateResponse({ outcome: "<script>alert(document.cookie)</script> secret@example.com" }),
    );
    expect(error.message).not.toContain("<");
    expect(error.message).not.toContain("@");
    expect(error.message).toContain("scriptalertdocumentcookiescript");
  });

  it("clips a long unexpected outcome", () => {
    const error = badResponse(() => parseLocateResponse({ outcome: "x".repeat(500) }));
    expect(error.message).toContain("x".repeat(40));
    expect(error.message).not.toContain("x".repeat(41));
  });
});
