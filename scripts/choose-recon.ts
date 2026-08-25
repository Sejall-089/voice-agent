// M16.5 — the first real signal on the premise this whole redesign rests on.
//
// WHY THIS EXISTS. M15 was killed by a measurement, not by an opinion: asked to localize a
// control in a screenshot, the model returned the WRONG CONTROL on real Windows chrome, and no
// prompt tuning closed the gap. M16's bet is that the same model is reliable at a DIFFERENT
// task — picking a numbered entry out of a list we wrote — because that is semantic matching
// rather than spatial localization.
//
// That is a bet, and every test in the suite so far is silent on it. tests/choosePrompt.test.ts
// proves the parser handles a given reply; tests/modelChooser.test.ts proves the wiring. Neither
// can prove the model ANSWERS WELL, because both feed it canned replies. This script is the one
// thing in the milestone that can, and it runs before pointAt is wired up (M16.7) rather than
// after, so a weak premise is found while the design can still change.
//
// It uses the REAL prompt (core/screen/prompt.ts) and the REAL candidate builder
// (core/screen/elements.ts) against the REAL committed fixtures — the same recon-before-fixtures
// discipline as scripts/notion-recon.mjs and scripts/tts-recon.mjs. A probe written against a
// copy of the prompt would measure the copy.
//
//   npx vite-node scripts/choose-recon.ts               # all cases, 3 trials each
//   npx vite-node scripts/choose-recon.ts --trials 5
//   npx vite-node scripts/choose-recon.ts --case file-menu
//
// PROVIDER: whatever LLM_PROVIDER says (openai here, gpt-5), through the app's own factory — so
// this measures the client the app actually uses, not a hand-rolled request.
import { readFileSync } from "node:fs";
import { buildCandidates } from "../src/core/screen/elements.ts";
import { ModelElementChooser } from "../src/core/screen/ModelElementChooser.ts";
import { renderChooseRequest } from "../src/core/screen/prompt.ts";
import { resolveChoice } from "../src/core/screen/resolve.ts";
import { OpenAILLMClient } from "../src/core/llm/openai.ts";
import { TREES } from "../tests/FakeElements.ts";
import type { ChoiceResult } from "../src/core/types.ts";

function fromEnvFile(key: string): string | undefined {
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    const value = line === undefined ? "" : line.slice(key.length + 1).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]!;
};
const TRIALS = Number(flag("--trials", "3"));
const ONLY = flag("--case", "");

// Each case names the tree, what a person would say, and what the RIGHT answer is.
//
// `expect` is deliberately expressed as an outcome a human would accept, not as a candidate
// number — numbering is an implementation detail and pinning it would measure the wrong thing.
interface Case {
  id: string;
  tree: keyof typeof TREES;
  target: string;
  // The candidate name that should be picked, or null when the right answer is NONE.
  want: string | null;
  // Set when the honest answer is a refusal because several entries share the name.
  wantAmbiguous?: boolean;
  note: string;
}

const CASES: Case[] = [
  // --- THE THREE M15 REGRESSION TARGETS ---
  {
    id: "file-menu",
    tree: "notepad",
    target: "the File menu",
    want: "File",
    note: "M15 localized this one tab over",
  },
  {
    id: "advice-tab",
    tree: "notepad",
    target: "the Advice.txt tab",
    want: "Advice.txt. Unmodified.",
    note: "M15 localized this onto a neighbouring tab",
  },
  {
    id: "new-button",
    tree: "explorer",
    target: "the New button",
    want: "New",
    note: "M15 was ~208px off, onto a neighbouring icon",
  },

  // --- PHRASING THE USER WOULD ACTUALLY USE (not the control's exact name) ---
  {
    id: "loose-new",
    tree: "explorer",
    target: "where do I make a new folder",
    want: "New",
    note: "intent, not a label",
  },
  {
    id: "loose-sort",
    tree: "explorer",
    target: "the column header for when things were last changed",
    want: "Date modified",
    note: "description, not a label",
  },
  {
    // EXPECTATION CORRECTED AFTER THE FIRST RUN. This case originally expected "Close" — but
    // M15's capture scoped to Notepad's own descendants and the fixture has no window-frame
    // Close button, only "Close Tab". NONE is the honest answer, and the model gave it 3/3
    // rather than offering the nearest thing. That is precisely the behaviour vision could not
    // be made to produce, so scoring it as a failure was measuring the probe, not the model.
    id: "loose-close",
    tree: "notepad",
    target: "close this window",
    want: null,
    note: "no window Close in this tree - must decline, not offer 'Close Tab'",
  },
  {
    id: "spatial",
    tree: "notepad",
    target: "the leftmost tab",
    want: "Stop Scrolling.txt. Unmodified.",
    note: "needs the code-computed position, the thing M15 had backwards",
  },

  // --- THE HARD ONES ---
  {
    id: "absent",
    tree: "notepad",
    target: "the send button",
    want: null,
    note: "must decline, not offer the nearest thing",
  },
  {
    id: "absent-plausible",
    tree: "explorer",
    target: "the print button",
    want: null,
    note: "plausible in a file manager, and not there",
  },
  {
    id: "ambiguous",
    tree: "explorer",
    target: "the filter dropdown",
    want: null,
    wantAmbiguous: true,
    note: "four of them, all reported at 'top'",
  },
  {
    id: "long-list",
    tree: "vscode",
    target: "the source control icon",
    want: "Source Control (Ctrl+Shift+G) - 10 pending changes",
    note: "83 candidates - the legibility question",
  },
  {
    // EXPECTATION CORRECTED AFTER THE FIRST RUN. Assumed there was no clean answer; VS Code does
    // expose "Run Code (Ctrl+Alt+N)", which is exactly right. The model found it 3/3 in an
    // 83-entry list.
    id: "long-list-2",
    tree: "vscode",
    target: "the button that runs the file",
    want: "Run Code (Ctrl+Alt+N)",
    note: "83 candidates, answer buried in the middle",
  },
];

