import { describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { UnresolvedReferenceError, UserFixableError } from "../src/core/errors.ts";
import { sendMessageTool } from "../src/core/tools/sendMessage.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { SEND_ERRORS, SlackBotSender } from "../src/core/senders/SlackBotSender.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  ChannelDirectory,
  DirectoryFailure,
  MessageSender,
  SendResult,
  ToolChoice,
  ToolDeps,
  ToolInput,
} from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";
import { fakeSlackFetch } from "./fakeSlackFetch.ts";

// M22 prompt 4. sendMessage with a BOT-mode sender: the channel asked for is checked against
// Slack's own list (a ChannelDirectory) before any dialog, and the texts name the real
// destination. The directory fake answers after a delay, so a check that was not awaited would
// let the dialog through and fail these tests.

const NOTES = "standup: shipped the directory, next up the bot texts";

// A FakeSender that says what a SlackBotSender says about itself.
class FakeBotSender extends FakeSender {
  readonly mode = "bot" as const;
}

const CHANNELS = [
  { id: "C0000000001", name: "help" },
  { id: "C0000000002", name: "social" },
  { id: "C0000000003", name: "helpdesk" },
  { id: "C0000000004", name: "help-desk" },
  { id: "C0000000005", name: "devops" },
  { id: "C0000000006", name: "dev-help" },
];

const directoryWith = (options: { unavailable?: DirectoryFailure[] } = {}) =>
  new FakeChannelDirectory({ channels: CHANNELS, delayMs: 5, ...options });

interface SessionOptions {
  sender?: MessageSender;
  // null: bot mode with NO directory handed to the planner.
  directory?: ChannelDirectory | null;
  selectedText?: string | null;
  confirms?: boolean[];
  facts?: Record<string, string>;
}

function session(options: SessionOptions = {}) {
  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  for (const [subject, value] of Object.entries(options.facts ?? {})) memory.write(subject, value);
  const shell = new MockShell({
    context: {
      selectedText: options.selectedText === undefined ? NOTES : options.selectedText,
      activeApp: null,
      activeWindowTitle: null,
    },
    confirms: options.confirms ?? [true, true, true],
  });
  const sender = options.sender ?? new FakeBotSender();
  const directory = options.directory === undefined ? directoryWith() : options.directory;
  let llm: FakeLLM | null = null;

  const turn = (choice: ToolChoice, instruction: string, completion = "FORMATTED") => {
    llm = new FakeLLM(choice, completion);
    const planner = new Planner(
      llm,
      shell,
      registry,
      memory,
      memory,
      sender,
      undefined, // gmail
      undefined, // draft
      undefined, // notion
      undefined, // calendar
      undefined, // speech
      undefined, // screen
      undefined, // elements
      undefined, // chooser
      () => Promise.resolve(), // sleep: skip the chain preview hold
      undefined, // chain state
      directory ?? undefined,
    );
    return planner.run(instruction);
  };

  const logRows = () =>
    db.prepare<[], { tool: string | null; status: string }>("SELECT tool, status FROM action_log").all();
  const sends = () => (sender as FakeSender).calls;
  // Everything a person was shown, in order.
  const texts = () => [...shell.confirmMessages, ...shell.results];

  return { shell, sender, directory, memory, turn, logRows, sends, texts, formatterCalls: () => llm?.completeCalls ?? 0 };
}

const send = (channel: string, notes?: string): ToolChoice => ({
  kind: "tool",
  name: "sendMessage",
  input: notes === undefined ? { channel } : { channel, notes },
});

const chain = (channel: string): ToolChoice => ({
  kind: "plan",
  steps: [
    { tool: "summarize", arguments: {}, describe: "summarize it" },
    { tool: "sendMessage", arguments: { channel, notes: "Summary: {step1}" }, describe: "send it" },
  ],
});

const notFound = (typed: string, tail = "") =>
  `I couldn't find a Slack channel called ${typed}. I can post to public channels and to private ` +
  `channels the bot has been added to.${tail}`;

const MAYBE_TEXT = "Could not confirm the message to #help. It may have been sent. Check Slack before trying again.";

