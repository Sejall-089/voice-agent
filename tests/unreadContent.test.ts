import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIN_CLIPBOARD_CHARS,
  UNREAD_CONTENT,
  canonicalToolName,
  checkUnreadContent,
  emptyCreates,
  pointsAtSomething,
  titleIsTheirWords,
  usesPointedContent,
} from "../src/core/chain.ts";
import { CONNECTORS, loadConnectorTools } from "../src/core/mcp/load.ts";
import { UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { toSpokenResult } from "../src/core/speech.ts";
import type { PlannedStep, ToolInput } from "../src/core/types.ts";

// A CREATE THAT USES NOTHING THE USER POINTED AT (core/chain.ts, `checkUnreadContent`).
//
// The fixture is not invented. `tests/fixtures/unreadContent/recorded.json` is every answer a real
// model gave, across the 2026-10 cost comparison runs, that contained a Linear or GitHub create —
// 77 of them, tool names exactly as sent (nine carry the provider's `functions.` prefix). Four of
// them are the failure this rule exists for: an issue titled "Bug report", no description, and
// nothing in the plan that reads the email or text. Two of those four were recorded twice (once in
// the proxy log, once in the run's own record), so they are six entries.
//
// The rule is checked against THOSE, not against plans written to fit it. The legitimate cases
// below are synthetic, and say so: instructions where the user dictated the content, which a
// rule too eager to refuse would refuse.

interface Recorded {
  source: string;
  instruction: string;
  clipboard: string | null;
  steps: PlannedStep[];
}

const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/unreadContent/recorded.json", import.meta.url), "utf8"),
) as Recorded[];

// The menu the app offers with everything configured — the declarations under test are the
// REAL ones, from the real tool definitions and the real connector definitions.
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

// What the planner does before it checks: a `functions.` prefix in front of a real name is that tool.
const canonical = (steps: readonly PlannedStep[]): PlannedStep[] =>
  steps.map((step) => ({ ...step, tool: canonicalToolName(step.tool, MENU) }));

const check = (instruction: string, steps: readonly PlannedStep[], clipboard: string | null = null) =>
  checkUnreadContent(instruction, { selectedText: clipboard }, canonical(steps), TOOLS);

const step = (tool: string, args: ToolInput = {}): PlannedStep => ({ tool, arguments: args, describe: "" });

// THE MISS, by its shape: a Linear create with no description, then a send, nothing else.
const isMiss = (entry: Recorded): boolean => {
  const steps = canonical(entry.steps);
  return (
    steps.length === 2 &&
    steps[0]?.tool === "linear__create_issue" &&
    steps[1]?.tool === "sendMessage" &&
    steps[0].arguments["description"] === undefined
  );
};

describe("the recorded answers", () => {
  it("are the 77 answers the comparison runs recorded, six of them the miss", () => {
    expect(RECORDED).toHaveLength(77);
    const misses = RECORDED.filter(isMiss);
    expect(misses).toHaveLength(6);
    // Every miss is the same invented issue: "Bug report", nothing else.
    for (const miss of misses) expect(miss.steps[0]?.arguments).toEqual({ title: "Bug report" });
    // Four distinct answers — gpt-5 low twice, gpt-5 default once, gpt-5-mini low once — the last
    // two recorded under two names each (the proxy log and the run's own record).
    expect(new Set(misses.map((miss) => miss.source.replace(/^baseline-/, "")))).toEqual(
      new Set(["proxy gpt-5/low", "proxy2 gpt-5/default", "proxy2 gpt-5-mini/low", "gpt5", "minilow"]),
    );
  });

  it("every recorded miss is refused, in the fixed words", () => {
    for (const miss of RECORDED.filter(isMiss)) {
      expect(check(miss.instruction, miss.steps, miss.clipboard), `${miss.source}: ${miss.instruction}`).toEqual({
        ok: false,
        reason: UNREAD_CONTENT,
      });
    }
  });

  it("every other recorded answer is allowed — the passes and the loud misses alike", () => {
    const others = RECORDED.filter((entry) => !isMiss(entry));
    expect(others).toHaveLength(71);
    for (const entry of others) {
      expect(check(entry.instruction, entry.steps, entry.clipboard), `${entry.source}: ${entry.instruction}`).toEqual({ ok: true });
    }
  });
});