const apiKey = process.env["OPENAI_API_KEY"] ?? fromEnvFile("OPENAI_API_KEY");
if (!apiKey) {
  console.error("No OPENAI_API_KEY (env or .env). This probe needs a real key.");
  process.exit(1);
}

const chooser = new ModelElementChooser({ llm: new OpenAILLMClient(apiKey) });

// What actually happened on one trial, in terms a person can score.
function describe(
  result: ChoiceResult,
  c: Case,
  candidates: ReturnType<typeof buildCandidates>,
): { ok: boolean; label: string } {
  if (result.kind === "none") {
    const ok = c.want === null && c.wantAmbiguous !== true;
    return { ok, label: "NONE" };
  }
  if (result.kind === "ambiguous") {
    const names = result.numbers
      .map((n) => candidates.find((x) => x.number === n)?.name ?? `#${n}`)
      .join(" | ");
    return { ok: c.wantAmbiguous === true, label: `AMBIGUOUS ${names}` };
  }
  const picked = candidates.find((x) => x.number === result.number);
  if (!picked) return { ok: false, label: `PICK ${result.number} (OUT OF RANGE)` };

  // The gate has the final say, and that is what the user would experience — a pick that code
  // then refuses as ambiguous IS a refusal, however confident the model was.
  try {
    resolveChoice(candidates, result, c.target, TREES[c.tree].windowTitle);
  } catch {
    return {
      ok: c.wantAmbiguous === true,
      label: `PICK "${picked.name}" -> refused by the gate`,
    };
  }
  return { ok: picked.name === c.want, label: `PICK "${picked.name}"` };
}

const rows: string[] = [];
let totalOk = 0;
let totalRuns = 0;

for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue;
  const tree = TREES[c.tree];
  const candidates = buildCandidates(tree);
  const prompt = renderChooseRequest(candidates, c.target, tree.windowTitle);

  const labels: string[] = [];
  let ok = 0;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    try {
      const result = await chooser.choose(candidates, c.target, tree.windowTitle);
      const scored = describe(result, c, candidates);
      if (scored.ok) ok += 1;
      labels.push(scored.label);
    } catch (error) {
      labels.push(`THREW ${(error as Error).message.slice(0, 60)}`);
    }
  }
  totalOk += ok;
  totalRuns += TRIALS;

  const unique = [...new Set(labels)];
  rows.push(
    `${c.id.padEnd(18)} ${String(ok)}/${TRIALS}  cands=${String(candidates.length).padStart(3)}  ` +
      `prompt=${String(prompt.length).padStart(5)}ch  ${unique.join("  ||  ")}`,
  );
  console.log(rows[rows.length - 1]);
}

console.log("");
console.log(`TOTAL ${totalOk}/${totalRuns}`);
console.log("");
console.log("Reminder: this is a probe against FIXTURES, not live verification. It measures");
console.log("whether the model picks well from a real candidate list. It says nothing about");
console.log("whether UIA enumeration, the settle check, or the overlay behave on a live desktop.");
