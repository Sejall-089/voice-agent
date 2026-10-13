import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalToolName } from "../../src/core/chain.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { CONNECTORS, loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";
import { captureContext } from "../../src/core/planner.ts";
import { buildRegistry, toToolSchemas } from "../../src/core/registry.ts";
import type { ToolChoice } from "../../src/core/types.ts";

// DOES THE REAL MODEL ROUTE A QUESTION ABOUT THE JOBS TO `jobStatus` — AND ONLY THAT? (M23)
//
// `jobStatus` is one more tool on a menu of twenty-seven, described in words. Whether "are my
// agents done yet" reaches it, and whether "tell the team the agents are done" does NOT, is a
// fact about a model that no fixture can establish: in every other test in this repo the
// choice IS the fixture.
//
// IT CALLS `chooseTool` DIRECTLY, never `planner.run`. What is measured is the choice; nothing
// here executes a tool. The connector tools sit over `UnavailableConnection`.
//
// OPT-IN BY ITS OWN FLAG — a key being present is not permission to spend it:
//
//     M23_STATUS_EVAL=1 npx vitest run tests/eval/jobStatus.eval.test.ts
//
// COST: 20 phrasings x TRIALS (default 3) = 60 `chooseTool` calls, plus the SDK's own retries.
//
// WHAT THE MODEL IS SHOWN IS WHAT THE APP SHOWS IT (CLAUDE.md, "an eval must see what the app
// sees"):
//   - the menu `main.ts` builds with everything configured, `jobs: true` included;
//   - a context taken through the app's own `captureContext`, over a shell whose clipboard
//     holds a few lines of unrelated notes — a clipboard is almost never empty, and on a past
//     eval it was the unrecorded variable that moved the result. HELD FIXED for every call;
//   - no email open, and no previous turn (the first instruction of a session).
//
// ONE TRIAL IS AN ANECDOTE, so each phrasing runs TRIALS times and is reported as n of TRIALS.
// A positive passes only if EVERY trial chose `jobStatus` alone; a negative passes only if NO
// trial chose it anywhere, as a lone call or as a step of a plan.

const PROVIDER = process.env["LLM_PROVIDER"];
const KEY =
  PROVIDER === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : process.env["OPENAI_API_KEY"];
const CONFIGURED = process.env["M23_STATUS_EVAL"] === "1" && Boolean(PROVIDER) && Boolean(KEY);
const TRIALS = Math.max(1, Number(process.env["M23_STATUS_TRIALS"] ?? "3") || 3);

interface Case {
  phrase: string;
  // true: must route to jobStatus. false: must not.
  status: boolean;
  // For a negative, what a sensible answer would be. Reported, not asserted: the property
  // under test is that it is NOT jobStatus.
  plausible?: string;
}

const CASES: readonly Case[] = [
  // --- Questions about the user's own background work. ---
  { phrase: "are my agents done yet", status: true },
  { phrase: "what's running", status: true },
  { phrase: "anything waiting on me", status: true },
  { phrase: "are my jobs done", status: true },
  { phrase: "did that finish", status: true },
  { phrase: "how are my background jobs doing", status: true },
  { phrase: "is anything still running in the background", status: true },
  { phrase: "what's the status of my agents", status: true },
  { phrase: "do any of my jobs need me", status: true },
  { phrase: "have my agents finished", status: true },
  { phrase: "what are my agents up to", status: true },
  { phrase: "is there anything I need to approve", status: true },
  // --- Near misses: the same nouns, a different request. ---
  // A message to send that happens to be ABOUT agents.
  { phrase: "tell the team the agents are done", status: false, plausible: "sendMessage" },
  { phrase: 'post "the background jobs are finished" in the bugs channel', status: false, plausible: "sendMessage" },
  // New work to start, not a report on old work.
  { phrase: "start an agent to check Gmail", status: false, plausible: "none / readEmail" },
  { phrase: "run a job that summarizes this", status: false, plausible: "summarize" },
  // A fact to store, and a fact to read back.
  { phrase: "remember that the agents finish by five", status: false, plausible: "remember" },
  { phrase: "what do you remember about my agents", status: false, plausible: "recall" },
  // "What's on / what's running" about something that is not this app's jobs.
  { phrase: "what's on my calendar today", status: false, plausible: "readSchedule" },
  { phrase: "is the build done? ask in the team channel", status: false, plausible: "sendMessage" },
];

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: Object.fromEntries(
      CONNECTORS.map((def) => [
        def.id,
        {
          enabled: true,
          tools: def.tools.map((tool) => tool.name),
          settings: { defaultTeam: "Engineering", owner: "acme", repo: "tracker" },
        },
      ]),
    ),
  }),
  readKey: () => "unused",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