describe("bot mode — the dialog and the result name the real channel", () => {
  it("asks 'Send to #help?' with the whole message after a blank line, and says 'Sent to #help.'", async () => {
    const s = session();
    const outcome = await s.turn(send("#help"), "send these notes to #help");

    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages).toEqual(["Send to #help?\n\nFORMATTED"]);
    expect(s.sends()).toEqual([{ channel: "#help", text: "FORMATTED" }]);
    expect(s.shell.results).toEqual(["Sent to #help.\n\nFORMATTED"]);
  });

  it.each(["HELP", " #Help ", "help"])("shows and sends Slack's name for %j, never the typed text", async (typed) => {
    const s = session();
    await s.turn(send(typed), "send these");
    expect(s.shell.confirmMessages).toEqual(["Send to #help?\n\nFORMATTED"]);
    expect(s.sends()[0]?.channel).toBe("#help");
  });

  it("sends a message given in the instruction as written, with no formatter call", async () => {
    const s = session();
    await s.turn(send("help", "ship it friday"), "send 'ship it friday' to help");
    expect(s.shell.confirmMessages).toEqual(["Send to #help?\n\nship it friday"]);
    expect(s.sends()).toEqual([{ channel: "#help", text: "ship it friday" }]);
    expect(s.formatterCalls()).toBe(0);
  });

  it("checks a channel memory resolved, by the name memory gave", async () => {
    const s = session({ facts: { team: "#social" } });
    await s.turn(send("the team"), "send these to the team");
    expect(s.shell.confirmMessages).toEqual(["Send to #social?\n\nFORMATTED"]);
    expect((s.directory as FakeChannelDirectory).calls[0]).toBe("#social");
  });

  it("asks the directory before the dialog, at every check — prepare, the dialog and the send", async () => {
    const s = session();
    await s.turn(send("#help"), "send these to #help");
    expect((s.directory as FakeChannelDirectory).calls).toEqual(["#help", "#help", "#help"]);
  });
});

describe("bot mode — a send that fails after the dialog", () => {
  const notSent = (error: string): SendResult => ({ ok: false, outcome: "not_sent", error });

  it.each([
    SEND_ERRORS.channelNotFound,
    SEND_ERRORS.notInChannel,
    SEND_ERRORS.archived,
    SEND_ERRORS.badToken,
    SEND_ERRORS.rateLimited,
    SEND_ERRORS.badText,
    SEND_ERRORS.rejected,
  ])("not_sent: 'Could not send to #help: %s'", async (error) => {
    const s = session({ sender: new FakeBotSender(notSent(error)) });
    const outcome = await s.turn(send("#help"), "send these");
    expect(outcome.status).toBe("error");
    expect(s.shell.results).toEqual([`Something went wrong: Could not send to #help: ${error}`]);
  });

  it("maybe_sent: says it may have been sent, and never invites a second send", async () => {
    const s = session({
      sender: new FakeBotSender({ ok: false, outcome: "maybe_sent", error: SEND_ERRORS.unconfirmed }),
    });
    const outcome = await s.turn(send("#help"), "send these");
    expect(outcome.status).toBe("error");
    expect(s.shell.results).toEqual([`Something went wrong: ${MAYBE_TEXT}`]);
    expect(MAYBE_TEXT).not.toMatch(/\bretry\b|safe to try|try again now|send it again|please try again/i);
  });

  it("treats a failure that does not say whether it was sent as maybe sent", async () => {
    const s = session({ sender: new FakeBotSender({ ok: false, error: "whatever" }) });
    await s.turn(send("#help"), "send these");
    expect(s.shell.results).toEqual([`Something went wrong: ${MAYBE_TEXT}`]);
  });

  it("treats a sender that rejects outright as an error, and claims nothing was sent or not", async () => {
    const s = session({ sender: new FakeBotSender({ ok: true }, true) });
    const outcome = await s.turn(send("#help"), "send these");
    expect(outcome.status).toBe("error");
    expect(s.shell.results.join("\n")).not.toContain("Sent to");
  });
});

// Everything below is refused BEFORE any dialog: no confirm, no send, no formatter call.
function expectRefusedBeforeDialog(s: ReturnType<typeof session>, outcome: { status: string }): void {
  expect(outcome.status).toBe("refused");
  expect(s.shell.confirmMessages).toEqual([]);
  expect(s.sends()).toEqual([]);
  expect(s.formatterCalls()).toBe(0);
  expect(s.logRows()).toEqual([{ tool: "sendMessage", status: "refused" }]);
}

