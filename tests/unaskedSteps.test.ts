import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UNASKED_STEP,
  UNASKED_STEP_NO_TEXT,
  canonicalToolName,
  checkUnaskedSteps,
  checkUnfilledBlanks,
  checkUnreadContent,
  createDescriptions,
  isUnaskedStepRefusal,
  saysAny,
  unaskedSteps,
} from "../src/core/chain.ts";
import { CONNECTORS, loadConnectorTools } from "../src/core/mcp/load.ts";
import { UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { MAX_SPOKEN_CHARS, toSpokenResult } from "../src/core/speech.ts";
import type { PlannedStep, ToolInput } from "../src/core/types.ts";
import { LONG_TRACE } from "./fixtures/planChoice/clipboards.ts";
import { EVAL, LIVE } from "./fixtures/unaskedSteps/replay.ts";
import type { Replayed } from "./fixtures/unaskedSteps/replay.ts";

// A SUMMARIZE OR REWRITE STEP NOBODY ASKED FOR, BEFORE A CREATE (core/chain.ts, `checkUnaskedSteps`,
// M30). The rule, the word lists and what they miss are pinned here against the REAL declarations;
// where the planner applies it is in tests/planner.unaskedSteps.test.ts.
//
// Replayed against every plan on record that has such a step: the 77 recorded model answers
// (tests/fixtures/unreadContent/recorded.json), M28's baseline eval table and the live action log
// (tests/fixtures/unaskedSteps/replay.ts). The phrasings further down are written by hand, and say
// so: they measure how far the word lists reach, and what they wrongly refuse is a known gap.

interface Recorded {
  source: string;
  instruction: string;
  clipboard: string | null;
  steps: PlannedStep[];
}

const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/unreadContent/recorded.json", import.meta.url), "utf8"),
) as Recorded[];

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
const TOOLS = buildRegistry({
  gmail: true,
  notion: true,
  calendar: true,
  speech: true,
  pointing: true,
  jobs: true,
  connectors,
});
const MENU = TOOLS.map((tool) => tool.name);

const canonical = (steps: readonly PlannedStep[]): PlannedStep[] =>
  steps.map((step) => ({ ...step, tool: canonicalToolName(step.tool, MENU) }));

const check = (instruction: string, steps: readonly PlannedStep[], clipboard: string | null = null) =>
  checkUnaskedSteps(instruction, { selectedText: clipboard }, canonical(steps), TOOLS);

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: "" });

// A replayed trial as a plan: stand-in arguments in the shape each plan had.
function planOf(row: Replayed): PlannedStep[] {
  const transform = row.tools.findIndex((tool) => tool === "summarize" || tool === "rewrite" || tool === "readEmail");
  return row.tools.map((tool, index) => {
    if (tool.endsWith("create_issue")) {
      const fed = transform !== -1 && transform < index;
      if (!fed && row.tools.length === 1) return step(tool, { title: "Migration fails on orders" });
      return step(tool, { title: "Migration fails on orders", description: fed ? `{step${transform + 1}}` : (row.clipboard ?? "") });
    }
    if (tool === "sendMessage") return step(tool, { channel: "fun", notes: `Filed: {step${index}}` });
    return step(tool);
  });
}

const declaredWords = (name: string): readonly string[] | undefined =>
  TOOLS.find((tool) => tool.name === name)?.askedForBy;

const SUMMARIZE_WORDS = [
  "summarize", "summarise", "summary", "condense", "shorten", "tl;dr", "tldr", "tl dr",
  "sum up", "shorter", "brief", "gist", "key points", "short version", "boil down",
];
const REWRITE_WORDS = [
  "rewrite", "reword", "polish", "rephrase", "clean up", "formal", "wording", "tidy", "make it sound",
];

