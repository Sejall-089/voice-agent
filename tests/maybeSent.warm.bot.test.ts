import { afterEach, describe, expect, it, vi } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { SlackChannelDirectory } from "../src/core/senders/SlackChannelDirectory.ts";
import { SlackBotSender } from "../src/core/senders/SlackBotSender.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { ToolChoice } from "../src/core/types.ts";
import { fakeSlackFetch, pagesOf, slackChannel, type SlackStep } from "./fakeSlackFetch.ts";

// M22 prompt 11 — live checklist step 10.2, covered by a test instead of a person with Wi-Fi off
// (NOT human-watched). The "warm list" case: the channel list was read a minute ago, so the app
// still believes #help exists and shows the dialog; then the post itself fails. Everything real
// except Slack: the real directory and the real bot sender on ONE scripted fetch, the real
// planner and tool, MockShell for the dialog.
//
// What it pins: the user is told the message MAY have been sent and to check before trying again;
// the second run read no channel list (the cache was warm) and posted exactly once (never
// retried); and the token, "Bearer" and Slack's URL appear nowhere a person or a log could see.

const TOKEN = "xoxb-test-WARM-SECRET-5150";
const HELP_ID = "C0000000001";
const MAYBE =
  "Something went wrong: Could not confirm the message to #help. It may have been sent. Check Slack before trying again.";
const FORBIDDEN = [TOKEN, "Bearer", "slack.com", "ECONNREFUSED", "fetch failed"];

const send: ToolChoice = { kind: "tool", name: "sendMessage", input: { channel: "#help", notes: "ship it" } };
const POSTED_OK: SlackStep = { kind: "json", body: { ok: true, channel: HELP_ID, ts: "1700000000.000100" } };

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(secondPost: SlackStep) {
  const clock = { t: 0 };
  const slack = fakeSlackFetch([
    ...pagesOf([slackChannel(HELP_ID, "help"), slackChannel("C0000000002", "social")]),
    POSTED_OK,
    secondPost,
  ]);
  const directory = new SlackChannelDirectory({ token: TOKEN, fetchFn: slack.fetchFn, now: () => clock.t });
  const sender = new SlackBotSender({ token: TOKEN, directory, fetchFn: slack.fetchFn, requestTimeoutMs: 30 });
  const memory = new SqliteMemory(createDatabase(":memory:"));
  const log = new InMemoryActionLog();
  const shell = new MockShell({
    context: { selectedText: null, activeApp: null, activeWindowTitle: null },
    confirms: [true, true],
  });
  const run = (instruction: string) =>
    new Planner(
      // A fresh planning answer each run; the rest is shared, as in the running app.
      { chooseTool: () => Promise.resolve(send), complete: () => Promise.resolve("") },
      shell,
      registry,
      memory,
      log,
      sender,
      undefined, // gmail
      undefined, // draft
      undefined, // notion
      undefined, // calendar
      undefined, // speech
      undefined, // screen
      undefined, // elements
      undefined, // chooser
      () => Promise.resolve(),
      undefined, // chain state
      directory,
    ).run(instruction);

  const captured: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  }
  return { clock, slack, shell, log, run, captured };
}

describe.each([
  { label: "a network error that quotes the token and URL", secondPost: { kind: "throw" } as SlackStep },
  { label: "a post that never answers (timeout)", secondPost: { kind: "hang" } as SlackStep },
])("warm list, then the post fails: $label", ({ secondPost }) => {
  it("shows the dialog, then says it MAY have been sent — after one post and no list read", async () => {
    const h = setup(secondPost);

    // 1. A send that works, which reads the channel list and leaves it warm.
    const first = await h.run("send 'ship it' to #help");
    expect(first.status).toBe("ok");
    expect(h.shell.results).toEqual(["Sent to #help.\n\nship it"]);
    const afterFirst = h.slack.requests.length;
    expect(h.slack.requests.filter((r) => r.url.includes("conversations.list"))).toHaveLength(1);

    // 2. A minute later — well inside the 10-minute list — the same send, and the post fails.
    h.clock.t = 60_000;
    const second = await h.run("send 'ship it' to #help");

    expect(h.shell.confirmMessages).toEqual(["Send to #help?\n\nship it", "Send to #help?\n\nship it"]);
    expect(second.status).toBe("error");
    expect(h.shell.results.at(-1)).toBe(MAYBE);

    const secondRequests = h.slack.requests.slice(afterFirst);
    expect(secondRequests.filter((r) => r.url.includes("conversations.list"))).toEqual([]);
    expect(secondRequests.filter((r) => r.url.includes("chat.postMessage"))).toHaveLength(1);
    expect(secondRequests).toHaveLength(1);

    expect(h.log.entries.at(-1)).toMatchObject({ tool: "sendMessage", status: "error" });

    // Nowhere a person or a log could see it.
    const everywhere = [
      ...h.shell.results,
      ...h.shell.confirmMessages,
      JSON.stringify(second),
      JSON.stringify(h.log.entries),
      ...h.captured,
    ];
    for (const text of everywhere) {
      for (const forbidden of FORBIDDEN) expect(text, `found ${forbidden}`).not.toContain(forbidden);
    }
  });
});
