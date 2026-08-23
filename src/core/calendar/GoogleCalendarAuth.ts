import { calendarAuthError } from "../errors.ts";
import type { CalendarAuth, FetchLike } from "./CalendarAuth.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Refresh this long before the token actually dies. A token that expires mid-request is a
// failure the user sees; a token refreshed a minute early costs one HTTP call nobody notices.
const EXPIRY_SKEW_MS = 60_000;

// If Google does not say how long the token lasts, assume the shortest thing that is still
// useful rather than the longest. Being wrong short means an extra refresh; being wrong long
// means handing out a dead token.
const DEFAULT_LIFETIME_MS = 5 * 60_000;

export interface GoogleCalendarAuthOptions {
  clientId: string;
  clientSecret: string;
  // Obtained once by `npm run calendar:connect` and pasted into .env. A SECRET: it never
  // appears in a log line, an error message, or a thrown string (spec §10).
  refreshToken: string | undefined;
  // Injected so the token exchange is testable without a network. Defaults to real `fetch`.
  fetchFn?: FetchLike;
  now?: () => number;
}

// The real `CalendarAuth`: exchanges a long-lived refresh token for short-lived access tokens.
//
// The access token is held in MEMORY only, never written anywhere. The refresh token lives in
// `.env` and is the only thing that persists — which is the whole reason this class is small.
// A token file would have meant a second secret store, a file format to keep in sync with the
// connect script, and the first exception to this repo's "secrets only from .env" rule.
export class GoogleCalendarAuth implements CalendarAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  private accessToken: string | null = null;
  private expiresAt = 0;
  // The single in-flight refresh. Two tools in one instruction must not both go and get a
  // token — Google would issue two, and the second would quietly invalidate the first.
  private refreshing: Promise<string> | null = null;

  constructor(options: GoogleCalendarAuthOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    // Refuse BEFORE reaching the network. There is nothing to ask Google for, and a request
    // that cannot succeed should not be made — it would only turn a clear "you haven't
    // connected yet" into whatever Google's error happens to say.
    if (this.refreshToken === undefined || this.refreshToken.length === 0) {
      throw calendarAuthError("not-connected");
    }

    if (this.accessToken !== null && this.now() < this.expiresAt - EXPIRY_SKEW_MS) {
      return this.accessToken;
    }

    // Everyone who arrives during a refresh waits on the same one.
    this.refreshing ??= this.refresh(this.refreshToken).finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  // Strike the two secrets out of text that came from somewhere else. Everything this file
  // writes itself is secret-free by construction; this is for the one message that isn't.
  private redact(text: string): string {
    let safe = text;
    for (const secret of [this.refreshToken, this.clientSecret]) {
      if (secret !== undefined && secret.length > 0) safe = safe.split(secret).join("[redacted]");
    }
    return safe;
  }

  private async refresh(refreshToken: string): Promise<string> {
    let response;
    try {
      response = await this.fetchFn(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      });
    } catch (error) {
      // A network failure is a MALFUNCTION, not something the user can fix by reconnecting.
      // Calling this "revoked" would send them through a consent flow to cure a dropped wifi
      // connection — so the cause is kept, because ENOTFOUND and ETIMEDOUT are worth telling
      // apart. It is REDACTED first: this is the one message built out of a string this code
      // did not write, and an HTTP client is entitled to quote the request it failed to send.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach Google to refresh calendar access: ${this.redact(message)}`,
      );
    }

    const body = await response.text();

    if (!response.ok) {
      // `invalid_grant` is Google's answer for a refresh token that no longer works — revoked
      // in the account's security settings, or aged out because the Cloud project is still in
      // "Testing" (those expire after 7 days; see .env.example). The two are indistinguishable
      // from the response, and the fix is the same, so they share one reason.
      if (errorCode(body) === "invalid_grant") {
        throw calendarAuthError("revoked");
      }
      // Anything else — a 500, a rate limit, a misconfigured client — is a real failure.
      // Reports the STATUS only: the request body held the client secret and the refresh token.
      throw new Error(`Google refused to refresh calendar access (HTTP ${response.status}).`);
    }

    const token = parseToken(body);
    this.accessToken = token.accessToken;
    this.expiresAt = this.now() + token.lifetimeMs;
    return token.accessToken;
  }
}

// Google returns `{"error": "invalid_grant", ...}`. Parsed defensively: an unparseable body is
// simply "not invalid_grant", which routes to the generic failure — the safe way round, since
// the alternative would be telling someone to reconnect over a malformed 502.
function errorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const code = (parsed as { error: unknown }).error;
      return typeof code === "string" ? code : null;
    }
  } catch {
    return null;
  }
  return null;
}

function parseToken(body: string): { accessToken: string; lifetimeMs: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Google's reply to the calendar token request wasn't readable.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Google's reply to the calendar token request wasn't readable.");
  }

  const record = parsed as { access_token?: unknown; expires_in?: unknown };
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // A 200 with no token in it. Loud, because silently carrying on would produce an
    // unauthenticated request whose failure looks like something else entirely.
    throw new Error("Google's reply to the calendar token request had no access token in it.");
  }

  const expiresIn = record.expires_in;
  const lifetimeMs =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1000
      : DEFAULT_LIFETIME_MS;

  return { accessToken, lifetimeMs };
}