describe("legitimate creates are never refused (synthetic, from the design review)", () => {
  const LEGIT: [string, PlannedStep[], string | null][] = [
    [
      "create a Linear issue titled login button is broken with description it does nothing on mobile",
      [step("linear__create_issue", { title: "Login button is broken", description: "It does nothing on mobile" })],
      null,
    ],
    ["create a Linear issue titled login button is broken", [step("linear__create_issue", { title: "Login button is broken" })], null],
    ["create an issue on github for body format", [step("github__create_issue", { title: "Body format" })], null],
    ["file a github issue: the export button is greyed out", [step("github__create_issue", { title: "Export button is greyed out" })], null],
    ["log it in Linear: dark mode toggle resets after reload", [step("linear__create_issue", { title: "Dark mode toggle resets after reload" })], null],
    [
      "create a linear ticket that the onboarding email has a typo and tell #bugs",
      [step("linear__create_issue", { title: "Onboarding email has a typo" }), step("sendMessage", { channel: "#bugs", notes: "New bug filed: {step1}" })],
      null,
    ],
    [
      "file this bug email in Linear and tell the bugs channel",
      [
        step("readEmail"),
        step("linear__create_issue", { title: "Login button does nothing on mobile", description: "{step1}" }),
        step("sendMessage", { channel: "the bugs channel", notes: "New bug filed: {step2}" }),
      ],
      null,
    ],
    [
      "File this email as a bug on GitHub and post it in the bugs channel",
      [
        step("readEmail"),
        step("github__create_issue", { title: "Login button does nothing", body: "{step1}" }),
        step("sendMessage", { channel: "the bugs channel", notes: "{step2}" }),
      ],
      null,
    ],
  ];

  it.each(LEGIT)("%s", (instruction, steps, clipboard) => {
    expect(check(instruction, steps, clipboard)).toEqual({ ok: true });
  });

  it("'these notes' copied word for word into the send, beside a title-only issue", () => {
    const notes =
      "Release checklist:\n- [ ] bump version\n- [ ] update changelog\n- [ ] run smoke tests on staging";
    const steps = [
      step("github__create_issue", { title: "Confirm body format renders in the issue template" }),
      step("sendMessage", { channel: "fun channel", notes }),
    ];
    const instruction = "create an issue on github for body format and send these notes to fun channel";
    // The preconditions that make this the clipboard clause's case and nobody else's: it points,
    // the create is empty, the title is not the user's words, and the send has notes (so it is
    // not reading the clipboard itself).
    expect(pointsAtSomething(instruction)).toBe(true);
    expect(emptyCreates(canonical(steps), TOOLS)).toHaveLength(1);
    expect(titleIsTheirWords("Confirm body format renders in the issue template", instruction)).toBe(false);
    expect(usesPointedContent(canonical(steps), TOOLS, null)).toBe(false);

    expect(check(instruction, steps, notes)).toEqual({ ok: true });
  });
});

