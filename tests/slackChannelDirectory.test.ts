import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PAGES,
  SlackChannelDirectory,
  UnavailableChannelDirectory,
} from "../src/core/senders/SlackChannelDirectory.ts";
import type { ChannelLookup, DirectoryFailure } from "../src/core/types.ts";
import { fakeSlackFetch, pagesOf, slackChannel, type SlackStep } from "./fakeSlackFetch.ts";

// M22. SlackChannelDirectory against a scripted Slack (tests/fakeSlackFetch.ts), with an
// injected clock. No real network. The response shapes are the ones scripts/slack-recon.mjs
// captured; the ones it could not (429, 500, a non-JSON body) are marked in that file.

const TOKEN = "xoxb-test-SECRET-4242";

const CHANNELS = [
  slackChannel("C0000000001", "help"),
  slackChannel("C0000000002", "social"),
  slackChannel("C0000000003", "helpdesk"),
  slackChannel("C0000000004", "dev-help"),
  slackChannel("C0000000005", "general"),
  slackChannel("C0000000006", "random"),
  slackChannel("C0000000007", "hello"),
  slackChannel("C0000000008", "devops"),
  slackChannel("C0000000009", "webdev"),
  slackChannel("G0000000010", "leads", { is_private: true, is_member: true }),
];

interface Setup {
  steps: SlackStep[];
  token?: string | undefined;
  requestTimeoutMs?: number;
  refreshDeadlineMs?: number;
  onRequest?: (index: number) => void;
}

function setup(options: Setup) {
  const clock = { t: 0 };
  const slack = fakeSlackFetch(options.steps, { onRequest: options.onRequest });
  const directory = new SlackChannelDirectory({
    token: "token" in options ? options.token : TOKEN,
    fetchFn: slack.fetchFn,
    now: () => clock.t,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.refreshDeadlineMs === undefined ? {} : { refreshDeadlineMs: options.refreshDeadlineMs }),
  });
  return { directory, slack, clock };
}

const unavailable = (failure: DirectoryFailure): ChannelLookup => ({ ok: false, reason: "unavailable", failure });

function idOf(lookup: ChannelLookup): string | null {
  return lookup.ok ? lookup.channel.id : null;
}

describe("resolution", () => {
  it.each(["#help", "help", "HELP", " #Help "])("resolves %j to the help channel's ID", async (input) => {
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    const lookup = await directory.resolve(input);
    expect(lookup).toEqual({
      ok: true,
      channel: { id: "C0000000001", name: "help", isPrivate: false },
    });
  });

  it("gives all four spellings the SAME ID, from one list", async () => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS) });
    const ids = [];
    for (const input of ["#help", "help", "HELP", " #Help "]) ids.push(idOf(await directory.resolve(input)));
    expect(new Set(ids)).toEqual(new Set(["C0000000001"]));
    expect(slack.requests).toHaveLength(1);
  });

  it("carries isPrivate through for a private channel", async () => {
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    expect(await directory.resolve("#leads")).toEqual({
      ok: true,
      channel: { id: "G0000000010", name: "leads", isPrivate: true },
    });
  });

  it("answers not_found, with suggestions, for a name Slack does not have", async () => {
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    const lookup = await directory.resolve("#hepl");
    expect(lookup).toEqual({ ok: false, reason: "not_found", suggestions: ["help", "hello"] });
  });

  // The ID only ever comes from the list. A string that happens to BE an ID is just a name
  // nothing is called.
  it.each(["C0000000001", "#C0000000001", "c0000000001"])("does not accept the ID %j as input", async (input) => {
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    const lookup = await directory.resolve(input);
    expect(lookup.ok).toBe(false);
    expect(lookup).toMatchObject({ reason: "not_found" });
  });

  it("strips only ONE leading #", async () => {
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    expect((await directory.resolve("##help")).ok).toBe(false);
  });

  it.each(["", "   ", "#", " # "])("answers %j with not_found, no suggestions, and no request", async (input) => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS) });
    expect(await directory.resolve(input)).toEqual({ ok: false, reason: "not_found", suggestions: [] });
    expect(slack.requests).toHaveLength(0);
  });

  it("matches a name written in a different Unicode normal form", async () => {
    const { directory } = setup({ steps: pagesOf([slackChannel("C1", "café")]) });
    expect(idOf(await directory.resolve("café"))).toBe("C1");
  });
});

