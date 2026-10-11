// A scripted `fetch` standing in for Slack's Web API (M22), in the injected-fetch pattern of
// tests/googleCalendar.test.ts. It serves one scripted step per request, in order, and records
// every request so a test can assert what was SENT — the URL, the method, the headers.
//
// THE SHAPES ARE RECON, NOT DOCS (scripts/slack-recon.mjs, 2026-10-11). Slack reports its
// failures as HTTP 200 with `{ ok: false, error: "<code>" }` (`invalid_auth`, `not_authed`); the
// last page of conversations.list carries `response_metadata.next_cursor: ""`. A 429, a 500 and a
// non-JSON body were NOT captured live — Slack could not be made to produce them without abusing
// it — so those steps are the documented shapes, and are labelled as such where they are built.
//
// PRIVATE CHANNELS (recon, 2026-10-11). conversations.list lists a private channel ONLY when the
// bot is a member: with two private channels in the workspace and the bot added to one, only that
// one was listed. So a private channel the bot is not in is simply absent, and the directory
// answers "not found" for it — before any dialog. Private channel IDs now start with "C", like
// public ones (the old "G" prefix was not seen), so fixtures here use "C…" for both.
//
// Two failure steps are written to be as hostile as the real thing can be:
//   - `throw` rejects with an Error whose message QUOTES the URL and the Authorization header,
//     because that is what undici does for a malformed header (measured). A directory that put
//     `error.message` anywhere would leak the token, and the leak tests would see it.
//   - `hang` never answers until the request's AbortSignal fires — and with no signal, never at
//     all. A directory that forgot its timeout hangs the test rather than passing it. `hangBody`
//     does the same after the headers have arrived.

export interface RecordedRequest {
  url: string;
  method: string;
  // Lower-cased header names → values, exactly as sent.
  headers: Record<string, string>;
  // The body as sent, when it was a string (a chat.postMessage JSON body); undefined for a GET.
  body: string | undefined;
}

export type SlackStep =
  // One conversations.list page. `nextCursor` omitted → "" (the last page, as recon saw it).
  | { kind: "page"; channels: unknown[]; nextCursor?: string }
  // Any JSON body, HTTP 200 unless given — `{ ok: false, error: "invalid_auth" }` and friends.
  | { kind: "json"; body: unknown; status?: number }
  // A bare status (429, 500, …) with optional headers and body text. Documented shape, not recon.
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string }
  // HTTP 200 with a body that is not JSON.
  | { kind: "text"; body: string }
  | { kind: "throw" }
  | { kind: "hang" }
  // HTTP 200 and headers at once, then a body that never arrives until the request is aborted —
  // the request "answered", but its reading did not. Tells a timeout during the body read from a
  // network failure there, which nothing else here can.
  | { kind: "hangBody" };

export interface FakeSlackFetch {
  fetchFn: typeof globalThis.fetch;
  requests: RecordedRequest[];
  // Steps not yet served — a test can assert none were left over, or none were reached.
  remaining(): number;
}

export interface FakeSlackFetchOptions {
  // Called as each request arrives, before it is answered — e.g. to move an injected clock.
  onRequest?: (index: number) => void;
}

// A channel entry with the per-channel fields recon saw that the directory reads.
export function slackChannel(
  id: string,
  name: string,
  extra: { is_private?: boolean; is_archived?: boolean; is_member?: boolean } = {},
): Record<string, unknown> {
  return {
    id,
    name,
    name_normalized: name,
    is_channel: true,
    is_private: extra.is_private ?? false,
    is_archived: extra.is_archived ?? false,
    is_member: extra.is_member ?? false,
  };
}

// The pages of one list, `perPage` channels each, with cursors linking them.
export function pagesOf(channels: unknown[], perPage = 200): SlackStep[] {
  const steps: SlackStep[] = [];
  for (let start = 0; start < Math.max(channels.length, 1); start += perPage) {
    const chunk = channels.slice(start, start + perPage);
    const last = start + perPage >= channels.length;
    steps.push({ kind: "page", channels: chunk, nextCursor: last ? "" : `cursor-${start + perPage}` });
  }
  return steps;
}

export function fakeSlackFetch(steps: SlackStep[], options: FakeSlackFetchOptions = {}): FakeSlackFetch {
  const queue = [...steps];
  const requests: RecordedRequest[] = [];

  const fetchFn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    options.onRequest?.(requests.length - 1);

    const step = queue.shift();
    // Async like the real thing: every answer arrives on a later tick, never in the same one.
    return new Promise<Response>((resolve, reject) => {
      const answer = (): void => {
        if (step === undefined) {
          reject(new Error("fakeSlackFetch: no scripted response left"));
          return;
        }
        switch (step.kind) {
          case "page":
            resolve(
              json({
                ok: true,
                channels: step.channels,
                response_metadata: { next_cursor: step.nextCursor ?? "" },
              }),
            );
            return;
          case "json":
            resolve(json(step.body, step.status));
            return;
          case "status":
            resolve(new Response(step.body ?? "", { status: step.status, headers: step.headers ?? {} }));
            return;
          case "text":
            resolve(new Response(step.body, { status: 200, headers: { "content-type": "text/html" } }));
            return;
          case "throw":
            reject(
              new TypeError(`fetch failed: connect ECONNREFUSED for ${url} with ${headers["authorization"] ?? ""}`),
            );
            return;
          case "hang": {
            const signal = init?.signal;
            if (!signal) return; // never answers: a directory with no timeout hangs here
            const abort = (): void =>
              reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            return;
          }
          case "hangBody": {
            const signal = init?.signal;
            const body = new ReadableStream<Uint8Array>({
              start(stream) {
                // As undici does: aborting the request errors a body still being read.
                signal?.addEventListener(
                  "abort",
                  () => stream.error(signal.reason ?? new DOMException("This operation was aborted", "AbortError")),
                  { once: true },
                );
              },
            });
            resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
            return;
          }
        }
      };
      setTimeout(answer, 0);
    });
  }) as typeof globalThis.fetch;

  return { fetchFn, requests, remaining: () => queue.length };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
