import { describe, expect, it } from "vitest";
import { buildCandidates } from "../src/core/screen/elements.ts";
import { CHOOSE_SYSTEM, parseChoice, renderChooseRequest } from "../src/core/screen/prompt.ts";
import { resolveChoice } from "../src/core/screen/resolve.ts";
import { ChooserError, ElementNotFoundError } from "../src/core/errors.ts";
import { TREES } from "./FakeElements.ts";
import type { Candidate } from "../src/core/types.ts";

const cands = (key: string): Candidate[] => buildCandidates(TREES[key]!);

const refusalOf = (fn: () => unknown): ElementNotFoundError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ElementNotFoundError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

// ---------------------------------------------------------------------------
// THE THREE FAILURE MODES, KEPT APART.
//
// They are three different facts and they get three different treatments. Folding them into one
// "invalid response" catch-all would tell someone to rephrase when the model correctly said the
// thing is not on screen — which is the design WORKING.
// ---------------------------------------------------------------------------
describe("failure mode 1: a malformed reply", () => {
  it("refuses prose as a ChooserError, not a pointing refusal", () => {
    // A ChooserError means the question could not be answered in the agreed form. It is a
    // different family from ElementNotFoundError, which means we got an answer and it means
    // "don't point".
    expect(() => parseChoice("I think you probably want number 4, the New button."))
      .toThrowError(ChooserError);
  });

  it.each([
    ["prose", "The New button is at the top left."],
    ["a bare number", "4"],
    ["a number with a label", "Number 4"],
    ["an unknown verb", "CHOOSE 4"],
    ["PICK with no number", "PICK"],
    ["PICK with a word", "PICK four"],
    ["an explanation after the answer", "PICK 4\nThat is the New button."],
    ["a preamble before the answer", "Sure!\nPICK 4"],
    ["JSON", '{"pick": 4}'],
    ["AMBIGUOUS with one number", "AMBIGUOUS 4"],
    ["AMBIGUOUS with no numbers", "AMBIGUOUS"],
  ])("rejects %s", (_label, reply) => {
    const error = (() => {
      try {
        parseChoice(reply);
      } catch (e) {
        return e as ChooserError;
      }
      throw new Error("expected a throw");
    })();
    expect(error).toBeInstanceOf(ChooserError);
    expect(error.reason).toBe("unparseable");
  });

  it("treats an empty reply as its own reason", () => {
    const error = (() => {
      try {
        parseChoice("   \n  ");
      } catch (e) {
        return e as ChooserError;
      }
      throw new Error("expected a throw");
    })();
    // "It said nothing" and "it said something unusable" are different diagnoses.
    expect(error.reason).toBe("empty");
  });

  it("never quotes the model's reply back to the screen", () => {
    // The reply describes the contents of the user's window. M15's parseLocateResponse held the
    // same line and this keeps it.
    const secret = "PICK the tab named ACME-Q3-layoffs.xlsx";
    try {
      parseChoice(secret);
    } catch (error) {
      expect((error as Error).message).not.toContain("ACME");
    }
  });

  it("does tolerate formatting noise, which is not a different answer", () => {
    expect(parseChoice("  PICK 4  ")).toEqual({ kind: "picked", number: 4 });
    expect(parseChoice("PICK 4.")).toEqual({ kind: "picked", number: 4 });
    expect(parseChoice("pick 4")).toEqual({ kind: "picked", number: 4 });
    expect(parseChoice("none")).toEqual({ kind: "none" });
    expect(parseChoice("AMBIGUOUS 3, 7")).toEqual({ kind: "ambiguous", numbers: [3, 7] });
  });
});

