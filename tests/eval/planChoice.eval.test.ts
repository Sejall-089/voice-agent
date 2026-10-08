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

// The measurement set for a wording change: the live failure, the one phrase that missed in the
// first eval, and the single-tool control.
const CORE = [
  "file this bug in Linear and tell the social channel",
  "log this as an issue and let #bugs know",
  "find the login issue in Linear",
] as const;

// Phrases that must NOT pick up a `readEmail` step however hard the descriptions push it.
// `draftReply` reads the email itself, and its two-step chain has worked since M17.
const OVERTEACH: readonly Case[] = [
  { phrase: "reply to this and send it", expected: ["draftReply", "sendReply"] },
];

// THE SECOND LIVE RETEST. With unrelated text on the clipboard the chain phrase was refused:
// the plan named `functions.linear__create_issue` — the provider's own internal namespace for
// tools, leaking into the free-text `tool` field of a plan step — and `validatePlan` rejected it
// as a tool the app does not have. With a clean clipboard the same words planned correctly.
// The phrase is verbatim, lower-case "linear" included. The clipboard text is a stand-in: what
// was actually on it that day was not recorded.
const UNRELATED_CLIPBOARD: Seen = {
  label: "unrelated clipboard",
  context: {
    selectedText:
      "Quarterly planning notes: the offsite moved to the 14th, catering is confirmed for " +
      "forty people, and the venue still needs a deposit by Friday. Parking is limited, so " +
      "encourage carpooling. Agenda draft is in the shared folder under Offsite/2026.",
    activeApp: null,
    activeWindowTitle: null,
  },
};
// The same clipboard, plus the one fact the app does not currently supply: that Gmail is in
// front. A stand-in for a context fix — the window title is not what such a fix would send,
// but it carries the same information.
const CLIPBOARD_AND_TOLD_GMAIL: Seen = {
  label: "unrelated clipboard + told Gmail is open",
  context: {
    ...UNRELATED_CLIPBOARD.context,
    activeApp: "chrome.exe",
    activeWindowTitle: "Bug: login button does nothing on mobile - dana@example.com - Gmail",
  },
};
// WHAT THE APP ACTUALLY SENDS since the fix: the planner asks Gmail whether a message is open
// and, when it is, the context carries `emailOpen: true` — rendered as the single line "An
// email is open in Gmail." (core/contextHints.ts). No window title, no subject. These two are
// the real thing, where "told Gmail is open" above was a stand-in used to decide to build it.
const HINTED: Seen = {
  label: "email open (hint)",
  context: { selectedText: null, activeApp: null, activeWindowTitle: null, emailOpen: true },
};
const HINTED_WITH_CLIPBOARD: Seen = {
  label: "email open (hint) + unrelated clipboard",
  context: { ...UNRELATED_CLIPBOARD.context, emailOpen: true },
};
// THE OVER-TEACHING RISK THE HINT INTRODUCES. With an email open and text on the clipboard,
// "summarize this" has always meant the clipboard — `summarize` reads the selection and nothing
// else. If the hint drags it toward `readEmail`, the fix has broken the app's oldest tool.
const SUMMARIZE_CONTROL: readonly Case[] = [{ phrase: "summarize this", expected: ["summarize"] }];

const CLIPBOARD: readonly Case[] = [
  { phrase: "file this bug in linear and tell the social channel", expected: BUG_CHAIN },
];

const results: {
  seen: string;
  phrase: string;
  expected: string;
  chosen: string;
  note: string;
}[] = [];

