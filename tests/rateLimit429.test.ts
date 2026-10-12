import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackChannelDirectory } from "../src/core/senders/SlackChannelDirectory.ts";
import { SEND_ERRORS, SlackBotSender } from "../src/core/senders/SlackBotSender.ts";
import type { ChannelLookup, SendResult } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { fakeSlackFetch, pagesOf, slackChannel, type SlackStep } from "./fakeSlackFetch.ts";

// M23-pre (M22 leftover): rate limits, hardened by tests. THE 429 SHAPES ARE FROM SLACK'S
// DOCUMENTATION, NOT CAPTURED LIVE — a real rate limit was never provoked, on purpose. What these
// pin is the app's side: whatever a 429 looks like (with or without Retry-After, an empty or
// non-JSON body, a Retry-After that is huge or not a number), the directory says `rate_limited`,
// the bot sender says `not_sent` "Slack is rate limiting. Try again shortly.", neither sleeps or
// retries on Retry-After, neither throws, and nothing leaks.

const TOKEN = "xoxb-test-RATE-SECRET-4290";
const FORBIDDEN = [TOKEN, "Bearer", "slack.com", "Retry-After", "retry-after"];
const RATE_LIMITED_DIR: ChannelLookup = { ok: false, reason: "unavailable", failure: "rate_limited" };
const RATE_LIMITED_SEND: SendResult = { ok: false, outcome: "not_sent", error: SEND_ERRORS.rateLimited };

afterEach(() => {
  vi.restoreAllMocks();
});

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

const SHAPES: { label: string; step: SlackStep }[] = [
  { label: "429 with no Retry-After and no body", step: { kind: "status", status: 429 } },
  { label: "429 with an empty body", step: { kind: "status", status: 429, body: "" } },
  {
    label: "429 with a non-JSON body",
    step: { kind: "status", status: 429, body: `<html>slow down ${TOKEN}</html>` },
  },
  {
    label: "429 with a JSON body that says ok:true (status wins)",
    step: { kind: "status", status: 429, body: JSON.stringify({ ok: true, channels: [] }) },
  },
  { label: "429 with Retry-After: 30", step: { kind: "status", status: 429, headers: { "retry-after": "30" } } },
  {
    label: "429 with a huge Retry-After",
    step: { kind: "status", status: 429, headers: { "retry-after": "99999999999" } },
  },
  {
    label: "429 with a Retry-After that is not a number",
    step: { kind: "status", status: 429, headers: { "retry-after": "soon" } },
  },
  {
    label: "429 with a negative Retry-After",
    step: { kind: "status", status: 429, headers: { "retry-after": "-5" } },
  },
  {
    label: "200 with ok:false error:ratelimited",
    step: { kind: "json", body: { ok: false, error: "ratelimited" } },
  },
  {
    label: "200 ok:false ratelimited, with the token in the body",
    step: { kind: "json", body: { ok: false, error: "ratelimited", detail: `Bearer ${TOKEN}` } },
  },
];

describe("SlackChannelDirectory on a rate limit", () => {
  it.each(SHAPES)("$label → unavailable/rate_limited, at once, one request", async ({ step }) => {
    const lines = captureConsole();
    const slack = fakeSlackFetch([step, ...pagesOf([slackChannel("C1", "help")])]);
    const directory = new SlackChannelDirectory({ token: TOKEN, fetchFn: slack.fetchFn, now: () => 0 });

    const started = Date.now();
    await expect(directory.resolve("help")).resolves.toEqual(RATE_LIMITED_DIR);
    // No sleeping on Retry-After, however large, and no retry.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slack.requests).toHaveLength(1);
    for (const text of [JSON.stringify(RATE_LIMITED_DIR), ...lines]) {
      for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden);
    }
    expect(lines).toEqual([]);
  });

  it("recovers on the next lookup: a rate limit is not remembered as a channel list", async () => {
    const slack = fakeSlackFetch([{ kind: "status", status: 429, headers: { "retry-after": "3600" } }, ...pagesOf([slackChannel("C1", "help")])]);
    const directory = new SlackChannelDirectory({ token: TOKEN, fetchFn: slack.fetchFn, now: () => 0 });
    expect(await directory.resolve("help")).toEqual(RATE_LIMITED_DIR);
    expect(await directory.resolve("help")).toMatchObject({ ok: true, channel: { id: "C1" } });
  });
});

describe("SlackBotSender on a rate limit", () => {
  it.each(SHAPES)("$label → not_sent, 'Slack is rate limiting. Try again shortly.', one post", async ({ step }) => {
    const lines = captureConsole();
    const slack = fakeSlackFetch([step, { kind: "json", body: { ok: true } }]);
    const sender = new SlackBotSender({
      token: TOKEN,
      directory: new FakeChannelDirectory({ channels: [{ id: "C1", name: "help" }] }),
      fetchFn: slack.fetchFn,
    });

    const started = Date.now();
    const result = await sender.send("#help", "hi");

    expect(result).toEqual(RATE_LIMITED_SEND);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slack.requests).toHaveLength(1); // never retried, whatever Retry-After says
    expect(slack.remaining()).toBe(1);
    for (const text of [JSON.stringify(result), ...lines]) {
      for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden);
    }
    expect(lines).toEqual([]);
  });
});
