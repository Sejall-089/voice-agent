import type {
  ChannelDirectory,
  ChannelId,
  ChannelInfo,
  ChannelLookup,
  DirectoryFailure,
} from "../types.ts";

// Which Slack channels exist, asked of Slack itself (M22).
//
// The bot-token sender posts to a channel ID, and the ID comes from HERE: from Slack's own list,
// never from what the model wrote, what an email said, or what the user typed. A name that is
// not on the list is not a channel — however much it looks like one — and the answer says so,
// with the closest real names as suggestions.
//
// Behind an interface like MessageSender, so the planner and tools can be tested against a fake
// (tests/FakeChannelDirectory.ts); and the HTTP is an injected `fetchFn`, so this file's own
// decisions are tested against scripted responses (tests/fakeSlackFetch.ts) — paging, the cache,
// and above all how each failure is classified.
//
// THE SHAPES BELOW ARE RECON, NOT DOCS (scripts/slack-recon.mjs, 2026-10-11):
//   - every Slack failure measured was HTTP 200 with `{ ok: false, error: "<code>" }` — a bad
//     token is `invalid_auth`, a missing one `not_authed`. HTTP status alone says nothing.
//   - the last page carries `response_metadata.next_cursor: ""` — present and empty.
//   - a network failure is a TypeError with `cause.code` (ENOTFOUND); a timed-out request is a
//     DOMException named "TimeoutError". Neither is read here: see `request`.
//
// THE LEAK RULE. The token, the URL, request headers, any response body and any error's
// `.message` never reach a returned value, a thrown value or a log line. Nothing is logged at
// all. A failure is one of a fixed set of codes (`DirectoryFailure`), decided by what happened —
// a status, a Slack error code, a timer that fired — and never by reading text someone else
// wrote. That is not caution for its own sake: undici's error for a malformed header quotes the
// header value whole, `Bearer` and token included (measured, M22 recon).

const API = "https://slack.com/api/conversations.list";

// Slack's page size ceiling for this method is larger, but 200 is what recon measured with and
// what Slack recommends; a workspace with more channels simply takes more pages.
const PAGE_SIZE = 200;

// A list that is still handing out cursors after this many pages is not one this app can trust
// to end. 50 pages of 200 is 10,000 channels — far past any workspace this is built for.
export const MAX_PAGES = 50;

// Slack error codes that mean "this token is not accepted". Everything else Slack can say is
// `slack_error`, except the rate limit, which has its own code because it has its own fix.
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

export interface SlackChannelDirectoryOptions {
  // The bot token (SLACK_BOT_TOKEN). Undefined or blank means "not configured".
  token: string | undefined;
  // Tests hand in a scripted fetch. Omitted → the runtime's own.
  fetchFn?: typeof globalThis.fetch;
  // The clock the cache and the refresh deadline are measured on. Omitted → Date.now.
  now?: () => number;
  // How long a fetched list is trusted. Past this it is refreshed before it is answered from,
  // and if that refresh fails nothing stale is served.
  ttlMs?: number;
  // A name that is not in a fresh list triggers one refresh — so a channel created a minute ago
  // works with no setup — but not more often than this, so a typo repeated does not hammer
  // Slack. Measured from the last refresh ATTEMPT, whether or not it succeeded.
  missRefreshMinGapMs?: number;
  // M22 prompt 7: ONE extra refresh on a miss inside that gap — so a channel created seconds
  // after the last fetch is found without waiting it out — but only this long after the last
  // attempt, and only one extra per `missRefreshMinGapMs`. So misses cost at most two fetches
  // per 30 s however fast they come, and a miss right after a fill never costs a second fetch.
  extraRefreshMinGapMs?: number;
  // Per request. A refresh is several requests when the list pages.
  requestTimeoutMs?: number;
  // For the whole refresh, every page included.
  refreshDeadlineMs?: number;
}

type RefreshResult = { ok: true } | { ok: false; failure: DirectoryFailure };

