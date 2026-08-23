// Supplying a usable Google access token, behind an interface like LLMClient and MessageSender.
//
// Deliberately NOT part of ToolDeps and never handed to a tool. `GoogleCalendar` owns one; the
// tools own a `CalendarSurface` and know nothing about tokens — the same way the Gmail tools
// know nothing about `CdpSession`. That is what lets `FakeCalendar` exist without faking an
// OAuth flow at all, which is the thing there is no honest way to fake.
//
// Everything here throws `CalendarAuthError` with a NAMED reason rather than a generic failure.
// "I was never connected", "it aged out" and "Google cut it off" are three different facts about
// the world, all fixable by the user in about a minute, and none of them are a malfunction.
export interface CalendarAuth {
  // A valid access token, refreshing first if the cached one is gone or nearly gone.
  // Throws CalendarAuthError when there is no way to get one.
  getAccessToken(): Promise<string>;
  // Tell it the token it just handed out was rejected, so the next call fetches a fresh one
  // instead of confidently reusing something Google has already refused.
  invalidate(): void;
}

// The slice of `fetch` this needs, declared rather than imported. Keeps the token exchange
// injectable in tests (there is no real network anywhere in this suite) and keeps `/core` free
// of `any` at the edge.
export interface TokenResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TokenResponse>;