describe("bot mode — a channel Slack does not have is refused before the dialog", () => {
  it.each([
    { typed: "#zzz", shown: "#zzz", tail: "" },
    { typed: "soc", shown: "#soc", tail: " Similar channels: #social." },
    { typed: "dev", shown: "#dev", tail: " Similar channels: #dev-help, #devops." },
    { typed: "#hel", shown: "#hel", tail: " Similar channels: #help, #help-desk, #helpdesk." },
  ])("$typed → '$tail'", async ({ typed, shown, tail }) => {
    const s = session();
    const outcome = await s.turn(send(typed), "send these");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.results).toEqual([notFound(shown, tail)]);
  });

  it("refuses a typed Slack ID: it is just a name that is not on the list", async () => {
    const s = session();
    const outcome = await s.turn(send("C0000000001"), "send these to C0000000001");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.results).toEqual([notFound("#C0000000001")]);
  });

  it("refuses a remembered channel Slack no longer has", async () => {
    const s = session({ facts: { team: "#old-team" } });
    const outcome = await s.turn(send("the team"), "send these to the team");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.results).toEqual([notFound("#old-team")]);
  });

  // Changed in M22 prompt 5: an unknown "the … channel" is now tried in Slack ONCE, exactly, with
  // "the" and "channel" dropped. Slack has no #bugs here, so the M21 words still stand.
  // Changed in M22 prompt 7: a lone send in bot mode now ASKS first, as a chain does. Nobody
  // answers here (no scripted answer), so it ends in the same M21 words — and Slack was asked
  // about "bugs" twice: by the lookup before the question, and by `prepare` after it.
  it("refuses an unknown 'the …' phrase in the M21 words when Slack has no exact match and the question goes unanswered", async () => {
    const s = session();
    const outcome = await s.turn(send("the bugs channel"), "send these to the bugs channel");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.questions).toEqual(["Before I start: which channel do you mean by 'the bugs channel'?"]);
    expect(s.shell.results[0]).toContain("teach me with: remember the bugs channel is #your-channel");
    expect((s.directory as FakeChannelDirectory).calls).toEqual(["bugs", "bugs"]);
  });
});

describe("bot mode — when Slack cannot answer, nothing is sent", () => {
  it.each([
    { failure: "no_token", said: "Slack rejected the bot token, so nothing was sent." },
    { failure: "auth", said: "Slack rejected the bot token, so nothing was sent." },
    { failure: "network", said: "I couldn't reach Slack to check the channel, so nothing was sent." },
    { failure: "timeout", said: "I couldn't reach Slack to check the channel, so nothing was sent." },
    { failure: "slack_error", said: "I couldn't reach Slack to check the channel, so nothing was sent." },
    { failure: "bad_response", said: "I couldn't reach Slack to check the channel, so nothing was sent." },
    { failure: "rate_limited", said: "Slack is rate limiting me, so nothing was sent." },
    { failure: "ambiguous", said: "More than one Slack channel is called #help, so nothing was sent." },
  ] as { failure: DirectoryFailure; said: string }[])("$failure → '$said'", async ({ failure, said }) => {
    const s = session({ directory: directoryWith({ unavailable: [failure] }) });
    const outcome = await s.turn(send("#help"), "send these to #help");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.results).toEqual([said]);
  });

  it("refuses a name two real channels share", async () => {
    const directory = new FakeChannelDirectory({
      channels: [
        { id: "C1", name: "help" },
        { id: "C2", name: "Help" },
      ],
      delayMs: 5,
    });
    const s = session({ directory });
    const outcome = await s.turn(send("help"), "send these to help");
    expectRefusedBeforeDialog(s, outcome);
    expect(s.shell.results).toEqual(["More than one Slack channel is called #help, so nothing was sent."]);
  });

  it("fails closed when bot mode has no directory at all", async () => {
    const s = session({ directory: null });
    const outcome = await s.turn(send("#help", "hello"), "send hello to #help");
    expect(outcome.status).toBe("refused");
    expect(s.shell.confirmMessages).toEqual([]);
    expect(s.sends()).toEqual([]);
    expect(s.shell.results).toEqual(["I couldn't check Slack channels, so nothing was sent."]);
  });
});

// Changed in M22 prompt 5: the prompt 4 interim (refuse every chained send) is gone. The chain's
// pre-flight now checks the channel as the plan WROTE it, before step 1.
describe("bot mode — inside a chain", () => {
  it("refuses a channel Slack does not have BEFORE step 1, with no dialog", async () => {
    const s = session();
    const outcome = await s.turn(chain("#nope"), "summarize and send to #nope", "THE SUMMARY");
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 2 });
    expect(s.shell.confirmMessages).toEqual([]);
    expect(s.sends()).toEqual([]);
    expect(s.formatterCalls()).toBe(0);
    expect(outcome.result).toBe(notFound("#nope"));
  });

  it("sends a chained message to a real channel, through its dialog", async () => {
    const s = session();
    const outcome = await s.turn(chain("#help"), "summarize and send to #help", "THE SUMMARY");
    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages).toEqual(["Step 2 of 2: Send to #help?\n\nSummary: THE SUMMARY"]);
    expect(s.sends()).toEqual([{ channel: "#help", text: "Summary: THE SUMMARY" }]);
  });

  it("never posts to a channel an earlier step produced, even one Slack has: refused before step 1", async () => {
    const s = session();
    // Step 1's result would be "help" — a real channel. It must not pick where the message goes.
    const outcome = await s.turn(chain("{step1}"), "work out where and send it", "help");
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 2 });
    expect(s.shell.confirmMessages).toEqual([]);
    expect(s.sends()).toEqual([]);
    expect(s.formatterCalls()).toBe(0);
    expect(outcome.result).toBe(
      "In bot mode I need you to name the Slack channel yourself, not take it from an earlier step, so nothing was done.",
    );
  });
});