// ONE TEST PER CLAUSE. Each starts from a recorded miss, changes exactly one thing, asserts the
// OTHER clauses still hold — so the flip can only be that clause's doing — and asserts the outcome
// flips to allowed. A rule with a clause removed fails exactly the test named for it.
describe("each clause, alone", () => {
  const MISS = RECORDED.find((entry) => isMiss(entry) && entry.source === "proxy2 gpt-5/default");
  if (MISS === undefined) throw new Error("the gpt-5 default miss is not in the fixture");
  const INSTRUCTION = MISS.instruction; // "log this as an issue and let #bugs know"
  const STEPS = canonical(MISS.steps);
  const [CREATE, SEND] = STEPS as [PlannedStep, PlannedStep];

  // Clauses 2-4 on a plan, and whether the whole check refuses.
  const state = (instruction: string, steps: readonly PlannedStep[], clipboard: string | null = null) => ({
    points: pointsAtSomething(instruction),
    uses: usesPointedContent(steps, TOOLS, clipboard),
    empty: emptyCreates(steps, TOOLS).length,
    theirs: emptyCreates(steps, TOOLS).some((c) => titleIsTheirWords(c.title, instruction)),
    refused: !checkUnreadContent(instruction, { selectedText: clipboard }, steps, TOOLS).ok,
  });

  it("the starting point: all four clauses hold, and it is refused", () => {
    expect(state(INSTRUCTION, STEPS)).toEqual({ points: true, uses: false, empty: 1, theirs: false, refused: true });
  });

  it("clause 1: an instruction that points at nothing", () => {
    const instruction = "log an issue in Linear and let #bugs know";
    expect(state(instruction, STEPS)).toEqual({ points: false, uses: false, empty: 1, theirs: false, refused: false });
  });

  it("clause 2: a step that reads what the user pointed at (readEmail, not fed into the create)", () => {
    const steps = [step("readEmail"), CREATE, SEND];
    expect(state(INSTRUCTION, steps)).toEqual({ points: true, uses: true, empty: 1, theirs: false, refused: false });
  });

  it("clause 2: a send with no notes reads the clipboard itself", () => {
    const steps = [CREATE, step("sendMessage", { channel: "#bugs" })];
    expect(state(INSTRUCTION, steps)).toEqual({ points: true, uses: true, empty: 1, theirs: false, refused: false });
    // And blank notes count as none.
    const blank = [CREATE, step("sendMessage", { channel: "#bugs", notes: "   " })];
    expect(state(INSTRUCTION, blank).uses).toBe(true);
  });

  it("clause 2: an argument that contains the captured clipboard text", () => {
    const clipboard = "Login button does nothing on Safari after the Tuesday deploy";
    const steps = [CREATE, step("sendMessage", { channel: "#bugs", notes: `Heads up:\n${clipboard}` })];
    expect(state(INSTRUCTION, steps, clipboard)).toEqual({ points: true, uses: true, empty: 1, theirs: false, refused: false });
  });

  it("clause 2: a clipboard shorter than the minimum never counts — the check stays on", () => {
    // "Bug" is inside the title "Bug report". Were short clipboards counted, any stray word on the
    // clipboard could switch the check off.
    expect("Bug".length).toBeLessThan(MIN_CLIPBOARD_CHARS);
    expect(state(INSTRUCTION, STEPS, "Bug")).toEqual({ points: true, uses: false, empty: 1, theirs: false, refused: true });
  });

  it("clause 2: a tracker search is NOT a read of what the user pointed at", () => {
    const steps = [step("linear__search_issues", { query: "login" }), CREATE, SEND];
    expect(state(INSTRUCTION, steps)).toEqual({ points: true, uses: false, empty: 1, theirs: false, refused: true });
  });

  it("clause 3: a {stepN} in the create's arguments means an earlier step fed it", () => {
    const steps = [step("linear__search_issues", { query: "login" }), step("linear__create_issue", { title: "{step1}" }), SEND];
    expect(state(INSTRUCTION, steps)).toEqual({ points: true, uses: false, empty: 0, theirs: false, refused: false });
  });

  it("clause 3: a create with a description", () => {
    const steps = [step("linear__create_issue", { title: "Bug report", description: "Login does nothing on Safari." }), SEND];
    expect(state(INSTRUCTION, steps)).toEqual({ points: true, uses: false, empty: 0, theirs: false, refused: false });
    // A blank description is no description.
    const blank = [step("linear__create_issue", { title: "Bug report", description: "  " }), SEND];
    expect(state(INSTRUCTION, blank).refused).toBe(true);
  });

  it("clause 4: a title made only of the user's own words", () => {
    const instruction = "log this login button bug as an issue and let #bugs know";
    const steps = [step("linear__create_issue", { title: "Login button bug" }), SEND];
    expect(state(instruction, steps)).toEqual({ points: true, uses: false, empty: 1, theirs: true, refused: false });
    // One invented word is enough to make it not theirs.
    const invented = [step("linear__create_issue", { title: "Login button bug report" }), SEND];
    expect(state(instruction, invented).refused).toBe(true);
  });
});

describe("the declarations the planner reads", () => {
  it("contentArg: exactly the two creates, naming their own title and body", () => {
    const declared = TOOLS.filter((tool) => tool.contentArg !== undefined).map((tool) => [tool.name, tool.contentArg]);
    expect(declared).toEqual([
      ["linear__create_issue", { title: "title", body: "description" }],
      ["github__create_issue", { title: "title", body: "body" }],
    ]);
  });

  it("readsContext: exactly the tools that read what the user points at", () => {
    const readers = TOOLS.filter((tool) => tool.readsContext !== undefined).map((tool) => tool.name).sort();
    expect(readers).toEqual(
      ["addToPage", "draftReply", "readEmail", "readSchedule", "reviseDraft", "rewrite", "sendMessage", "summarize"],
    );
    // Not a tracker read, not memory.
    for (const name of ["linear__search_issues", "linear__get_issue", "github__list_issues", "github__get_issue", "recall"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.readsContext, name).toBeUndefined();
    }
  });

  it("sendMessage reads the clipboard only when it was given no notes", () => {
    const reads = TOOLS.find((tool) => tool.name === "sendMessage")?.readsContext;
    expect(typeof reads).toBe("function");
    if (typeof reads !== "function") return;
    expect(reads({ channel: "#bugs" })).toBe(true);
    expect(reads({ channel: "#bugs", notes: "" })).toBe(true);
    expect(reads({ channel: "#bugs", notes: "we ship friday" })).toBe(false);
  });
});

describe("the refusal's words", () => {
  it("are plain ASCII — nothing the speech engine garbles", () => {
    expect(UNREAD_CONTENT).toMatch(/^[\x20-\x7E]+$/);
  });

  it("are one paragraph, spoken whole", () => {
    expect(UNREAD_CONTENT).not.toContain("\n");
    expect(toSpokenResult(UNREAD_CONTENT)).toEqual({ text: UNREAD_CONTENT, remainder: null });
  });
});
