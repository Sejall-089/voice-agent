import { describe, expect, it } from "vitest";
import { bugChain, harness, plan, step } from "./botChainHarness.ts";

// M22 prompt 5. Outside bot mode NONE of prompt 5 runs: no pre-flight check of the channel, no
// Slack lookup of "the … channel", no Slack check of an answer, no Slack check in `remember`. A
// directory IS handed to the planner in every test here, to show it is never consulted — the
// sender's mode decides. (One documented prompt 4 exception: a LONE send's `prepare` is not given
// the sender and reads the directory's presence; main.ts never passes one in webhook mode. That
// case is pinned in tests/sendMessage.webhookMode.test.ts and is not exercised here.)
//
// Texts are M21's, character for character (tests/planner.ask.test.ts holds the originals).

const QUESTION = "Before I start: which channel do you mean by 'the bugs channel'?";
const M21_DIALOG_HEAD =
  "Step 3 of 3: Send via your Slack webhook?\n(You asked for #typo. A webhook posts to its own channel and ignores this.)\n\n";

describe.each(["none", "webhook"] as const)("sender mode %s", (mode) => {
  it("asks for an unknown channel and saves the answer AS TYPED, without asking Slack", async () => {
    const h = harness(bugChain("the bugs channel"), { mode, asks: ["#typo"] });
    const outcome = await h.planner.run("file this bug and tell the bugs channel");

    expect(outcome.status).toBe("ok");
    expect(h.shell.questions).toEqual([QUESTION]);
    expect(h.notified()[0]).toBe("Saved: the bugs channel = #typo");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#typo", active: 1 }]);
    expect(h.shell.confirmMessages[1]?.startsWith(M21_DIALOG_HEAD)).toBe(true);
    expect(h.directory.calls).toEqual([]);
  });

  it("asks about 'the help channel' instead of looking it up in Slack", async () => {
    const h = harness(bugChain("the help channel"), { mode, asks: [null] });
    await h.planner.run("file this bug and tell the help channel");
    expect(h.shell.questions).toEqual(["Before I start: which channel do you mean by 'the help channel'?"]);
    expect(h.directory.calls).toEqual([]);
  });

  it("does not check a literal channel before step 1: the chain runs as in M21", async () => {
    const h = harness(bugChain("#nope"), { mode });
    const outcome = await h.planner.run("file this bug and tell #nope");
    expect(outcome.status).toBe("ok");
    expect(h.github.created).toHaveLength(1);
    expect(h.sender.calls[0]?.channel).toBe("#nope");
    expect(h.directory.calls).toEqual([]);
  });

  it("does not refuse a channel from an earlier step before step 1", async () => {
    const h = harness(
      plan([step("summarize", {}, "work out where"), step("sendMessage", { channel: "{step1}", notes: "fyi" }, "send")]),
      { mode, completion: "#ops", context: { selectedText: "notes", activeApp: null, activeWindowTitle: null } },
    );
    const outcome = await h.planner.run("work out where and send it");
    // M21: step 1 runs, and the step-time channel check takes it from there.
    expect(outcome.chain?.completed).toBeGreaterThanOrEqual(1);
    expect(outcome.result).not.toContain("name the Slack channel yourself");
    expect(h.directory.calls).toEqual([]);
  });

  it("remembers a channel fact as typed", async () => {
    const h = harness({ kind: "tool", name: "remember", input: { subject: "team", value: "#Nope" } }, { mode });
    await h.planner.run("remember the team is #Nope");
    expect(h.shell.results).toEqual(["Remembered: team = #Nope"]);
    expect(h.directory.calls).toEqual([]);
  });
});
