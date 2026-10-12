import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackSender } from "../src/core/senders/SlackSender.ts";
import { fakeSlackFetch } from "./fakeSlackFetch.ts";

// M23-pre (M22 leftover): the WEBHOOK post had no timeout — a webhook that never answered held
// the send forever. It is now cut off after `requestTimeoutMs` (default 10 s) and ends in exactly
// the words any other unanswered request already did, so no webhook text changes.

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOKPART";
const NO_ANSWER = "Could not reach Slack: the request did not get an answer.";
const FORBIDDEN = ["SECRETWEBHOOKPART", "hooks.slack.com", "Bearer", "aborted", "AbortError"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe("SlackSender: the webhook post has a timeout", () => {
  it("ends a post that never answers, with the existing fixed text", async () => {
    const lines = captureConsole();
    const slack = fakeSlackFetch([{ kind: "hang" }]);
    const sender = new SlackSender(WEBHOOK, undefined, { fetchFn: slack.fetchFn, requestTimeoutMs: 20 });

    const started = Date.now();
    const result = await sender.send("#help", "hi");

    expect(result).toEqual({ ok: false, error: NO_ANSWER });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slack.requests).toHaveLength(1); // never retried
    for (const text of [JSON.stringify(result), ...lines]) {
      for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden);
    }
    expect(lines).toEqual([]);
  }, 3_000);

  it("ends a post whose headers came but whose body never does — the same text", async () => {
    const slack = fakeSlackFetch([{ kind: "hangBody" }]);
    const sender = new SlackSender(WEBHOOK, undefined, { fetchFn: slack.fetchFn, requestTimeoutMs: 20 });
    // A webhook's success is read from the status alone, so headers arriving is an answer.
    expect(await sender.send("#help", "hi")).toEqual({ ok: true });
  });

  it("uses the runtime's own fetch, with the timeout, when none is handed in", async () => {
    let signalled: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signalled = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException(`aborted ${WEBHOOK}`, "AbortError")));
        });
      }),
    );
    const sender = new SlackSender(WEBHOOK, undefined, { requestTimeoutMs: 20 });
    expect(await sender.send("#help", "hi")).toEqual({ ok: false, error: NO_ANSWER });
    expect(signalled?.aborted).toBe(true);
  }, 3_000);

  it("defaults to 10 s: a post answered well within it is not cut off", async () => {
    const slack = fakeSlackFetch([{ kind: "status", status: 200 }]);
    const sender = new SlackSender(WEBHOOK, undefined, { fetchFn: slack.fetchFn });
    expect(await sender.send("#help", "hi")).toEqual({ ok: true });
  });
});

describe("SlackSender: the existing results are unchanged", () => {
  it("success", async () => {
    const slack = fakeSlackFetch([{ kind: "status", status: 200, body: "ok" }]);
    expect(await new SlackSender(WEBHOOK, "#social", { fetchFn: slack.fetchFn }).send("#help", "hi")).toEqual({ ok: true });
    // It posts to the webhook, with the text and the asked channel, as before.
    expect(slack.requests[0]?.url).toBe(WEBHOOK);
    expect(JSON.parse(slack.requests[0]?.body ?? "{}")).toEqual({ text: "hi", channel: "#help" });
  });

  it.each([404, 500, 403])("HTTP %i: the status only", async (status) => {
    const slack = fakeSlackFetch([{ kind: "status", status, body: `no ${WEBHOOK}` }]);
    const result = await new SlackSender(WEBHOOK, undefined, { fetchFn: slack.fetchFn }).send("#help", "hi");
    expect(result).toEqual({ ok: false, error: `Slack rejected the message (HTTP ${status}).` });
  });

  it("a network error: the same fixed text, nothing of the error", async () => {
    const slack = fakeSlackFetch([{ kind: "throw" }]);
    const result = await new SlackSender(WEBHOOK, undefined, { fetchFn: slack.fetchFn }).send("#help", "hi");
    expect(result).toEqual({ ok: false, error: NO_ANSWER });
    for (const forbidden of FORBIDDEN) expect(JSON.stringify(result)).not.toContain(forbidden);
  });

  it("no webhook configured: unchanged", async () => {
    expect(await new SlackSender(undefined).send("#help", "hi")).toEqual({
      ok: false,
      error: "SLACK_WEBHOOK_URL is not set in .env.",
    });
  });
});
