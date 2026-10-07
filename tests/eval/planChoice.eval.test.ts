import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildRegistry, toToolSchemas } from "../../src/core/registry.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { CONNECTORS, loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";

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
// COST: one `chooseTool` call per phrase below (4), plus the SDK's own retries.

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

const results: { phrase: string; expected: string; chosen: string }[] = [];

describe.skipIf(!CONFIGURED)("does the REAL model plan the bug-report chain (M19)", () => {
  for (const { phrase, expected } of CASES) {
    it(`"${phrase}" -> ${expected.join(" > ")}`, async () => {
      const choice = await createLLMClient().chooseTool(
        phrase,
        {
          selectedText: null,
          activeApp: "chrome.exe",
          activeWindowTitle: "Login broken on Safari - dana@example.com - Gmail",
        },
        MENU,
        null,
      );

      const chosen =
        choice.kind === "plan"
          ? choice.steps.map((step) => step.tool)
          : choice.kind === "tool"
            ? [choice.name]
            : [`(${choice.kind})`];
      results.push({ phrase, expected: expected.join(" > "), chosen: chosen.join(" > ") });
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
          (r) => `  ${r.chosen === r.expected ? "ok      " : "MISMATCH"}  "${r.phrase}"\n            -> ${r.chosen}`,
        ),
        `  ${results.filter((r) => r.chosen === r.expected).length}/${results.length} matched`,
        "",
      ].join("\n"),
    );
  });
});
