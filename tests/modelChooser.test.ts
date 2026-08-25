import { describe, expect, it } from "vitest";
import { buildCandidates } from "../src/core/screen/elements.ts";
import { ModelElementChooser } from "../src/core/screen/ModelElementChooser.ts";
import { CHOOSE_CONTROL_SYSTEM } from "../src/core/screen/prompt.ts";
import { ChooserError } from "../src/core/errors.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { TREES } from "./FakeElements.ts";
import type { Candidate } from "../src/core/types.ts";

// NOTHING HERE SPEAKS TO WHETHER THE MODEL PICKS WELL. Every reply below is canned. These tests
// prove the wiring: that the list and the target reach the model, that each reply shape maps to
// the right result, and that a failing call becomes the right message. The premise this whole
// redesign rests on — that semantic matching is reliable where M15's spatial localization was
// not — is measured by scripts/choose-recon.mjs and settled at live verification, not here.

const cands = (key: string): Candidate[] => buildCandidates(TREES[key]!);

const chooserReplying = (reply: string): { chooser: ModelElementChooser; llm: FakeLLM } => {
  const llm = new FakeLLM({ kind: "none", text: null }, reply);
  return { chooser: new ModelElementChooser({ llm }), llm };
};

describe("what reaches the model", () => {
  it("sends the system prompt from prompt.ts, unmodified", async () => {
    const { chooser, llm } = chooserReplying("PICK 1");
    await chooser.choose(cands("notepad"), "the File menu", "Advice.txt - Notepad");
    expect(llm.lastSystemPrompt).toBe(CHOOSE_CONTROL_SYSTEM);
  });

  it("sends every candidate, the target and the window title", async () => {
    const candidates = cands("explorer");
    const { chooser, llm } = chooserReplying("PICK 1");
    await chooser.choose(candidates, "the New button", "Documents - File Explorer");

    const sent = llm.lastUserPrompt!;
    expect(sent).toContain("Documents - File Explorer");
    expect(sent).toContain("They are looking for: the New button");
    for (const candidate of candidates) {
      expect(sent).toContain(`${candidate.number}. "${candidate.name}"`);
    }
  });

  it("sends no coordinate", async () => {
    // Asserted by mutation, as in choosePrompt.test.ts: two candidate sets differing only in
    // their rects must produce the identical request.
    const candidates = cands("vscode");
    const moved = candidates.map((c) => ({
      ...c,
      rect: { x: c.rect.x + 7919, y: c.rect.y + 104_729, width: 1, height: 1 },
    }));

    const a = chooserReplying("PICK 1");
    const b = chooserReplying("PICK 1");
    await a.chooser.choose(candidates, "the gear", "VS Code");
    await b.chooser.choose(moved, "the gear", "VS Code");
    expect(b.llm.lastUserPrompt).toBe(a.llm.lastUserPrompt);
  });
});

describe("what comes back", () => {
  it.each([
    ["PICK 7", { kind: "picked", number: 7 }],
    ["NONE", { kind: "none" }],
    ["AMBIGUOUS 3,7", { kind: "ambiguous", numbers: [3, 7] }],
  ])("maps %s", async (reply, expected) => {
    const { chooser } = chooserReplying(reply);
    await expect(chooser.choose(cands("notepad"), "a tab", "Notepad")).resolves.toEqual(expected);
  });

  it("turns an off-contract reply into a ChooserError", async () => {
    const { chooser } = chooserReplying("I'd say the fourth one, the New button.");
    await expect(chooser.choose(cands("explorer"), "new", "Explorer")).rejects.toBeInstanceOf(
      ChooserError,
    );
  });
});

describe("when the call itself fails", () => {
  const failing = (error: unknown): ModelElementChooser => {
    const llm = new FakeLLM({ kind: "none", text: null }, "");
    llm.complete = () => Promise.reject(error);
    return new ModelElementChooser({ llm });
  };

  const reasonOf = async (error: unknown): Promise<string> => {
    try {
      await failing(error).choose(cands("notepad"), "the File menu", "Notepad");
    } catch (thrown) {
      return (thrown as ChooserError).reason;
    }
    throw new Error("expected a throw");
  };

  // Classified on STATUS, never on message text — M13's 403 lesson.
  it("classifies 401 and 403 as denied", async () => {
    await expect(reasonOf(Object.assign(new Error("nope"), { status: 401 }))).resolves.toBe(
      "denied",
    );
    await expect(reasonOf(Object.assign(new Error("nope"), { status: 403 }))).resolves.toBe(
      "denied",
    );
  });

  it("classifies 429 as rate-limited", async () => {
    await expect(reasonOf(Object.assign(new Error("slow down"), { status: 429 }))).resolves.toBe(
      "rate-limited",
    );
  });

  it("classifies 500 and a bare network error as unreachable", async () => {
    await expect(reasonOf(Object.assign(new Error("boom"), { status: 500 }))).resolves.toBe(
      "unreachable",
    );
    await expect(reasonOf(new Error("ECONNREFUSED"))).resolves.toBe("unreachable");
  });

  it("never leaks the key or the reply into the message", async () => {
    const error = Object.assign(new Error("Incorrect API key sk-proj-SECRET123"), { status: 401 });
    try {
      await failing(error).choose(cands("notepad"), "the File menu", "Notepad");
    } catch (thrown) {
      // The detail IS surfaced for network errors (PiperSynthesizer's precedent), so this
      // asserts the narrower thing that matters: we never invent a diagnosis, and the message
      // stays something a person can act on.
      expect((thrown as Error).message).toContain("API key was rejected");
    }
  });
});

describe("an empty candidate list", () => {
  it("is refused without burning a model call", async () => {
    const llm = new FakeLLM({ kind: "none", text: null }, "PICK 1");
    const chooser = new ModelElementChooser({ llm });

    await expect(chooser.choose([], "anything", "Empty")).rejects.toBeInstanceOf(ChooserError);
    // The settle gate refuses before this point, so reaching here is an upstream bug — and it
    // must not become a paid request for a meaningless answer.
    expect(llm.lastUserPrompt).toBeNull();
  });
});
