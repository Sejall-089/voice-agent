import { describe, it, expect } from "vitest";
import { GoogleCalendar } from "../src/core/calendar/GoogleCalendar.ts";
import { CalendarAuthError, UserFixableError } from "../src/core/errors.ts";
import type { CalendarAuth } from "../src/core/calendar/CalendarAuth.ts";

// GoogleCalendar was deliberately left untested when M13 shipped — thin transport, the same
// call made for ChromeGmail. The first live run showed that was half right. Request SHAPING is
// only provable against the real API; error CLASSIFICATION is ordinary logic, and it was wrong
// in a way that made a working connection look revoked. So the logic is tested now, with an
// injected fetch, and the shaping still isn't — because it still can't be.
//
// The 403 body below is the real one, captured from the live account.

const SCOPE_403 = JSON.stringify({
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    errors: [
      { message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" },
    ],
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
        metadata: { service: "calendar-json.googleapis.com", method: "calendar.v3.Calendars.Get" },
      },
    ],
  },
});

function fakeAuth() {
  const auth = {
    invalidated: 0,
    getAccessToken: () => Promise.resolve("access-token"),
    invalidate: () => {
      auth.invalidated += 1;
    },
  };
  return auth as CalendarAuth & { invalidated: number };
}

function calendar(
  responses: { status?: number; body?: unknown }[],
  auth: CalendarAuth = fakeAuth(),
) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let index = 0;

  const fetchFn = ((url: string, init?: RequestInit) => {
    urls.push(String(url));
    inits.push(init);
    const next = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const status = next.status ?? 200;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof globalThis.fetch;

  return { instance: new GoogleCalendar({ auth, fetchFn }), urls, inits };
}

describe("reading the calendar's timezone", () => {
  // The regression test for M13's first live bug.
  it("asks the events collection, never /calendars/primary", async () => {
    const { instance, urls } = calendar([{ body: { timeZone: "Asia/Kolkata", items: [] } }]);

    expect(await instance.calendarTimeZone()).toBe("Asia/Kolkata");

    // `/calendars/primary` is the Calendars resource, which the calendar.events scope does not
    // grant. Asking for it returned 403 on every single calendar instruction, while the token
    // itself was perfectly valid.
    expect(urls[0]).toContain("/calendars/primary/events");
    expect(urls[0]).not.toMatch(/\/calendars\/primary(\?|$)/);
  });

  it("reads it once and remembers it", async () => {
    const { instance, urls } = calendar([{ body: { timeZone: "Asia/Kolkata" } }]);

    await instance.calendarTimeZone();
    await instance.calendarTimeZone();

    expect(urls).toHaveLength(1);
  });

  it("takes it for free from a listing, so it costs no request of its own", async () => {
    const { instance, urls } = calendar([{ body: { timeZone: "Europe/Berlin", items: [] } }]);

    await instance.listUpcoming("2026-08-26T00:00:00Z", "2026-08-27T00:00:00Z", 10);
    expect(await instance.calendarTimeZone()).toBe("Europe/Berlin");

    // readSchedule now costs exactly one HTTP call, not two.
    expect(urls).toHaveLength(1);
  });

  it("falls back to UTC rather than guessing a plausible zone", async () => {
    const { instance } = calendar([{ body: { items: [] } }]);
    expect(await instance.calendarTimeZone()).toBe("UTC");
  });
});

describe("classifying a 403", () => {
  // M13's second live bug: every 403 was read as a revocation, so the app told the user to
  // reconnect — and reconnecting requests the same permissions, so it could never have worked.
  it("reads an insufficient scope as exactly that, not as a revocation", async () => {
    const { instance } = calendar([{ status: 403, body: SCOPE_403 }]);

    const error = await instance.calendarTimeZone().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as CalendarAuthError).reason).toBe("insufficient-scope");
    expect((error as Error).message).toContain("not allowed to do that");
    // The message must not promise that reconnecting fixes it, because usually it doesn't.
    expect((error as Error).message).not.toMatch(/revoked/i);
  });

  it("tells you to enable the API when that's the actual problem", async () => {
    const { instance } = calendar([
      {
        status: 403,
        body: { error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } },
      },
    ]);

    const error = await instance.calendarTimeZone().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserFixableError);
    expect(error).not.toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toContain("isn't enabled");
  });

  it("treats a rate limit as transient, not as anything to reconnect", async () => {
    const { instance } = calendar([
      { status: 403, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } } },
    ]);

    const error = await instance.calendarTimeZone().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(UserFixableError);
    expect((error as Error).message).toMatch(/rate-limiting/i);
  });

  it("names the reason code on a 403 it doesn't recognise", async () => {
    const { instance } = calendar([
      { status: 403, body: { error: { code: 403, errors: [{ reason: "somethingNew" }] } } },
    ]);

    await expect(instance.calendarTimeZone()).rejects.toThrow(/HTTP 403, somethingNew/);
  });

  it("does not fall over on a 403 with an unparseable body", async () => {
    const { instance } = calendar([{ status: 403, body: "<html>nope</html>" }]);
    await expect(instance.calendarTimeZone()).rejects.toThrow(/HTTP 403/);
  });
});

