import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackSender } from "../src/core/senders/SlackSender.ts";
import { GoogleCalendar } from "../src/core/calendar/GoogleCalendar.ts";
import type { CalendarAuth } from "../src/core/calendar/CalendarAuth.ts";

// M22 prompt 3. Both of these used to put a failed fetch's `error.message` into what the user
// is shown — and from there into the action log and the next planning prompt. An HTTP client is
// entitled to quote the request it failed to send: undici's error for a malformed URL quotes the
// URL, and for a malformed header quotes the header, `Bearer` and token included (measured, M22
// recon). Each fetch below throws exactly that kind of message, and nothing of it may come back.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlackSender: a failed fetch does not leak the webhook URL", () => {
  const WEBHOOK = "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOKPART";

  it("returns a fixed message, with neither the URL nor the client's own words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError(`Failed to parse URL from ${WEBHOOK}: fetch failed ECONNREFUSED`))),
    );
    const result = await new SlackSender(WEBHOOK).send("#help", "hi");

    expect(result).toEqual({ ok: false, error: "Could not reach Slack: the request did not get an answer." });
    const said = JSON.stringify(result);
    for (const forbidden of ["SECRETWEBHOOKPART", "hooks.slack.com", "Failed to parse", "ECONNREFUSED"]) {
      expect(said).not.toContain(forbidden);
    }
  });
});

describe("GoogleCalendar: a failed fetch does not leak the access token", () => {
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN";

  it("throws a fixed message, with neither the token, the URL nor the client's own words", async () => {
    const auth = {
      getAccessToken: () => Promise.resolve(TOKEN),
      invalidate: () => undefined,
    } as CalendarAuth;
    const fetchFn = ((url: string) =>
      Promise.reject(
        new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value. (${url})`),
      )) as unknown as typeof globalThis.fetch;

    const error = await new GoogleCalendar({ auth, fetchFn }).getEvent("abc").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("Could not reach Google Calendar: the request did not get an answer.");
    for (const forbidden of [TOKEN, "Bearer", "googleapis.com", "Headers.append"]) {
      expect(message).not.toContain(forbidden);
    }
  });
});
