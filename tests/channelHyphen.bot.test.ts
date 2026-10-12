import { describe, expect, it } from "vitest";
import { hyphenated, resolveSlackName } from "../src/core/tools/sendMessage.ts";
import type { ChannelDirectory, ChannelId, ChannelLookup, ToolChoice } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { CHANNELS, bugChain, harness } from "./botChainHarness.ts";

// M22 prompt 11, part C. Slack channel names cannot contain spaces, so people say "new channel"
// for #new-channel and "all wicky micky" for #all-wicky-micky. In bot mode a name Slack does not
// have is now also tried with spaces as hyphens — exactly, never a near match, nothing saved —
// and if the spellings lead to two DIFFERENT real channels, it is refused as ambiguous.

const WORKSPACE = [
  ...CHANNELS,
  { id: "C0000000011", name: "new-channel" },
  { id: "C0000000012", name: "all-wicky-micky" },
];
const NOTES = { selectedText: "the notes", activeApp: null, activeWindowTitle: null };
const send = (channel: string): ToolChoice => ({ kind: "tool", name: "sendMessage", input: { channel } });
const writes = (events: string[]) => events.filter((e) => e.startsWith("write:"));
const notFoundHead = (shown: string) => `I couldn't find a Slack channel called ${shown}.`;

describe("hyphenated", () => {
  it.each([
    ["new channel", "new-channel"],
    ["all  wicky\tmicky", "all-wicky-micky"],
    ["#new channel", "#new-channel"],
    ["  New Channel  ", "New-Channel"],
  ])("%j → %j", (input, output) => {
    expect(hyphenated(input)).toBe(output);
  });

  it.each(["help", "#help", "new-channel", "  social  "])("%j → null (no space to turn)", (input) => {
    expect(hyphenated(input)).toBeNull();
  });
});

describe("resolveSlackName: the order and the rules", () => {
  const channel = (id: string, name: string): ChannelLookup => ({
    ok: true,
    channel: { id: id as ChannelId, name, isPrivate: false },
  });
  const miss = (suggestions: string[] = []): ChannelLookup => ({ ok: false, reason: "not_found", suggestions });
  function scripted(answers: Record<string, ChannelLookup>): ChannelDirectory & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      resolve: (input: string) => {
        calls.push(input);
        return Promise.resolve(answers[input] ?? miss());
      },
    };
  }

  it("takes the name as typed when Slack has it, and tries nothing else", async () => {
    const directory = scripted({ "new channel": channel("C1", "new channel") });
    expect(await resolveSlackName(directory, "new channel")).toMatchObject({ ok: true, channel: { id: "C1" } });
    expect(directory.calls).toEqual(["new channel"]);
  });

  it("tries every other spelling, in order: no 'channel', hyphens, both", async () => {
    const directory = scripted({});
    await resolveSlackName(directory, "all wicky micky channel");
    expect(directory.calls).toEqual([
      "all wicky micky channel",
      "all wicky micky",
      "all-wicky-micky-channel",
      "all-wicky-micky",
    ]);
  });

  it("refuses as ambiguous when two spellings reach two different channels", async () => {
    const directory = scripted({ social: channel("C2", "social"), "social-channel": channel("C9", "social-channel") });
    expect(await resolveSlackName(directory, "social channel")).toEqual({
      ok: false,
      reason: "unavailable",
      failure: "ambiguous",
    });
  });

  it("is not ambiguous when two spellings reach the SAME channel", async () => {
    const same = channel("C7", "ops");
    const directory = scripted({ ops: same, "ops-channel": same });
    expect(await resolveSlackName(directory, "ops channel")).toMatchObject({ ok: true, channel: { id: "C7" } });
  });

  it("returns a spelling Slack could not answer — never a guess, even with another hit", async () => {
    const directory = scripted({
      social: channel("C2", "social"),
      "social-channel": { ok: false, reason: "unavailable", failure: "timeout" },
    });
    expect(await resolveSlackName(directory, "social channel")).toEqual({
      ok: false,
      reason: "unavailable",
      failure: "timeout",
    });
  });

  it("keeps the first not-found, with its own suggestions, when nothing matches", async () => {
    const directory = scripted({ "new chanel": miss(["new-channel"]), "new-chanel": miss(["other"]) });
    expect(await resolveSlackName(directory, "new chanel")).toEqual(miss(["new-channel"]));
  });
});

