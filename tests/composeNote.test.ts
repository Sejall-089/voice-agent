import { describe, it, expect } from "vitest";
import { composeNote } from "../src/core/composeNote.ts";
import { FakeLLM } from "./FakeLLM.ts";

// M11. Same reasoning as compose.test.ts: composeNote's output is model-generated text, so
// its content can't be asserted directly — what CAN be asserted deterministically is the
// instruction sent to the model.
const UNUSED_CHOICE = { kind: "none", text: null } as const;

describe("composeNote (M11) — the Notion half of the compose split", () => {
  it("tells the model to append only, never replace or rewrite the page", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "Some new note text.");

    await composeNote(llm, {
      instruction: "add a note that the launch moved to Friday",
      tone: "clear, natural, and concise",
      material: null,
      destination: { title: "Launch plan", existing: "Kickoff is Monday." },
    });

    expect(llm.lastSystemPrompt).toMatch(/APPENDED after everything already on the page/);
    expect(llm.lastSystemPrompt).toMatch(
      /can never replace, rewrite, or remove anything that is already there/i,
    );
  });

  it("carries the same no-invention rule compose.ts uses", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "note text");

    await composeNote(llm, {
      instruction: "summarize what we decided",
      tone: "clear, natural, and concise",
      material: null,
      destination: null,
    });

    expect(llm.lastSystemPrompt).toMatch(
      /do not invent the user's\s+opinions, feedback, requests, or stance/i,
    );
  });

  it("explicitly rules out a greeting or sign-off — a note isn't addressed to anyone", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "note text");

    await composeNote(llm, {
      instruction: "say thanks",
      tone: "clear, natural, and concise",
      material: null,
      destination: null,
    });

    // Unlike compose.ts's rules (which INSTRUCT a greeting and sign-off), composeNote's rules
    // must rule them OUT.
    expect(llm.lastSystemPrompt).toMatch(/no greeting, no sign-?off/i);
    expect(llm.lastSystemPrompt).not.toMatch(/include a brief.*greeting/i);
  });

  it("passes existing page content as context, so the model doesn't repeat it", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "note text");

    await composeNote(llm, {
      instruction: "add a follow-up",
      tone: "clear, natural, and concise",
      material: null,
      destination: { title: "Meeting notes", existing: "Alex will send the deck by Friday." },
    });

    expect(llm.lastUserPrompt).toContain("Meeting notes");
    expect(llm.lastUserPrompt).toContain("Alex will send the deck by Friday.");
  });

  it("passes clipboard material to draw on when there is any", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "note text");

    await composeNote(llm, {
      instruction: "turn this into a note",
      tone: "clear, natural, and concise",
      material: "Q3 revenue grew 12% year over year.",
      destination: null,
    });

    expect(llm.lastUserPrompt).toContain("Q3 revenue grew 12% year over year.");
  });

  it("omits the material section entirely when there is none", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "note text");

    await composeNote(llm, {
      instruction: "add a note",
      tone: "clear, natural, and concise",
      material: null,
      destination: null,
    });

    expect(llm.lastUserPrompt).not.toContain("MATERIAL TO DRAW ON");
  });

  it("throws rather than writing emptiness into the page", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "   ");

    await expect(
      composeNote(llm, {
        instruction: "add a note",
        tone: "clear, natural, and concise",
        material: null,
        destination: null,
      }),
    ).rejects.toThrow(/empty note/i);
  });
});
