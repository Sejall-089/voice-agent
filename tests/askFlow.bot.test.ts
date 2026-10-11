import { describe, expect, it } from "vitest";
import type { DirectoryFailure } from "../src/core/types.ts";
import { UNAVAILABLE, bugChain, harness, notFound } from "./botChainHarness.ts";

// M22 prompt 5. "Which channel do you mean by 'the bugs channel'?" in bot mode: the answer must be
// a channel Slack has, and what is saved is Slack's own "#name" — checked BEFORE anything is saved.
// A name Slack does not have is asked about again, with what it does have, inside the same budget
// of two questions per chain. A Slack that cannot be asked refuses the plan and saves nothing.
//
// The harness has no channel called "bugs", so "the bugs channel" is never found by the lookup
// and is always asked about. Directory call 0 is that lookup; call 1 is the first answer's check.

const INSTRUCTION = "file this bug on GitHub and tell the bugs channel";
const QUESTION = "Before I start: which channel do you mean by 'the bugs channel'?";
const M21_RETRY = "I need the channel's own name, like #bugs. Which channel do you mean by 'the bugs channel'?";
const M21_REFUSAL =
  'Step 3 of my plan needs "the bugs channel", and I don\'t know what that refers to yet, so I ' +
  "didn't start it — teach me with: remember the bugs channel is <what it is>.";
const writes = (events: string[]) => events.filter((e) => e.startsWith("write:"));

describe("bot-mode ask flow: a valid answer", () => {
  it.each(["help", "#help", "HELP", " #Help "])("%j is saved as Slack's '#help' and used", async (answer) => {
    const h = harness(bugChain("the bugs channel"), { asks: [answer] });
    const outcome = await h.planner.run(INSTRUCTION);

    expect(outcome.status).toBe("ok");
    expect(h.shell.questions).toEqual([QUESTION]);
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
    expect(h.notified()[0]).toBe("Saved: the bugs channel = #help");
    expect(h.sender.calls[0]?.channel).toBe("#help");
    expect(h.github.created).toHaveLength(1);
  });

  it("checks the answer in Slack BEFORE anything is saved", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["#help"] });
    await h.planner.run(INSTRUCTION);
    const checked = h.events.indexOf("resolve:#help");
    const saved = h.events.indexOf("write:bugs channel=#help");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(saved).toBeGreaterThan(checked);
    // And nothing at all was written before that check.
    expect(writes(h.events.slice(0, checked))).toEqual([]);
  });
});

describe("bot-mode ask flow: an answer Slack does not have", () => {
  it("is asked about again with what Slack does have, then the corrected answer is saved", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["#bug", "#bug-reports"] });
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([
      QUESTION,
      `${notFound("#bug", " Did you mean #bug-reports?")} Which channel do you mean by 'the bugs channel'?`,
    ]);
    expect(outcome.status).toBe("ok");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#bug-reports", active: 1 }]);
    expect(writes(h.events)).toEqual(["write:bugs channel=#bug-reports"]);
  });

  it("gives up with the M21 refusal when the second answer is wrong too — the budget is two", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["#bug", "#nope", "#help"] });
    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toHaveLength(2);
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toBe(M21_REFUSAL);
    expect(h.facts()).toEqual([]);
    expect(writes(h.events)).toEqual([]);
    h.nothingRan();
  });

  it("never accepts a typed Slack ID", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["C0000000001", null] });
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.shell.questions[1]).toBe(
      `${notFound("#C0000000001")} Which channel do you mean by 'the bugs channel'?`,
    );
    expect(outcome.status).toBe("refused");
    expect(h.facts()).toEqual([]);
  });

  it("still asks again in the M21 words for an answer that is not a channel name at all", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["the team", "#help"] });
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.shell.questions).toEqual([QUESTION, M21_RETRY]);
    expect(outcome.status).toBe("ok");
    // "the team" was never put to Slack: it is not a name.
    expect(h.directory.calls).not.toContain("the team");
  });
});

describe("bot-mode ask flow: Slack cannot be asked", () => {
  it.each(["network", "timeout", "auth", "rate_limited", "slack_error"] as DirectoryFailure[])(
    "while checking the answer (%s): the plan is refused and nothing is saved",
    async (failure) => {
      const h = harness(bugChain("the bugs channel"), { asks: ["#help", "#help"], failOn: { 1: failure } });
      const outcome = await h.planner.run(INSTRUCTION);

      expect(h.shell.questions).toEqual([QUESTION]);
      expect(outcome.status).toBe("refused");
      expect(outcome.result).toBe(UNAVAILABLE[failure]);
      expect(h.facts()).toEqual([]);
      expect(writes(h.events)).toEqual([]);
      h.nothingRan();
    },
  );

  it("during the lookup, before any question: refused, nothing asked or saved", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: ["#help"], failOn: { 0: "network" } });
    const outcome = await h.planner.run(INSTRUCTION);
    expect(h.shell.questions).toEqual([]);
    expect(outcome.result).toBe(UNAVAILABLE.network);
    expect(h.facts()).toEqual([]);
  });
});
