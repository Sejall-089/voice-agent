import { describe, expect, it } from "vitest";
import type { DirectoryFailure } from "../src/core/types.ts";
import { STEP_CHANNEL, UNAVAILABLE, bugChain, harness, notFound, plan, step } from "./botChainHarness.ts";

// M22 prompt 5. In bot mode a chain's pre-flight checks the send step's channel AS THE PLAN WROTE
// IT, before step 1: a channel Slack does not have, a Slack that cannot be asked, or a channel
// that would come from an earlier step's result refuses the WHOLE plan — no email read, no issue
// created, no dialog. This is what replaced prompt 4's interim refusal of every chained send.

const INSTRUCTION = "file this bug on GitHub and tell the channel";

describe("bot-mode pre-flight: a channel Slack does not have refuses the plan before step 1", () => {
  it("a literal channel: nothing runs, and the refusal says what Slack does have", async () => {
    const h = harness(bugChain("#bug"));
    const outcome = await h.planner.run(INSTRUCTION);

    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 3 });
    expect(outcome.result).toBe(notFound("#bug", " Similar channels: #bug-reports."));
    h.nothingRan();
    expect(h.shell.questions).toEqual([]);
    expect(h.directory.calls).toEqual(["#bug"]);
  });

  it("creates NO issue when the channel is bad — the orphaned-issue case", async () => {
    const h = harness(bugChain("#nope"));
    await h.planner.run(INSTRUCTION);
    expect(h.github.created).toEqual([]);
    expect(h.github.calls).toEqual([]);
  });

  it.each(Object.keys(UNAVAILABLE) as DirectoryFailure[])(
    "Slack unavailable (%s): nothing runs, and nothing is guessed",
    async (failure) => {
      const h = harness(bugChain("#help"), { failOn: { 0: failure } });
      const outcome = await h.planner.run(INSTRUCTION);
      expect(outcome.status).toBe("refused");
      expect(outcome.chain).toEqual({ completed: 0, total: 3 });
      expect(outcome.result).toBe(UNAVAILABLE[failure]);
      h.nothingRan();
    },
  );

  it("a remembered channel Slack no longer has: refused with suggestions, and NOT forgotten", async () => {
    const h = harness(bugChain("the bugs channel"), { facts: { "bugs channel": "#bug" } });
    const before = h.facts();
    const outcome = await h.planner.run(INSTRUCTION);

    expect(outcome.status).toBe("refused");
    expect(outcome.result).toBe(notFound("#bug", " Similar channels: #bug-reports."));
    h.nothingRan();
    expect(h.facts()).toEqual(before);
    expect(h.events.filter((e) => e.startsWith("write:"))).toEqual([]);
    // Memory answered first; Slack was asked about memory's answer, not the phrase.
    expect(h.directory.calls).toEqual(["#bug"]);
  });

  it("a bot sender with no directory refuses the plan before step 1 (fails closed)", async () => {
    const h = harness(bugChain("#help"), { directory: false });
    const outcome = await h.planner.run(INSTRUCTION);
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toBe("I couldn't check Slack channels, so nothing was sent.");
    h.nothingRan();
  });
});