describe("failure mode 2: a number that does not exist", () => {
  it("refuses an index just past the end of a long list", () => {
    // NOT a theoretical edge case. VS Code's candidate list runs to 83 entries and an index
    // hallucinated a little past the end is exactly the mistake to expect on a long list.
    const candidates = cands("vscode");
    expect(candidates).toHaveLength(83);

    const error = refusalOf(() =>
      resolveChoice(candidates, { kind: "picked", number: 104 }, "the source control icon", "VS Code"),
    );
    expect(error.refusal).toBe("untrustworthy");
  });

  it("is a DIFFERENT refusal from the model saying none", () => {
    const candidates = cands("vscode");
    const outOfRange = refusalOf(() =>
      resolveChoice(candidates, { kind: "picked", number: 999 }, "the gear", "VS Code"),
    );
    const none = refusalOf(() =>
      resolveChoice(candidates, { kind: "none" }, "the gear", "VS Code"),
    );

    expect(outOfRange.refusal).toBe("untrustworthy");
    expect(none.refusal).toBe("not-found");
    expect(outOfRange.message).not.toBe(none.message);
  });

  it("never clamps to the nearest valid index", () => {
    const candidates = cands("notepad");
    // Clamping would put a confident marker on whatever happened to be last in the list.
    expect(() =>
      resolveChoice(candidates, { kind: "picked", number: 27 }, "the File menu", "Notepad"),
    ).toThrowError(ElementNotFoundError);
    expect(candidates).toHaveLength(26);
  });

  it("rejects zero and negatives at the parser, before they reach the gate", () => {
    expect(() => parseChoice("PICK 0")).toThrowError(ChooserError);
    expect(() => parseChoice("PICK -1")).toThrowError(ChooserError);
  });
});

describe("failure mode 3: the model correctly says it is not here", () => {
  it("is a legitimate outcome with its own refusal kind, not an error path", () => {
    const error = refusalOf(() =>
      resolveChoice(cands("notepad"), { kind: "none" }, "the send button", "Notepad"),
    );
    expect(error.refusal).toBe("not-found");
    expect(error).toBeInstanceOf(ElementNotFoundError);
    // Emphatically NOT a ChooserError — the model did exactly what it was asked to do.
    expect(error).not.toBeInstanceOf(ChooserError);
  });

  it("says how many controls it actually looked at, which vision could never do", () => {
    const error = refusalOf(() =>
      resolveChoice(cands("notepad"), { kind: "none" }, "the send button", "Notepad"),
    );
    // Under vision this sentence was the model's word taken on trust. Now it is checkable.
    expect(error.message).toContain("26 controls");
    expect(error.message).toContain("Notepad");
    expect(error.message).toContain('"the send button"');
  });
});

// ---------------------------------------------------------------------------
// AMBIGUITY. Two routes in, one refusal out.
// ---------------------------------------------------------------------------
describe("ambiguity, detected by CODE after the pick", () => {
  it("refuses when the chosen candidate shares its name with another", () => {
    // Explorer really does expose four controls named "Filter dropdown".
    const candidates = cands("explorer");
    const filters = candidates.filter((c) => c.name === "Filter dropdown");
    expect(filters).toHaveLength(4);

    const error = refusalOf(() =>
      resolveChoice(
        candidates,
        { kind: "picked", number: filters[0]!.number },
        "the filter dropdown",
        "File Explorer",
      ),
    );
    expect(error.refusal).toBe("ambiguous");
  });

  it("does not depend on the model admitting the ambiguity", () => {
    // The model answered a confident PICK. Code refused anyway. That is the guarantee: it does
    // not rest on the model choosing to be honest about its own uncertainty.
    const candidates = cands("explorer");
    const filters = candidates.filter((c) => c.name === "Filter dropdown");
    for (const filter of filters) {
      expect(
        refusalOf(() =>
          resolveChoice(candidates, { kind: "picked", number: filter.number }, "filter", "Explorer"),
        ).refusal,
      ).toBe("ambiguous");
    }
  });

  it("names them by left-to-right order when the position phrase cannot separate them", () => {
    // All four are "top", so four identical phrases would be useless to answer.
    const candidates = cands("explorer");
    const filters = candidates.filter((c) => c.name === "Filter dropdown");
    expect(new Set(filters.map((c) => c.position)).size).toBe(1);

    const error = refusalOf(() =>
      resolveChoice(
        candidates,
        { kind: "picked", number: filters[0]!.number },
        "the filter dropdown",
        "File Explorer",
      ),
    );
    expect(error.message).toContain("1st from the left");
    expect(error.message).toContain("4th from the left");
  });

  it("uses the position phrase when that DOES separate them", () => {
    const candidates = cands("explorer");
    const details = candidates.filter((c) => c.name === "Details");
    expect(details).toHaveLength(2);
    expect(new Set(details.map((c) => c.position)).size).toBe(2);

    const error = refusalOf(() =>
      resolveChoice(
        candidates,
        { kind: "picked", number: details[0]!.number },
        "details",
        "File Explorer",
      ),
    );
    expect(error.message).toContain("bottom right");
    expect(error.message).toContain("top right");
  });

  it("accepts a unique name without complaint", () => {
    // The three regression targets are all unique, so none of this touches them.
    const candidates = cands("explorer");
    const newButton = candidates.find((c) => c.name === "New")!;
    const chosen = resolveChoice(
      candidates,
      { kind: "picked", number: newButton.number },
      "the new button",
      "File Explorer",
    );
    expect(chosen.rect).toEqual({ x: 9, y: 123, width: 129, height: 67 });
  });

  it("leaves all three M15 regression targets resolvable", () => {
    const notepad = cands("notepad");
    const file = notepad.find((c) => c.name === "File")!;
    const tab = notepad.find((c) => c.name.startsWith("Advice.txt"))!;

    expect(
      resolveChoice(notepad, { kind: "picked", number: file.number }, "the file menu", "Notepad")
        .rect,
    ).toEqual({ x: 4, y: 49, width: 62, height: 48 });
    expect(
      resolveChoice(notepad, { kind: "picked", number: tab.number }, "the advice tab", "Notepad")
        .rect,
    ).toEqual({ x: 454, y: 1, width: 120, height: 48 });
  });
});

