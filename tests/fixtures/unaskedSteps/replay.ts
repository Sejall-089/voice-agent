import { LONG_TRACE, SHORT_BUG, UNRELATED_TEXT } from "../planChoice/clipboards.ts";

// THE PLANS M30's CHECK IS REPLAYED AGAINST, besides tests/fixtures/unreadContent/recorded.json.
//
// Two sources, neither invented:
//
//   EVAL  M28's baseline table (spec.md §9, M28): 45 answered calls on gpt-5-mini at low effort,
//         three trials a case, the app's wording unchanged. The per-trial answers were never
//         saved, so each trial is rebuilt from the table: its tool sequence, the phrase and what
//         was on screen. Arguments are stand-ins in the shape each plan had ("as given" puts the
//         clipboard in the description; a summarize plan's create takes `{step1}`).
//   LIVE  The action log (read read-only, 2026-10-23): every run grouped by job that had a
//         summarize or rewrite step before a create. A run cancelled at a dialog logged only the
//         steps up to it, so a send step after the cancel is not listed. The clipboard's content
//         was not logged; every one of these runs had text copied (M27, M28 and M29's live runs).
//
// `expected` is the investigation's own reading of each instruction — whether the person asked for
// the step — written by hand, not computed by the check under test.

export interface Replayed {
  source: string;
  instruction: string;
  clipboard: string | null;
  emailOpen?: true;
  tools: readonly string[];
  // `refused`: a step nobody asked for before a create. `runs`: everything else.
  expected: "refused" | "runs";
}

const C = "linear__create_issue";
const S = "sendMessage";
const SUM = "summarize";
const READ = "readEmail";

// A stand-in for what the long-clipboard live runs had copied: the M28/M29 checklists' text.
const COPIED_LIVE = LONG_TRACE;

const times = (count: number, row: Replayed): Replayed[] => Array.from({ length: count }, () => row);

export const EVAL: readonly Replayed[] = [
  ...times(3, { source: "eval", instruction: "create a linear issue and send to fun", clipboard: SHORT_BUG, tools: [C, S], expected: "runs" }),
  { source: "eval", instruction: "create a linear issue and send to fun", clipboard: LONG_TRACE, tools: [C], expected: "runs" },
  { source: "eval", instruction: "create a linear issue and send to fun", clipboard: LONG_TRACE, tools: [SUM, C, S], expected: "refused" },
  { source: "eval", instruction: "create a linear issue and send to fun", clipboard: LONG_TRACE, tools: [C, S], expected: "runs" },
  ...times(3, { source: "eval", instruction: "log this as an issue and let #bugs know", clipboard: SHORT_BUG, tools: [C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "log this as an issue and let #bugs know", clipboard: LONG_TRACE, tools: [SUM, C, S], expected: "refused" }),
  ...times(3, { source: "eval", instruction: "summarize this and file it in Linear", clipboard: LONG_TRACE, tools: [SUM, C], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "file this bug in linear and tell the social channel", clipboard: SHORT_BUG, emailOpen: true, tools: [READ, C, S], expected: "runs" }),
  { source: "eval", instruction: "create a linear issue and send to fun", clipboard: UNRELATED_TEXT, tools: [SUM, C, S], expected: "refused" },
  ...times(2, { source: "eval", instruction: "create a linear issue and send to fun", clipboard: UNRELATED_TEXT, tools: [C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "file this bug email in Linear and tell the bugs channel", clipboard: null, tools: [READ, C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "make a Linear ticket from this email, then post the link in #bugs", clipboard: null, tools: [READ, C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "log this as an issue and let #bugs know", clipboard: null, tools: [SUM, C, S], expected: "refused" }),
  ...times(3, { source: "eval", instruction: "file this bug in Linear and tell the social channel", clipboard: null, tools: [READ, C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "find the login issue in Linear", clipboard: null, tools: ["linear__search_issues"], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "log this as an issue and let #bugs know", clipboard: LONG_TRACE, emailOpen: true, tools: [READ, C, S], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "reply to this and send it", clipboard: LONG_TRACE, emailOpen: true, tools: ["draftReply", "sendReply"], expected: "runs" }),
  ...times(3, { source: "eval", instruction: "summarize this", clipboard: UNRELATED_TEXT, emailOpen: true, tools: [SUM], expected: "runs" }),
];

export const LIVE: readonly Replayed[] = [
  { source: "live 561-563", instruction: "create a issue in linear and send status on fun", clipboard: COPIED_LIVE, tools: [SUM, C, S], expected: "refused" },
  { source: "live 637-639", instruction: "create a linear issue and send to fun", clipboard: COPIED_LIVE, tools: [SUM, C, S], expected: "refused" },
  { source: "live 640-642", instruction: "create a linear issue and send to fun", clipboard: COPIED_LIVE, tools: [SUM, C, S], expected: "refused" },
  { source: "live 648-649", instruction: "create a linear issue and send to fun", clipboard: COPIED_LIVE, tools: ["rewrite", C], expected: "refused" },
  { source: "live 654-655", instruction: "create a linear issue and send to fun", clipboard: COPIED_LIVE, tools: [SUM, C], expected: "refused" },
  { source: "live 656-658", instruction: "create a linear issue and send to fun", clipboard: COPIED_LIVE, tools: [SUM, C], expected: "refused" },
  { source: "live 662-663", instruction: "rewrite this and file it in Linear, then tell fun", clipboard: COPIED_LIVE, tools: ["rewrite", C], expected: "runs" },
  { source: "live 664-665", instruction: "rewrite this and file in linear then tell fun", clipboard: COPIED_LIVE, tools: ["rewrite", C], expected: "runs" },
];
