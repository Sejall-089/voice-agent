import { describe, it, expect } from "vitest";
import { elaborateTool } from "../src/core/tools/elaborate.ts";
import type { Tool } from "../src/core/types.ts";
import { jobWorld, settle, tool } from "./jobWorld.ts";

// M25 Fix 1: the live finding, end to end through the real job runner and planner.
//
// A long summary is read out; the user asks something short ("what's the time") and gets a
// one-line answer; then says "read the rest". Before M25 the short answer's `say()` CLEARED the
// slot, so the reply was "There's nothing more to read out." Now the summary's rest is read, with
// a lead-in saying it is from the earlier answer.

const LONG =
  "Alex wrote about the Q3 launch, and the design review has moved from Tuesday to Thursday afternoon because two of the reviewers are travelling. " +
  "Priya wants the final onboarding mockups by Wednesday evening. " +
  "The copy for the pricing page still needs legal sign off. " +
  "The mobile team flagged a crash on Android 14 when the app resumes from the background.";

const summary: Tool = {
  name: "readInbox", description: "Summarize the inbox.", inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe", background: "ok", planPhrase: "run a test step", handler: () => Promise.resolve(LONG),
};
const shortAnswer: Tool = {
  name: "shortThing", description: "Answer briefly.", inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe", background: "ok", planPhrase: "run a test step", handler: () => Promise.resolve("It's 2:51 PM."),
};

function world() {
  return jobWorld({
    script: {
      "summarize my inbox": tool("readInbox"),
      "what's the time": tool("shortThing"),
      "read the rest": tool("elaborate"),
    },
    tools: [summary, shortAnswer, elaborateTool],
  });
}

describe("read the rest after a short answer in between (M25 Fix 1)", () => {
  it("reads the summary's rest, said to be from the earlier answer", async () => {
    const w = world();
    await w.run("summarize my inbox");
    await settle();
    await w.run("what's the time");
    await settle();
    await w.run("read the rest");
    await settle();

    const last = w.shell.results.at(-1) ?? "";
    expect(last.startsWith("From the earlier answer: ")).toBe(true);
    expect(last).toContain("The copy for the pricing page still needs legal sign off.");
    expect(w.shell.spoken.at(-1)).toBe(last);
  });

  it("straight after the summary there is no lead-in", async () => {
    const w = world();
    await w.run("summarize my inbox");
    await settle();
    await w.run("read the rest");
    await settle();

    const last = w.shell.results.at(-1) ?? "";
    expect(last.startsWith("From the earlier answer")).toBe(false);
    expect(last).toContain("The copy for the pricing page still needs legal sign off.");
  });

  it("asked twice, the second time there is nothing more", async () => {
    const w = world();
    await w.run("summarize my inbox");
    await settle();
    await w.run("what's the time");
    await settle();
    await w.run("read the rest");
    await settle();
    await w.run("read the rest");
    await settle();

    expect(w.shell.results.at(-1)).toBe("There's nothing more to read out.");
  });
});