describe("bot mode — the handler on its own", () => {
  function direct(directory: ChannelDirectory | undefined, chained = false) {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    const sender = new FakeBotSender();
    const deps = {
      context: { selectedText: NOTES, activeApp: null, activeWindowTitle: null },
      memory,
      sender,
      chained,
      ...(directory === undefined ? {} : { channelDirectory: directory }),
    } as unknown as ToolDeps;
    const call = (input: ToolInput) => sendMessageTool.handler(input, deps);
    return { call, sender };
  }

  it("throws the refusal class for a channel Slack does not have, and sends nothing", async () => {
    const d = direct(directoryWith());
    const error: unknown = await d.call({ channel: "#nope", notes: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect(d.sender.calls).toEqual([]);
  });

  it.each(["network", "auth", "ambiguous"] as DirectoryFailure[])(
    "throws the refusal class when the directory is unavailable (%s)",
    async (failure) => {
      const d = direct(directoryWith({ unavailable: [failure] }));
      const error: unknown = await d.call({ channel: "#help", notes: "hi" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnresolvedReferenceError);
      expect(d.sender.calls).toEqual([]);
    },
  );

  it("refuses with no directory, and sends nothing", async () => {
    const d = direct(undefined);
    const error: unknown = await d.call({ channel: "#help", notes: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFixableError);
    expect(d.sender.calls).toEqual([]);
  });

  // Changed in M22 prompt 5: inside a chain the handler no longer refuses on its own — the
  // pre-flight has already checked the channel as written. It still checks the channel in Slack.
  it("sends inside a chain to a channel Slack has, and refuses one it does not", async () => {
    const d = direct(directoryWith(), true);
    expect(await d.call({ channel: "#help", notes: "hi" })).toBe("Sent to #help.\n\nhi");
    const error: unknown = await d.call({ channel: "#nope", notes: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect(d.sender.calls).toEqual([{ channel: "#help", text: "hi" }]);
  });
});

describe("bot mode — end to end with the real SlackBotSender", () => {
  it("posts to the directory's ID, and says Sent to the channel's name", async () => {
    const slack = fakeSlackFetch([{ kind: "json", body: { ok: true, channel: "C0000000001", ts: "1.2" } }]);
    const directory = directoryWith();
    const sender = new SlackBotSender({ token: "xoxb-test", directory, fetchFn: slack.fetchFn });
    const s = session({ sender, directory });

    const outcome = await s.turn(send("HELP", "ship it <!channel>"), "send it");

    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages).toEqual(["Send to #help?\n\nship it <!channel>"]);
    expect(s.shell.results).toEqual(["Sent to #help.\n\nship it <!channel>"]);
    expect(slack.requests).toHaveLength(1);
    expect(JSON.parse(slack.requests[0]?.body ?? "{}")).toEqual({
      channel: "C0000000001",
      text: "ship it &lt;!channel&gt;",
    });
  });
});

// THE GUARD, for bot mode: no text a person is shown mentions a webhook — not a dialog, not a
// result, not a refusal. (The webhook-mode guard in tests/sendMessage.test.ts runs untouched.)
describe("bot mode — no text mentions a webhook", () => {
  it("across sends, failures, refusals and chains", async () => {
    const texts: string[] = [];
    const scenarios: { options: SessionOptions; choice: ToolChoice; completion?: string }[] = [
      { options: {}, choice: send("#help") },
      { options: {}, choice: send("help", "hello") },
      { options: { sender: new FakeBotSender({ ok: false, outcome: "not_sent", error: SEND_ERRORS.archived }) }, choice: send("#help") },
      { options: { sender: new FakeBotSender({ ok: false, outcome: "maybe_sent", error: SEND_ERRORS.unconfirmed }) }, choice: send("#help") },
      { options: {}, choice: send("#hel") },
      { options: { directory: directoryWith({ unavailable: ["network"] }) }, choice: send("#help") },
      { options: { directory: null }, choice: send("#help") },
      { options: {}, choice: chain("#help"), completion: "THE SUMMARY" },
      { options: {}, choice: chain("#nope"), completion: "THE SUMMARY" },
    ];
    for (const { options, choice, completion } of scenarios) {
      const s = session(options);
      await s.turn(choice, "send it", completion);
      texts.push(...s.texts());
    }
    expect(texts.length).toBeGreaterThanOrEqual(scenarios.length);
    for (const text of texts) expect(text, text).not.toMatch(/webhook/i);
  });
});