describe("classifying everything else", () => {
  it("drops the token and says expired on a 401", async () => {
    const auth = fakeAuth();
    const { instance } = calendar([{ status: 401, body: {} }], auth);

    const error = await instance.calendarTimeZone().catch((e: unknown) => e);

    expect((error as CalendarAuthError).reason).toBe("expired");
    // Dropped, so the next instruction fetches a fresh one instead of reusing something
    // Google has already refused.
    expect(auth.invalidated).toBe(1);
  });

  it("never echoes a response body back on a server error", async () => {
    // Google's error bodies can quote event content — someone's meeting title is not ours to
    // put in an error message.
    const { instance } = calendar([
      { status: 500, body: { error: { message: "Lunch with Dr Patel — oncology" } } },
    ]);

    const error = await instance.calendarTimeZone().catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      "Google Calendar refused the request (HTTP 500).",
    );
    expect((error as Error).message).not.toContain("Patel");
  });
});

describe("writing", () => {
  it("patches a move rather than replacing the event", async () => {
    const { instance, urls, inits } = calendar([
      { body: { timeZone: "Asia/Kolkata" } },
      {
        body: {
          id: "evt1",
          summary: "Design review",
          start: { dateTime: "2026-08-26T16:00:00+05:30" },
          end: { dateTime: "2026-08-26T17:00:00+05:30" },
        },
      },
    ]);

    await instance.moveEvent("evt1", "2026-08-26T16:00:00+05:30", "2026-08-26T17:00:00+05:30");

    // PATCH, so a description or meeting link this app never modelled cannot be erased.
    expect(inits[1]?.method).toBe("PATCH");
    expect(urls[1]).toContain("sendUpdates=all");
    // Times and nothing else.
    expect(Object.keys(JSON.parse(String(inits[1]?.body))).sort()).toEqual(["end", "start"]);
  });

  it("asks Google to actually email the guests it promised to email", async () => {
    const { instance, urls, inits } = calendar([
      { body: { timeZone: "Asia/Kolkata" } },
      {
        body: {
          id: "new1",
          summary: "Design sync",
          start: { dateTime: "2026-08-26T15:00:00+05:30" },
          end: { dateTime: "2026-08-26T16:00:00+05:30" },
          attendees: [{ email: "alex@example.com" }],
        },
      },
    ]);

    const created = await instance.createEvent({
      title: "Design sync",
      start: "2026-08-26T15:00:00+05:30",
      end: "2026-08-26T16:00:00+05:30",
      attendees: ["alex@example.com"],
    });

    // The confirm dialog told the user their guests would be emailed. If this parameter were
    // missing, that dialog would have been a lie.
    expect(inits[1]?.method).toBe("POST");
    expect(urls[1]).toContain("sendUpdates=all");
    expect(created.attendees).toEqual(["alex@example.com"]);
  });
});