// The menu the running app offers with everything configured (main.ts), jobs included.
const MENU = toToolSchemas(
  buildRegistry({
    gmail: true,
    notion: true,
    calendar: true,
    speech: true,
    pointing: true,
    connectors,
    jobs: true,
  }),
);
const NAMES = MENU.map((tool) => tool.name);

const CLIPBOARD =
  "Standup notes: API latency is back under 200ms after the cache fix. Mina is out Thursday. " +
  "Release notes draft is in the shared folder; needs a second pair of eyes before Friday.";

// What a choice named, as the app would read it: canonical tool names, in order.
function toolsOf(choice: ToolChoice): string[] {
  if (choice.kind === "tool") return [canonicalToolName(choice.name, NAMES)];
  if (choice.kind === "plan") return choice.steps.map((step) => canonicalToolName(step.tool, NAMES));
  return [];
}

function describeChoice(choice: ToolChoice): string {
  if (choice.kind === "tool") return canonicalToolName(choice.name, NAMES);
  if (choice.kind === "plan") return `plan[${toolsOf(choice).join(" > ")}]`;
  if (choice.kind === "incomplete") return "(incomplete)";
  return "(no tool)";
}

const rows: { phrase: string; kind: string; correct: number; chosen: string[] }[] = [];

describe.skipIf(!CONFIGURED)("does the REAL model route job questions to jobStatus (M23)", () => {
  const llm = CONFIGURED ? createLLMClient() : null;

  it.each(CASES.map((entry) => [entry.phrase, entry] as const))(
    `%j, x${TRIALS}`,
    async (_phrase, entry) => {
      if (llm === null) throw new Error("not configured");
      // The app's own context path, over the fixed clipboard, with no email open.
      const { context } = await captureContext(
        {
          getContext: () =>
            Promise.resolve({ selectedText: CLIPBOARD, activeApp: null, activeWindowTitle: null }),
        },
        { hasOpenEmail: () => Promise.resolve(false) },
      );

      const chosen: string[] = [];
      let correct = 0;
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const choice = await llm.chooseTool(entry.phrase, context, MENU, null);
        const tools = toolsOf(choice);
        chosen.push(describeChoice(choice));
        const isStatus = tools.length === 1 && tools[0] === "jobStatus";
        const mentionsStatus = tools.includes("jobStatus");
        if (entry.status ? isStatus : !mentionsStatus) correct += 1;
      }
      rows.push({
        phrase: entry.phrase,
        kind: entry.status ? "status" : `near-miss (${entry.plausible ?? "other"})`,
        correct,
        chosen,
      });
      expect(correct, `${entry.phrase} -> ${chosen.join(", ")}`).toBe(TRIALS);
    },
    // Three sequential model calls of a reasoning model; generous, because a timeout here
    // would be reported as a routing failure and it is not one.
    180_000,
  );

  afterAll(() => {
    if (rows.length === 0) return;
    const total = rows.length * TRIALS;
    const right = rows.reduce((sum, row) => sum + row.correct, 0);
    const positives = rows.filter((row) => row.kind === "status");
    const negatives = rows.filter((row) => row.kind !== "status");
    const sum = (list: typeof rows): number => list.reduce((n, row) => n + row.correct, 0);
    console.log(`\njobStatus routing — provider: ${PROVIDER}, ${TRIALS} trials per phrasing`);
    for (const row of rows) {
      console.log(
        `  ${row.correct}/${TRIALS}  ${row.kind.padEnd(34)} ${JSON.stringify(row.phrase)}  ->  ${row.chosen.join(" | ")}`,
      );
    }
    console.log(
      `  positives ${sum(positives)}/${positives.length * TRIALS}, ` +
        `near-miss negatives ${sum(negatives)}/${negatives.length * TRIALS}, ` +
        `overall ${right}/${total} (${((100 * right) / total).toFixed(1)}%)`,
    );
  });
});

describe("jobStatus routing eval", () => {
  it("is skipped unless M23_STATUS_EVAL=1 and LLM_PROVIDER are set", () => {
    if (!CONFIGURED) {
      console.log("  jobStatus routing eval SKIPPED: M23_STATUS_EVAL is not 1 (it costs real API calls).");
    }
    expect(true).toBe(true);
  });
});
