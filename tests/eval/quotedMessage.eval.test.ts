import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildRegistry, toToolSchemas } from "../../src/core/registry.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";
import type { CapturedContext, ToolChoice } from "../../src/core/types.ts";

// WHEN THE USER DICTATES THE MESSAGE ITSELF, DOES THE MODEL PUT THOSE WORDS IN `notes`? (M21)
//
// Found live, 2026-10-11: `send "helluuu" to social channel` was refused. That refusal was the
// TOOL's fault — it formatted the quoted words and the formatter called them "not notes" — and
// is fixed and pinned in tests/sendMessage.test.ts: a message given in the instruction is sent
// as written. What that fix depends on is the half only the real model can show: that a quoted
// or "saying …" message arrives as `notes`, word for word, and that an open email does not pull
// the model off course. (Once, live, with an email open, the same kind of instruction came
// back as prose asking what to do with the email. It did not reproduce here — see "MEASURED".)
//
// IT CALLS `chooseTool` DIRECTLY and executes nothing; connector tools are built over
// `UnavailableConnection`.
//
// OPT-IN BY ITS OWN FLAG:
//
//     M21_QUOTED_EVAL=1 npx vitest run tests/eval/quotedMessage.eval.test.ts
//
// THE CONTEXT IS WRITTEN OUT PER CASE, clipboard included (CLAUDE.md: what the model was shown
// is part of the result). Each case is run EVAL_TRIALS times (default 5) and passes at 4 of 5.
//
// COST: 8 cases x 5 = 40 `chooseTool` calls.
//
// MEASURED 2026-10-11, LLM_PROVIDER=openai, 5 trials per cell. "Before" is the tool description
// without the sentence about a message given in the instruction:
//
//                                                                    before   after
//   send "helluuu" to social channel            no email              5/5      5/5
//   send "helluuu" to social channel            email open            5/5      5/5
//   send "hello guys" to social channel         no email              5/5      5/5
//   send "hello guys" to social channel         email open            5/5      5/5
//   …the same, email open AND unrelated clipboard text                5/5      5/5
//   tell the social channel saying we ship friday    no email         5/5      5/5
//   say good morning team in the social channel      email open       5/5      5/5
//   send these notes to the team (clipboard notes)   → NO `notes`     5/5      5/5
//
// So the planner was already doing this before the description changed, and the live prose
// reply is NOT reproduced by any of these. The description sentence is there to say what the
// code now does, not because a number moved. What the live run had and these do not is its
// actual clipboard, which nothing recorded.

const PROVIDER = process.env["LLM_PROVIDER"];
const ENABLED = process.env["M21_QUOTED_EVAL"] === "1" && PROVIDER !== undefined;
const TRIALS = Number(process.env["EVAL_TRIALS"] ?? 5);
const PASS_AT = Math.ceil(TRIALS * 0.8);

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: {
      linear: { enabled: true, tools: ["create_issue", "search_issues", "get_issue"], settings: { defaultTeam: "Engineering" } },
      github: { enabled: true, tools: ["create_issue", "list_issues", "get_issue"], settings: { owner: "example", repo: "example" } },
    },
  }),
  readKey: () => "not-a-real-key",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

const TOOLS = toToolSchemas(
  buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true, connectors }),
);

const NOTHING: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const EMAIL_OPEN: CapturedContext = { ...NOTHING, emailOpen: true };
const UNRELATED = "Quarterly numbers: revenue up 4%, churn flat. Draft only — do not circulate.";

const describeChoice = (choice: ToolChoice): string => {
  if (choice.kind === "tool") return `tool ${choice.name} ${JSON.stringify(choice.input)}`;
  if (choice.kind === "plan") return `plan ${choice.steps.map((s) => `${s.tool} ${JSON.stringify(s.arguments)}`).join(" > ")}`;
  if (choice.kind === "none") return `PROSE ${JSON.stringify(choice.text)}`;
  return `incomplete (${choice.reason})`;
};

// One lone `sendMessage` whose `notes` is the user's message — the same words, allowing only
// for case and a closing full stop, which is how a dictated phrase tends to come back.
const sendsExactly = (message: string) => (choice: ToolChoice): boolean => {
  if (choice.kind !== "tool" || choice.name !== "sendMessage") return false;
  const notes = choice.input["notes"];
  const bare = (text: string): string => text.trim().toLowerCase().replace(/[.!]$/, "");
  return typeof notes === "string" && bare(notes) === bare(message);
};

