import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { FORMAT_SYSTEM, isMessage } from "../../src/core/tools/sendMessage.ts";

// WHAT DOES THE REAL FORMATTER DO WITH TEXT THAT IS NOT NOTES? (M21)
//
// Found live: `sendMessage` was handed the user's own instruction as its notes ("send these
// notes to the bugs channel"), the formatter replied "Please paste the rough notes you want
// formatted for the #bugs channel." — and Slack received that. Two things now stand in the way:
// the formatter is told to answer exactly NO_NOTES when it is given nothing to format, and
// `isMessage` refuses a reply that is that word or that asks for the notes.
//
// The unit tests pin `isMessage` against literal replies. What they cannot say is what the model
// actually replies — including whether the new instruction makes it call REAL, short,
// imperative-sounding notes "not notes". That is this file.
//
// It calls `llm.complete` with the app's own FORMAT_SYSTEM and nothing else. Nothing is sent.
//
// OPT-IN BY ITS OWN FLAG:
//
//     M21_FORMATTER_EVAL=1 npx vitest run tests/eval/sendFormatter.eval.test.ts
//
// COST: 5 inputs, 14 `complete` calls in all. Each case passes at 4 of 5 (or 2 of 3).
//
// MEASURED 2026-10-10, LLM_PROVIDER=openai. Two wordings of the NO_NOTES instruction:
//
//                                                         first wording   current
//   "send these notes to the bugs channel"  → refused          5/5          5/5
//   "post this to the team"                 → refused          3/3          3/3
//   ordinary rough notes                    → sent             2/2          2/2
//   "remind everyone the deploy is at 5pm today" → sent        0/2          2/2
//   "can someone review PR 212 before friday?"   → sent        2/2          2/2
//
// The first wording ("only an instruction to send something") called a real one-line note "not
// notes" both times — exactly the over-reach this file exists to catch, and invisible to every
// unit test. Every refusal in both runs was the literal word NO_NOTES; the pattern half of
// `isMessage` was never the thing that caught one. Small trial counts: a direction, not a rate.

const ENABLED = process.env["M21_FORMATTER_EVAL"] === "1" && process.env["LLM_PROVIDER"] !== undefined;

interface Case {
  name: string;
  input: string;
  trials: number;
  // Should the reply be accepted as a message to post?
  message: boolean;
}

const CASES: Case[] = [
  // NOT notes — the two live inputs' shape. The reply must be refused by `isMessage`.
  { name: "the instruction itself (row 417)", input: "send these notes to the bugs channel", trials: 5, message: false },
  { name: "another bare instruction", input: "post this to the team", trials: 3, message: false },
  // Notes. The reply must be accepted — including when they are short or sound like an order.
  {
    name: "ordinary rough notes",
    input: "standup: shipped memory engine, next up slack, blocked on nothing",
    trials: 2,
    message: true,
  },
  { name: "one short imperative note", input: "remind everyone the deploy is at 5pm today", trials: 2, message: true },
  { name: "a note that is a question for the team", input: "can someone review PR 212 before friday?", trials: 2, message: true },
];

const summary: string[] = [];

describe.skipIf(!ENABLED)("send formatter eval", () => {
  afterAll(() => console.log(`\n${"=".repeat(78)}\n${summary.join("\n")}\n${"=".repeat(78)}`));

  for (const testCase of CASES) {
    it(
      testCase.name,
      async () => {
        const llm = createLLMClient();
        const replies: string[] = [];
        for (let i = 0; i < testCase.trials; i++) replies.push(await llm.complete(FORMAT_SYSTEM, testCase.input));

        const right = replies.filter((reply) => isMessage(reply) === testCase.message).length;
        summary.push(
          `${right}/${testCase.trials}  ${testCase.name} — ${JSON.stringify(testCase.input)} should be ${testCase.message ? "SENT" : "REFUSED"}`,
          ...replies.map((reply) => `        ${isMessage(reply) ? "message" : "refused"}  ${JSON.stringify(reply).slice(0, 150)}`),
        );
        expect(right, replies.join("\n---\n")).toBeGreaterThanOrEqual(Math.ceil(testCase.trials * 0.66));
      },
      300_000,
    );
  }
});

describe.skipIf(ENABLED)("send formatter eval", () => {
  it("is skipped unless M21_FORMATTER_EVAL=1 and LLM_PROVIDER are set", () => {
    console.log("  send formatter eval SKIPPED: M21_FORMATTER_EVAL is not 1 (it costs real API calls).");
  });
});
