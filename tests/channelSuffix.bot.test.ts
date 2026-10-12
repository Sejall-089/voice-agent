import { describe, expect, it } from "vitest";
import { resolveSlackName, withoutChannelSuffix } from "../src/core/tools/sendMessage.ts";
import type { ChannelDirectory, ChannelLookup, ToolChoice } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { CHANNELS, bugChain, harness, notFound } from "./botChainHarness.ts";

// M22 prompt 7, live finding (b): "social channel", "#social channel" and "fun channel" were looked
// up as channel NAMES and refused. In bot mode a name Slack does not have is now tried ONCE more
// with a trailing word "channel" dropped — exactly, never a near match, and never saved.

const WITH_FUN = [...CHANNELS, { id: "C0000000009", name: "fun" }];
const NOTES = { selectedText: "the notes", activeApp: null, activeWindowTitle: null };
const send = (channel: string): ToolChoice => ({ kind: "tool", name: "sendMessage", input: { channel } });

describe("withoutChannelSuffix", () => {
  it.each([
    ["social channel", "social"],
    ["#social channel", "#social"],
    ["Social Channel", "Social"],
    ["  fun   CHANNEL ", "fun"],
    ["dev ops channel", "dev ops"],
  ])("%j → %j", (input, output) => {
    expect(withoutChannelSuffix(input)).toBe(output);
  });

  it.each(["channel", "#channel", " channel ", "social", "#social", "social chanel", "socialchannel", "channels"])(
    "%j → null (nothing to retry)",
    (input) => {
      expect(withoutChannelSuffix(input)).toBeNull();
    },
  );
});

describe("resolveSlackName", () => {
  // A directory that answers from a script, one entry per call, recording what it was asked.
  function scripted(answers: ChannelLookup[]): ChannelDirectory & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      resolve: (input: string) => {
        calls.push(input);
        return Promise.resolve(answers.shift() ?? { ok: false, reason: "not_found", suggestions: [] });
      },
    };
  }

  it("does not retry a name Slack has", async () => {
    const directory = new FakeChannelDirectory({ channels: WITH_FUN, delayMs: 5 });
    expect(await resolveSlackName(directory, "#social")).toMatchObject({ ok: true });
    expect(directory.calls).toEqual(["#social"]);
  });

  it("does not retry when Slack could not be asked", async () => {
    const directory = scripted([{ ok: false, reason: "unavailable", failure: "network" }]);
    expect(await resolveSlackName(directory, "social channel")).toEqual({
      ok: false,
      reason: "unavailable",
      failure: "network",
    });
    expect(directory.calls).toEqual(["social channel"]);
  });

  it("keeps the FIRST not-found, with its suggestions, when the retry misses too", async () => {
    const directory = scripted([
      { ok: false, reason: "not_found", suggestions: ["for-the-typed-name"] },
      { ok: false, reason: "not_found", suggestions: ["for-the-retry"] },
    ]);
    expect(await resolveSlackName(directory, "nope channel")).toEqual({
      ok: false,
      reason: "not_found",
      suggestions: ["for-the-typed-name"],
    });
    expect(directory.calls).toEqual(["nope channel", "nope", "nope-channel"]);
  });

  it("reports a retry Slack could not answer as unavailable — never a guess", async () => {
    const directory = scripted([
      { ok: false, reason: "not_found", suggestions: [] },
      { ok: false, reason: "unavailable", failure: "timeout" },
    ]);
    expect(await resolveSlackName(directory, "social channel")).toEqual({
      ok: false,
      reason: "unavailable",
      failure: "timeout",
    });
  });
});

describe("bot mode: 'X channel' is the channel X", () => {
  it.each([
    ["social channel", "#social"],
    ["#social channel", "#social"],
    ["Social Channel", "#social"],
    ["fun channel", "#fun"],
  ])("a lone send to %j goes to %s, and nothing is saved", async (said, shown) => {
    const h = harness(send(said), { channels: WITH_FUN, context: NOTES });
    const outcome = await h.planner.run(`send these notes to ${said}`);
    expect(outcome.status).toBe("ok");
    expect(h.shell.confirmMessages).toEqual([`Send to ${shown}?\n\nFORMATTED`]);
    expect(h.sender.calls[0]?.channel).toBe(shown);
    expect(h.facts()).toEqual([]);
    expect(h.events.filter((e) => e.startsWith("write:"))).toEqual([]);
  });

  it.each([
    ["channel", "#channel"],
    ["social chanel", "#social chanel"],
  ])("%j is not a channel: refused, never corrected", async (said, shown) => {
    const h = harness(send(said), { channels: WITH_FUN, context: NOTES });
    const outcome = await h.planner.run(`send these notes to ${said}`);
    expect(outcome.status).toBe("refused");
    expect(h.sender.calls).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.shell.results[0]).toContain(`I couldn't find a Slack channel called ${shown}.`);
  });

  it("a chain with 'social channel' passes the pre-flight and posts to #social", async () => {
    const h = harness(bugChain("social channel"), { channels: WITH_FUN });
    const outcome = await h.planner.run("file this bug and tell social channel");
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#social");
  });

  it("remember 'the bugs channel is fun channel' stores #fun", async () => {
    const h = harness(
      { kind: "tool", name: "remember", input: { subject: "bugs channel", value: "fun channel" } },
      { channels: WITH_FUN },
    );
    await h.planner.run("remember the bugs channel is fun channel");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#fun", active: 1 }]);
    expect(h.shell.results).toEqual(["Remembered: bugs channel = #fun"]);
  });

  it("an answer of 'fun channel' to the question is saved as #fun", async () => {
    const h = harness(bugChain("the bugs channel"), { channels: WITH_FUN, asks: ["fun channel"] });
    const outcome = await h.planner.run("file this bug and tell the bugs channel");
    expect(outcome.status).toBe("ok");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#fun", active: 1 }]);
    expect(h.sender.calls[0]?.channel).toBe("#fun");
  });

  it("a miss keeps the suggestions for what was typed", async () => {
    const h = harness(send("hel channel"), { channels: WITH_FUN, context: NOTES });
    await h.planner.run("send these notes to hel channel");
    // "hel channel" has no suggestions in the fake; the retry "hel" would have had #help — and
    // the first answer stands.
    expect(h.shell.results).toEqual([notFound("#hel channel")]);
  });
});

describe("webhook mode: no suffix retry", () => {
  it.each(["none", "webhook"] as const)("mode %s: 'social channel' is the M21 literal, Slack never asked", async (mode) => {
    const h = harness(send("social channel"), { mode, channels: WITH_FUN, context: NOTES, directory: false });
    const outcome = await h.planner.run("send these notes to social channel");
    expect(outcome.status).toBe("ok");
    expect(h.shell.confirmMessages[0]).toBe(
      "Send via your Slack webhook?\n(You asked for social channel. A webhook posts to its own channel and ignores this.)\n\nFORMATTED",
    );
    expect(h.directory.calls).toEqual([]);
  });

  it.each(["none", "webhook"] as const)("mode %s: remember 'fun channel' is stored as typed", async (mode) => {
    const h = harness(
      { kind: "tool", name: "remember", input: { subject: "bugs channel", value: "fun channel" } },
      { mode, channels: WITH_FUN },
    );
    await h.planner.run("remember the bugs channel is fun channel");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "fun channel", active: 1 }]);
    expect(h.directory.calls).toEqual([]);
  });
});