describe("ambiguity, volunteered by the MODEL", () => {
  it("refuses and names the entries the model listed", () => {
    const candidates = cands("notepad");
    const error = refusalOf(() =>
      resolveChoice(
        candidates,
        { kind: "ambiguous", numbers: [candidates[0]!.number, candidates[1]!.number] },
        "the tab",
        "Notepad",
      ),
    );
    expect(error.refusal).toBe("ambiguous");
    expect(error.message).toContain(candidates[0]!.name);
    expect(error.message).toContain(candidates[1]!.name);
  });

  it("still refuses when the numbers it listed do not exist", () => {
    const error = refusalOf(() =>
      resolveChoice(cands("notepad"), { kind: "ambiguous", numbers: [900, 901] }, "the tab", "Notepad"),
    );
    // Degrades to the unnamed form rather than throwing something else — the user still learns
    // the app declined to choose.
    expect(error.refusal).toBe("ambiguous");
    expect(error.message).toContain("more than one");
  });
});

// ---------------------------------------------------------------------------
describe("renderChooseRequest", () => {
  it("puts every candidate on a numbered line with name, type and position", () => {
    const candidates = cands("notepad");
    const rendered = renderChooseRequest(candidates, "the File menu", "Advice.txt - Notepad");

    expect(rendered).toContain("Window: Advice.txt - Notepad");
    expect(rendered).toContain("They are looking for: the File menu");
    const file = candidates.find((c) => c.name === "File")!;
    expect(rendered).toContain(`${file.number}. "File" (MenuItem, top left)`);
  });

  it("carries no coordinate anywhere", () => {
    // THE STRUCTURAL PROPERTY OF THE WHOLE MILESTONE: if no pixel value goes into the request,
    // no pixel value can come back in the reply.
    //
    // Asserted by MUTATION rather than by string matching. Searching the rendered text for rect
    // values is unreliable — a rect of 63 collides with candidate number 63 — so instead the
    // same candidates are rendered twice with wildly different rects. If any coordinate reached
    // the prompt, the two renderings would differ.
    const candidates = cands("vscode");
    const moved = candidates.map((c) => ({
      ...c,
      rect: { x: c.rect.x + 7919, y: c.rect.y + 104_729, width: 1, height: 1 },
    }));

    expect(renderChooseRequest(moved, "the source control icon", "VS Code")).toBe(
      renderChooseRequest(candidates, "the source control icon", "VS Code"),
    );
  });

  it("stays a sane size on the densest window measured", () => {
    const rendered = renderChooseRequest(cands("vscode"), "the settings gear", "VS Code");
    expect(rendered.length).toBeLessThan(12_000);
  });

  it("tells the model to decline rather than offer the nearest thing", () => {
    expect(CHOOSE_SYSTEM).toContain("NONE");
    expect(CHOOSE_SYSTEM).toContain("worse in every case");
  });
});
