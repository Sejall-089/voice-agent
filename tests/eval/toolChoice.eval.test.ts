import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";
import { Planner } from "../../src/core/planner.ts";
import { buildRegistry } from "../../src/core/registry.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { createDatabase } from "../../src/core/memory/db.ts";
import { SqliteMemory } from "../../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../../src/main/shell/MockShell.ts";

// WHICH TOOL THE REAL MODEL PICKS (M18, checklist section 7).
//
// THIS IS THE FIRST TEST IN THIS REPO THAT CALLS A REAL MODEL, and that is worth stating
// loudly because it changes what `npm run eval` costs. Every other file under tests/ —
// `demoTasks.eval.test.ts` and `story.eval.test.ts` included — drives tool choice through
// `FakeLLM` and makes zero API calls. They prove that ONCE a tool is chosen the machine does
// the right thing. Nothing in the suite could speak to the choice ITSELF, which is exactly the
// gap M18's three overlapping "open/play/turn up" tools widened:
//
//   "open Spotify"                  -> openApp      (an installed application)
//   "open the Spotify web player"   -> openTarget   (a website)
//   "play X on Spotify"             -> searchSpotify (a search page)
//
// Those three are one word apart in English and three different tools in the registry. A
// fixture-driven test cannot tell us whether the descriptions actually separate them, because
// the fixture IS the answer being checked.
//
// WHAT MAKES THIS SAFE TO RUN: the shell is a `MockShell`, so every side effect lands in an
// array. No app is launched, no key is pressed, no URL is opened. The model, the system prompt
// (`core/llm/prompt.ts`), the registry and the planner are all the real ones — only the hands
// are fake.
//
// WHAT IT COSTS: one `chooseTool` call per phrase, so ~10 calls per run, plus whatever the
// OpenAI SDK's default `maxRetries: 2` adds on a transient failure. Handlers for the expected
// tools make no further model calls.
//
// IT SKIPS ITSELF when the chosen provider has no API key, so adding this file does not
// silently start spending money on a machine that never asked it to.

interface Case {
  phrase: string;
  expected: string;
}

const CASES: readonly Case[] = [
  // The M18 three-way split — the whole reason this file exists.
  { phrase: "open Spotify", expected: "openApp" },
  { phrase: "open the Spotify web player", expected: "openTarget" },
  { phrase: "play Bohemian Rhapsody on Spotify", expected: "searchSpotify" },
  // Volume, in three phrasings including the barest one.
  { phrase: "turn it up", expected: "systemVolume" },
  { phrase: "turn the volume down a bit", expected: "systemVolume" },
  { phrase: "mute", expected: "systemVolume" },
  // Media keys, including an informal word for "next track".
  { phrase: "pause", expected: "mediaControl" },
  { phrase: "next song", expected: "mediaControl" },
  // The two that must NOT have been disturbed by M18's arrivals.
  { phrase: "open Notepad", expected: "openApp" },
  { phrase: "open my dashboard", expected: "openTarget" },
];

const PROVIDER = process.env["LLM_PROVIDER"];
const KEY =
  PROVIDER === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : process.env["OPENAI_API_KEY"];

// OPT-IN BY AN EXPLICIT FLAG, not merely by having a key configured — and this is here because
// the first version got it wrong and cost real money to find out.
//
// `npm test` is `vitest run`, which globs ALL of tests/ including tests/eval. Gating only on
// "is there an API key?" meant a file that spends money on every single `npm test`, on a machine
// where a key is always present. It ran 10 calls that nobody asked for before anyone noticed the
// suite had gone from 7 seconds to 62.
//
// So: a key is necessary and NOT sufficient. Run it deliberately:
//
//     M18_TOOL_CHOICE_EVAL=1 npm run eval
//
// The same reasoning `POINTING_ENABLED` exists for (spec.md §3): a credential that is present
// for another purpose must never be read as permission to spend it.
const OPTED_IN = process.env["M18_TOOL_CHOICE_EVAL"] === "1";
const CONFIGURED = OPTED_IN && Boolean(PROVIDER) && Boolean(KEY);

// THE MENU IS THE ONE THIS INSTALL ACTUALLY OFFERS, not the base registry the other two eval
// files use. That is a deliberate departure: tool choice gets HARDER as the menu grows, and
// measuring against a six-tool menu when the running app offers seventeen would flatter the
// result. Everything is switched on here because everything is configured in this .env
// (CHROME_DEBUG_URL, GOOGLE_*, PIPER_*, POINTING_ENABLED).
const MENU = buildRegistry({
  gmail: true,
  notion: true,
  calendar: true,
  speech: true,
  pointing: true,
});

const results: { phrase: string; expected: string; chosen: string }[] = [];

