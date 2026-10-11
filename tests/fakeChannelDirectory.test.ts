import { describe, expect, it } from "vitest";
import { SlackChannelDirectory } from "../src/core/senders/SlackChannelDirectory.ts";
import type { ChannelLookup } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { fakeSlackFetch, pagesOf, slackChannel } from "./fakeSlackFetch.ts";

// The fake's matching is written independently of the real class (tests/FakeChannelDirectory.ts).
// This is what keeps the two honest: the same channels, the same inputs, the same answers. If
// either one's rule drifts — a fake grown lenient, a real one grown strict — a case here fails.

const CHANNELS = [
  { id: "C0000000001", name: "help" },
  { id: "C0000000002", name: "social" },
  { id: "C0000000003", name: "helpdesk" },
  { id: "C0000000004", name: "leads", isPrivate: true },
];

const DUPLICATED = [
  { id: "C1", name: "help" },
  { id: "C2", name: "Help" },
  { id: "C3", name: "social" },
];

// Resolution only — ok, the ID, and the reason. Suggestions are deliberately simpler in the fake.
function shape(lookup: ChannelLookup): unknown {
  if (lookup.ok) return { ok: true, id: lookup.channel.id, name: lookup.channel.name, isPrivate: lookup.channel.isPrivate };
  return lookup.reason === "unavailable" ? { ok: false, failure: lookup.failure } : { ok: false, reason: lookup.reason };
}

function real(channels: { id: string; name: string; isPrivate?: boolean }[]): SlackChannelDirectory {
  const slack = fakeSlackFetch(
    pagesOf(channels.map((c) => slackChannel(c.id, c.name, { is_private: c.isPrivate ?? false }))),
  );
  return new SlackChannelDirectory({ token: "xoxb-test", fetchFn: slack.fetchFn, now: () => 0 });
}

const INPUTS = [
  "#help",
  "help",
  "HELP",
  " #Help ",
  "#leads",
  "C0000000001",
  "#C0000000001",
  "nonexistent",
  "##help",
  "",
  "   ",
  "#",
];

describe("FakeChannelDirectory agrees with SlackChannelDirectory", () => {
  it.each(INPUTS)("on %j", async (input) => {
    const fake = new FakeChannelDirectory({ channels: CHANNELS });
    expect(shape(await fake.resolve(input))).toEqual(shape(await real(CHANNELS).resolve(input)));
  });

  it.each(["help", "Help", "social"])("on %j when two channels share a name", async (input) => {
    const fake = new FakeChannelDirectory({ channels: DUPLICATED });
    expect(shape(await fake.resolve(input))).toEqual(shape(await real(DUPLICATED).resolve(input)));
  });
});

describe("FakeChannelDirectory itself", () => {
  it("answers on a later tick, never synchronously", async () => {
    const fake = new FakeChannelDirectory({ channels: CHANNELS });
    let settled = false;
    const pending = fake.resolve("help").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await pending;
    expect(settled).toBe(true);
  });

  it("records every input exactly as given", async () => {
    const fake = new FakeChannelDirectory({ channels: CHANNELS });
    await fake.resolve(" #Help ");
    await fake.resolve("nope");
    expect(fake.calls).toEqual([" #Help ", "nope"]);
  });

  it("plays scripted failures in order, then answers from the list — and never rejects", async () => {
    const fake = new FakeChannelDirectory({ channels: CHANNELS, unavailable: ["network", "auth"] });
    await expect(fake.resolve("help")).resolves.toEqual({ ok: false, reason: "unavailable", failure: "network" });
    await expect(fake.resolve("help")).resolves.toEqual({ ok: false, reason: "unavailable", failure: "auth" });
    expect(shape(await fake.resolve("help"))).toEqual({ ok: true, id: "C0000000001", name: "help", isPrivate: false });
  });

  it("suggests names that start with, then contain, the input — at most three", async () => {
    const fake = new FakeChannelDirectory({ channels: CHANNELS });
    expect(await fake.resolve("hel")).toEqual({ ok: false, reason: "not_found", suggestions: ["help", "helpdesk"] });
    expect(await fake.resolve("h")).toEqual({ ok: false, reason: "not_found", suggestions: [] });
  });
});
