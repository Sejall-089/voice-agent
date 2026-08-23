import { describe, it, expect } from "vitest";
import { GoogleCalendarAuth } from "../src/core/calendar/GoogleCalendarAuth.ts";
import { CalendarAuthError } from "../src/core/errors.ts";
import type { FetchLike, TokenResponse } from "../src/core/calendar/CalendarAuth.ts";

// The one piece of M13 that talks to Google directly, tested with an injected `fetch` so no
// test in this repo has ever made a real token request or run a real consent flow.
//
// What this proves: the refresh logic, the caching, the single-flight guard, and — the part
// that matters most — that a failure is classified honestly. "Reconnect your calendar" and
// "Google is down" are different problems, and telling someone the wrong one sends them
// through a consent flow to fix their wifi.

const SECRET = "super-secret-client-secret";
const REFRESH = "1//refresh-token-value";

interface Call {
  url: string;
  body: string;
}

function fakeFetch(
  responses: (Partial<TokenResponse> & { body?: string })[],
  calls: Call[] = [],
): { fetchFn: FetchLike; calls: Call[] } {
  let index = 0;
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, body: init.body });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const body = next?.body ?? "";
    return Promise.resolve({
      ok: next?.ok ?? true,
      status: next?.status ?? 200,
      text: () => Promise.resolve(body),
    });
  };
  return { fetchFn, calls };
}

function okToken(accessToken = "access-1", expiresIn = 3600): { body: string } {
  return { body: JSON.stringify({ access_token: accessToken, expires_in: expiresIn }) };
}

