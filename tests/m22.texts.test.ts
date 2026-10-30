import { describe, expect, it } from "vitest";
import { UNNAMED_FACT } from "../src/core/tools/remember.ts";
import { slackRefusalText } from "../src/core/tools/sendMessage.ts";
import type { ChannelLookup, DirectoryFailure, ToolChoice } from "../src/core/types.ts";
import { bugChain, harness, plan, step, type HarnessOptions } from "./botChainHarness.ts";

// M22 prompt 6. Two wording fixes, pinned:
//   - suggestions are a STATEMENT ("Similar channels: #a, #b."), never "Did you mean …?" — a
//     refusal must not read as a question nothing is waiting on;
//   - `remember`'s refusals say "so nothing was saved."; every send path still says "so nothing
//     was sent."

const notFound = (suggestions: string[]): Exclude<ChannelLookup, { ok: true }> => ({
  ok: false,
  reason: "not_found",
  suggestions,
});
const unavailable = (failure: DirectoryFailure): Exclude<ChannelLookup, { ok: true }> => ({
  ok: false,
  reason: "unavailable",
  failure,
});
const BASE =
  "I couldn't find a Slack channel called #bug. I can post to public channels and to private channels the bot has been added to.";
const FAILURES: DirectoryFailure[] = [
  "no_token",
  "auth",
  "network",
  "timeout",
  "slack_error",
  "bad_response",
  "rate_limited",
  "ambiguous",
];

describe("slackRefusalText: suggestions as a statement", () => {
  it.each([
    { suggestions: [], text: BASE },
    { suggestions: ["bug-reports"], text: `${BASE} Similar channels: #bug-reports.` },
    { suggestions: ["bug-reports", "bugs-old"], text: `${BASE} Similar channels: #bug-reports, #bugs-old.` },
    {
      suggestions: ["bug-reports", "bugs-old", "debug"],
      text: `${BASE} Similar channels: #bug-reports, #bugs-old, #debug.`,
    },
  ])("with $suggestions.length suggestion(s)", ({ suggestions, text }) => {
    expect(slackRefusalText(notFound(suggestions), "#bug")).toBe(text);
  });

  it("names at most three, and never asks", () => {
    const text = slackRefusalText(notFound(["a1", "a2", "a3", "a4"]), "bug");
    expect(text).toBe(`${BASE} Similar channels: #a1, #a2, #a3.`);
    expect(text).not.toContain("?");
    expect(text).not.toMatch(/did you mean/i);
  });

  it("the not-found text is the same for remember: only an unavailable one changes its ending", () => {
    expect(slackRefusalText(notFound(["help"]), "#bug", "saved")).toBe(slackRefusalText(notFound(["help"]), "#bug"));
  });
});

describe("slackRefusalText: what did not happen", () => {
  it.each(FAILURES)("a send (the default) says 'so nothing was sent.' (%s)", (failure) => {
    expect(slackRefusalText(unavailable(failure), "#help")).toMatch(/, so nothing was sent\.$/);
    expect(slackRefusalText(unavailable(failure), "#help", "sent")).toBe(slackRefusalText(unavailable(failure), "#help"));
  });

  it.each(FAILURES)("remember says 'so nothing was saved.' (%s)", (failure) => {
    const saved = slackRefusalText(unavailable(failure), "#help", "saved");
    expect(saved).toMatch(/, so nothing was saved\.$/);
    expect(saved.replace(/saved\.$/, "sent.")).toBe(slackRefusalText(unavailable(failure), "#help"));
  });

  it("end to end: remember says saved, a send says sent", async () => {
    const remembered = harness({ kind: "tool", name: "remember", input: { subject: "team", value: "#help" } }, {
      failOn: { 0: "network" },
    });
    await remembered.planner.run("remember the team is #help");
    expect(remembered.shell.results).toEqual(["I couldn't reach Slack to check the channel, so nothing was saved."]);
    // Refused in `prepare` (M33 moved the check there): before any tier or dialog.
    expect(remembered.shell.confirmMessages).toEqual([]);

    const sent = harness({ kind: "tool", name: "sendMessage", input: { channel: "#help" } }, { failOn: { 0: "network" } });
    await sent.planner.run("send these to #help");
    expect(sent.shell.results).toEqual(["I couldn't reach Slack to check the channel, so nothing was sent."]);
  });
});