describe("the request", () => {
  it("asks conversations.list for public and private, unarchived, 200 a page, with GET", async () => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS) });
    await directory.resolve("help");
    const url = new URL(slack.requests[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/api/conversations.list");
    expect(url.searchParams.get("types")).toBe("public_channel,private_channel");
    expect(url.searchParams.get("exclude_archived")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(slack.requests[0]?.method).toBe("GET");
  });

  it("sends the token in the Authorization header and NOWHERE else", async () => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS, 4) });
    await directory.resolve("help");
    expect(slack.requests).toHaveLength(3);
    for (const request of slack.requests) {
      expect(request.url).not.toContain(TOKEN);
      expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      const elsewhere = Object.entries(request.headers).filter(
        ([name, value]) => name !== "authorization" && value.includes(TOKEN),
      );
      expect(elsewhere).toEqual([]);
    }
  });
});

describe("paging", () => {
  it("follows next_cursor and merges every page", async () => {
    const steps = pagesOf(CHANNELS, 4);
    expect(steps).toHaveLength(3);
    const { directory, slack } = setup({ steps });

    // Each one from a different page.
    expect(idOf(await directory.resolve("help"))).toBe("C0000000001");
    expect(idOf(await directory.resolve("general"))).toBe("C0000000005");
    expect(idOf(await directory.resolve("webdev"))).toBe("C0000000009");

    expect(slack.requests).toHaveLength(3);
    expect(new URL(slack.requests[1]?.url ?? "").searchParams.get("cursor")).toBe("cursor-4");
    expect(new URL(slack.requests[2]?.url ?? "").searchParams.get("cursor")).toBe("cursor-8");
  });

  it("treats a missing response_metadata as the last page", async () => {
    const { directory, slack } = setup({
      steps: [{ kind: "json", body: { ok: true, channels: [slackChannel("C1", "help")] } }],
    });
    expect(idOf(await directory.resolve("help"))).toBe("C1");
    expect(slack.requests).toHaveLength(1);
  });

  it(`gives up as bad_response when the list is still paging after ${MAX_PAGES} pages`, async () => {
    const endless: SlackStep[] = Array.from({ length: MAX_PAGES + 5 }, (_, i) => ({
      kind: "page",
      channels: [slackChannel(`C${i}`, `chan-${i}`)],
      nextCursor: `more-${i}`,
    }));
    const { directory, slack } = setup({ steps: endless });
    expect(await directory.resolve("chan-0")).toEqual(unavailable("bad_response"));
    expect(slack.requests).toHaveLength(MAX_PAGES);
  });

  it("drops archived channels, from answers and from suggestions", async () => {
    const { directory } = setup({
      steps: pagesOf([...CHANNELS, slackChannel("C0000000099", "old-help", { is_archived: true })]),
    });
    expect(await directory.resolve("old-help")).toMatchObject({ ok: false, reason: "not_found" });
    // "old-hel" would put "old-help" first, as a prefix match, if it had been kept.
    expect(await directory.resolve("old-hel")).toEqual({ ok: false, reason: "not_found", suggestions: [] });
  });

  it("skips malformed entries and keeps the rest", async () => {
    const { directory } = setup({
      steps: pagesOf([
        { id: 5, name: "numeric-id" },
        { name: "no-id" },
        { id: "C7" },
        { id: "C8", name: "" },
        { id: "", name: "empty-id" },
        "a string",
        null,
        slackChannel("C0000000001", "help"),
      ]),
    });
    expect(idOf(await directory.resolve("help"))).toBe("C0000000001");
    expect(await directory.resolve("no-id")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await directory.resolve("numeric-id")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("is bad_response when EVERY entry is malformed", async () => {
    const { directory } = setup({
      steps: pagesOf([{ id: 1, name: 2 }, { nope: true }, null]),
    });
    expect(await directory.resolve("help")).toEqual(unavailable("bad_response"));
  });

  it("is not a failure when the workspace simply has no channels", async () => {
    const { directory } = setup({ steps: [{ kind: "page", channels: [] }] });
    expect(await directory.resolve("help")).toEqual({ ok: false, reason: "not_found", suggestions: [] });
  });

  it.each([
    { label: "ok with no channels array", body: { ok: true } },
    { label: "channels that is not an array", body: { ok: true, channels: { help: "C1" } } },
    { label: "no ok flag", body: { channels: [] } },
    { label: "a JSON array", body: [] },
    { label: "a JSON string", body: "ok" },
  ])("is bad_response for $label", async ({ body }) => {
    const { directory } = setup({ steps: [{ kind: "json", body }] });
    expect(await directory.resolve("help")).toEqual(unavailable("bad_response"));
  });

  it("refuses a name two channels share — ambiguous, never a guess", async () => {
    const { directory } = setup({
      steps: pagesOf([slackChannel("C1", "help"), slackChannel("C2", "Help"), slackChannel("C3", "social")]),
    });
    expect(await directory.resolve("help")).toEqual(unavailable("ambiguous"));
    expect(idOf(await directory.resolve("social"))).toBe("C3");
  });
});

describe("the cache", () => {
  it("answers a second lookup within the TTL from the cache", async () => {
    const { directory, slack, clock } = setup({ steps: pagesOf(CHANNELS) });
    await directory.resolve("help");
    clock.t = 599_999;
    expect(idOf(await directory.resolve("social"))).toBe("C0000000002");
    expect(slack.requests).toHaveLength(1);
  });

  it("refetches once the TTL has passed", async () => {
    const renamed = [slackChannel("C0000000001", "support")];
    const { directory, slack, clock } = setup({ steps: [...pagesOf(CHANNELS), ...pagesOf(renamed)] });
    expect(idOf(await directory.resolve("help"))).toBe("C0000000001");
    clock.t = 600_000;
    expect(idOf(await directory.resolve("support"))).toBe("C0000000001");
    expect(slack.requests).toHaveLength(2);
  });

  it("never serves stale data when the refresh past the TTL fails", async () => {
    const { directory, clock } = setup({
      steps: [...pagesOf(CHANNELS), { kind: "json", body: { ok: false, error: "internal_error" } }],
    });
    expect((await directory.resolve("help")).ok).toBe(true);
    clock.t = 600_000;
    expect(await directory.resolve("help")).toEqual(unavailable("slack_error"));
  });

  it("refreshes ONCE on a miss — and a channel created since then is found", async () => {
    const withNew = [...CHANNELS, slackChannel("C0000000077", "brand-new")];
    const { directory, slack, clock } = setup({ steps: [...pagesOf(CHANNELS), ...pagesOf(withNew)] });
    await directory.resolve("help");
    clock.t = 30_000;
    expect(idOf(await directory.resolve("#brand-new"))).toBe("C0000000077");
    expect(slack.requests).toHaveLength(2);
  });

  it("does not refresh on a miss within the minimum gap of the last attempt", async () => {
    const { directory, slack, clock } = setup({ steps: [...pagesOf(CHANNELS), ...pagesOf(CHANNELS)] });
    await directory.resolve("help");
    // Straight after the fill: the list is seconds old, so a miss is answered from it.
    expect(await directory.resolve("nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(slack.requests).toHaveLength(1);

    clock.t = 31_000;
    expect(await directory.resolve("nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(slack.requests).toHaveLength(2);

    clock.t = 40_000;
    expect(await directory.resolve("still-nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(slack.requests).toHaveLength(2);
  });

  it("reports a FAILED miss-refresh as unavailable, never as not_found", async () => {
    const { directory, clock } = setup({ steps: [...pagesOf(CHANNELS), { kind: "throw" }] });
    await directory.resolve("help");
    clock.t = 31_000;
    expect(await directory.resolve("brand-new")).toEqual(unavailable("network"));
  });

  it("counts a failed refresh as an attempt for the gap", async () => {
    const { directory, slack, clock } = setup({ steps: [...pagesOf(CHANNELS), { kind: "throw" }] });
    await directory.resolve("help");
    clock.t = 31_000;
    await directory.resolve("brand-new");
    clock.t = 35_000;
    expect(await directory.resolve("brand-new")).toMatchObject({ ok: false, reason: "not_found" });
    expect(slack.requests).toHaveLength(2);
    // And a hit within the TTL is still served: a failed miss-refresh does not throw the list away.
    expect(idOf(await directory.resolve("help"))).toBe("C0000000001");
  });

  it("shares one request between concurrent lookups", async () => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS) });
    const answers = await Promise.all([
      directory.resolve("help"),
      directory.resolve("social"),
      directory.resolve("not-a-channel"),
    ]);
    expect(answers.map(idOf)).toEqual(["C0000000001", "C0000000002", null]);
    expect(slack.requests).toHaveLength(1);
  });

  it("shares one miss-refresh between concurrent misses", async () => {
    const withNew = [...CHANNELS, slackChannel("C0000000077", "brand-new")];
    const { directory, slack, clock } = setup({ steps: [...pagesOf(CHANNELS), ...pagesOf(withNew)] });
    await directory.resolve("help");
    clock.t = 31_000;
    const answers = await Promise.all([directory.resolve("brand-new"), directory.resolve("brand-new")]);
    expect(answers.map(idOf)).toEqual(["C0000000077", "C0000000077"]);
    expect(slack.requests).toHaveLength(2);
  });
});

// Every way a refresh can fail, each mapped to its fixed code — and each one RESOLVED, never
// rejected. `scenarios` is reused by the leak tests below, so every case here is also checked
// for what it must not say.
const LEAKY_BODY = `<html>Bearer ${TOKEN} at https://slack.com/api/conversations.list</html>`;

interface Scenario {
  label: string;
  steps: SlackStep[];
  expected: DirectoryFailure;
  requestTimeoutMs?: number;
}

const scenarios: Scenario[] = [
  ...["invalid_auth", "not_authed", "token_revoked", "account_inactive"].map(
    (code): Scenario => ({
      label: `ok:false ${code}`,
      steps: [{ kind: "json", body: { ok: false, error: code, detail: LEAKY_BODY } }],
      expected: "auth",
    }),
  ),
  {
    label: "HTTP 429 with Retry-After",
    steps: [{ kind: "status", status: 429, headers: { "retry-after": "30" }, body: LEAKY_BODY }],
    expected: "rate_limited",
  },
  {
    label: "HTTP 200 ok:false ratelimited",
    steps: [{ kind: "json", body: { ok: false, error: "ratelimited" } }],
    expected: "rate_limited",
  },
  { label: "HTTP 500", steps: [{ kind: "status", status: 500, body: LEAKY_BODY }], expected: "slack_error" },
  { label: "HTTP 503", steps: [{ kind: "status", status: 503 }], expected: "slack_error" },
  { label: "HTTP 404", steps: [{ kind: "status", status: 404, body: LEAKY_BODY }], expected: "slack_error" },
  {
    label: "ok:false missing_scope",
    steps: [{ kind: "json", body: { ok: false, error: "missing_scope", needed: "groups:read" } }],
    expected: "slack_error",
  },
  {
    label: `ok:false with an unknown code that quotes the token`,
    steps: [{ kind: "json", body: { ok: false, error: LEAKY_BODY } }],
    expected: "slack_error",
  },
  { label: "ok:false with no code", steps: [{ kind: "json", body: { ok: false } }], expected: "slack_error" },
  { label: "a body that is not JSON", steps: [{ kind: "text", body: LEAKY_BODY }], expected: "bad_response" },
  {
    label: "a failure on the SECOND page",
    steps: [{ kind: "page", channels: [slackChannel("C1", "help")], nextCursor: "next" }, { kind: "throw" }],
    expected: "network",
  },
  { label: "a network failure whose message quotes the URL and token", steps: [{ kind: "throw" }], expected: "network" },
  { label: "a request that never answers", steps: [{ kind: "hang" }], expected: "timeout", requestTimeoutMs: 20 },
];

describe("failures", () => {
  it.each(scenarios)("$label → $expected, resolved and not rejected", async ({ steps, expected, requestTimeoutMs }) => {
    const { directory } = setup({ steps, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
    await expect(directory.resolve("help")).resolves.toEqual(unavailable(expected));
  });

  it("is a timeout when the whole refresh outlasts its deadline, even if every page answered", async () => {
    const clock = { t: 0 };
    const slack = fakeSlackFetch(
      [
        { kind: "page", channels: [slackChannel("C1", "a")], nextCursor: "p2" },
        { kind: "page", channels: [slackChannel("C2", "b")], nextCursor: "p3" },
        { kind: "page", channels: [slackChannel("C3", "help")] },
      ],
      // Each page "takes" 15s on the injected clock.
      { onRequest: () => (clock.t += 15_000) },
    );
    const directory = new SlackChannelDirectory({
      token: TOKEN,
      fetchFn: slack.fetchFn,
      now: () => clock.t,
      refreshDeadlineMs: 20_000,
    });
    expect(await directory.resolve("help")).toEqual(unavailable("timeout"));
    expect(slack.requests).toHaveLength(2);
  });

  it("is a network failure when fetch throws synchronously", async () => {
    const directory = new SlackChannelDirectory({
      token: TOKEN,
      fetchFn: (() => {
        throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(directory.resolve("help")).resolves.toEqual(unavailable("network"));
  });

  it("does not retry: one failure is one request", async () => {
    const { directory, slack } = setup({ steps: [{ kind: "status", status: 500 }, ...pagesOf(CHANNELS)] });
    await directory.resolve("help");
    expect(slack.requests).toHaveLength(1);
  });

  it("recovers on the next lookup after a failed first fill", async () => {
    const { directory, slack } = setup({ steps: [{ kind: "throw" }, ...pagesOf(CHANNELS)] });
    expect(await directory.resolve("help")).toEqual(unavailable("network"));
    expect(idOf(await directory.resolve("help"))).toBe("C0000000001");
    expect(slack.requests).toHaveLength(2);
  });
});

describe("no token", () => {
  it.each([undefined, "", "   ", "\t\n"])("is unavailable/no_token for %j, with zero requests", async (token) => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS), token });
    expect(await directory.resolve("help")).toEqual(unavailable("no_token"));
    expect(await directory.resolve("")).toEqual(unavailable("no_token"));
    expect(slack.requests).toHaveLength(0);
  });

  it("refuses a token no header could carry, before any request", async () => {
    const { directory, slack } = setup({ steps: pagesOf(CHANNELS), token: "xoxb-abc\ndef" });
    expect(await directory.resolve("help")).toEqual(unavailable("auth"));
    expect(slack.requests).toHaveLength(0);
  });

  it("UnavailableChannelDirectory is always unavailable/no_token", async () => {
    const directory = new UnavailableChannelDirectory();
    expect(await directory.resolve("help")).toEqual(unavailable("no_token"));
    expect(await directory.resolve("")).toEqual(unavailable("no_token"));
  });
});

// THE LEAK RULE. For every failure above — and for an invalid token and a malformed one — what
// comes back, and anything written to the console while getting it, must not contain the token,
// the word "Bearer", Slack's URL, or the text of the fake network error.
describe("nothing leaks", () => {
  const FORBIDDEN = [TOKEN, "Bearer", "slack.com", "ECONNREFUSED", "fetch failed", "invalid header"];

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

  function assertClean(texts: string[]): void {
    for (const text of texts) {
      for (const forbidden of FORBIDDEN) expect(text, `found ${JSON.stringify(forbidden)}`).not.toContain(forbidden);
    }
  }

  it.each(scenarios)("$label", async ({ steps, requestTimeoutMs }) => {
    const seen = captureConsole();
    const { directory } = setup({ steps, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
    const result = await directory.resolve("help");
    expect(result.ok).toBe(false);
    assertClean([JSON.stringify(result), ...seen]);
    expect(seen).toEqual([]);
  });

  it("a fetch that throws synchronously, quoting the header", async () => {
    const seen = captureConsole();
    const directory = new SlackChannelDirectory({
      token: TOKEN,
      fetchFn: (() => {
        throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
      }) as unknown as typeof globalThis.fetch,
    });
    const result = await directory.resolve("help");
    assertClean([JSON.stringify(result), ...seen]);
  });

  it("a malformed token", async () => {
    const seen = captureConsole();
    const bad = "xoxb-SECRET\nINJECTED";
    const { directory } = setup({ steps: pagesOf(CHANNELS), token: bad });
    const result = await directory.resolve("help");
    assertClean([JSON.stringify(result), ...seen]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("a successful lookup and a miss", async () => {
    const seen = captureConsole();
    const { directory } = setup({ steps: pagesOf(CHANNELS) });
    assertClean([JSON.stringify(await directory.resolve("help")), JSON.stringify(await directory.resolve("hepl")), ...seen]);
    expect(seen).toEqual([]);
  });
});

describe("suggestions", () => {
  async function suggestionsFor(input: string, channels = CHANNELS): Promise<string[]> {
    const { directory } = setup({ steps: pagesOf(channels) });
    const lookup = await directory.resolve(input);
    if (lookup.ok || lookup.reason !== "not_found") throw new Error(`expected not_found for ${input}`);
    return lookup.suggestions;
  }

  it("puts names that START with the input first, alphabetically", async () => {
    expect(await suggestionsFor("he")).toEqual(["hello", "help", "helpdesk"]);
  });

  it("then names that CONTAIN it", async () => {
    expect(await suggestionsFor("dev")).toEqual(["dev-help", "devops", "webdev"]);
    expect(await suggestionsFor("elp")).toEqual(["dev-help", "help", "helpdesk"]);
  });

  it("then names within a small edit distance, closest first", async () => {
    expect(await suggestionsFor("hepl")).toEqual(["help", "hello"]);
    expect(await suggestionsFor("socail")).toEqual(["social"]);
    expect(await suggestionsFor("genral")).toEqual(["general"]);
  });

  it("returns at most three", async () => {
    expect((await suggestionsFor("e")).length).toBeLessThanOrEqual(3);
    expect(await suggestionsFor("h")).toEqual([]);
    expect((await suggestionsFor("el")).length).toBe(3);
  });

  it("suggests nothing for input under two characters", async () => {
    expect(await suggestionsFor("x")).toEqual([]);
    expect(await suggestionsFor("#h")).toEqual([]);
  });

  it("suggests nothing when nothing is close", async () => {
    expect(await suggestionsFor("zzzzzzzz")).toEqual([]);
  });

  it("is deterministic, whatever order Slack listed the channels in", async () => {
    const reversed = [...CHANNELS].reverse();
    for (const input of ["he", "dev", "hepl", "elp"]) {
      expect(await suggestionsFor(input, reversed), input).toEqual(await suggestionsFor(input));
    }
  });

  it("returns names only — never an ID", async () => {
    const lists = await Promise.all(["he", "dev", "hepl", "lead", "C000000000"].map((input) => suggestionsFor(input)));
    for (const name of lists.flat()) expect(name).not.toMatch(/^[CG]\d+$/);
    expect(await suggestionsFor("lead")).toEqual(["leads"]);
  });

  it("are taken from the list as it is NOW, after a miss-refresh", async () => {
    const later = [...CHANNELS, slackChannel("C0000000077", "help-new")];
    const { directory, clock } = setup({ steps: [...pagesOf(CHANNELS), ...pagesOf(later)] });
    await directory.resolve("help");
    clock.t = 31_000;
    const lookup = await directory.resolve("help-ne");
    expect(lookup).toEqual({ ok: false, reason: "not_found", suggestions: ["help-new"] });
  });
});