// What the cache holds for one normalized name: the channel, or the fact that two share it.
type Entry = ChannelInfo | "ambiguous";

interface Cache {
  byName: Map<string, Entry>;
  // Slack's names, de-duplicated, for suggestions.
  names: string[];
  // When the refresh that produced this STARTED: the data is at least this old.
  fetchedAt: number;
}

// The one place a string becomes a `ChannelId`, and it is only ever handed an `id` that came out
// of Slack's list.
function asChannelId(id: string): ChannelId {
  return id as ChannelId;
}

// "#Help", " help ", "HELP" → "help". ONE leading "#" is stripped: "##help" is not a name
// anybody meant, and it is left to not match.
export function normalizeChannelName(input: string): string {
  const trimmed = input.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return bare.normalize("NFC").toLowerCase();
}

export class SlackChannelDirectory implements ChannelDirectory {
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly missRefreshMinGapMs: number;
  private readonly extraRefreshMinGapMs: number;
  private readonly requestTimeoutMs: number;
  private readonly refreshDeadlineMs: number;

  private cache: Cache | null = null;
  // When the last refresh began, successful or not. -Infinity: nothing has been tried yet.
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  // When the last EXTRA miss-refresh (inside the normal gap) was allowed.
  private lastExtraAt = Number.NEGATIVE_INFINITY;
  // The one refresh in flight, shared by everyone who arrives while it runs.
  private inflight: Promise<RefreshResult> | null = null;

  constructor(options: SlackChannelDirectoryOptions) {
    this.token = options.token?.trim() ?? "";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.missRefreshMinGapMs = options.missRefreshMinGapMs ?? 30_000;
    this.extraRefreshMinGapMs = options.extraRefreshMinGapMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.refreshDeadlineMs = options.refreshDeadlineMs ?? 20_000;
  }

  async resolve(input: string): Promise<ChannelLookup> {
    // NEVER REJECTS. Everything below is written not to throw; this is the backstop for a bug,
    // and what it says is a fixed code, not whatever was thrown.
    try {
      return await this.lookup(input);
    } catch {
      return unavailable("bad_response");
    }
  }

  private async lookup(input: string): Promise<ChannelLookup> {
    // Not configured: say so, and ask nobody. Checked before the input on purpose — with no
    // token no name can be answered, and "not found" would be a claim about Slack that was never
    // put to Slack.
    if (this.token.length === 0) return unavailable("no_token");
    // A token Slack could never accept as a header value is refused before it is handed to
    // `fetch`, whose error for it quotes the header — token and all.
    if (!/^[\x21-\x7e]+$/.test(this.token)) return unavailable("auth");

    const name = normalizeChannelName(input);
    if (name.length === 0) return { ok: false, reason: "not_found", suggestions: [] };

    // A list that is missing or past its TTL is refreshed FIRST, and a failed refresh is a
    // failure: nothing stale is ever answered from.
    if (this.inflight !== null || this.cache === null || this.isExpired(this.cache)) {
      const refreshed = await this.refresh();
      if (!refreshed.ok) return unavailable(refreshed.failure);
    }

    const found = this.find(name);
    if (found !== null) return found;

    // A miss in a fresh list. The channel may simply be newer than the list: refresh once — but
    // not if a refresh was attempted moments ago, which is the "repeated typo" case.
    if (this.inflight !== null || this.mayRefreshOnMiss()) {
      const refreshed = await this.refresh();
      // A refresh that failed says nothing about whether the channel exists. Not knowing is
      // reported as not knowing, never as "not found".
      if (!refreshed.ok) return unavailable(refreshed.failure);
      const again = this.find(name);
      if (again !== null) return again;
    }

    return { ok: false, reason: "not_found", suggestions: suggest(name, this.cache?.names ?? []) };
  }