interface Case {
  name: string;
  instruction: string;
  context: CapturedContext;
  expected: string;
  passes: (choice: ToolChoice) => boolean;
}

const CASES: Case[] = [
  { name: "quoted, no email", instruction: 'send "helluuu" to social channel', context: NOTHING, expected: 'sendMessage, notes "helluuu"', passes: sendsExactly("helluuu") },
  { name: "quoted, email open", instruction: 'send "helluuu" to social channel', context: EMAIL_OPEN, expected: 'sendMessage, notes "helluuu"', passes: sendsExactly("helluuu") },
  { name: "quoted (two words), no email", instruction: 'send "hello guys" to social channel', context: NOTHING, expected: 'sendMessage, notes "hello guys"', passes: sendsExactly("hello guys") },
  { name: "quoted (two words), email open", instruction: 'send "hello guys" to social channel', context: EMAIL_OPEN, expected: 'sendMessage, notes "hello guys"', passes: sendsExactly("hello guys") },
  {
    name: "quoted, email open AND unrelated clipboard text",
    instruction: 'send "hello guys" to social channel',
    context: { ...EMAIL_OPEN, selectedText: UNRELATED },
    expected: 'sendMessage, notes "hello guys" — not the clipboard, not the email',
    passes: sendsExactly("hello guys"),
  },
  { name: "'saying', no email", instruction: "tell the social channel saying we ship friday", context: NOTHING, expected: 'sendMessage, notes "we ship friday"', passes: sendsExactly("we ship friday") },
  { name: "'say', email open", instruction: "say good morning team in the social channel", context: EMAIL_OPEN, expected: 'sendMessage, notes "good morning team"', passes: sendsExactly("good morning team") },
  {
    // The other direction: notes that are ON THE CLIPBOARD must still come from there, so the
    // tool formats them. A model that started copying them into `notes` would turn every
    // clipboard send into a verbatim one.
    name: "clipboard notes are NOT copied into `notes`",
    instruction: "send these notes to the team",
    context: { ...NOTHING, selectedText: "standup: shipped the memory engine, slack next, blocked on nothing" },
    expected: "sendMessage with no `notes` (the tool reads the clipboard)",
    passes: (choice) =>
      choice.kind === "tool" &&
      choice.name === "sendMessage" &&
      (choice.input["notes"] === undefined || String(choice.input["notes"]).trim() === ""),
  },
];

const summary: string[] = [];

describe.skipIf(!ENABLED)(`quoted-message eval (${PROVIDER ?? "no provider"}, ${TRIALS} trials each)`, () => {
  afterAll(() => console.log(`\n${"=".repeat(78)}\n${summary.join("\n")}\n${"=".repeat(78)}`));

  for (const testCase of CASES) {
    it(
      testCase.name,
      async () => {
        const llm = createLLMClient();
        const seen: { ok: boolean; saw: string }[] = [];
        for (let i = 0; i < TRIALS; i++) {
          const choice = await llm.chooseTool(testCase.instruction, testCase.context, TOOLS, null);
          seen.push({ ok: testCase.passes(choice), saw: describeChoice(choice) });
        }
        const passed = seen.filter((trial) => trial.ok).length;
        summary.push(
          `${passed}/${TRIALS}  ${testCase.name} — ${JSON.stringify(testCase.instruction)} → ${testCase.expected}`,
          ...seen.map((trial, i) => `        ${i + 1}. ${trial.ok ? "ok  " : "MISS"} ${trial.saw.slice(0, 170)}`),
        );
        expect(passed, seen.map((trial) => trial.saw).join("\n")).toBeGreaterThanOrEqual(PASS_AT);
      },
      600_000,
    );
  }
});

describe.skipIf(ENABLED)("quoted-message eval", () => {
  it("is skipped unless M21_QUOTED_EVAL=1 and LLM_PROVIDER are set", () => {
    console.log("  quoted-message eval SKIPPED: M21_QUOTED_EVAL is not 1 (it costs real API calls).");
  });
});