// THE GUARD. In bot mode the only things that may end in "?" are the app's OWN questions (asked
// through askUser, which waits for the answer) and the dialog titles ("Send to #help?"), which the
// dialog itself answers. Every result, refusal and status line is a statement.
describe("bot mode: nothing but a real question or a dialog title asks anything", () => {
  const send = (channel: string): ToolChoice => ({ kind: "tool", name: "sendMessage", input: { channel } });
  // RE-JUSTIFIED AT M34. Every scenario ran under "do it". From M34 a FIRST `remember` whose
  // subject the instruction never says is refused before Slack is asked (rule B), so the two
  // remember scenarios would have checked B's sentence instead of the Slack refusals they were
  // written for. They now say their subject, and each scenario states which refusal it reaches
  // (`reaches`); B's own refusal is a scenario of its own, under "do it".
  const scenarios: {
    choice: ToolChoice;
    options: HarnessOptions;
    instruction?: string;
    reaches?: "slack" | "rule B";
  }[] = [
    { choice: send("#bug"), options: {} },
    { choice: send("#help"), options: {} },
    { choice: send("#help"), options: { failOn: { 0: "rate_limited" } } },
    { choice: send("the hel channel"), options: {} },
    { choice: bugChain("#bug"), options: {} },
    { choice: bugChain("#help"), options: {} },
    { choice: bugChain("the help channel"), options: {} },
    { choice: bugChain("the bugs channel"), options: { asks: ["#bug", null] } },
    { choice: bugChain("the bugs channel"), options: { asks: ["#bug", "#bug-reports"] } },
    { choice: bugChain("the bugs channel"), options: { asks: ["#help"], failOn: { 3: "timeout" } } },
    { choice: plan([step("summarize", {}, "x"), step("sendMessage", { channel: "{step1}" }, "y")]), options: {} },
    {
      choice: { kind: "tool", name: "remember", input: { subject: "bugs channel", value: "#bug" } } as ToolChoice,
      options: {},
      instruction: "remember the bugs channel is #bug",
      reaches: "slack",
    },
    {
      choice: { kind: "tool", name: "remember", input: { subject: "team", value: "#help" } } as ToolChoice,
      options: { failOn: { 0: "auth" } },
      instruction: "remember the team is #help",
      reaches: "slack",
    },
    {
      choice: { kind: "tool", name: "remember", input: { subject: "team", value: "#help" } } as ToolChoice,
      options: {},
      reaches: "rule B",
    },
  ];

  it("across refusals, sends, asks and remember", async () => {
    let questions = 0;
    let dialogs = 0;
    for (const { choice, options, instruction, reaches } of scenarios) {
      const h = harness(choice, options);
      await h.planner.run(instruction ?? "do it");
      if (reaches === "slack") expect(h.directory.calls.length, instruction).toBeGreaterThan(0);
      if (reaches === "rule B") {
        expect(h.shell.results).toEqual([UNNAMED_FACT]);
        expect(h.directory.calls).toEqual([]);
      }

      for (const text of [...h.shell.results, ...h.notified()]) {
        expect(text, text).not.toContain("?");
      }
      for (const dialog of h.shell.confirmMessages) {
        dialogs += 1;
        const [title, ...rest] = dialog.split("\n");
        expect(title, dialog).toMatch(/^(Step \d of \d: )?(Send to #[a-z0-9-]+\?|Create .*\?)$/);
        expect(rest.join("\n"), dialog).not.toContain("?");
      }
      for (const question of h.shell.questions) {
        questions += 1;
        // One question, and it is the one being asked: exactly one "?", at the end.
        expect(question.match(/\?/g)?.length, question).toBe(1);
        expect(question.endsWith("?"), question).toBe(true);
      }
    }
    // The check is only worth something if it saw real questions and dialogs.
    expect(questions).toBeGreaterThanOrEqual(4);
    expect(dialogs).toBeGreaterThanOrEqual(4);
  });
});
