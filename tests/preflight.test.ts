import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { PlannerOutcome, ToolChoice, ToolInput } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";

// Do a chain's pre-flight and the step itself give the SAME verdict on the same arguments?
//
// They are two pieces of code answering one question at two moments, and the failure worth
// fearing is drift between them: a pre-flight that refuses something the step would have run
// blocks a plan that was fine, and nothing in either one's own tests would notice.
//
// So each case below is run twice through the REAL planner, registry and memory —
//
//   alone:    the tool as a single instruction. What `runStep` and the tool decide.
//   chained:  the identical call as step 2 of a plan. Refused UP FRONT means zero steps ran.
//
// — and the two verdicts are compared. Neither run is told what the other should say.

const FACTS: Record<string, string> = {
  team: "#design-team",
  "target:dashboard": "https://dash.example.com",
};

function run(choice: ToolChoice): Promise<{ outcome: PlannerOutcome; llm: FakeLLM; shell: MockShell }> {
  const memory = new SqliteMemory(createDatabase(":memory:"));
  for (const [subject, value] of Object.entries(FACTS)) memory.write(subject, value);
  const shell = new MockShell({
    context: { selectedText: "some notes", activeApp: null, activeWindowTitle: null },
    confirms: [true, true, true], // every dialog that is reached is approved
  });
  const llm = new FakeLLM(choice, "SUMMARY");
  const planner = new Planner(
    llm,
    shell,
    registry,
    memory,
    memory,
    new FakeSender(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => Promise.resolve(), // sleep — never wait out the plan-preview hold
  );
  return planner.run("do it").then((outcome) => ({ outcome, llm, shell }));
}

async function refusedAlone(tool: string, input: ToolInput): Promise<boolean> {
  const { outcome } = await run({ kind: "tool", name: tool, input });
  return outcome.status !== "ok";
}

// Refused by the PRE-FLIGHT, specifically: nothing ran at all. A chain that got through step 1
// and stopped at step 2 was refused by the step, which is the other side of the comparison.
async function refusedUpFront(tool: string, input: ToolInput): Promise<boolean> {
  const { outcome, llm, shell } = await run({
    kind: "plan",
    steps: [
      { tool: "summarize", arguments: {}, describe: "summarize it" },
      { tool, arguments: input, describe: "then this" },
    ],
  });
  const upFront = outcome.chain?.completed === 0;
  // "Nothing ran" checked against the world, not against the planner's own account of it.
  if (upFront) {
    expect(llm.completeCalls).toBe(0);
    expect(shell.actions).toEqual([]);
  }
  return upFront;
}

describe("the pre-flight and the step agree — sendMessage", () => {
  // Every shape a channel can arrive in. `expected` is written out by hand so that two wrong
  // answers that happen to match cannot pass for agreement.
  const CASES: { label: string; input: ToolInput; refused: boolean }[] = [
    { label: "a literal channel", input: { channel: "#bugs" }, refused: false },
    { label: "a known reference", input: { channel: "the team" }, refused: false },
    { label: "a known reference, other article", input: { channel: "My Team" }, refused: false },
    { label: "an unknown reference", input: { channel: "the bugs channel" }, refused: true },
    { label: "an unknown reference, 'my'", input: { channel: "my channel" }, refused: true },
    { label: "an empty channel", input: { channel: "" }, refused: true },
    { label: "a blank channel", input: { channel: "   " }, refused: true },
    { label: "no channel at all", input: {}, refused: true },
    {
      label: "a known channel and a body that reads like an unknown reference",
      input: { channel: "the team", notes: "the bugs channel" },
      refused: false,
    },
  ];

  it.each(CASES)("$label", async ({ input, refused }) => {
    expect(await refusedAlone("sendMessage", input), "alone").toBe(refused);
    expect(await refusedUpFront("sendMessage", input), "pre-flight").toBe(refused);
  });
});

describe("the pre-flight and the step agree — openTarget", () => {
  const CASES: { label: string; input: ToolInput; refused: boolean }[] = [
    { label: "a known reference", input: { target: "my dashboard" }, refused: false },
    { label: "a known reference, url left empty", input: { target: "my dashboard", url: "" }, refused: false },
    { label: "an unknown reference", input: { target: "my upwork" }, refused: true },
    { label: "an unknown reference, url left empty", input: { target: "my upwork", url: "" }, refused: true },
    {
      label: "an unknown reference beside a real URL",
      input: { target: "the Spotify web player", url: "https://open.spotify.com" },
      refused: false,
    },
    { label: "a bare host", input: { target: "youtube.com" }, refused: false },
    { label: "nothing at all", input: {}, refused: true },
  ];

  it.each(CASES)("$label", async ({ input, refused }) => {
    expect(await refusedAlone("openTarget", input), "alone").toBe(refused);
    expect(await refusedUpFront("openTarget", input), "pre-flight").toBe(refused);
  });

  // THE KNOWN GAP, pinned so it is a decision rather than a surprise. The pre-flight asks "is
  // this a reference we cannot place?"; `openTarget` additionally needs a URL. A plain word that
  // is neither — "youtube", with the model supplying no URL — is not a reference, so the
  // pre-flight lets the plan start and the step refuses it where it always did. The direction
  // that matters holds: the pre-flight never refuses what the step would have run.
  it("lets a non-reference, non-URL target through to the step, which refuses it", async () => {
    const input = { target: "youtube" };
    expect(await refusedAlone("openTarget", input)).toBe(true);
    expect(await refusedUpFront("openTarget", input)).toBe(false);
  });
});
