import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildRegistry, toToolSchemas } from "../../src/core/registry.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { CONNECTORS, loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";
import type { CapturedContext } from "../../src/core/types.ts";

// DOES THE REAL MODEL REACH FOR `plan` WHEN IT SHOULD? (M19)
//
// The known gap since M17: a model handed a multi-step instruction answers with one tool, or
// with chat, rather than calling `plan`. M19 adds a worked example to the plan tool's
// description (core/llm/plan.ts) in the hope of moving that. Whether it does is exactly the
// kind of fact no fixture can establish — in every other test in this repo the plan IS the
// fixture.
//
// IT CALLS `chooseTool` DIRECTLY, never `planner.run`: what is measured is the choice, and
// running the chosen plan would read Gmail and reach for Linear. Nothing here executes a tool.
// The connector tools are built over `UnavailableConnection`, so even a bug could not create
// an issue — the schemas the model reads are the real ones, and there is nothing behind them.
//
// OPT-IN BY ITS OWN FLAG, for the reason tests/eval/toolChoice.eval.test.ts learned the
// expensive way: a key being present is not permission to spend it.
//
//     M19_PLAN_EVAL=1 npx vitest run tests/eval/planChoice.eval.test.ts
//
// TWO CONTEXTS, AND THE DIFFERENCE BETWEEN THEM IS A FINDING. The first version of this file
// handed the model an active window title ("... - Gmail"). The running app never does:
// `WindowsShell.getContext()` returns the clipboard and NULL for the window title and app, so
// the planner has no idea an email is open. The first live chain showed what that costs — "file
// this bug in Linear and tell the social channel" came back as chat asking for the bug details.
// An eval that knows more than the app does flatters the app.
//
//   "as the app sees it"   nothing but the instruction — what a live run gets today
//   "told Gmail is open"   the same, plus a window title — what a context fix would add
//
// COST: 5 phrases as the app sees it + 4 chain phrases told Gmail is open = 9 `chooseTool`
// calls, plus the SDK's own retries.

const PROVIDER = process.env["LLM_PROVIDER"];
const KEY =
  PROVIDER === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : process.env["OPENAI_API_KEY"];
const CONFIGURED = process.env["M19_PLAN_EVAL"] === "1" && Boolean(PROVIDER) && Boolean(KEY);

const BUG_CHAIN = ["readEmail", "linear__create_issue", "sendMessage"];

interface Case {
  phrase: string;
  // The tools, in order — or a single tool name for a phrase that must NOT become a plan.
  expected: string[];
}

const CASES: readonly Case[] = [
  // The worked example's own phrasing, then two that share none of its words.
  { phrase: "file this bug email in Linear and tell the bugs channel", expected: BUG_CHAIN },
  { phrase: "make a Linear ticket from this email, then post the link in #bugs", expected: BUG_CHAIN },
  { phrase: "log this as an issue and let #bugs know", expected: BUG_CHAIN },
  // THE LIVE FAILURE (docs/M19-live-checklist.md, live result 2), verbatim. No word says
  // "email": "this bug" is the only pointer to what is on screen.
  { phrase: "file this bug in Linear and tell the social channel", expected: BUG_CHAIN },
  // The control. An example that teaches the model to plan EVERYTHING would be a regression:
  // one tool must still be one tool.
  { phrase: "find the login issue in Linear", expected: ["linear__search_issues"] },
];

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: Object.fromEntries(
      CONNECTORS.map((def) => [
        def.id,
        {
          enabled: true,
          tools: def.tools.map((tool) => tool.name),
          settings: { defaultTeam: "Engineering" },
        },
      ]),
    ),
  }),
  readKey: () => "unused",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

// The menu the running app offers with everything configured — tool choice gets harder as the
// menu grows, and a small menu would flatter the result.
const MENU = toToolSchemas(
  buildRegistry({
    gmail: true,
    notion: true,
    calendar: true,
    speech: true,
    pointing: true,
    connectors,
  }),
);

interface Seen {
  label: string;
  context: CapturedContext;
}

const AS_THE_APP_SEES_IT: Seen = {
  label: "as the app sees it",
  context: { selectedText: null, activeApp: null, activeWindowTitle: null },
};
const TOLD_GMAIL_IS_OPEN: Seen = {
  label: "told Gmail is open",
  context: {
    selectedText: null,
    activeApp: "chrome.exe",
    activeWindowTitle: "Bug: login button does nothing on mobile - dana@example.com - Gmail",
  },
};

const results: { seen: string; phrase: string; expected: string; chosen: string }[] = [];

describe.skipIf(!CONFIGURED)("does the REAL model plan the bug-report chain (M19)", () => {
  const runs = [
    ...CASES.map((entry) => ({ ...entry, seen: AS_THE_APP_SEES_IT })),
    ...CASES.filter((entry) => entry.expected === BUG_CHAIN).map((entry) => ({
      ...entry,
      seen: TOLD_GMAIL_IS_OPEN,
    })),
  ];
  for (const { phrase, expected, seen } of runs) {
    it(`[${seen.label}] "${phrase}" -> ${expected.join(" > ")}`, async () => {
      const choice = await createLLMClient().chooseTool(phrase, seen.context, MENU, null);

      // A chat reply IS a choice, and its words are the diagnosis — the planner logs a miss
      // with no text, so this is the only place they are ever recorded.
      const said =
        choice.kind === "none" && choice.text
          ? `: ${choice.text.replace(/\s+/g, " ").slice(0, 200)}`
          : "";
      const chosen =
        choice.kind === "plan"
          ? choice.steps.map((step) => step.tool)
          : choice.kind === "tool"
            ? [choice.name]
            : [`(${choice.kind}${said})`];
      results.push({
        seen: seen.label,
        phrase,
        expected: expected.join(" > "),
        chosen: chosen.join(" > "),
      });
      expect(chosen).toEqual(expected);

      if (choice.kind === "plan" && expected === BUG_CHAIN) {
        // The two things the worked example exists to teach: the email goes in as {step1}, and
        // the TITLE is the model's own words — it cannot be a placeholder, because step 1's
        // result is the whole email.
        const create = choice.steps[1]?.arguments ?? {};
        expect(String(create["description"])).toContain("{step1}");
        expect(String(create["title"])).not.toMatch(/\{\s*step/i);
        expect(String(choice.steps[2]?.arguments["notes"])).toContain("{step2}");
      }
    }, 120_000);
  }

  afterAll(() => {
    if (results.length === 0) return;
    console.log(
      [
        "",
        "  PLAN CHOICE — what the real model actually answered",
        ...results.map(
          (r) =>
            `  ${r.chosen === r.expected ? "ok      " : "MISMATCH"}  [${r.seen}] "${r.phrase}"\n            -> ${r.chosen}`,
        ),
        `  ${results.filter((r) => r.chosen === r.expected).length}/${results.length} matched`,
        "",
      ].join("\n"),
    );
  });
});