describe("bot-mode pre-flight: a channel from an earlier step is never used", () => {
  it("refuses {stepN} as the channel before step 1, without asking Slack", async () => {
    const h = harness(
      plan([
        step("readEmail", {}, "read the email"),
        step("sendMessage", { channel: "{step1}", notes: "fyi" }, "tell whoever it says"),
      ]),
    );
    const outcome = await h.planner.run("tell the channel the email names");

    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 2 });
    expect(outcome.result).toBe(STEP_CHANNEL);
    h.nothingRan();
    expect(h.directory.calls).toEqual([]);
  });

  it("refuses it even when the step's result would be a real channel", async () => {
    // summarize's result is the completion: "help", a channel Slack has.
    const h = harness(
      plan([
        step("summarize", {}, "work out where"),
        step("sendMessage", { channel: "{step1}", notes: "fyi" }, "send it there"),
      ]),
      { completion: "help", context: { selectedText: "notes", activeApp: null, activeWindowTitle: null } },
    );
    const outcome = await h.planner.run("work out where and send it");
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toBe(STEP_CHANNEL);
    expect(h.llm.completeCalls).toBe(0);
    h.nothingRan();
  });

  it("refuses a channel with a placeholder anywhere in it", async () => {
    const h = harness(
      plan([
        step("summarize", {}, "work out where"),
        step("sendMessage", { channel: "#team-{step1}", notes: "fyi" }, "send it there"),
      ]),
    );
    const outcome = await h.planner.run("send it");
    expect(outcome.result).toBe(STEP_CHANNEL);
    h.nothingRan();
  });

  it("still allows {stepN} in the MESSAGE — only the channel is refused", async () => {
    const h = harness(bugChain("#help"));
    const outcome = await h.planner.run(INSTRUCTION);
    expect(outcome.status).toBe("ok");
  });
});

describe("bot-mode pre-flight: a channel Slack has lets the chain run end to end", () => {
  it("a literal channel: reads the email, creates the issue, sends to Slack's name for it", async () => {
    const h = harness(bugChain("HELP"));
    const outcome = await h.planner.run(INSTRUCTION);

    expect(outcome.status).toBe("ok");
    expect(outcome.chain).toEqual({ completed: 3, total: 3 });
    expect(h.github.created).toHaveLength(1);
    expect(h.sender.calls).toHaveLength(1);
    expect(h.sender.calls[0]?.channel).toBe("#help");
    expect(h.shell.confirmMessages).toHaveLength(2);
    expect(h.shell.confirmMessages[1]?.startsWith("Step 3 of 3: Send to #help?\n\nNew bug filed: ")).toBe(true);
    expect(h.shell.questions).toEqual([]);
  });

  it("a remembered channel Slack has: runs, and sends to memory's channel", async () => {
    const h = harness(bugChain("the bugs channel"), { facts: { "bugs channel": "#bug-reports" } });
    const outcome = await h.planner.run(INSTRUCTION);
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#bug-reports");
    expect(h.shell.questions).toEqual([]);
  });
});

describe("bot mode — no new text mentions a webhook", () => {
  it("across pre-flight refusals, asks, sends and remember", async () => {
    const runs = [
      harness(bugChain("#bug")),
      harness(bugChain("#help"), { failOn: { 0: "network" } }),
      harness(plan([step("summarize", {}, "x"), step("sendMessage", { channel: "{step1}" }, "y")])),
      harness(bugChain("#help")),
      harness(bugChain("the help channel")),
      harness(bugChain("the bugs channel"), { asks: ["#bug", "#bug-reports"] }),
      harness(bugChain("the bugs channel"), { asks: ["#help"], failOn: { 3: "timeout" } }),
      harness({ kind: "tool", name: "remember", input: { subject: "bugs channel", value: "#nope" } }),
      harness({ kind: "tool", name: "remember", input: { subject: "team", value: "#help" } }),
    ];
    // RE-JUSTIFIED AT M34. INSTRUCTION ("file this bug on GitHub and tell the channel") names
    // neither "bugs channel" nor "team", so from M34 both remember runs are first writes rule B
    // refuses before Slack is asked — and this sweep would no longer see remember's Slack texts.
    // They now say their subject, so one is refused by Slack (#nope) and one is saved (#help).
    const instructions = new Map([
      [runs[7], "remember the bugs channel is #nope"],
      [runs[8], "remember the team is #help"],
    ]);
    const texts: string[] = [];
    for (const h of runs) {
      await h.planner.run(instructions.get(h) ?? INSTRUCTION);
      texts.push(...h.texts());
    }
    expect(runs[7]?.directory.calls).toEqual(["#nope"]);
    expect(runs[8]?.facts()).toEqual([{ subject: "team", value: "#help", active: 1 }]);
    expect(texts.length).toBeGreaterThan(runs.length);
    for (const text of texts) expect(text, text).not.toMatch(/webhook/i);
  });
});