async function choose(phrase: string): Promise<string> {
  const memory = new SqliteMemory(createDatabase(":memory:"));
  // The facts a real install would have. "open my dashboard" is only answerable with one.
  memory.write("tone", "concise and warm", { confidence: 0.9 });
  memory.write("team", "#design-team", { confidence: 0.9 });
  memory.write("target:dashboard", "https://dash.example.com", { confidence: 0.9 });

  // No selected text: none of these phrases is about a selection, and a clipboard full of prose
  // would nudge the model toward `summarize`/`rewrite` for reasons that have nothing to do with
  // what is being measured.
  const shell = new MockShell({
    context: { selectedText: null, activeApp: null, activeWindowTitle: null },
  });

  const planner = new Planner(createLLMClient(), shell, MENU, memory, memory);
  const outcome = await planner.run(phrase);
  return outcome.tool ?? `(none: ${outcome.status})`;
}

describe.skipIf(!CONFIGURED)("which tool the REAL model picks (M18 §7)", () => {
  // Sequential, not concurrent: ten parallel calls is a good way to meet a rate limit and
  // spend the retry budget proving nothing.
  for (const { phrase, expected } of CASES) {
    it(`"${phrase}" -> ${expected}`, async () => {
      const chosen = await choose(phrase);
      results.push({ phrase, expected, chosen });
      expect(chosen, `"${phrase}" chose ${chosen}, expected ${expected}`).toBe(expected);
    }, 120_000);
  }

  afterAll(() => {
    if (results.length === 0) return;
    const pad = (s: string, n: number): string => s.padEnd(n);
    const lines = [
      "",
      "  TOOL CHOICE — what the real model actually picked",
      `  ${pad("phrase", 36)}${pad("expected", 16)}chosen`,
      `  ${"-".repeat(36)}${"-".repeat(16)}${"-".repeat(16)}`,
      ...results.map(
        (r) =>
          `  ${pad(r.phrase, 36)}${pad(r.expected, 16)}${r.chosen}` +
          (r.chosen === r.expected ? "" : "   <-- MISMATCH"),
      ),
      `  ${results.filter((r) => r.chosen === r.expected).length}/${results.length} matched`,
      "",
    ];
    console.log(lines.join("\n"));
  });
});

// --- DOES A FULL CLIPBOARD PULL A CLEAR ACTION TOWARD summarize / rewrite / CHAT? -------------
//
// A live finding the block above was BUILT not to see. Three times — "open calc", "pause",
// "open Spotify" — the app answered a plain action instruction with chat text ("Would you like
// me to summarize the selected findings, or rewrite them...") and ran nothing; the retry worked.
// The 10/10 above passes `selectedText: null`, and its own comment says why: a clipboard full
// of prose would nudge the model. That nudge is the bug, so this block measures it.
//
// IT CALLS `chooseTool` DIRECTLY, not `planner.run`, for three reasons:
//   * the thing being measured is the CHOICE, and a chat reply is a choice — the planner
//     reduces it to "no_tool" and the words are lost (they are not in the action log either);
//   * a wrongly chosen `summarize` would run its handler, which is a second model call — the
//     call count below would stop being knowable in advance;
//   * `previousTurn` is passed as null on every call, so the selection is the ONLY variable.
//     The live retries also carried a "found no matching tool" previous turn; that is a
//     separate question and is deliberately not mixed in here.
// It also needs no SQLite, so it runs while the app holds the Electron build of the binary.
//
// COST: 5 phrases x 3 runs x 2 selections + 5 phrases x 1 empty-selection control = 35 calls,
// plus the SDK's own retries on a transient failure. Needs a second flag on top of the first,
// so running the 10-phrase eval above never quietly becomes 45 calls:
//
//     M18_TOOL_CHOICE_EVAL=1 M18_SELECTION_EVAL=1 \
//       M18_SELECTION_FILE=<path to a text file> npx vitest run tests/eval/toolChoice.eval.test.ts -t "selected text"
//
// THE ASSERTION IS DELIBERATELY ONLY ON THE CONTROL. With a selection present this is a
// MEASUREMENT of a known bug, reported as picks out of 3; a red test for each would say nothing
// the table does not, and would have to be deleted or inverted the day the prompt is fixed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toToolSchemas } from "../../src/core/registry.ts";

const SELECTION_PHRASES: readonly Case[] = [
  { phrase: "open Spotify", expected: "openApp" },
  { phrase: "open calc", expected: "openApp" },
  { phrase: "pause", expected: "mediaControl" },
  { phrase: "turn it up", expected: "systemVolume" },
  { phrase: "play Bohemian Rhapsody on Spotify", expected: "searchSpotify" },
];

const SELECTION_FILE = process.env["M18_SELECTION_FILE"];
const SELECTION_OPTED_IN = CONFIGURED && process.env["M18_SELECTION_EVAL"] === "1";
const RUNS = 3;

function loadFixture(path: string | undefined): string | null {
  if (path === undefined || path.length === 0) return null;
  return readFileSync(path, "utf8");
}