  // May a miss refresh the list now? The normal rule: the last attempt was `missRefreshMinGapMs`
  // ago. The extra one (M22 prompt 7): at least `extraRefreshMinGapMs` since the last attempt, and
  // no other extra inside the last `missRefreshMinGapMs` — taken, and recorded, here.
  private mayRefreshOnMiss(): boolean {
    const now = this.now();
    const sinceAttempt = now - this.lastAttemptAt;
    if (sinceAttempt >= this.missRefreshMinGapMs) return true;
    if (sinceAttempt >= this.extraRefreshMinGapMs && now - this.lastExtraAt >= this.missRefreshMinGapMs) {
      this.lastExtraAt = now;
      return true;
    }
    return false;
  }

  private isExpired(cache: Cache): boolean {
    return this.now() - cache.fetchedAt >= this.ttlMs;
  }

  private find(name: string): ChannelLookup | null {
    const entry = this.cache?.byName.get(name);
    if (entry === undefined) return null;
    if (entry === "ambiguous") return unavailable("ambiguous");
    return { ok: true, channel: entry };
  }

  // Single-flight: concurrent callers share one refresh and one set of requests.
  private refresh(): Promise<RefreshResult> {
    this.inflight ??= this.fetchAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // Every page of the list, or a failure code. Replaces the cache only on success.
  private async fetchAll(): Promise<RefreshResult> {
    const startedAt = this.now();
    this.lastAttemptAt = startedAt;
    const deadline = startedAt + this.refreshDeadlineMs;

    const channels: ChannelInfo[] = [];
    let entries = 0;
    let wellFormed = 0;
    let cursor = "";

    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return { ok: false, failure: "bad_response" };

      const remaining = deadline - this.now();
      if (remaining <= 0) return { ok: false, failure: "timeout" };

      const answer = await this.request(cursor, Math.min(this.requestTimeoutMs, remaining));
      if (!answer.ok) return answer;

      const read = readPage(answer.body);
      if (!read.ok) return read;

      entries += read.entries;
      wellFormed += read.wellFormed;
      channels.push(...read.channels);

      if (read.nextCursor === "") break;
      cursor = read.nextCursor;
    }

    // Slack said "ok" and every entry it sent was unreadable: that is not an empty workspace,
    // it is an answer in a shape this code does not know.
    if (entries > 0 && wellFormed === 0) return { ok: false, failure: "bad_response" };

    this.cache = buildCache(channels, startedAt);
    return { ok: true };
  }

