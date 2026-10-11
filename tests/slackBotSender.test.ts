import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_ERRORS, SlackBotSender, escapeSlackText } from "../src/core/senders/SlackBotSender.ts";
import type { ChannelDirectory, ChannelLookup, SendResult } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { fakeSlackFetch, type SlackStep } from "./fakeSlackFetch.ts";

// M22. SlackBotSender against FakeChannelDirectory and a scripted Slack. No real network.
//
// What these tests hold it to: the ID it posts to is the DIRECTORY's, never the input; the token
// is only ever in the Authorization header; text cannot ping anyone; one request, never retried;
// and every failure says correctly whether the message might be in the channel — `not_sent`
// when Slack definitively refused, `maybe_sent` whenever the answer is unknown.
//
// chat.postMessage's own failure shapes were NOT captured live (the recon script is read-only and
// never posts). They follow conversations.list's measured shape — HTTP 200, `ok: false`, a code —
// which is the documented shape for every Web API method.

const TOKEN = "xoxb-test-SECRET-9191";
const HELP_ID = "C0000000001";

const CHANNELS = [
  { id: HELP_ID, name: "help" },
  { id: "C0000000002", name: "social" },
  { id: "C0000000003", name: "leads", isPrivate: true },
];

function setup(steps: SlackStep[], options: { directory?: ChannelDirectory; token?: string; requestTimeoutMs?: number } = {}) {
  const slack = fakeSlackFetch(steps);
  const directory = options.directory ?? new FakeChannelDirectory({ channels: CHANNELS });
  const sender = new SlackBotSender({
    token: "token" in options ? options.token : TOKEN,
    directory,
    fetchFn: slack.fetchFn,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return { sender, slack, directory };
}

const OK: SlackStep = { kind: "json", body: { ok: true, channel: HELP_ID, ts: "1700000000.000100" } };

const posts = (slack: ReturnType<typeof fakeSlackFetch>) =>
  slack.requests.filter((request) => request.url.includes("chat.postMessage"));

describe("a successful send", () => {
  it("is exactly one POST to chat.postMessage, to the directory's ID", async () => {
    const { sender, slack } = setup([OK]);
    expect(await sender.send(" #Help ", "ship it")).toEqual({ ok: true });

    expect(slack.requests).toHaveLength(1);
    const [request] = slack.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(request?.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = JSON.parse(request?.body ?? "null") as Record<string, unknown>;
    expect(body).toEqual({ channel: HELP_ID, text: "ship it" });
  });

  it("posts the ID, never the name it was handed", async () => {
    const { sender, slack } = setup([OK]);
    await sender.send("#help", "hi");
    const body = slack.requests[0]?.body ?? "";
    expect(body).toContain(HELP_ID);
    expect(body).not.toContain("#help");
    expect(JSON.parse(body)).not.toHaveProperty("channel", "help");
  });

  it("asks the directory about the name it was given, exactly as given", async () => {
    const directory = new FakeChannelDirectory({ channels: CHANNELS });
    const { sender } = setup([OK], { directory });
    await sender.send(" #Help ", "hi");
    expect(directory.calls).toEqual([" #Help "]);
  });

  it("sends the token in the Authorization header and nowhere else", async () => {
    const { sender, slack } = setup([OK]);
    await sender.send("help", `the token is not ${"x"} here`);
    const [request] = slack.requests;
    expect(request?.url).not.toContain(TOKEN);
    expect(request?.body).not.toContain(TOKEN);
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    const elsewhere = Object.entries(request?.headers ?? {}).filter(
      ([name, value]) => name !== "authorization" && value.includes(TOKEN),
    );
    expect(elsewhere).toEqual([]);
  });

  it("escapes &, < and > so the text cannot notify the channel or ping anyone", async () => {
    const { sender, slack } = setup([OK]);
    const text = "Heads up <!channel> & <!here> — ask <@U123> or see <https://evil.example|docs> > now";
    await sender.send("help", text);
    const sent = (JSON.parse(slack.requests[0]?.body ?? "{}") as { text: string }).text;
    expect(sent).toBe(
      "Heads up &lt;!channel&gt; &amp; &lt;!here&gt; — ask &lt;@U123&gt; or see &lt;https://evil.example|docs&gt; &gt; now",
    );
    expect(sent).not.toMatch(/<|>/);
  });

  it("escapes & first, so an already-escaped sequence is escaped once more, not undone", () => {
    expect(escapeSlackText("&lt;!channel&gt;")).toBe("&amp;lt;!channel&amp;gt;");
    expect(escapeSlackText("a & b")).toBe("a &amp; b");
  });

  it("reports mode bot and no fixed destination", () => {
    const { sender } = setup([]);
    expect(sender.mode).toBe("bot");
    expect((sender as { postsTo?: unknown }).postsTo).toBeUndefined();
  });
});

const notSent = (error: string): SendResult => ({ ok: false, outcome: "not_sent", error });
const MAYBE: SendResult = { ok: false, outcome: "maybe_sent", error: SEND_ERRORS.unconfirmed };
const LEAKY = `<html>Bearer ${TOKEN} at https://slack.com/api/chat.postMessage</html>`;

interface Scenario {
  label: string;
  steps: SlackStep[];
  expected: SendResult;
  requestTimeoutMs?: number;
}

// Every outcome of the POST itself. Reused by the leak tests below.
const postScenarios: Scenario[] = [
  ...(
    [
      ["channel_not_found", SEND_ERRORS.channelNotFound],
      ["not_in_channel", SEND_ERRORS.notInChannel],
      ["is_archived", SEND_ERRORS.archived],
      ["invalid_auth", SEND_ERRORS.badToken],
      ["not_authed", SEND_ERRORS.badToken],
      ["token_revoked", SEND_ERRORS.badToken],
      ["account_inactive", SEND_ERRORS.badToken],
      ["ratelimited", SEND_ERRORS.rateLimited],
      ["msg_too_long", SEND_ERRORS.badText],
      ["no_text", SEND_ERRORS.badText],
      ["restricted_action", SEND_ERRORS.rejected],
      [LEAKY, SEND_ERRORS.rejected],
    ] as const
  ).map(
    ([code, error]): Scenario => ({
      label: `ok:false ${code === LEAKY ? "(a code quoting the token)" : code} → not_sent`,
      steps: [{ kind: "json", body: { ok: false, error: code, detail: LEAKY } }],
      expected: notSent(error),
    }),
  ),
  { label: "ok:false with no code → not_sent", steps: [{ kind: "json", body: { ok: false } }], expected: notSent(SEND_ERRORS.rejected) },
  {
    label: "HTTP 429 with Retry-After → not_sent",
    steps: [{ kind: "status", status: 429, headers: { "retry-after": "30" }, body: LEAKY }],
    expected: notSent(SEND_ERRORS.rateLimited),
  },
  { label: "HTTP 500 → maybe_sent", steps: [{ kind: "status", status: 500, body: LEAKY }], expected: MAYBE },
  { label: "HTTP 503 → maybe_sent", steps: [{ kind: "status", status: 503 }], expected: MAYBE },
  { label: "HTTP 404 → maybe_sent", steps: [{ kind: "status", status: 404, body: LEAKY }], expected: MAYBE },
  { label: "a 200 that is not JSON → maybe_sent", steps: [{ kind: "text", body: LEAKY }], expected: MAYBE },
  { label: "a 200 with no ok flag → maybe_sent", steps: [{ kind: "json", body: { channel: HELP_ID } }], expected: MAYBE },
  { label: "a 200 that is a JSON array → maybe_sent", steps: [{ kind: "json", body: [] }], expected: MAYBE },
  { label: "a network failure quoting the URL and token → maybe_sent", steps: [{ kind: "throw" }], expected: MAYBE },
  { label: "a request that never answers → maybe_sent", steps: [{ kind: "hang" }], expected: MAYBE, requestTimeoutMs: 20 },
  {
    label: "headers, then a body that never arrives → maybe_sent",
    steps: [{ kind: "hangBody" }],
    expected: MAYBE,
    requestTimeoutMs: 20,
  },
];

describe("what a failed POST means", () => {
  it.each(postScenarios)("$label", async ({ steps, expected, requestTimeoutMs }) => {
    const { sender, slack } = setup(steps, requestTimeoutMs === undefined ? {} : { requestTimeoutMs });
    await expect(sender.send("help", "hi")).resolves.toEqual(expected);
    expect(posts(slack)).toHaveLength(1);
  });

  it("never retries: a timeout is exactly one request", async () => {
    const { sender, slack } = setup([{ kind: "hang" }, OK, OK], { requestTimeoutMs: 20 });
    expect(await sender.send("help", "hi")).toEqual(MAYBE);
    expect(slack.requests).toHaveLength(1);
    expect(slack.remaining()).toBe(2);
  });

  it("never retries a 5xx either", async () => {
    const { sender, slack } = setup([{ kind: "status", status: 502 }, OK]);
    expect(await sender.send("help", "hi")).toEqual(MAYBE);
    expect(slack.requests).toHaveLength(1);
  });
});

// Refusals that happen BEFORE the post: nothing reaches chat.postMessage, so all are not_sent.
interface PreScenario {
  label: string;
  // A factory, not an instance: a scripted failure is used up by the call that receives it, and
  // each scenario runs twice (here and in the leak tests).
  directory?: () => ChannelDirectory;
  token?: string;
  channel: string;
  expected: SendResult;
}

const MISBEHAVING: Record<string, ChannelDirectory> = {
  rejects: { resolve: () => Promise.reject(new Error(`boom ${TOKEN}`)) },
  "throws synchronously": {
    resolve: () => {
      throw new Error(`boom ${TOKEN}`);
    },
  },
  "returns undefined": { resolve: () => Promise.resolve(undefined as unknown as ChannelLookup) },
  "returns ok with no channel": { resolve: () => Promise.resolve({ ok: true } as unknown as ChannelLookup) },
  "returns ok with a non-string id": {
    resolve: () => Promise.resolve({ ok: true, channel: { id: 42, name: "help", isPrivate: false } } as unknown as ChannelLookup),
  },
  "returns an unknown shape": { resolve: () => Promise.resolve({ ok: false, reason: "whatever" } as unknown as ChannelLookup) },
};

const preScenarios: PreScenario[] = [
  { label: "a channel the directory does not have", channel: "#nope", expected: notSent(SEND_ERRORS.channelNotFound) },
  {
    label: "an ID typed as the channel",
    channel: HELP_ID,
    expected: notSent(SEND_ERRORS.channelNotFound),
  },
  {
    label: "a name two channels share",
    directory: () => new FakeChannelDirectory({ channels: [{ id: "C1", name: "help" }, { id: "C2", name: "Help" }] }),
    channel: "help",
    expected: notSent(SEND_ERRORS.ambiguous),
  },
  ...(["network", "timeout", "auth", "rate_limited", "slack_error", "bad_response", "no_token"] as const).map(
    (failure): PreScenario => ({
      label: `a directory that is unavailable (${failure})`,
      directory: () => new FakeChannelDirectory({ channels: CHANNELS, unavailable: [failure] }),
      channel: "help",
      expected: notSent(SEND_ERRORS.cannotCheck),
    }),
  ),
  ...Object.entries(MISBEHAVING).map(
    ([how, directory]): PreScenario => ({
      label: `a directory that ${how}`,
      directory: () => directory,
      channel: "help",
      expected: notSent(SEND_ERRORS.cannotCheck),
    }),
  ),
  ...["", "   ", "\n"].map(
    (token): PreScenario => ({
      label: `a blank token (${JSON.stringify(token)})`,
      token,
      channel: "help",
      expected: notSent(SEND_ERRORS.notSetUp),
    }),
  ),
  { label: "a token no header could carry", token: "xoxb-SECRET\nINJECTED", channel: "help", expected: notSent(SEND_ERRORS.badToken) },
];

describe("refusals before the post", () => {
  it.each(preScenarios)("$label → not_sent, and no chat.postMessage", async ({ directory, token, channel, expected }) => {
    const { sender, slack } = setup([OK], {
      ...(directory === undefined ? {} : { directory: directory() }),
      ...(token === undefined ? {} : { token }),
    });
    await expect(sender.send(channel, "hi")).resolves.toEqual(expected);
    expect(posts(slack)).toHaveLength(0);
    expect(slack.requests).toHaveLength(0);
  });

  it("does not even ask the directory when there is no token", async () => {
    const directory = new FakeChannelDirectory({ channels: CHANNELS });
    const { sender } = setup([OK], { directory, token: "" });
    await sender.send("help", "hi");
    expect(directory.calls).toEqual([]);
  });

  it("works with an undefined token too", async () => {
    const slack = fakeSlackFetch([OK]);
    const sender = new SlackBotSender({
      token: undefined,
      directory: new FakeChannelDirectory({ channels: CHANNELS }),
      fetchFn: slack.fetchFn,
    });
    expect(await sender.send("help", "hi")).toEqual(notSent(SEND_ERRORS.notSetUp));
    expect(slack.requests).toHaveLength(0);
  });
});

// THE LEAK RULE. For every failure — before the post and of it — the result, and anything written
// to the console, contains no token, no "Bearer", no Slack URL and none of the fake error's text.
describe("nothing leaks", () => {
  const FORBIDDEN = [TOKEN, "SECRET", "Bearer", "slack.com", "ECONNREFUSED", "fetch failed", "boom"];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureConsole(): string[] {
    const seen: string[] = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ""}` : String(arg))).join(" "));
      });
    }
    return seen;
  }

  function assertClean(result: SendResult, seen: string[]): void {
    expect(seen).toEqual([]);
    const said = JSON.stringify(result);
    for (const forbidden of FORBIDDEN) expect(said, `found ${JSON.stringify(forbidden)}`).not.toContain(forbidden);
    // And the error is always one of the fixed texts.
    expect(Object.values(SEND_ERRORS)).toContain(result.error);
  }

  it.each(postScenarios)("$label", async ({ steps, requestTimeoutMs }) => {
    const seen = captureConsole();
    const { sender } = setup(steps, requestTimeoutMs === undefined ? {} : { requestTimeoutMs });
    assertClean(await sender.send("help", `message mentioning ${TOKEN}? no`), seen);
  });

  it.each(preScenarios)("$label", async ({ directory, token, channel }) => {
    const seen = captureConsole();
    const { sender } = setup([OK], {
      ...(directory === undefined ? {} : { directory: directory() }),
      ...(token === undefined ? {} : { token }),
    });
    assertClean(await sender.send(channel, "hi"), seen);
  });

  it("a fetch that throws synchronously, quoting the header", async () => {
    const seen = captureConsole();
    const sender = new SlackBotSender({
      token: TOKEN,
      directory: new FakeChannelDirectory({ channels: CHANNELS }),
      fetchFn: (() => {
        throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
      }) as unknown as typeof globalThis.fetch,
    });
    const result = await sender.send("help", "hi");
    expect(result).toEqual(MAYBE);
    assertClean(result, seen);
  });
});
