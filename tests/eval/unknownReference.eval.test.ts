import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildRegistry, toToolSchemas } from "../../src/core/registry.ts";
import { realModelGate } from "./realModel.ts";
import { loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";
import type { ActionLogEntry, CapturedContext, ToolChoice } from "../../src/core/types.ts";

// DOES THE REAL MODEL WRITE THE PLAN WHEN IT DOES NOT RECOGNISE A NAME — OR ASK ABOUT IT? (M21)
//
// Found live. "File this email as a bug on GitHub and post it in the bugs channel", with nothing
// known as "the bugs channel", is meant to come back as a plan carrying the phrase exactly as
// said: the app resolves it, or asks the user itself through a real question the hotkeys know
// about. Shown the refusal of an earlier attempt as "the previous turn", the model instead
// answered in PROSE with a question of its own — which the app displays as a result, so it
// looks like a question and nothing is waiting on it.
//
// Two things were done about it. The planner no longer shows that refusal to the model at all
// (tests/planner.ask.test.ts — deterministic). And the prompt gained one narrow rule: a "my…" or
// "the…" name you do not recognise goes into the plan as written, and is never asked about.
// THIS FILE MEASURES THE SECOND, so it shows the model the refusal ON PURPOSE — the very thing
// the app now withholds — because that is the condition under which the rule has to hold.
//
// IT CALLS `chooseTool` DIRECTLY and executes nothing. The connector tools are built over
// `UnavailableConnection`: the schemas the model reads are the real ones, with nothing behind
// them.
//
// OPT-IN BY ITS OWN FLAG — a key being present is not permission to spend it:
//
//     M21_REFERENCE_EVAL=1 REAL_MODEL=1 npx vitest run tests/eval/unknownReference.eval.test.ts
//
// EVERY CASE IS RUN SEVERAL TIMES (CLAUDE.md: one trial is an anecdote) and passes at 4 of 5.
// THE CONTEXT IS WRITTEN OUT PER CASE, clipboard included. That is not tidiness: the first
// real-window reproduction of this bug passed by accident, because 1,737 characters of
// unrelated clipboard text changed the model's answer. What the model was shown is part of the
// result.
//
// THREE GROUPS:
//   "the rule"        an unrecognised name, with a refusal about it as the previous turn
//   "no regression"   instructions that planned correctly before the rule existed
//   "still asks"      VAGUE instructions, where a clarifying question is the right answer and
//                     must stay one (the M10/M17 decision in CHOOSE_SYSTEM's "If no tool
//                     fits…"). One of them names "my meeting" — a "my…" phrase — on purpose:
//                     the rule is about what a NAME means, never about a detail that is missing.
//
// COST: 7 cases x TRIALS (default 5) = 35 `chooseTool` calls.
//
// MEASURED 2026-10-10, LLM_PROVIDER=openai, 5 trials each (the count is trials that gave the
// expected answer). "Before" is the prompt without the rule, same cases, same day:
//
//                                                               before   after
//   the rule        chain, pre-flight refusal shown               0/5     5/5
//   the rule        lone send, the tool's own refusal shown       0/5     5/5
//   no regression   the M19 chain, no previous turn               5/5     5/5
//   no regression   "send these notes to the team"                5/5     5/5
//   still asks      "move my meeting"                             5/5     5/5
//   still asks      "schedule a meeting"                          5/5     5/5
//
// Every "before" miss on the first two was prose asking what "the bugs channel" is. One run of
// 5 per cell: enough to show the direction (0 to 5), not enough to promise 5 of 5 forever.

const PROVIDER = process.env["LLM_PROVIDER"];
const SELECTED = process.env["M21_REFERENCE_EVAL"] === "1" && PROVIDER !== undefined;
const TRIALS = Number(process.env["EVAL_TRIALS"] ?? 5);
const PASS_AT = Math.ceil(TRIALS * 0.8);

const connectors = loadConnectorTools({
  // The app's own shape of connectors.json, written out so the eval does not depend on a file
  // the user edits.
  configText: JSON.stringify({
    connectors: {
      linear: { enabled: true, tools: ["create_issue", "search_issues", "get_issue"], settings: { defaultTeam: "Engineering" } },
      github: { enabled: true, tools: ["create_issue", "list_issues", "get_issue"], settings: { owner: "example", repo: "example" } },
    },
  }),
  readKey: () => "not-a-real-key",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

// Everything the running app can have on its menu at once.
const TOOLS = toToolSchemas(
  buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true, connectors }),
);

const NOTHING: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
const EMAIL_OPEN: CapturedContext = { ...NOTHING, emailOpen: true };

// The two rows the app can leave behind after not knowing a channel — as they sit in a log.
const PREFLIGHT_REFUSAL: ActionLogEntry = {
  ts: "2026-10-10T15:17:24.646Z",
  instruction: "File this email as a bug on GitHub and post it in the bugs channel.",
  tool: null,
  arguments: { plan: ["readEmail", "github__create_issue", "sendMessage"] },
  result:
    'Step 3 of my plan needs "the bugs channel", and I don\'t know what that refers to yet, so I ' +
    "didn't start it — teach me with: remember the bugs channel is <what it is>.",
  status: "refused",
};
const TOOL_REFUSAL: ActionLogEntry = {
  ts: "2026-10-10T13:38:16.835Z",
  instruction: "tell the bugs channel the deploy is done",
  tool: "sendMessage",
  arguments: { channel: "the bugs channel", notes: "the deploy is done" },
  result:
    'I don\'t know which channel "the bugs channel" means — teach me with: remember the bugs channel is #your-channel.',
  status: "refused",
};

// M22 prompt 6: the row bot mode leaves when a channel is not in Slack — the exact text
// `slackRefusalText` builds (tests/m22.texts.test.ts pins it).
const BOT_NOT_FOUND_REFUSAL: ActionLogEntry = {
  ts: "2026-10-11T10:00:00.000Z",
  instruction: "tell #bug the deploy is done",
  tool: "sendMessage",
  arguments: { channel: "#bug", notes: "the deploy is done" },
  result:
    "I couldn't find a Slack channel called #bug. I can post to public channels and to private " +
    "channels the bot has been added to. Similar channels: #bug-reports.",
  status: "refused",
};

type Verdict = { ok: boolean; saw: string };

const describeChoice = (choice: ToolChoice): string => {
  if (choice.kind === "plan") return `plan ${choice.steps.map((s) => s.tool).join(" > ")}`;
  if (choice.kind === "tool") return `tool ${choice.name} ${JSON.stringify(choice.input)}`;
  if (choice.kind === "none") return `PROSE ${JSON.stringify(choice.text)}`;
  if (choice.kind === "multiple") return `MULTIPLE CALLS ${choice.tools.join(" + ")}`;
  return `incomplete (${choice.reason})`;
};

// The channel a choice would send to, wherever the send sits.
const channelOf = (choice: ToolChoice): unknown => {
  if (choice.kind === "tool" && choice.name === "sendMessage") return choice.input["channel"];
  if (choice.kind === "plan") return choice.steps.find((s) => s.tool === "sendMessage")?.arguments["channel"];
  return undefined;
};
const saysExactly = (value: unknown, phrase: string): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === phrase;

const planned = (tools: string[]) => (choice: ToolChoice): boolean =>
  choice.kind === "plan" && tools.every((tool, i) => choice.steps[i]?.tool === tool) && choice.steps.length === tools.length;
// A clarifying question: prose, and it actually asks something.
const asks = (choice: ToolChoice): boolean =>
  choice.kind === "none" && choice.text !== null && choice.text.includes("?");

interface Case {
  group: "the rule" | "no regression" | "still asks" | "bot mode";
  name: string;
  instruction: string;
  context: CapturedContext;
  previous: ActionLogEntry | null;
  expected: string;
  passes: (choice: ToolChoice) => boolean;
}

const CASES: Case[] = [
  {
    group: "the rule",
    name: "chain, with the pre-flight's refusal as the previous turn",
    instruction: "File this email as a bug on GitHub and post it in the bugs channel",
    context: EMAIL_OPEN,
    previous: PREFLIGHT_REFUSAL,
    expected: "a plan ending in sendMessage, channel written exactly 'the bugs channel'",
    passes: (choice) =>
      planned(["readEmail", "github__create_issue", "sendMessage"])(choice) &&
      saysExactly(channelOf(choice), "the bugs channel"),
  },
  {
    group: "the rule",
    name: "lone send, with the tool's own refusal as the previous turn",
    instruction: "tell the bugs channel the deploy is done",
    context: NOTHING,
    previous: TOOL_REFUSAL,
    expected: "sendMessage, channel written exactly 'the bugs channel'",
    passes: (choice) =>
      choice.kind === "tool" && choice.name === "sendMessage" && saysExactly(channelOf(choice), "the bugs channel"),
  },
  {
    group: "no regression",
    name: "the M19 chain, no previous turn",
    instruction: "file this bug in Linear and tell the social channel",
    context: EMAIL_OPEN,
    previous: null,
    expected: "plan readEmail > linear__create_issue > sendMessage",
    passes: planned(["readEmail", "linear__create_issue", "sendMessage"]),
  },
  {
    group: "no regression",
    name: "the oldest single-tool send",
    instruction: "send these notes to the team",
    context: { ...NOTHING, selectedText: "standup: shipped the memory engine, slack next, blocked on nothing" },
    previous: null,
    expected: "sendMessage, channel 'the team'",
    passes: (choice) =>
      choice.kind === "tool" && choice.name === "sendMessage" && saysExactly(channelOf(choice), "the team"),
  },
  {
    group: "still asks",
    name: "a 'my…' phrase with a detail MISSING (no new time)",
    instruction: "move my meeting",
    context: NOTHING,
    previous: null,
    expected: "a clarifying question in prose (which meeting / to when)",
    passes: asks,
  },
  {
    group: "still asks",
    name: "a vague instruction with nothing to act on",
    instruction: "schedule a meeting",
    context: NOTHING,
    previous: null,
    expected: "a clarifying question in prose (when / what)",
    passes: asks,
  },
  // M22 prompt 6. Bot mode's not-found refusal names similar channels as a STATEMENT ("Similar
  // channels: #bug-reports.") rather than "Did you mean …?", so that, shown as the previous turn,
  // it does not read as a question waiting for an answer. Passing means the next instruction is
  // planned as a send — not answered in prose about which channel was meant.
  // Measured 2026-10-11, LLM_PROVIDER=openai, 5 trials: 5/5, each `sendMessage` to "the bugs channel".
  {
    group: "bot mode",
    name: "lone send, with the bot-mode 'Similar channels' refusal as the previous turn",
    instruction: "tell the bugs channel the deploy is done",
    context: NOTHING,
    previous: BOT_NOT_FOUND_REFUSAL,
    expected: "sendMessage (a tool call, not prose asking which channel was meant)",
    passes: (choice) => choice.kind === "tool" && choice.name === "sendMessage",
  },
];

// DRY UNLESS REAL_MODEL=1 (tests/eval/realModel.ts): M21_REFERENCE_EVAL chooses this eval;
// REAL_MODEL=1 is what spends, under the per-run cap.
const GATE = realModelGate({
  name: "unknown-reference eval",
  plannedCalls: CASES.length * TRIALS,
  selected: SELECTED,
  howToRun: "M21_REFERENCE_EVAL=1 REAL_MODEL=1 npx vitest run tests/eval/unknownReference.eval.test.ts",
});
const ENABLED = GATE.real;
const llm = ENABLED ? GATE.client() : null;

const summary: string[] = [];

describe.skipIf(!ENABLED)(`unknown-reference eval (${PROVIDER ?? "no provider"}, ${TRIALS} trials each)`, () => {
  afterAll(() => {
    console.log(`\n${"=".repeat(78)}\n${summary.join("\n")}\n${"=".repeat(78)}`);
  });

  for (const testCase of CASES) {
    it(
      `[${testCase.group}] ${testCase.name}`,
      async () => {
        if (llm === null) throw new Error("the unknown-reference eval is a dry run");
        const verdicts: Verdict[] = [];
        for (let i = 0; i < TRIALS; i++) {
          const choice = await llm.chooseTool(testCase.instruction, testCase.context, TOOLS, testCase.previous);
          verdicts.push({ ok: testCase.passes(choice), saw: describeChoice(choice) });
        }
        const passed = verdicts.filter((v) => v.ok).length;
        summary.push(
          `${String(passed).padStart(2)}/${TRIALS}  [${testCase.group}] ${testCase.name}`,
          `        "${testCase.instruction}"  — expected ${testCase.expected}`,
          ...verdicts.map((v, i) => `        ${i + 1}. ${v.ok ? "ok  " : "MISS"} ${v.saw.slice(0, 190)}`),
        );
        expect(passed, verdicts.map((v) => v.saw).join("\n")).toBeGreaterThanOrEqual(PASS_AT);
      },
      600_000,
    );
  }
});

describe("unknown-reference eval", () => {
  it("says whether it runs for real (M21_REFERENCE_EVAL=1, LLM_PROVIDER, REAL_MODEL=1) and what it would cost", () => {
    console.log(GATE.line);
  });
});