function auth(
  options: {
    refreshToken?: string | undefined;
    fetchFn?: FetchLike;
    now?: () => number;
  } = {},
) {
  return new GoogleCalendarAuth({
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: SECRET,
    refreshToken: "refreshToken" in options ? options.refreshToken : REFRESH,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("getting a token", () => {
  it("exchanges the refresh token for an access token", async () => {
    const { fetchFn, calls } = fakeFetch([okToken()]);

    expect(await auth({ fetchFn }).getAccessToken()).toBe("access-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
  });

  it("reuses a cached token instead of refreshing on every call", async () => {
    const { fetchFn, calls } = fakeFetch([okToken()]);
    const instance = auth({ fetchFn, now: () => 1_000 });

    await instance.getAccessToken();
    await instance.getAccessToken();
    await instance.getAccessToken();

    expect(calls).toHaveLength(1);
  });

  it("refreshes early rather than handing out a token about to die", async () => {
    // A token that expires mid-request is a failure the user sees. One refreshed a minute
    // early costs an HTTP call nobody notices.
    let clock = 0;
    const { fetchFn, calls } = fakeFetch([okToken("access-1", 3600), okToken("access-2", 3600)]);
    const instance = auth({ fetchFn, now: () => clock });

    expect(await instance.getAccessToken()).toBe("access-1");

    // 30s before expiry: inside the skew, so it does not get reused.
    clock = 3600_000 - 30_000;
    expect(await instance.getAccessToken()).toBe("access-2");
    expect(calls).toHaveLength(2);
  });

  it("still reuses the token just outside the skew window", async () => {
    let clock = 0;
    const { fetchFn, calls } = fakeFetch([okToken("access-1", 3600)]);
    const instance = auth({ fetchFn, now: () => clock });

    await instance.getAccessToken();
    clock = 3600_000 - 90_000; // 90s left: still comfortably usable
    expect(await instance.getAccessToken()).toBe("access-1");
    expect(calls).toHaveLength(1);
  });

  it("only refreshes once when several callers arrive at the same moment", async () => {
    // Two tools in one instruction both wanting a token. Google would issue two, and the
    // second would quietly invalidate the first.
    const { fetchFn, calls } = fakeFetch([okToken()]);
    const instance = auth({ fetchFn });

    const tokens = await Promise.all([
      instance.getAccessToken(),
      instance.getAccessToken(),
      instance.getAccessToken(),
    ]);

    expect(tokens).toEqual(["access-1", "access-1", "access-1"]);
    expect(calls).toHaveLength(1);
  });

  it("fetches again after being told the token was rejected", async () => {
    const { fetchFn, calls } = fakeFetch([okToken("access-1"), okToken("access-2")]);
    const instance = auth({ fetchFn, now: () => 0 });

    expect(await instance.getAccessToken()).toBe("access-1");
    instance.invalidate();
    expect(await instance.getAccessToken()).toBe("access-2");
    expect(calls).toHaveLength(2);
  });

  it("assumes a short life when Google doesn't say how long the token lasts", async () => {
    let clock = 0;
    const { fetchFn, calls } = fakeFetch([
      { body: JSON.stringify({ access_token: "access-1" }) },
      okToken("access-2"),
    ]);
    const instance = auth({ fetchFn, now: () => clock });

    await instance.getAccessToken();
    clock = 5 * 60_000; // past the assumed 5-minute lifetime
    await instance.getAccessToken();

    // Wrong-and-short costs a refresh. Wrong-and-long hands out a dead token.
    expect(calls).toHaveLength(2);
  });
});

describe("classifying a failure", () => {
  it("refuses without touching the network when nothing is connected", async () => {
    const { fetchFn, calls } = fakeFetch([okToken()]);
    const instance = auth({ refreshToken: undefined, fetchFn });

    await expect(instance.getAccessToken()).rejects.toBeInstanceOf(CalendarAuthError);
    await expect(instance.getAccessToken()).rejects.toThrow(/not connected/i);
    // There is nothing to ask Google for. A doomed request would only replace a clear message
    // with whatever Google's error happens to say.
    expect(calls).toHaveLength(0);
  });

  it("treats an empty refresh token the same as a missing one", async () => {
    const { fetchFn, calls } = fakeFetch([okToken()]);
    await expect(auth({ refreshToken: "", fetchFn }).getAccessToken()).rejects.toThrow(
      /not connected/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("reads Google's invalid_grant as a revoked connection", async () => {
    const { fetchFn } = fakeFetch([
      { ok: false, status: 400, body: JSON.stringify({ error: "invalid_grant" }) },
    ]);

    const error = await auth({ fetchFn }).getAccessToken().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as CalendarAuthError).reason).toBe("revoked");
    expect((error as Error).message).toContain("npm run calendar:connect");
  });

  it("does NOT call a server error a revoked connection", async () => {
    // The distinction this test exists for: reconnecting cannot fix a 500, and sending someone
    // through a consent flow to cure an outage is worse than saying nothing useful.
    const { fetchFn } = fakeFetch([{ ok: false, status: 503, body: "upstream unavailable" }]);

    const error = await auth({ fetchFn }).getAccessToken().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toContain("503");
  });

  it("does NOT call a dropped connection a revoked connection either", async () => {
    const fetchFn: FetchLike = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

    const error = await auth({ fetchFn }).getAccessToken().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toMatch(/could not reach google/i);
  });

  it("is loud about a 200 with no token in it", async () => {
    // Carrying on would produce an unauthenticated request whose failure looks like a
    // different problem entirely.
    const { fetchFn } = fakeFetch([{ body: JSON.stringify({ scope: "calendar" }) }]);
    await expect(auth({ fetchFn }).getAccessToken()).rejects.toThrow(/no access token/i);
  });

  it("treats an unreadable error body as a generic failure, not a revocation", async () => {
    const { fetchFn } = fakeFetch([{ ok: false, status: 502, body: "<html>bad gateway</html>" }]);

    const error = await auth({ fetchFn }).getAccessToken().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toContain("502");
  });
});

describe("secrets", () => {
  it("never puts the refresh token or the client secret in an error", async () => {
    // spec §10. Every failure path, because it only takes one to leak.
    const failures: FetchLike[] = [
      fakeFetch([{ ok: false, status: 400, body: JSON.stringify({ error: "invalid_grant" }) }])
        .fetchFn,
      fakeFetch([{ ok: false, status: 503, body: "nope" }]).fetchFn,
      fakeFetch([{ body: "{}" }]).fetchFn,
      fakeFetch([{ body: "not json at all" }]).fetchFn,
      () => Promise.reject(new Error(`boom while sending ${REFRESH}`)),
    ];

    for (const fetchFn of failures) {
      const error = await auth({ fetchFn }).getAccessToken().catch((e: unknown) => e);
      const text = `${(error as Error).message}\n${(error as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(REFRESH);
    }
  });
});
