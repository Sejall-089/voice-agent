import { describe, expect, it } from "vitest";
import { SlackChannelDirectory } from "../src/core/senders/SlackChannelDirectory.ts";
import { fakeSlackFetch, pagesOf, slackChannel, type SlackStep } from "./fakeSlackFetch.ts";

// M22 prompt 7, live finding (c): a channel created seconds ago was refused until the 30 s
// miss-refresh gap had passed. A miss may now take ONE extra refresh inside that gap — at least
// 5 s after the last attempt, and at most one extra per 30 s — so misses cost at most two list
// fetches per 30 s however fast they come, and a miss right after a fill never costs a second.

const TOKEN = "xoxb-test-SECRET-7777";
const BASE = [slackChannel("C0000000001", "help"), slackChannel("C0000000002", "social")];
const WITH_NEW = [...BASE, slackChannel("C0000000077", "brand-new")];

function setup(steps: SlackStep[]) {
  const clock = { t: 0 };
  const slack = fakeSlackFetch(steps);
  const directory = new SlackChannelDirectory({ token: TOKEN, fetchFn: slack.fetchFn, now: () => clock.t });
  return { directory, slack, clock };
}

// Enough pages that running out of script can never be what a test observes.
const plenty = (channels: unknown[], times = 12): SlackStep[] =>
  Array.from({ length: times }, () => pagesOf(channels)).flat();

describe("the extra refresh on a miss", () => {
  it("finds a channel created after the last fetch, on a miss 6 s later", async () => {
    const { directory, slack, clock } = setup([...pagesOf(BASE), ...pagesOf(WITH_NEW)]);
    await directory.resolve("help");
    clock.t = 6_000;
    const lookup = await directory.resolve("#brand-new");
    expect(lookup).toMatchObject({ ok: true, channel: { id: "C0000000077" } });
    expect(slack.requests).toHaveLength(2);
  });

  it("does not refresh on a miss within 5 s of the last fetch", async () => {
    const { directory, slack, clock } = setup(plenty(WITH_NEW));
    await directory.resolve("help");
    clock.t = 2_000;
    expect(await directory.resolve("nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(slack.requests).toHaveLength(1);
  });

  it("allows only ONE extra inside the 30 s gap", async () => {
    const { directory, slack, clock } = setup(plenty(BASE));
    await directory.resolve("help"); // fill at 0
    clock.t = 6_000;
    await directory.resolve("nope"); // the extra
    expect(slack.requests).toHaveLength(2);
    clock.t = 9_000; // 3 s after it: within 5 s
    await directory.resolve("nope");
    clock.t = 20_000; // 14 s after it, but the extra is used up until 36 s
    await directory.resolve("nope");
    expect(slack.requests).toHaveLength(2);
    clock.t = 36_000; // 30 s after the last attempt: the normal rule
    await directory.resolve("nope");
    expect(slack.requests).toHaveLength(3);
  });

  it("bounds a storm of misses: at most two fetches in any 30 s", async () => {
    const { directory, slack, clock } = setup(plenty(BASE, 40));
    await directory.resolve("help");
    const at: number[] = [0];
    for (let t = 500; t <= 120_000; t += 500) {
      clock.t = t;
      const before = slack.requests.length;
      await directory.resolve(`typo-${t}`);
      if (slack.requests.length > before) at.push(t);
    }
    for (const start of at) {
      expect(at.filter((t) => t >= start && t < start + 30_000).length, `window from ${start}`).toBeLessThanOrEqual(2);
    }
    // Fill, then extra 5 s later, then the normal rule every 30 s with an extra 5 s after each.
    expect(at).toEqual([0, 5_000, 35_000, 40_000, 70_000, 75_000, 105_000, 110_000]);
  });

  it("shares one request between concurrent misses that both qualify", async () => {
    const { directory, slack, clock } = setup([...pagesOf(BASE), ...pagesOf(WITH_NEW), ...pagesOf(WITH_NEW)]);
    await directory.resolve("help");
    clock.t = 6_000;
    const answers = await Promise.all([directory.resolve("brand-new"), directory.resolve("brand-new"), directory.resolve("nope")]);
    expect(answers.map((a) => a.ok)).toEqual([true, true, false]);
    expect(slack.requests).toHaveLength(2);
  });

  it("reports a failed extra refresh as unavailable, with nothing it should not say", async () => {
    const { directory, clock } = setup([...pagesOf(BASE), { kind: "throw" }]);
    await directory.resolve("help");
    clock.t = 6_000;
    const lookup = await directory.resolve("brand-new");
    expect(lookup).toEqual({ ok: false, reason: "unavailable", failure: "network" });
    const said = JSON.stringify(lookup);
    for (const forbidden of [TOKEN, "Bearer", "slack.com", "ECONNREFUSED"]) expect(said).not.toContain(forbidden);
  });

  it("can be set: an extra gap of 30 s is the prompt 6 behaviour", async () => {
    const clock = { t: 0 };
    const slack = fakeSlackFetch(plenty(BASE));
    const directory = new SlackChannelDirectory({
      token: TOKEN,
      fetchFn: slack.fetchFn,
      now: () => clock.t,
      extraRefreshMinGapMs: 30_000,
    });
    await directory.resolve("help");
    clock.t = 6_000;
    await directory.resolve("nope");
    expect(slack.requests).toHaveLength(1);
  });
});
