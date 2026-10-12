import { describe, expect, it } from "vitest";
import type { ToolChoice } from "../src/core/types.ts";
import { bugChain, harness } from "./botChainHarness.ts";

// M22 prompt 5. "the help channel", unknown to memory, in bot mode: Slack is asked ONCE for a
// channel called exactly "help" (a leading the/my/our and a trailing "channel" dropped). Found: it
// is used — the dialog still names it — and NOTHING is saved. Not found: exactly what M21 did (the
// lone send's "teach me" refusal, the chain's question). Memory always answers first.

const send = (channel: string): ToolChoice => ({ kind: "tool", name: "sendMessage", input: { channel } });
const NOTES_CONTEXT = { selectedText: "the notes", activeApp: null, activeWindowTitle: null };
const QUESTION = (said: string) => `Before I start: which channel do you mean by '${said}'?`;

describe("'the help channel' on a lone send", () => {
  it("is Slack's #help when memory does not know it — and nothing is saved", async () => {
    const h = harness(send("the help channel"), { context: NOTES_CONTEXT });
    const outcome = await h.planner.run("send these to the help channel");

    expect(outcome.status).toBe("ok");
    expect(h.shell.confirmMessages).toEqual(["Send to #help?\n\nFORMATTED"]);
    expect(h.sender.calls).toEqual([{ channel: "#help", text: "FORMATTED" }]);
    expect(h.facts()).toEqual([]);
    expect(h.events.filter((e) => e.startsWith("write:"))).toEqual([]);
    expect(h.directory.calls.slice(0, 2)).toEqual(["help channel", "help"]);
  });

  it.each(["my help channel", "The Help Channel", "the help"])("also for %j", async (said) => {
    const h = harness(send(said), { context: NOTES_CONTEXT });
    const outcome = await h.planner.run(`send these to ${said}`);
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#help");
  });

  it("keeps the M21 refusal when Slack has no exact match", async () => {
    const h = harness(send("the unknown channel"), { context: NOTES_CONTEXT });
    const outcome = await h.planner.run("send these to the unknown channel");
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([
      'I don\'t know which channel "the unknown channel" means — teach me with: remember the unknown channel is #your-channel.',
    ]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.llm.completeCalls).toBe(0);
  });

  it("never auto-resolves a NEAR match: 'the hepl channel' is not #help", async () => {
    const h = harness(send("the hepl channel"), { context: NOTES_CONTEXT });
    const outcome = await h.planner.run("send these to the hepl channel");
    expect(outcome.status).toBe("refused");
    expect(h.sender.calls).toEqual([]);
    expect(h.shell.results[0]).toContain("teach me with");
  });

  // Mutation run, M22 prompt 5: "take the first suggestion" survived the 'hepl' test above,
  // because the fake suggests only names that start with or contain the input — 'hepl' gets no
  // suggestion to take. 'hel' does get one (#help), so this is the case that can tell.
  it("never takes a SUGGESTION as the channel: 'the hel channel' is refused, not #help", async () => {
    const h = harness(send("the hel channel"), { context: NOTES_CONTEXT });
    const outcome = await h.planner.run("send these to the hel channel");
    expect(outcome.status).toBe("refused");
    expect(h.sender.calls).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.shell.results[0]).toContain("teach me with");
  });

  it("lets memory win: a saved 'help channel' beats Slack's #help", async () => {
    const h = harness(send("the help channel"), { context: NOTES_CONTEXT, facts: { "help channel": "#social" } });
    await h.planner.run("send these to the help channel");
    expect(h.shell.confirmMessages).toEqual(["Send to #social?\n\nFORMATTED"]);
    expect(h.sender.calls[0]?.channel).toBe("#social");
    expect(h.directory.calls).not.toContain("help");
  });
});

describe("'the help channel' in a chain", () => {
  it("is found without asking, runs, and saves nothing", async () => {
    const h = harness(bugChain("the help channel"));
    const outcome = await h.planner.run("file this bug and tell the help channel");

    expect(outcome.status).toBe("ok");
    expect(h.shell.questions).toEqual([]);
    expect(h.sender.calls[0]?.channel).toBe("#help");
    expect(h.facts()).toEqual([]);
    expect(h.notified().some((line) => line.startsWith("Saved:"))).toBe(false);
  });

  it("is ASKED about when Slack has no exact match, as in M21", async () => {
    const h = harness(bugChain("the bugs channel"), { asks: [null] });
    const outcome = await h.planner.run("file this bug and tell the bugs channel");
    expect(h.shell.questions).toEqual([QUESTION("the bugs channel")]);
    expect(outcome.status).toBe("refused");
    h.nothingRan();
  });

  it("never auto-resolves a near match in a chain either: it asks", async () => {
    const h = harness(bugChain("the hepl channel"), { asks: [null] });
    await h.planner.run("file this bug and tell the hepl channel");
    expect(h.shell.questions).toEqual([QUESTION("the hepl channel")]);
    h.nothingRan();
  });

  it("never takes a SUGGESTION as the channel in a chain: 'the hel channel' is asked about", async () => {
    const h = harness(bugChain("the hel channel"), { asks: [null] });
    await h.planner.run("file this bug and tell the hel channel");
    expect(h.shell.questions).toEqual([QUESTION("the hel channel")]);
    h.nothingRan();
  });

  it("lets memory win in a chain too", async () => {
    const h = harness(bugChain("the help channel"), { facts: { "help channel": "#engineering" } });
    const outcome = await h.planner.run("file this bug and tell the help channel");
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#engineering");
    expect(h.directory.calls).not.toContain("help");
  });

  it("refuses the plan when Slack cannot be asked during the lookup — no guess, no question", async () => {
    const h = harness(bugChain("the help channel"), { failOn: { 0: "network" } });
    const outcome = await h.planner.run("file this bug and tell the help channel");
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toBe("I couldn't reach Slack to check the channel, so nothing was sent.");
    expect(h.shell.questions).toEqual([]);
    h.nothingRan();
  });
});
