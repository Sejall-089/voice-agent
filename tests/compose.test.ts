import { describe, it, expect } from "vitest";
import { composeReply } from "../src/core/compose.ts";
import { FakeLLM } from "./FakeLLM.ts";
import type { EmailMessage } from "../src/core/types.ts";

// M10. compose.ts's output is model-generated text, so its content can't be asserted
// directly — what CAN be asserted deterministically is the instruction sent to the model.
// FakeLLM never calls chooseTool here, so the ToolChoice passed to its constructor is unused.
const UNUSED_CHOICE = { kind: "none", text: null } as const;

function notificationEmail(): EmailMessage {
  return {
    subject: "Your weekly digest",
    from: "digest@example.com",
    fromName: null,
    to: null,
    body: "Here are this week's top stories. No action needed.",
  };
}

describe("composeReply (M10) — the neutral-acknowledgment instruction", () => {
  it("always tells the model not to invent the user's stance, opinions, or requests", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "Hi,\n\nThanks for the update.\n\nBest regards,");

    await composeReply(llm, {
      instruction: "reply to this",
      tone: "clear, natural, and concise",
      source: notificationEmail(),
    });

    expect(llm.lastSystemPrompt).toMatch(
      /do not invent the user's\s+opinions, feedback, requests, or stance/i,
    );
    expect(llm.lastSystemPrompt).toMatch(/write a brief, neutral acknowledgment/i);
  });

  it("carries the same instruction into a revision (previousDraft present)", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "Updated draft");

    await composeReply(llm, {
      instruction: "make it shorter",
      tone: "clear, natural, and concise",
      source: notificationEmail(),
      previousDraft: "Hi,\n\nThanks for the update.\n\nBest regards,",
    });

    expect(llm.lastSystemPrompt).toMatch(
      /do not invent the user's\s+opinions, feedback, requests, or stance/i,
    );
    expect(llm.lastUserPrompt).toContain("Hi,\n\nThanks for the update.\n\nBest regards,");
  });

  it("addresses the recipient and signs off by name when both are given", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "reply text");

    await composeReply(llm, {
      instruction: "say thanks",
      tone: "clear, natural, and concise",
      source: notificationEmail(),
      recipientName: "Alex",
      userName: "Sam",
    });

    expect(llm.lastSystemPrompt).toContain("Address the recipient as Alex.");
    expect(llm.lastSystemPrompt).toContain("Sign off as Sam.");
  });

  it("stays neutral (no name instruction) when neither name is available", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "reply text");

    await composeReply(llm, {
      instruction: "say thanks",
      tone: "clear, natural, and concise",
      source: notificationEmail(),
    });

    expect(llm.lastSystemPrompt).not.toContain("Address the recipient");
    expect(llm.lastSystemPrompt).not.toContain("Sign off as");
    expect(llm.lastSystemPrompt).toMatch(/neutral greeting/i);
  });

  it("throws rather than writing emptiness into the reply box", async () => {
    const llm = new FakeLLM(UNUSED_CHOICE, "   ");

    await expect(
      composeReply(llm, {
        instruction: "say thanks",
        tone: "clear, natural, and concise",
        source: notificationEmail(),
      }),
    ).rejects.toThrow(/empty reply/i);
  });
});