describe("the declarations", () => {
  it("summarize and rewrite declare exactly the approved words, and no other tool declares any", () => {
    expect(declaredWords("summarize")).toEqual(SUMMARIZE_WORDS);
    expect(declaredWords("rewrite")).toEqual(REWRITE_WORDS);
    expect(TOOLS.filter((tool) => tool.askedForBy !== undefined).map((tool) => tool.name).sort()).toEqual([
      "rewrite",
      "summarize",
    ]);
  });

  it("the two lists share no word", () => {
    expect(SUMMARIZE_WORDS.filter((word) => REWRITE_WORDS.includes(word))).toEqual([]);
  });

  it("the creates the check looks for are the two connector creates", () => {
    expect(TOOLS.filter((tool) => tool.contentArg !== undefined).map((tool) => tool.name).sort()).toEqual([
      "github__create_issue",
      "linear__create_issue",
    ]);
  });
});

describe("how a word is matched", () => {
  it.each([...SUMMARIZE_WORDS, ...REWRITE_WORDS])("'%s' matches itself in a sentence", (word) => {
    expect(saysAny(`please ${word} the notes and file them`, [word])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(saysAny("SUMMARIZE this and file it", ["summarize"])).toBe(true);
    expect(saysAny("Give me the TL;DR and log it", ["tl;dr"])).toBe(true);
    expect(saysAny("Boil Down this text", ["boil down"])).toBe(true);
  });

  it("matches whole words only", () => {
    expect(saysAny("file the summarized notes", ["summarize"])).toBe(false);
    expect(saysAny("the briefcase icon is gone", ["brief"])).toBe(false);
    expect(saysAny("an informal note", ["formal"])).toBe(false);
    expect(saysAny("the shortened link 404s", ["shorten"])).toBe(false);
  });

  // "tl;dr" in the three forms it gets written in, on summarize's own list. Asked of the REAL
  // declaration, so dropping a form from the tool is what these tests notice.
  it.each(["tl;dr this and file it", "tldr this and file it", "tl dr this and file it", "TLDR, then log it", "Tl Dr and file it"])(
    "'%s' asks for a summary",
    (instruction) => {
      expect(saysAny(instruction, declaredWords("summarize") ?? [])).toBe(true);
      expect(saysAny(instruction, declaredWords("rewrite") ?? [])).toBe(false);
    },
  );

  it.each(["the tldrs page is down", "atldr build fails", "tl drive mount is gone", "xtl;dr"])(
    "'%s' holds the letters inside a longer word, and does not ask",
    (instruction) => {
      expect(saysAny(instruction, declaredWords("summarize") ?? [])).toBe(false);
    },
  );

  it("a two-word entry takes one object word between", () => {
    for (const object of ["it", "this", "that", "these", "those", "them"]) {
      expect(saysAny(`sum ${object} up`, ["sum up"])).toBe(true);
      expect(saysAny(`boil ${object} down`, ["boil down"])).toBe(true);
      expect(saysAny(`clean ${object} up`, ["clean up"])).toBe(true);
    }
    expect(saysAny("clean up this text", ["clean up"])).toBe(true);
  });

  it("but not any word, nor two", () => {
    expect(saysAny("the sum went up", ["sum up"])).toBe(false);
    expect(saysAny("sum the whole thing up", ["sum up"])).toBe(false);
  });

  it("a three-word entry is matched as written", () => {
    expect(saysAny("make it sound friendlier", ["make it sound"])).toBe(true);
    expect(saysAny("make this sound friendlier", ["make it sound"])).toBe(false);
  });
});

describe("the rule", () => {
  const CREATE = step("linear__create_issue", { title: "Migration fails", description: "{step1}" });
  const SEND = step("sendMessage", { channel: "fun", notes: "{step2}" });

  it("refuses a summarize step before a create the instruction did not ask for", () => {
    expect(check("create a linear issue and send to fun", [step("summarize"), CREATE, SEND], LONG_TRACE)).toEqual({
      ok: false,
      reason: UNASKED_STEP,
    });
  });

  it("refuses a rewrite step before a create, and before a GitHub create", () => {
    expect(check("create a linear issue", [step("rewrite"), CREATE], LONG_TRACE).ok).toBe(false);
    expect(
      check("open a github issue for this", [step("rewrite"), step("github__create_issue", { title: "T", body: "{step1}" })], LONG_TRACE).ok,
    ).toBe(false);
  });

  it("judges a `functions.`-prefixed step by its canonical name", () => {
    expect(check("create a linear issue", [step("functions.summarize"), step("functions.linear__create_issue", { title: "T", description: "{step1}" })], LONG_TRACE).ok).toBe(false);
  });

  it("a step not before a create is not looked at", () => {
    // A plan that only summarizes; one that summarizes after filing; one that summarizes and posts.
    expect(check("post this to fun", [step("summarize"), SEND], LONG_TRACE)).toEqual({ ok: true });
    // No word from either list in the instruction, so only the step's position lets it run.
    const filedFirst = [step("linear__create_issue", { title: "T", description: LONG_TRACE }), step("summarize")];
    expect(saysAny("file this and tell fun", [...SUMMARIZE_WORDS, ...REWRITE_WORDS])).toBe(false);
    expect(check("file this and tell fun", filedFirst, LONG_TRACE)).toEqual({ ok: true });
    expect(check("file this and tell fun", [filedFirst[0] as PlannedStep, step("rewrite")], LONG_TRACE)).toEqual({ ok: true });
    expect(check("post this to fun", [step("rewrite"), SEND], LONG_TRACE)).toEqual({ ok: true });
  });

  it("a lone summarize, rewrite or create is never refused by it", () => {
    expect(check("create a linear issue", [step("summarize")], LONG_TRACE)).toEqual({ ok: true });
    expect(check("create a linear issue", [step("rewrite")], LONG_TRACE)).toEqual({ ok: true });
    expect(check("create a linear issue", [step("linear__create_issue", { title: "T" })], LONG_TRACE)).toEqual({ ok: true });
  });

  it("a step of a tool with no words declared (readEmail) is not looked at", () => {
    expect(check("create a linear issue and send to fun", [step("readEmail"), CREATE, SEND])).toEqual({ ok: true });
  });

  it("names every unasked step, not only the first", () => {
    const steps = canonical([step("summarize"), step("rewrite"), CREATE]);
    expect(unaskedSteps("create a linear issue", steps, TOOLS)).toEqual([0, 1]);
    expect(unaskedSteps("summarize this and file it", steps, TOOLS)).toEqual([1]);
  });

  it("judges the instruction, never the clipboard", () => {
    // The clipboard says "summarize"; the instruction does not. Refused.
    const copied = "Please summarize the attached incident report before Friday's review.";
    expect(check("create a linear issue and send to fun", [step("summarize"), CREATE, SEND], copied).ok).toBe(false);
    // And the other way: the instruction asks, the clipboard says nothing of the kind. Runs.
    expect(check("summarize this and file it in Linear", [step("summarize"), CREATE], LONG_TRACE)).toEqual({ ok: true });
  });
});

describe("per-tool word lists", () => {
  const CREATE = step("linear__create_issue", { title: "T", description: "{step1}" });

  it("'polish this and file it' with a summarize step is refused", () => {
    expect(check("polish this and file it", [step("summarize"), CREATE], LONG_TRACE).ok).toBe(false);
  });

  it("'summarize this and file it' with a summarize step runs", () => {
    expect(check("summarize this and file it", [step("summarize"), CREATE], LONG_TRACE)).toEqual({ ok: true });
  });

  it("'summarize this and file it' with a rewrite step is refused", () => {
    expect(check("summarize this and file it", [step("rewrite"), CREATE], LONG_TRACE).ok).toBe(false);
  });

  it("CONTROL: 'polish this and file it' with a rewrite step runs", () => {
    expect(check("polish this and file it", [step("rewrite"), CREATE], LONG_TRACE)).toEqual({ ok: true });
  });
});

describe("the refusal", () => {
  const PLAN = [step("summarize"), step("linear__create_issue", { title: "T", description: "{step1}" })];

  it("with nothing copied, says to copy the text", () => {
    expect(check("log this as an issue and let #bugs know", PLAN, null)).toEqual({ ok: false, reason: UNASKED_STEP_NO_TEXT });
    expect(check("log this as an issue and let #bugs know", PLAN, "  \n ")).toEqual({ ok: false, reason: UNASKED_STEP_NO_TEXT });
  });

  it("with text copied, offers to file it as it is or to ask by name", () => {
    expect(check("create a linear issue and send to fun", PLAN, LONG_TRACE)).toEqual({ ok: false, reason: UNASKED_STEP });
  });

  it("both wordings are the approved text, word for word", () => {
    expect(UNASKED_STEP_NO_TEXT).toBe("I'd need text to work from. Copy it, then ask again.");
    expect(UNASKED_STEP).toBe(
      "I won't summarize/reword it unless you ask. Ask again to file it as it is, or say 'summarize' / 'rewrite' if you want that.",
    );
  });

  it.each([UNASKED_STEP_NO_TEXT, UNASKED_STEP])("is plain ASCII, one paragraph, and spoken whole: %s", (text) => {
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(toSpokenResult(text)).toEqual({ text, remainder: null });
  });

  it("its rows are recognised, and nothing else is", () => {
    for (const result of [UNASKED_STEP, UNASKED_STEP_NO_TEXT]) {
      expect(isUnaskedStepRefusal({ status: "refused", tool: null, result })).toBe(true);
      expect(isUnaskedStepRefusal({ status: "ok", tool: null, result })).toBe(false);
      expect(isUnaskedStepRefusal({ status: "refused", tool: "summarize", result })).toBe(false);
    }
    expect(isUnaskedStepRefusal({ status: "refused", tool: null, result: "My plan for that used a tool I don't have" })).toBe(false);
  });
});

// THE REPLAY. Every plan on record with a summarize or rewrite step before a create: 30 that
// nobody asked for, 5 that the person did.
describe("replaying the recorded plans", () => {
  // Written by hand: which recorded instructions ask for a summary or a rewrite. None do.
  const RECORDED_ASKS = new Set<string>();
  const hasStepBeforeCreate = (steps: readonly PlannedStep[]): boolean => {
    const tools = canonical(steps).map((entry) => entry.tool);
    const create = tools.findIndex((tool) => tool.endsWith("create_issue"));
    return tools.slice(0, Math.max(create, 0)).some((tool) => tool === "summarize" || tool === "rewrite");
  };

  it("recorded.json: the 16 unasked summarize steps are refused, the other 61 answers are not", () => {
    const flagged = RECORDED.filter((entry) => hasStepBeforeCreate(entry.steps) && !RECORDED_ASKS.has(entry.instruction));
    // The precondition: the 16 the investigation counted.
    expect(flagged).toHaveLength(16);
    for (const entry of RECORDED) {
      const verdict = check(entry.instruction, entry.steps, entry.clipboard);
      expect(verdict.ok, `${entry.source}: ${entry.instruction}`).toBe(!flagged.includes(entry));
    }
  });

  it("recorded.json: those 16 all had nothing copied, so all get the copy-the-text wording", () => {
    for (const entry of RECORDED.filter((candidate) => hasStepBeforeCreate(candidate.steps))) {
      expect(entry.clipboard).toBeNull();
      expect(check(entry.instruction, entry.steps, entry.clipboard)).toEqual({ ok: false, reason: UNASKED_STEP_NO_TEXT });
    }
  });

  it("recorded.json: the other two checks see these answers exactly as before", () => {
    // M30 adds a check; it changes neither of the others. Their verdicts on all 77, as pinned by
    // tests/unreadContent.test.ts and tests/unfilledBlanks.test.ts, do not depend on this one.
    const refusedByOthers = RECORDED.filter(
      (entry) =>
        !checkUnreadContent(entry.instruction, { selectedText: entry.clipboard }, canonical(entry.steps), TOOLS).ok ||
        !checkUnfilledBlanks(entry.instruction, { selectedText: entry.clipboard }, canonical(entry.steps)).ok,
    );
    // None of the answers the other checks refuse has a step before a create, so no plan is
    // refused twice over with a different wording than before.
    expect(refusedByOthers.filter((entry) => hasStepBeforeCreate(entry.steps))).toEqual([]);
  });

  it.each([
    ["M28's eval table", EVAL, 8, 37],
    ["the live action log", LIVE, 6, 2],
  ] as const)("%s: every unasked step is refused and every other plan runs", (_name, rows, refused, runs) => {
    expect(rows.filter((row) => row.expected === "refused")).toHaveLength(refused);
    expect(rows.filter((row) => row.expected === "runs")).toHaveLength(runs);
    for (const row of rows) {
      const verdict = check(row.instruction, planOf(row), row.clipboard);
      expect(verdict.ok, `${row.source}: ${row.instruction} (${row.tools.join(" > ")})`).toBe(row.expected === "runs");
    }
  });

  it("in all: 30 unasked steps refused, and the 5 steps the person asked for still run", () => {
    const refusedRecorded = RECORDED.filter((entry) => !check(entry.instruction, entry.steps, entry.clipboard).ok);
    const replayed = [...EVAL, ...LIVE];
    const refusedReplayed = replayed.filter((row) => !check(row.instruction, planOf(row), row.clipboard).ok);
    expect(refusedRecorded.length + refusedReplayed.length).toBe(30);

    const askedFor = replayed.filter((row) => row.expected === "runs" && hasStepBeforeCreate(planOf(row)));
    expect(askedFor.map((row) => row.instruction)).toEqual([
      "summarize this and file it in Linear",
      "summarize this and file it in Linear",
      "summarize this and file it in Linear",
      "rewrite this and file it in Linear, then tell fun",
      "rewrite this and file in linear then tell fun",
    ]);
    for (const row of askedFor) expect(check(row.instruction, planOf(row), row.clipboard)).toEqual({ ok: true });
  });

  // The M28 controls the reverted prompt wordings broke. A check in code cannot change what the
  // model plans; what it could do is refuse what the model already plans right. It does not.
  it("CONTROLS: the email-open and nothing-on-screen plans from M28's set are untouched", () => {
    const controls = EVAL.filter(
      (row) => row.emailOpen === true || (row.clipboard === null && !row.tools.includes("summarize")),
    );
    expect(controls.map((row) => `${row.instruction} | ${row.tools.join(">")}`)).toEqual([
      ...Array(3).fill("file this bug in linear and tell the social channel | readEmail>linear__create_issue>sendMessage"),
      ...Array(3).fill("file this bug email in Linear and tell the bugs channel | readEmail>linear__create_issue>sendMessage"),
      ...Array(3).fill("make a Linear ticket from this email, then post the link in #bugs | readEmail>linear__create_issue>sendMessage"),
      ...Array(3).fill("file this bug in Linear and tell the social channel | readEmail>linear__create_issue>sendMessage"),
      ...Array(3).fill("find the login issue in Linear | linear__search_issues"),
      ...Array(3).fill("log this as an issue and let #bugs know | readEmail>linear__create_issue>sendMessage"),
      ...Array(3).fill("reply to this and send it | draftReply>sendReply"),
      ...Array(3).fill("summarize this | summarize"),
    ]);
    for (const row of controls) expect(check(row.instruction, planOf(row), row.clipboard)).toEqual({ ok: true });
  });
});

// HOW FAR THE WORD LISTS REACH. Phrasings written by hand during M30's investigation, each paired
// with the step it asks for and run as that step before a Linear create. Not measured against a
// model; what is wrongly refused here is a known gap (spec.md §5b), pinned so a change shows.
describe("the phrasing set", () => {
  const ASKS_FOR: readonly (readonly [string, "summarize" | "rewrite"])[] = [
    ["summarise this and file it", "summarize"],
    ["give me a tl;dr of this and log it in linear", "summarize"],
    ["tldr this and file it", "summarize"],
    ["condense this into an issue", "summarize"],
    ["shorten this and log it", "summarize"],
    ["clean this up and file it", "rewrite"],
    ["clean up this text and file it in linear", "rewrite"],
    ["polish this and post it to fun", "rewrite"],
    ["reword this then file it", "rewrite"],
    ["rephrase this and log it", "rewrite"],
    ["sum this up and file it", "summarize"],
    ["make this shorter and file it", "summarize"],
    ["boil this down and log it in linear", "summarize"],
    ["file the gist of this", "summarize"],
    ["file a short version of this", "summarize"],
    ["give me the key points and file them", "summarize"],
    ["make this more formal and file it", "rewrite"],
    ["fix the wording and log it", "rewrite"],
    ["tidy this up and file it", "rewrite"],
    ["file a one-line issue from this", "summarize"],
    ["make it brief and file it", "summarize"],
    ["summary of this in linear please", "summarize"],
  ];

  const runAs = (instruction: string, tool: string) =>
    check(instruction, [step(tool), step("linear__create_issue", { title: "T", description: "{step1}" })], LONG_TRACE);

  it("22 phrasings that ask for the step: 1 is wrongly refused, and this is the one", () => {
    expect(ASKS_FOR).toHaveLength(22);
    const refused = ASKS_FOR.filter(([instruction, tool]) => !runAs(instruction, tool).ok).map(([instruction]) => instruction);
    expect(refused).toEqual(["file a one-line issue from this"]);
  });

  it("'tldr this and file it' runs (a known gap until the review pass)", () => {
    expect(runAs("tldr this and file it", "summarize")).toEqual({ ok: true });
  });

  // The other direction: the word is part of the bug being reported, and the person asked for no
  // summary or rewrite. The check lets the step through — what happened before M30, so no
  // regression, and a known gap.
  it("4 phrasings where the word is part of the bug: all 4 let the step through", () => {
    const VERB_IN_THE_BUG: readonly (readonly [string, "summarize" | "rewrite"])[] = [
      ["file an issue: the summarize button is broken", "summarize"],
      ["log a bug that the rewrite tool drops the header", "rewrite"],
      ["file this: polish translations are missing", "rewrite"],
      ["create an issue to shorten the login timeout", "summarize"],
    ];
    for (const [instruction, tool] of VERB_IN_THE_BUG) expect(runAs(instruction, tool)).toEqual({ ok: true });
  });
});

describe("where a create's description came from (the console only)", () => {
  const create = (description?: string): PlannedStep =>
    step("linear__create_issue", description === undefined ? { title: "T" } : { title: "T", description });

  it("the clipboard as copied, whitespace aside", () => {
    expect(createDescriptions(canonical([create(`  ${LONG_TRACE.replace(/\n\n/g, "\n")} `)]), TOOLS, LONG_TRACE)).toEqual([
      "equals clipboard",
    ]);
  });

  it("anything else differs, a condensed clipboard included", () => {
    expect(createDescriptions(canonical([create(LONG_TRACE.slice(0, 400))]), TOOLS, LONG_TRACE)).toEqual([
      "differs from clipboard",
    ]);
    expect(createDescriptions(canonical([create("Migration dies on orders")]), TOOLS, null)).toEqual(["differs from clipboard"]);
  });

  it("an earlier step's result", () => {
    expect(createDescriptions(canonical([step("summarize"), create("Summary: {step1}")]), TOOLS, LONG_TRACE)).toEqual([
      "from an earlier step",
    ]);
  });

  it("nothing for a create with no description, or a plan with no create", () => {
    expect(createDescriptions(canonical([create()]), TOOLS, LONG_TRACE)).toEqual([]);
    expect(createDescriptions(canonical([create("  ")]), TOOLS, LONG_TRACE)).toEqual([]);
    expect(createDescriptions(canonical([step("summarize"), step("sendMessage", { channel: "fun", notes: "{step1}" })]), TOOLS, LONG_TRACE)).toEqual([]);
  });

  it("one entry per create, in order", () => {
    const github = step("github__create_issue", { title: "T", body: LONG_TRACE });
    expect(createDescriptions(canonical([github, create("{step1}")]), TOOLS, LONG_TRACE)).toEqual([
      "equals clipboard",
      "from an earlier step",
    ]);
  });
});