// "empty" is the control: exactly what the 10-phrase block above sends.
const SELECTIONS: readonly { name: string; runs: number; text: () => string | null }[] = [
  { name: "empty (control)", runs: 1, text: () => null },
  { name: "user file", runs: RUNS, text: () => loadFixture(SELECTION_FILE) },
  {
    name: "status report",
    runs: RUNS,
    text: () =>
      loadFixture(fileURLToPath(new URL("./fixtures/claude-code-status-report.txt", import.meta.url))),
  },
];

interface Pick {
  phrase: string;
  expected: string;
  fixture: string;
  picked: string;
  said: string | null;
}
const picks: Pick[] = [];

async function pickOnce(phrase: string, selectedText: string | null): Promise<{ picked: string; said: string | null }> {
  const choice = await createLLMClient().chooseTool(
    phrase,
    { selectedText, activeApp: null, activeWindowTitle: null },
    toToolSchemas(MENU),
    null,
  );
  if (choice.kind === "tool") return { picked: choice.name, said: null };
  if (choice.kind === "plan") {
    return { picked: `plan(${choice.steps.map((s) => s.tool).join(">")})`, said: null };
  }
  if (choice.kind === "none") {
    const said = choice.text !== null && choice.text.trim().length > 0 ? choice.text.trim() : null;
    return { picked: said === null ? "(nothing)" : "(chat text)", said };
  }
  return { picked: `(${choice.kind})`, said: null };
}

describe.skipIf(!SELECTION_OPTED_IN)("selected text vs a clear action instruction (M18 live finding)", () => {
  it("has the user's selection file to test with", () => {
    expect(
      SELECTION_FILE,
      "set M18_SELECTION_FILE to the text that was on the clipboard",
    ).toBeTruthy();
    expect(loadFixture(SELECTION_FILE)?.trim().length ?? 0).toBeGreaterThan(0);
  });

  for (const selection of SELECTIONS) {
    for (const { phrase, expected } of SELECTION_PHRASES) {
      for (let run = 1; run <= selection.runs; run += 1) {
        it(`"${phrase}" with ${selection.name} selected, run ${run}/${selection.runs}`, async () => {
          const { picked, said } = await pickOnce(phrase, selection.text());
          picks.push({ phrase, expected, fixture: selection.name, picked, said });
          // Only the control is a pass/fail claim — see the note above this block.
          if (selection.name.startsWith("empty")) expect(picked).toBe(expected);
        }, 120_000);
      }
    }
  }

  afterAll(() => {
    if (picks.length === 0) return;
    const pad = (s: string, n: number): string => s.padEnd(n);
    const rows: string[] = [];
    for (const { phrase, expected } of SELECTION_PHRASES) {
      for (const selection of SELECTIONS) {
        const mine = picks.filter((p) => p.phrase === phrase && p.fixture === selection.name);
        if (mine.length === 0) continue;
        const tally = new Map<string, number>();
        for (const p of mine) tally.set(p.picked, (tally.get(p.picked) ?? 0) + 1);
        const right = tally.get(expected) ?? 0;
        const detail = [...tally].map(([name, n]) => `${name} ${n}/${mine.length}`).join(", ");
        rows.push(
          `  ${pad(phrase, 36)}${pad(selection.name, 18)}${pad(`${right}/${mine.length} ${expected}`, 24)}${detail}`,
        );
      }
    }
    const said = picks.filter((p) => p.said !== null);
    console.log(
      [
        "",
        "  SELECTED TEXT vs A CLEAR ACTION — picks per phrase and fixture",
        `  ${pad("phrase", 36)}${pad("fixture", 18)}${pad("correct", 24)}all picks`,
        `  ${"-".repeat(110)}`,
        ...rows,
        "",
        ...(said.length === 0
          ? ["  No chat-text replies."]
          : [
              "  CHAT TEXT RETURNED INSTEAD OF A TOOL:",
              ...said.map((p) => `    [${p.fixture}] "${p.phrase}" -> ${JSON.stringify(p.said)}`),
            ]),
        "",
      ].join("\n"),
    );
  });
});

// A standing note rather than a test, so a silent skip is never mistaken for a pass. The usual
// reason it skips is that nobody opted in — which is the intended default, since every run of
// this file costs real API calls.
describe("tool-choice eval configuration", () => {
  it("says out loud whether the real-model eval ran", () => {
    if (!CONFIGURED) {
      const why = !OPTED_IN
        ? "M18_TOOL_CHOICE_EVAL is not 1 (this is the default — it costs real API calls)"
        : `LLM_PROVIDER=${PROVIDER ?? "unset"} has no matching API key`;
      console.log(`\n  tool-choice eval SKIPPED: ${why}.`);
      console.log("  To run it:  M18_TOOL_CHOICE_EVAL=1 npm run eval\n");
    }
    expect(typeof CONFIGURED).toBe("boolean");
  });
});