describe("bot mode: spaces as hyphens, end to end", () => {
  it.each([
    ["new channel", "#new-channel"],
    ["#new channel", "#new-channel"],
    ["all wicky micky", "#all-wicky-micky"],
    ["the new channel", "#new-channel"],
    ["the all wicky micky channel", "#all-wicky-micky"],
    ["social channel", "#social"],
  ])("a lone send to %j goes to %s, and nothing is saved", async (said, shown) => {
    const h = harness(send(said), { channels: WORKSPACE, context: NOTES });
    const outcome = await h.planner.run(`send these notes to ${said}`);
    expect(outcome.status).toBe("ok");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([`Send to ${shown}?\n\nFORMATTED`]);
    expect(h.sender.calls).toEqual([{ channel: shown, text: "FORMATTED" }]);
    expect(h.facts()).toEqual([]);
    expect(writes(h.events)).toEqual([]);
  });

  it("refuses 'social channel' as ambiguous when #social and #social-channel both exist", async () => {
    const h = harness(send("social channel"), {
      channels: [...WORKSPACE, { id: "C0000000013", name: "social-channel" }],
      context: NOTES,
    });
    const outcome = await h.planner.run("send these notes to social channel");
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual(["More than one Slack channel is called #social channel, so nothing was sent."]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.sender.calls).toEqual([]);
  });

  it.each([
    ["channel", "#channel"],
    ["new chanel", "#new chanel"],
    ["C0000000011", "#C0000000011"],
  ])("%j does not resolve", async (said, shown) => {
    const h = harness(send(said), { channels: WORKSPACE, context: NOTES });
    const outcome = await h.planner.run(`send these notes to ${said}`);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results[0]?.startsWith(notFoundHead(shown))).toBe(true);
    expect(h.sender.calls).toEqual([]);
    expect(writes(h.events)).toEqual([]);
  });

  it("a chain with 'new channel' passes the pre-flight and posts to #new-channel", async () => {
    const h = harness(bugChain("new channel"), { channels: WORKSPACE });
    const outcome = await h.planner.run("file this bug and tell new channel");
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#new-channel");
  });

  it("a chain with 'the new channel' finds it without asking, and saves nothing", async () => {
    const h = harness(bugChain("the new channel"), { channels: WORKSPACE });
    const outcome = await h.planner.run("file this bug and tell the new channel");
    expect(outcome.status).toBe("ok");
    expect(h.shell.questions).toEqual([]);
    expect(h.sender.calls[0]?.channel).toBe("#new-channel");
    expect(h.facts()).toEqual([]);
  });

  it("an answer of 'all wicky micky' to the question is saved as #all-wicky-micky", async () => {
    const h = harness(bugChain("the bugs channel"), { channels: WORKSPACE, asks: ["all wicky micky"] });
    const outcome = await h.planner.run("file this bug and tell the bugs channel");
    expect(outcome.status).toBe("ok");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#all-wicky-micky", active: 1 }]);
  });

  it("remember 'the bugs channel is new channel' stores #new-channel", async () => {
    const h = harness(
      { kind: "tool", name: "remember", input: { subject: "bugs channel", value: "new channel" } },
      { channels: WORKSPACE },
    );
    await h.planner.run("remember the bugs channel is new channel");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#new-channel", active: 1 }]);
  });
});

describe("webhook mode: no hyphen retry", () => {
  it.each(["none", "webhook"] as const)("mode %s: 'new channel' stays the M21 literal, Slack never asked", async (mode) => {
    const h = harness(send("new channel"), { mode, channels: WORKSPACE, context: NOTES, directory: false });
    const outcome = await h.planner.run("send these notes to new channel");
    expect(outcome.status).toBe("ok");
    expect(h.shell.confirmMessages[0]).toBe(
      "Send via your Slack webhook?\n(You asked for new channel. A webhook posts to its own channel and ignores this.)\n\nFORMATTED",
    );
    expect(h.sender.calls[0]?.channel).toBe("new channel");
    expect(h.directory.calls).toEqual([]);
  });

  it.each(["none", "webhook"] as const)("mode %s: remember 'new channel' is stored as typed", async (mode) => {
    const h = harness(
      { kind: "tool", name: "remember", input: { subject: "bugs channel", value: "new channel" } },
      { mode, channels: WORKSPACE },
    );
    await h.planner.run("remember the bugs channel is new channel");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "new channel", active: 1 }]);
    expect(h.directory.calls).toEqual([]);
  });
});

describe("the fake agrees: FakeChannelDirectory matches names exactly", () => {
  it("does not itself treat 'new channel' as #new-channel — the retry is the resolver's", async () => {
    const fake = new FakeChannelDirectory({ channels: WORKSPACE });
    expect(await fake.resolve("new channel")).toMatchObject({ ok: false, reason: "not_found" });
  });
});