  // One page. The token travels ONLY as the Authorization header.
  //
  // How a failure is classified never depends on an error's text. A request is a timeout if OUR
  // timer fired — whatever the runtime then threw, and however it named it — and anything else
  // that was thrown is "network". `.message` is not read, on any path.
  private async request(
    cursor: string,
    timeoutMs: number,
  ): Promise<{ ok: true; body: unknown } | { ok: false; failure: DirectoryFailure }> {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(PAGE_SIZE),
    });
    if (cursor !== "") params.set("cursor", cursor);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${API}?${params.toString()}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.token}` },
          signal: controller.signal,
        });
      } catch {
        return { ok: false, failure: timedOut ? "timeout" : "network" };
      }

      // A 429 is a rate limit whatever its body says. Any other non-2xx is Slack failing in a
      // way it does not usually (recon: every measured failure was a 200 with ok:false).
      if (response.status === 429) return { ok: false, failure: "rate_limited" };
      if (!response.ok) return { ok: false, failure: "slack_error" };

      let text: string;
      try {
        text = await response.text();
      } catch {
        return { ok: false, failure: timedOut ? "timeout" : "network" };
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, failure: "bad_response" };
      }

      if (!isRecord(body)) return { ok: false, failure: "bad_response" };
      if (body["ok"] === false) return { ok: false, failure: slackFailure(body["error"]) };
      if (body["ok"] !== true) return { ok: false, failure: "bad_response" };
      return { ok: true, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

// The safe default when no bot token is configured: it never asks anyone, and says so.
export class UnavailableChannelDirectory implements ChannelDirectory {
  resolve(_input: string): Promise<ChannelLookup> {
    return Promise.resolve(unavailable("no_token"));
  }
}

function unavailable(failure: DirectoryFailure): ChannelLookup {
  return { ok: false, reason: "unavailable", failure };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Slack's `error` code → ours. The code is matched, never passed on: an unknown one is just
// "slack_error", so nothing Slack wrote reaches a caller.
function slackFailure(code: unknown): DirectoryFailure {
  if (typeof code !== "string") return "slack_error";
  if (AUTH_ERRORS.has(code)) return "auth";
  if (code === "ratelimited") return "rate_limited";
  return "slack_error";
}

type PageRead =
  | { ok: true; channels: ChannelInfo[]; entries: number; wellFormed: number; nextCursor: string }
  | { ok: false; failure: DirectoryFailure };

// One `ok: true` page → its usable channels and the next cursor ("" when it is the last).
//
// An entry without a string `id` and a non-empty string `name` is SKIPPED, not fatal: one odd
// conversation must not take every other channel down with it. An archived entry is well-formed
// and dropped (the request already asks Slack to leave them out; this is the second line).
function readPage(body: unknown): PageRead {
  if (!isRecord(body)) return { ok: false, failure: "bad_response" };
  const list = body["channels"];
  if (!Array.isArray(list)) return { ok: false, failure: "bad_response" };

  const channels: ChannelInfo[] = [];
  let wellFormed = 0;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const name = entry["name"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    wellFormed += 1;
    if (entry["is_archived"] === true) continue;
    channels.push({ id: asChannelId(id), name, isPrivate: entry["is_private"] === true });
  }

  const metadata = body["response_metadata"];
  const next = isRecord(metadata) ? metadata["next_cursor"] : undefined;
  return {
    ok: true,
    channels,
    entries: list.length,
    wellFormed,
    nextCursor: typeof next === "string" ? next : "",
  };
}

function buildCache(channels: readonly ChannelInfo[], fetchedAt: number): Cache {
  const byName = new Map<string, Entry>();
  for (const channel of channels) {
    const key = normalizeChannelName(channel.name);
    // Two channels one name: neither is picked, ever. Slack does not allow this today; if it
    // ever happens (a shared channel, a rename race), guessing would post to the wrong one.
    byName.set(key, byName.has(key) ? "ambiguous" : channel);
  }
  const names = [...new Set(channels.map((channel) => channel.name))];
  return { byName, names, fetchedAt };
}

// --- Suggestions ---
//
// Up to three real names close to what was asked, in a fixed order: names that START with it,
// then names that CONTAIN it, then names within a small edit distance of it — alphabetical
// within the first two, by distance then alphabetical within the third. Nothing for input under
// two characters: everything is "close" to one letter.
export function suggest(input: string, names: readonly string[]): string[] {
  if (input.length < 2) return [];

  const prefix: string[] = [];
  const substring: string[] = [];
  const near: { name: string; distance: number }[] = [];

  for (const name of names) {
    const key = normalizeChannelName(name);
    if (key === input) continue;
    if (key.startsWith(input)) {
      prefix.push(name);
    } else if (key.includes(input)) {
      substring.push(name);
    } else {
      const distance = editDistance(input, key);
      // Two edits, or a third of the longer name when that is more: "hepl" → "help" is two,
      // and a long name can absorb a proportionally larger slip.
      const allowed = Math.max(2, Math.floor(Math.max(input.length, key.length) / 3));
      if (distance <= allowed) near.push({ name, distance });
    }
  }

  const alphabetical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  prefix.sort(alphabetical);
  substring.sort(alphabetical);
  near.sort((a, b) => a.distance - b.distance || alphabetical(a.name, b.name));

  return [...prefix, ...substring, ...near.map((entry) => entry.name)].slice(0, 3);
}

// Optimal string alignment distance: Levenshtein plus adjacent transposition, so "hepl" is one
// slip from "help" rather than two.
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
    }
  }
  return d[a.length][b.length];
}