describe.skipIf(!CONFIGURED)("does the REAL model plan the bug-report chain (M19)", () => {
  // WHICH RUN. One trial of a model's choice is an anecdote: the live-failing phrase passed its
  // first single trial here, having failed twice in the app. So a wording change is measured on
  // a small fixed set, several times, before and after.
  //
  //   M19_PLAN_SET=all        (default) every phrase once, in both contexts            9 calls
  //   M19_PLAN_SET=core       the three CORE phrases, as the app sees them, x TRIALS   3 x TRIALS
  //   M19_PLAN_SET=overteach  the phrases that must NOT gain a readEmail step          1 x TRIALS
  //   M19_PLAN_SET=clipboard  the chain phrase with unrelated text on the clipboard    1 x TRIALS
  //   M19_PLAN_SET=clipboard-gmail   the same, and told Gmail is open                  1 x TRIALS
  //   M19_PLAN_SET=hinted     WHAT THE APP SENDS NOW with an email open (`emailOpen`):
  //                           the clipboard phrase, the core set, and the control that
  //                           "summarize this" with clipboard text stays `summarize`    5 x TRIALS
  //   M19_PLAN_TRIALS=3       repeats per phrase (default 1)
  const set = process.env["M19_PLAN_SET"] ?? "all";
  const trials = Math.max(1, Number(process.env["M19_PLAN_TRIALS"] ?? "1") || 1);
  const pick = (phrases: readonly string[], from: readonly Case[]): Case[] =>
    phrases.map((phrase) => {
      const found = from.find((entry) => entry.phrase === phrase);
      if (found === undefined) throw new Error(`no case for "${phrase}"`);
      return found;
    });
  const selected =
    set === "hinted"
      ? [
          ...CLIPBOARD.map((entry) => ({ ...entry, seen: HINTED_WITH_CLIPBOARD })),
          ...pick(CORE, CASES).map((entry) => ({ ...entry, seen: HINTED })),
          ...SUMMARIZE_CONTROL.map((entry) => ({ ...entry, seen: HINTED_WITH_CLIPBOARD })),
        ]
      : set === "clipboard"
      ? CLIPBOARD.map((entry) => ({ ...entry, seen: UNRELATED_CLIPBOARD }))
      : set === "clipboard-gmail"
        ? CLIPBOARD.map((entry) => ({ ...entry, seen: CLIPBOARD_AND_TOLD_GMAIL }))
      : set === "core"
      ? pick(CORE, CASES).map((entry) => ({ ...entry, seen: AS_THE_APP_SEES_IT }))
      : set === "overteach"
        ? OVERTEACH.map((entry) => ({ ...entry, seen: AS_THE_APP_SEES_IT }))
        : [
            ...CASES.map((entry) => ({ ...entry, seen: AS_THE_APP_SEES_IT })),
            ...CASES.filter((entry) => entry.expected === BUG_CHAIN).map((entry) => ({
              ...entry,
              seen: TOLD_GMAIL_IS_OPEN,
            })),
          ];
  const runs = selected.flatMap((entry) =>
    Array.from({ length: trials }, (_, index) => ({ ...entry, trial: index + 1 })),
  );
  for (const { phrase, expected, seen, trial } of runs) {
    it(`[${seen.label}] #${trial} "${phrase}" -> ${expected.join(" > ")}`, async () => {
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
      // What went into the issue when the plan did NOT read the email first — the live run
      // filed one whose description the model had simply made up.
      const create =
        choice.kind === "plan"
          ? choice.steps.find((step) => step.tool === "linear__create_issue")
          : undefined;
      const invented =
        create !== undefined && !chosen.includes("readEmail")
          ? `   [description: ${JSON.stringify(create.arguments["description"] ?? null).slice(0, 110)}]`
          : "";
      results.push({
        seen: seen.label,
        phrase,
        expected: expected.join(" > "),
        chosen: chosen.join(" > "),
        note: invented,
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
            `  ${r.chosen === r.expected ? "ok      " : "MISMATCH"}  [${r.seen}] "${r.phrase}"\n            -> ${r.chosen}${r.note}`,
        ),
        `  ${results.filter((r) => r.chosen === r.expected).length}/${results.length} matched`,
        "",
      ].join("\n"),
    );
  });
});
