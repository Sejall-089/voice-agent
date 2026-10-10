import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { UnresolvedReferenceError } from "../src/core/errors.ts";
import { checkChannel, sendMessageTool } from "../src/core/tools/sendMessage.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { SlackSender, webhookChannelWarning } from "../src/core/senders/SlackSender.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  CapturedContext,
  LLMClient,
  MessageSender,
  Tool,
  ToolChoice,
  ToolDeps,
  ToolInput,
} from "../src/core/types.ts";
import { FakeGmail } from "./FakeGmail.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";
import type { Database } from "better-sqlite3";

const NOTES = "standup: shipped memory engine, next up slack, blocked on nothing";

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// Mirrors the real composition. `confirms` is the queue MockShell.confirm() answers from.
function session(options: {
  confirms: boolean[];
  sender?: MessageSender;
  selectedText?: string | null;
}) {
  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  const shell = new MockShell({
    // `undefined` means "the usual notes"; an explicit null means an EMPTY clipboard, which `??`
    // would have quietly turned back into the notes.
    context: contextWith(options.selectedText === undefined ? NOTES : options.selectedText),
    confirms: options.confirms,
  });
  const sender = options.sender ?? new FakeSender();

  // The LLM of the most recent turn — what the formatter was actually handed.
  let llm: FakeLLM | null = null;

  const turn = (choice: ToolChoice, instruction: string, completion = "FORMATTED") => {
    llm = new FakeLLM(choice, completion);
    // The fifteenth argument is the planner's `sleep`: a chain holds its plan preview on screen
    // for 2.5s, and a test has no reason to wait for it. Everything between is its default.
    const planner = new Planner(
      llm,
      shell,
      registry,
      memory,
      memory,
      sender,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(),
    );
    return planner.run(instruction);
  };

  const logRows = () =>
    db
      .prepare<[], { tool: string | null; status: string }>("SELECT tool, status FROM action_log")
      .all();

  // What the action log recorded each call's arguments as — the row the NEXT planning prompt is
  // shown as "the previous turn".
  const loggedArgs = () =>
    db
      .prepare<[], { arguments: string | null }>("SELECT arguments FROM action_log ORDER BY id")
      .all()
      .map((row) => (row.arguments === null ? null : (JSON.parse(row.arguments) as ToolInput)));

  return { db, memory, shell, sender, turn, logRows, loggedArgs, lastLlm: () => llm };
}

const sendChoice = (channel: string): ToolChoice => ({
  kind: "tool",
  name: "sendMessage",
  input: { channel },
});

describe("sendMessage — approved path", () => {
  it("sends the formatted message to the resolved channel and logs ok", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(outcome.status).toBe("ok");
    const sender = s.sender as FakeSender;
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toEqual({ channel: "#design-team", text: "FORMATTED" });
    expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "ok" });
  });
});

describe("🛑 sendMessage — the confirm gate", () => {
  // The test that protects the user. "No" must mean NOTHING HAPPENED — so we assert the side
  // effect never occurred, not merely that the planner reported it didn't.
  it("sends NOTHING when the user cancels", async () => {
    const s = session({ confirms: [false] });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    const sender = s.sender as FakeSender;
    expect(sender.calls).toHaveLength(0); // <-- the whole point of the gate
    expect(outcome.status).toBe("cancelled");
    expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "cancelled" });
  });

  // The trust property: you approve the CONCRETE action, never the vague one you typed.
  it("asks about the RESOLVED channel, not the raw reference", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(s.shell.confirmMessages).toHaveLength(1);
    expect(s.shell.confirmMessages[0]).toContain("#design-team");
    expect(s.shell.confirmMessages[0]).not.toContain("the team");
  });

  it("only gates the irreversible tool — reversible tools are not confirmed", async () => {
    const s = session({ confirms: [] });

    await s.turn({ kind: "tool", name: "summarize", input: {} }, "summarize this", "SUMMARY");

    expect(s.shell.confirmMessages).toHaveLength(0);
  });
});

describe("sendMessage — failure after a successful confirm", () => {
  it("reports the failure, logs an error, and never claims it sent", async () => {
    const sender = new FakeSender({ ok: false, error: "Slack rejected the message (HTTP 404)." });
    const s = session({ confirms: [true], sender });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(outcome.status).toBe("error");
    expect(s.shell.results[0]).toMatch(/could not send/i);
    expect(s.shell.results[0]).not.toMatch(/^Sent to/i); // never a false success
    expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "error" });
  });

  it("survives the sender throwing (network down)", async () => {
    const sender = new FakeSender({ ok: true }, true);
    const s = session({ confirms: [true], sender });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(outcome.status).toBe("error");
    expect(s.shell.results[0]).not.toMatch(/^Sent to/i);
  });

  it("a planner with no sender configured cannot send", async () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    memory.write("team", "#design-team");
    const shell = new MockShell({ context: contextWith(NOTES), confirms: [true] });

    // No 6th arg — falls back to UnavailableSender.
    const planner = new Planner(
      new FakeLLM(sendChoice("the team"), "FORMATTED"),
      shell,
      registry,
      memory,
      memory,
    );

    const outcome = await planner.run("send these notes to the team");

    expect(outcome.status).toBe("error");
    expect(shell.results[0]).toMatch(/no message sender/i);
  });
});

// The one function that decides whether a channel is somewhere this app can name. Tested on its
// own because it is ordinary branching, and it is the half that decides what a person is told.
describe("checkChannel", () => {
  const memoryWith = (facts: Record<string, string>) => {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    for (const [subject, value] of Object.entries(facts)) memory.write(subject, value);
    return memory;
  };

  it("passes a literal channel through, trimmed, without asking memory", () => {
    // `team` is stored, and is NOT what a literal "#general" means.
    const memory = memoryWith({ team: "#design-team" });
    expect(checkChannel("  #general ", memory)).toEqual({ ok: true, channel: "#general" });
  });

  it("resolves a reference through memory", () => {
    const memory = memoryWith({ team: "#design-team" });
    expect(checkChannel("the team", memory)).toEqual({ ok: true, channel: "#design-team" });
    expect(checkChannel("My Team", memory)).toEqual({ ok: true, channel: "#design-team" });
  });

  it("refuses a reference memory does not know, naming what was not found", () => {
    const check = checkChannel("the bugs channel", memoryWith({ team: "#design-team" }));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain('"the bugs channel"');
    expect(check.reason).toMatch(/remember the bugs channel is/);
  });

  it("refuses a fact whose value is itself still a reference", () => {
    // Someone taught it "the bugs channel is the team". One lookup, never a chase: the answer
    // has to be a destination, and "the team" is not one.
    const check = checkChannel("the bugs channel", memoryWith({ "bugs channel": "the team" }));
    expect(check.ok).toBe(false);
  });

  const NOT_A_CHANNEL: { label: string; value: unknown }[] = [
    { label: "an empty string", value: "" },
    { label: "a blank string", value: "   " },
    { label: "a missing value", value: undefined },
    { label: "something that is not text", value: 42 },
  ];
  it.each(NOT_A_CHANNEL)("refuses $label", ({ value }) => {
    const check = checkChannel(value, memoryWith({}));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/which channel/i);
  });
});

describe("sendMessage — an unknown channel is refused BEFORE the confirm dialog", () => {
  it("never shows the dialog, sends nothing, and names what it could not find", async () => {
    // `confirms: [true]` on purpose: if the dialog WERE shown it would be approved, so the only
    // thing that can make `confirmMessages` empty is the refusal coming first.
    const s = session({ confirms: [true] });
    // memory has never been taught what "the team" is

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(s.shell.confirmMessages).toHaveLength(0); // <-- never asked
    expect((s.sender as FakeSender).calls).toHaveLength(0);
    // M6: unresolved reference → `refused`, not `error`, in the tool's own words.
    expect(outcome.status).toBe("refused");
    expect(s.shell.results).toHaveLength(1);
    expect(s.shell.results[0]).toContain('"the team"');
    expect(s.shell.results[0]).not.toMatch(/something went wrong/i);
    expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "refused" });
    // Nothing was formatted for a message that was never going anywhere.
    expect(s.lastLlm()?.completeCalls).toBe(0);
  });

  it("refuses an empty channel the same way, rather than asking 'Send to ?'", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(sendChoice("  "), "send these notes");

    expect(s.shell.confirmMessages).toHaveLength(0);
    expect((s.sender as FakeSender).calls).toHaveLength(0);
    expect(outcome.status).toBe("refused");
  });

  // A channel WRITTEN in the plan is settled before step 1 (the pre-flight, tests/preflight.test.ts
  // and tests/chain.test.ts). The one that can still reach a step unknown is a channel that only
  // exists once an earlier step has run — and the step must refuse it the same way, with no dialog.
  it("stops a chain at the send step, with no dialog, when the channel came from an earlier step", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(
      {
        kind: "plan",
        steps: [
          { tool: "summarize", arguments: {}, describe: "work out who to tell" },
          {
            tool: "sendMessage",
            arguments: { channel: "{step1}" },
            describe: "tell them",
          },
        ],
      },
      "work out who to tell and tell them",
      "the bugs channel", // step 1's result — a reference nothing is stored under
    );

    // Step 1 RAN: this was not the pre-flight, which would have completed nothing.
    expect(outcome.chain).toEqual({ completed: 1, total: 2 });
    expect(s.shell.confirmMessages).toHaveLength(0);
    expect((s.sender as FakeSender).calls).toHaveLength(0);
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toContain('"the bugs channel"');
  });
});

// Through the planner the confirm summary always refuses first, so no test above can tell
// whether the HANDLER checks at all — delete its check and they all still pass. It is the last
// thing between an argument and the sender, so it is called here directly, with nothing in front.
describe("sendMessage — the handler refuses on its own, with no gate in front of it", () => {
  function direct(facts: Record<string, string> = {}) {
    const memory = new SqliteMemory(createDatabase(":memory:"));
    for (const [subject, value] of Object.entries(facts)) memory.write(subject, value);
    const sender = new FakeSender();
    const llm = new FakeLLM({ kind: "none", text: null }, "FORMATTED");
    // Only what this handler reads. The cast is the same one tests/mcpAdapter.test.ts makes.
    const deps = {
      context: contextWith(NOTES),
      llm,
      memory,
      sender,
      chained: false,
    } as unknown as ToolDeps;
    const call = (input: ToolInput) => sendMessageTool.handler(input, deps);
    return { call, sender, llm };
  }

  it("throws an UnresolvedReferenceError for an unknown channel, and nothing reaches the sender", async () => {
    const d = direct({ team: "#design-team" });

    const error: unknown = await d.call({ channel: "the bugs channel", notes: "hello" }).catch((e: unknown) => e);

    // The TYPE is what makes the planner show it as a refusal rather than "Something went wrong".
    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect((error as Error).message).toContain('"the bugs channel"');
    expect(d.sender.calls).toEqual([]);
    // Refused before the notes were formatted, not after.
    expect(d.llm.completeCalls).toBe(0);
  });

  it.each([{ channel: "" }, { channel: "   " }, {}])("refuses %j the same way", async (input) => {
    const d = direct();

    const error: unknown = await d.call({ ...input, notes: "hello" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect(d.sender.calls).toEqual([]);
  });

  it("resolves a reference itself when nothing resolved it first", async () => {
    // The other half of "does not depend on a gate having run": handed the raw reference, it
    // sends to what the reference MEANS — never to the words "the team".
    const d = direct({ team: "#design-team" });

    await d.call({ channel: "the team", notes: "hello" });

    // And it sends `notes` AS IT FINDS THEM: the handler never calls the formatter (that
    // happens in `prepare`, before the dialog), so nothing can change after an approval.
    expect(d.sender.calls).toEqual([{ channel: "#design-team", text: "hello" }]);
    expect(d.llm.completeCalls).toBe(0);
  });
});

describe("sendMessage — a known channel behaves as it always has", () => {
  it("asks once, about the literal channel it was given, and sends there", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(sendChoice("#design-team"), "send these notes to #design-team");

    expect(outcome.status).toBe("ok");
    // "Known" is about the channel being ACCEPTED. What the question says about where the
    // message goes is a separate matter, pinned in "honest about where a webhook posts" below.
    expect(s.shell.confirmMessages).toEqual([
      "Send via your Slack webhook?\n(You asked for #design-team. A webhook posts to its own channel and ignores this.)\n\nFORMATTED",
    ]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#design-team", text: "FORMATTED" }]);
  });
});

// `referenceArgs`: a tool names WHICH of its arguments are references, and the planner resolves
// those and nothing else. Shown on a probe tool first, so the rule is pinned for the planner
// rather than only for the one tool that happens to use it.
describe("referenceArgs — the planner resolves only the arguments a tool declares", () => {
  const probe = (declared: Pick<Tool, "referenceArgs" | "resolvesReferences">) => {
    const seen: ToolInput[] = [];
    const tool: Tool = {
      name: "probe",
      description: "records what it was handed",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      ...declared,
      handler: (input) => {
        seen.push(input);
        return Promise.resolve("done");
      },
    };
    const memory = new SqliteMemory(createDatabase(":memory:"));
    memory.write("team", "#design-team");
    const shell = new MockShell({ context: contextWith(null) });
    const choice: ToolChoice = {
      kind: "tool",
      name: "probe",
      input: { where: "the team", what: "the team", count: 3 },
    };
    const run = () => new Planner(new FakeLLM(choice), shell, [tool], memory, memory).run("probe");
    return { run, seen };
  };

  it("resolves a declared argument and leaves an undeclared one exactly as written", async () => {
    const p = probe({ referenceArgs: ["where"] });
    await p.run();
    expect(p.seen).toEqual([{ where: "#design-team", what: "the team", count: 3 }]);
  });

  it("still resolves every argument when nothing is declared", async () => {
    // The default every tool had before this, and the case the first test must differ from.
    const p = probe({});
    await p.run();
    expect(p.seen).toEqual([{ where: "#design-team", what: "#design-team", count: 3 }]);
  });

  it("resolves nothing when a tool opts out, whatever it declares", async () => {
    const p = probe({ referenceArgs: ["where"], resolvesReferences: false });
    await p.run();
    expect(p.seen).toEqual([{ where: "the team", what: "the team", count: 3 }]);
  });

  it("records the RESOLVED channel in the action log, and never resolves the body", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    await s.turn(
      { kind: "tool", name: "sendMessage", input: { channel: "the team", notes: "the team" } },
      "send 'the team' to the team",
    );

    // The log holds the channel as resolved and the message as SENT — which, for a message
    // given in the instruction, is the words as written: "the team", not the fact it names,
    // and not a formatter's version of it.
    expect(s.loggedArgs()).toEqual([{ channel: "#design-team", notes: "the team" }]);
    expect(s.lastLlm()?.completeCalls).toBe(0);
  });
});

// Memory resolution inspects VALUES, so before this a message body that happened to read like a
// reference was swapped for the fact it named — and posted. Only `channel` is a reference.
describe("sendMessage — the message body is never a reference", () => {
  const BODY = "the team";

  it("sends the body as written when it matches a stored fact", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");
    // The precondition: this body IS something memory would rewrite, given the chance.
    expect(await s.memory.resolveArgs({ notes: BODY })).toEqual({ notes: "#design-team" });

    await s.turn(
      { kind: "tool", name: "sendMessage", input: { channel: "#general", notes: BODY } },
      "send 'the team' to #general",
    );

    // The dialog shows the body as written, and that is what is sent: memory did not rewrite
    // it, and — being a message given in the instruction — no formatter touched it either.
    expect(s.shell.confirmMessages).toEqual([
      `Send via your Slack webhook?\n(You asked for #general. A webhook posts to its own channel and ignores this.)\n\n${BODY}`,
    ]);
    expect((s.sender as FakeSender).calls[0]?.text).toBe(BODY);
    expect(s.lastLlm()?.completeCalls).toBe(0);
    expect((s.sender as FakeSender).calls[0]?.channel).toBe("#general");
  });

  it("sends an earlier step's result verbatim, while still resolving the channel", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(
      {
        kind: "plan",
        steps: [
          { tool: "summarize", arguments: {}, describe: "summarize it" },
          {
            tool: "sendMessage",
            arguments: { channel: "the team", notes: "{step1}" },
            describe: "tell the team",
          },
        ],
      },
      "summarize this and tell the team",
      BODY, // step 1's result is, word for word, a reference memory knows
    );

    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages).toEqual([
      `Step 2 of 2: Send via your Slack webhook?\n(You asked for #design-team. A webhook posts to its own channel and ignores this.)\n\n${BODY}`,
    ]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#design-team", text: BODY }]);
  });
});

// A Slack app webhook posts to the ONE channel it was created for and ignores the `channel`
// field. So the channel the user named is not where the message goes, and no text may say it is.
// What the app can honestly name is the webhook's own channel — when it has been told
// (SLACK_WEBHOOK_CHANNEL, carried by the sender as `postsTo`) — and otherwise only "your Slack
// webhook".
describe("sendMessage — honest about where a webhook posts", () => {
  const ASKED_NOTE_KNOWN = "(You asked for #help; the webhook posts to its own channel.)";
  const ASKED_NOTE_UNKNOWN = "(You asked for #help. A webhook posts to its own channel and ignores this.)";

  const send = (channel: string, notes?: string): ToolChoice => ({
    kind: "tool",
    name: "sendMessage",
    input: notes === undefined ? { channel } : { channel, notes },
  });
  const chained = (channel: string): ToolChoice => ({
    kind: "plan",
    steps: [
      { tool: "summarize", arguments: {}, describe: "summarize it" },
      { tool: "sendMessage", arguments: { channel, notes: "{step1}" }, describe: "send it" },
    ],
  });
  const through = (postsTo: string | null, result = { ok: true } as { ok: boolean; error?: string }) =>
    session({ confirms: [true], sender: new FakeSender(result, false, postsTo) });

  describe("the confirm question", () => {
    // Every lone send's dialog ends with the message itself, after a blank line. These tests are
    // about the lines ABOVE it; "what is approved is what is sent" below is about the message.
    const MESSAGE = "\n\nFORMATTED";

    it("names the webhook's channel, and nothing else, when that is the channel asked for", async () => {
      const s = through("#social");
      await s.turn(send("#social"), "send these to #social");
      expect(s.shell.confirmMessages).toEqual([`Send to #social via your Slack webhook?${MESSAGE}`]);
    });

    it("treats '#Social', 'social' and '#social' as the same channel", async () => {
      for (const asked of ["#Social", "social", " #social "]) {
        const s = through("#social");
        await s.turn(send(asked), "send these");
        expect(s.shell.confirmMessages, asked).toEqual([`Send to #social via your Slack webhook?${MESSAGE}`]);
      }
    });

    it("says so on a second line when a DIFFERENT channel was asked for", async () => {
      const s = through("#social");
      await s.turn(send("#help"), "send these to #help");
      expect(s.shell.confirmMessages).toEqual([
        `Send to #social via your Slack webhook?\n${ASKED_NOTE_KNOWN}${MESSAGE}`,
      ]);
    });

    it("names no destination at all when the webhook's channel is not configured", async () => {
      const s = through(null);
      await s.turn(send("#help"), "send these to #help");
      expect(s.shell.confirmMessages).toEqual([`Send via your Slack webhook?\n${ASKED_NOTE_UNKNOWN}${MESSAGE}`]);
    });

    it("reports the RESOLVED channel as what was asked for, not the phrase", async () => {
      const s = through("#social");
      s.memory.write("team", "#design-team");
      await s.turn(send("the team"), "send these to the team");
      expect(s.shell.confirmMessages[0]).toBe(
        `Send to #social via your Slack webhook?\n(You asked for #design-team; the webhook posts to its own channel.)${MESSAGE}`,
      );
    });

    it("keeps the message after a blank line, on a lone send", async () => {
      const s = through("#social");
      await s.turn(send("#help", "ship it friday"), "send this", "• ship it Friday");
      // The message was given in the instruction, so it is shown as written (not formatted).
      expect(s.shell.confirmMessages).toEqual([
        `Send to #social via your Slack webhook?\n${ASKED_NOTE_KNOWN}\n\nship it friday`,
      ]);
    });

    it("keeps the step label in front and the whole message after, in a chain", async () => {
      const s = through(null);
      await s.turn(chained("#help"), "summarize and send", "THE SUMMARY");
      expect(s.shell.confirmMessages).toEqual([
        `Step 2 of 2: Send via your Slack webhook?\n${ASKED_NOTE_UNKNOWN}\n\nTHE SUMMARY`,
      ]);
    });
  });

  describe("the result", () => {
    it.each([
      { label: "configured, same channel", postsTo: "#social", asked: "#social", head: "Sent to #social via your Slack webhook." },
      {
        label: "configured, different channel",
        postsTo: "#social",
        asked: "#help",
        head: `Sent to #social via your Slack webhook.\n${ASKED_NOTE_KNOWN}`,
      },
      { label: "not configured", postsTo: null, asked: "#help", head: `Sent via your Slack webhook.\n${ASKED_NOTE_UNKNOWN}` },
    ])("$label", async ({ postsTo, asked, head }) => {
      const s = through(postsTo);
      const outcome = await s.turn(send(asked), "send these");
      expect(outcome.status).toBe("ok");
      expect(s.shell.results).toEqual([`${head}\n\nFORMATTED`]);
    });
  });

  describe("a failed send", () => {
    const REJECTED = { ok: false, error: "Slack rejected the message (HTTP 404)." };

    it.each([
      { label: "configured, same channel", postsTo: "#social", asked: "#social", said: `Could not send to #social via your Slack webhook: ${REJECTED.error}` },
      {
        label: "configured, different channel",
        postsTo: "#social",
        asked: "#help",
        said: `Could not send to #social via your Slack webhook: ${REJECTED.error}\n${ASKED_NOTE_KNOWN}`,
      },
      {
        label: "not configured",
        postsTo: null,
        asked: "#help",
        said: `Could not send via your Slack webhook: ${REJECTED.error}\n${ASKED_NOTE_UNKNOWN}`,
      },
    ])("$label", async ({ postsTo, asked, said }) => {
      const s = through(postsTo, REJECTED);
      const outcome = await s.turn(send(asked), "send these");
      expect(outcome.status).toBe("error");
      expect(s.shell.results).toEqual([`Something went wrong: ${said}`]);
    });
  });

  // THE GUARD. Whatever these texts come to say later, the channel that was ASKED FOR may appear
  // in exactly one place — the parenthesised "You asked for…" line — and never as where a
  // message is going, went, or failed to go. Every text a person is shown is collected and
  // checked, for a configured webhook and an unconfigured one.
  describe("no text claims the asked channel as the destination", () => {
    const BODY = "the release is out";

    async function everyText(postsTo: string | null): Promise<string[]> {
      const texts: string[] = [];
      const lone = through(postsTo);
      await lone.turn(send("#help", BODY), "send this to #help", BODY);
      const chain = through(postsTo);
      await chain.turn(chained("#help"), "summarize and send to #help", BODY);
      const failed = through(postsTo, { ok: false, error: "Slack rejected the message (HTTP 404)." });
      await failed.turn(send("#help", BODY), "send this to #help", BODY);
      for (const s of [lone, chain, failed]) texts.push(...s.shell.confirmMessages, ...s.shell.results);
      return texts;
    }

    it.each([{ postsTo: "#social" }, { postsTo: null }])("webhook channel: $postsTo", async ({ postsTo }) => {
      const texts = await everyText(postsTo);
      // Three confirms and four results — two sent, one failed, and the chain's first step
      // showing its summary. The check below is only worth anything if it is looking at all of
      // them, and if the six that are ABOUT the send really do mention the asked channel.
      expect(texts).toHaveLength(7);
      expect(texts.filter((text) => text.includes("#help"))).toHaveLength(6);

      for (const text of texts) {
        expect(text, text).not.toMatch(/\b(send|sent|sending|posted|post) (it |this |these )?to #help\b/i);
        const withoutTheNote = text
          .split("\n")
          .filter((line) => !/^\(You asked for #help[.;] /.test(line))
          .join("\n");
        expect(withoutTheNote, text).not.toContain("#help");
      }
    });
  });
});

// LIVE BUG (M21). "send these notes to the bugs channel", with nothing useful to send. The
// dialog showed a 140-character preview of the raw `notes` argument — or nothing at all, when
// the text came from the clipboard — and the formatter ran AFTER Send was pressed. Twice it
// answered with a question of its own, and Slack received it:
//
//     Please paste the rough notes you want formatted for the #bugs channel.
//
// What was approved was not what was sent. Now the text is settled BEFORE the dialog
// (`Tool.prepare`), the dialog shows all of it, and the handler sends that string and nothing else.
describe("sendMessage — what is approved is what is sent", () => {
  const QUESTION =
    "Send via your Slack webhook?\n(You asked for #team. A webhook posts to its own channel and ignores this.)";
  const lone = (notes?: string): ToolChoice => ({
    kind: "tool",
    name: "sendMessage",
    input: notes === undefined ? { channel: "#team" } : { channel: "#team", notes },
  });

  it("shows, in the dialog, exactly the text it then sends — for text from the clipboard", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(lone(), "send these notes to #team", "• shipped the memory engine\n• slack next");

    const sent = (s.sender as FakeSender).calls[0]?.text;
    expect(sent).toBe("• shipped the memory engine\n• slack next");
    // The whole dialog, to the character: the question, a blank line, the message.
    expect(s.shell.confirmMessages).toEqual([`${QUESTION}\n\n${sent ?? ""}`]);
    expect(outcome.status).toBe("ok");
  });

  it("shows the WHOLE message, however long — never a preview of something else", async () => {
    const long = `${"a long line of formatted notes. ".repeat(40)}THE END`;
    const s = session({ confirms: [true] });

    // From the clipboard, so it IS formatted — and the formatter's long reply is what is shown.
    await s.turn(lone(), "send these", long);

    expect(s.shell.confirmMessages[0]).toBe(`${QUESTION}\n\n${long}`);
    expect(s.shell.confirmMessages[0]).not.toContain("…");
    expect((s.sender as FakeSender).calls[0]?.text).toBe(long);
  });

  it("formats ONCE, before the dialog, and never again after Send", async () => {
    // Held open: "before the dialog" can only be seen while the dialog is still unanswered.
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    const shell = new MockShell({ context: contextWith(NOTES), holdConfirm: true });
    const sender = new FakeSender();
    const llm = new FakeLLM(lone(), "FORMATTED");
    const running = new Planner(llm, shell, registry, memory, memory, sender).run("send these to #team");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(shell.isConfirmPending()).toBe(true);
    expect(llm.completeCalls).toBe(1); // already formatted
    expect(llm.lastUserPrompt).toBe(NOTES);
    expect(shell.confirmMessages[0]?.endsWith("\n\nFORMATTED")).toBe(true);
    expect(sender.calls).toEqual([]); // and nothing has gone anywhere

    shell.answerConfirm(true);
    await running;

    expect(llm.completeCalls).toBe(1); // the handler did not ask the formatter again
    expect(sender.calls).toEqual([{ channel: "#team", text: "FORMATTED" }]);
  });

  // THE TEST THAT A RE-FORMATTING HANDLER FAILS. Every other fake formatter here returns the
  // same text however often it is asked, so a handler that formatted AGAIN after the dialog
  // would send the same string and pass. This one answers differently each time: the only way
  // for what is sent to equal what was shown is for nothing to have asked it twice.
  it("sends the text the dialog showed even when the formatter would answer differently a second time", async () => {
    const replies = ["FIRST ANSWER — the one that was shown", "SECOND ANSWER — never approved by anyone"];
    const asked: string[] = [];
    const llm: LLMClient = {
      chooseTool: () => Promise.resolve(lone()),
      complete: (_system, user) => {
        asked.push(user);
        return Promise.resolve(replies[asked.length - 1] ?? "A THIRD ANSWER");
      },
    };
    const memory = new SqliteMemory(createDatabase(":memory:"));
    const shell = new MockShell({ context: contextWith(NOTES), confirms: [true] });
    const sender = new FakeSender();

    const outcome = await new Planner(llm, shell, registry, memory, memory, sender).run("send these to #team");

    expect(outcome.status).toBe("ok");
    expect(asked).toEqual([NOTES]); // asked once, with the notes
    const shown = shell.confirmMessages[0]?.split("\n\n").slice(1).join("\n\n");
    expect(shown).toBe(replies[0]);
    expect(sender.calls).toEqual([{ channel: "#team", text: replies[0] }]);
    // And the result the user is shown afterwards is that same text again.
    expect(shell.results[0]?.endsWith(`\n\n${replies[0] ?? ""}`)).toBe(true);
  });

  // Nothing is spent on a send that was never going anywhere: the channel is checked FIRST.
  it.each([
    { label: "an unknown channel", channel: "the bugs channel" },
    { label: "an empty channel", channel: "  " },
  ])("makes no formatting call for $label", async ({ channel }) => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(
      { kind: "tool", name: "sendMessage", input: { channel, notes: "real notes worth formatting" } },
      "send these",
    );

    expect(outcome.status).toBe("refused");
    expect(s.lastLlm()?.completeCalls).toBe(0);
    expect(s.shell.confirmMessages).toEqual([]);
  });

  // `prepare` runs before anything has been approved, so it may ask the model and do NOTHING
  // else. Proved from both sides: it is handed only what it is allowed to touch, and through the
  // whole planner nothing was sent, saved, or acted on by the time the dialog is up.
  describe("prepare has no side effects", () => {
    it("is handed the context, the model and a read-only memory — nothing it could act with", async () => {
      let seen: object | null = null;
      const tool: Tool = {
        name: "probe",
        description: "",
        inputSchema: { type: "object", properties: {}, required: [] },
        risk: "safe",
        prepare: (args, deps) => {
          seen = deps;
          return args;
        },
        handler: () => Promise.resolve("done"),
      };
      const memory = new SqliteMemory(createDatabase(":memory:"));
      const shell = new MockShell({ context: contextWith("clip") });
      const choice: ToolChoice = { kind: "tool", name: "probe", input: {} };
      await new Planner(new FakeLLM(choice), shell, [tool], memory, memory, new FakeSender()).run("probe");

      expect(seen).not.toBeNull();
      // Exactly these, and no more: no shell, no sender, no surfaces, no draft store.
      // (`instruction` joined at the 2026-10-11 fix: the user's own words, read-only text, so a
      // tool can tell a message the user dictated from the instruction itself.)
      expect(Object.keys(seen ?? {}).sort()).toEqual(["chained", "context", "instruction", "llm", "memory"]);
      expect((seen as unknown as { instruction: string }).instruction).toBe("probe");
      // And the memory it gets can look things up but has no way to write.
      expect(Object.keys((seen as unknown as { memory: object }).memory)).toEqual(["resolve"]);
    });

    it("has sent, saved and done nothing by the time the dialog is on screen", async () => {
      const db = createDatabase(":memory:");
      const memory = new SqliteMemory(db);
      memory.write("team", "#team");
      const factsBefore = db.prepare("SELECT * FROM facts").all();
      const shell = new MockShell({ context: contextWith(NOTES), holdConfirm: true });
      const sender = new FakeSender();
      const llm = new FakeLLM(
        { kind: "tool", name: "sendMessage", input: { channel: "the team" } },
        "FORMATTED",
      );
      const running = new Planner(llm, shell, registry, memory, memory, sender).run("send these to the team");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Parked at the dialog: prepare has run (the message is there), and that is ALL.
      expect(shell.isConfirmPending()).toBe(true);
      expect(shell.confirmMessages[0]?.endsWith("\n\nFORMATTED")).toBe(true);
      expect(sender.calls).toEqual([]);
      expect(db.prepare("SELECT * FROM facts").all()).toEqual(factsBefore);
      expect(db.prepare("SELECT * FROM action_log").all()).toEqual([]);
      expect(shell.actions).toEqual([]);
      expect(shell.results).toEqual([]);

      shell.answerConfirm(false);
      await running;
      expect(sender.calls).toEqual([]);
    });
  });

  it("sends nothing when the dialog is cancelled, though it had already formatted", async () => {
    const s = session({ confirms: [false] });

    const outcome = await s.turn(lone(), "send these to #team");

    expect(outcome.status).toBe("cancelled");
    expect((s.sender as FakeSender).calls).toEqual([]);
    expect(s.lastLlm()?.completeCalls).toBe(1);
  });

  it("records what was actually sent as the logged message", async () => {
    const s = session({ confirms: [true] });
    // Clipboard text, formatted: the log's `notes` is the formatter's output, which is what went.
    await s.turn(lone(), "send these", "THE FORMATTED TEXT");
    expect(s.loggedArgs()).toEqual([{ channel: "#team", notes: "THE FORMATTED TEXT" }]);
  });

  // A formatter that answers with a request for the notes has not produced a message. It is
  // refused before any dialog — an approval must never be asked for something that is not one.
  describe("a formatter reply that asks for the notes is never sent", () => {
    it.each([
      "Please paste the rough notes you want formatted for the #bugs channel.", // row 417, live
      "Please paste the rough notes you want formatted for the bugs channel.", // row 418, live
      "NO_NOTES", // what the formatter is now told to say
      "  no_notes\n",
      "I don't see any notes to format — could you share them?",
      "Could you provide the notes you'd like me to send?",
      "What notes would you like me to format?",
      "No notes were provided.",
      "", // and a formatter that returned nothing at all
      "   \n ",
    ])("%j", async (reply) => {
      const s = session({ confirms: [true] });

      // No `notes`: the text is the clipboard's, which is the one source that is formatted —
      // and so the one source whose formatter reply is judged.
      const outcome = await s.turn(lone(), "send these notes to the bugs channel", reply);

      expect(s.shell.confirmMessages).toEqual([]); // never asked
      expect((s.sender as FakeSender).calls).toEqual([]); // never sent
      expect(outcome.status).toBe("refused");
      expect(s.shell.results).toHaveLength(1);
      expect(s.shell.results[0]).toMatch(/didn't send anything/i);
      expect(s.shell.results[0]).not.toMatch(/something went wrong/i);
      // What the formatter said is not shown as though it were the app's own words.
      if (reply.trim().length > 0) expect(s.shell.results[0]).not.toContain(reply.trim());
      expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "refused" });
    });

    // THE OTHER DIRECTION. A message may itself ask its readers something, or ask them for
    // something — that is a message, not a request to the user for notes.
    it.each([
      "Can everyone review the PR by Friday?",
      "Standup moved to 3pm. Please bring your updates.",
      "Reminder: please send your timesheets to Dana by 5.",
      "• Decision: ship Friday\n• Open question: who owns the rollback?",
      "Notes from today's sync:\n- shipped the memory engine",
    ])("but %j is a message, and is sent", async (reply) => {
      const s = session({ confirms: [true] });

      const outcome = await s.turn(lone(), "send these to #team", reply);

      expect(outcome.status).toBe("ok");
      expect((s.sender as FakeSender).calls[0]?.text).toBe(reply);
    });
  });

  describe("with nothing to send", () => {
    it.each([
      { label: "an empty clipboard and no notes", selectedText: null, notes: undefined },
      { label: "a blank clipboard and no notes", selectedText: "  \n ", notes: undefined },
      { label: "blank notes and an empty clipboard", selectedText: null, notes: "   " },
    ])("$label: refuses before any dialog, and says what to do", async ({ selectedText, notes }) => {
      const s = session({ confirms: [true], selectedText });

      const outcome = await s.turn(lone(notes), "send these notes to #team");

      expect(s.shell.confirmMessages).toEqual([]);
      expect((s.sender as FakeSender).calls).toEqual([]);
      expect(outcome.status).toBe("refused");
      expect(s.shell.results).toEqual([
        "There's nothing to send. Copy the notes first (select them and press Ctrl+C), or put " +
          'them in the instruction — for example: send "standup moved to 3pm" to the team.',
      ]);
      // Nothing was formatted for a message that did not exist.
      expect(s.lastLlm()?.completeCalls).toBe(0);
    });
  });

  it("leaves a chain exactly as it was: verbatim, shown in full, no formatter", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(
      {
        kind: "plan",
        steps: [
          { tool: "summarize", arguments: {}, describe: "summarize it" },
          { tool: "sendMessage", arguments: { channel: "#team", notes: "Summary: {step1}" }, describe: "send it" },
        ],
      },
      "summarize this and send it to #team",
      // The one completion in this run is the SUMMARY. It reads like a request on purpose: in a
      // chain the text is another step's output and is not judged, only shown and sent.
      "Please paste the notes you want formatted.",
    );

    expect(outcome.status).toBe("ok");
    expect(s.lastLlm()?.completeCalls).toBe(1); // summarize only — the send formatted nothing
    const sent = "Summary: Please paste the notes you want formatted.";
    expect(s.shell.confirmMessages).toEqual([`Step 2 of 2: ${QUESTION}\n\n${sent}`]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#team", text: sent }]);
  });
});

// LIVE REGRESSION (M21, 2026-10-11). `send "helluuu" to social channel` was refused: "what I was
// given to send wasn't notes". The planner had done its job — `notes: "helluuu"` — and then the
// tool ran the user's own quoted words through the FORMATTER, which called a short greeting
// "nothing to tell anyone" (NO_NOTES, 3 of 3 against the real model).
//
// A message the user gave in the instruction is not rough notes. It is sent as written: no
// formatter, no judgement of what it says. Formatting is for text that came from the clipboard.
describe("sendMessage — a message given in the instruction is sent as written", () => {
  const QUESTION =
    "Send via your Slack webhook?\n(You asked for #team. A webhook posts to its own channel and ignores this.)";
  const said = (notes: string): ToolChoice => ({
    kind: "tool",
    name: "sendMessage",
    input: { channel: "#team", notes },
  });

  it("sends the quoted words exactly: no formatter call, and the dialog shows what is sent", async () => {
    // The clipboard is NOT empty (the default NOTES) and the formatter would refuse if asked:
    // neither may matter, because the message is in the instruction.
    const s = session({ confirms: [true] });

    const outcome = await s.turn(said("helluuu"), 'send "helluuu" to #team', "NO_NOTES");

    expect(outcome.status).toBe("ok");
    expect(s.lastLlm()?.completeCalls).toBe(0);
    expect(s.shell.confirmMessages).toEqual([`${QUESTION}\n\nhelluuu`]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#team", text: "helluuu" }]);
    // Dialog body and sent text, compared to each other rather than each to a literal.
    expect(s.shell.confirmMessages[0]?.split("\n\n").slice(1).join("\n\n")).toBe(
      (s.sender as FakeSender).calls[0]?.text,
    );
  });

  it("keeps spacing, case and punctuation as they were said", async () => {
    const message = "  Heads up —  deploy at 5PM!!\nDon't merge.  ";
    const s = session({ confirms: [true] });

    await s.turn(said(message), `tell #team saying ${message}`);

    expect((s.sender as FakeSender).calls[0]?.text).toBe(message);
    expect(s.lastLlm()?.completeCalls).toBe(0);
  });

  // WHAT THE MESSAGE SAYS IS NOT THE APP'S BUSINESS. Each of these would have been refused,
  // rewritten or looked up by something: the formatter's NO_NOTES rule, the "asks for the notes"
  // check, or memory. None of them may touch words the user asked to have sent.
  it.each([
    ["a single word", "ok"],
    ["text that reads like an instruction to the app", "send these notes to the bugs channel"],
    ["text that asks for notes", "Please paste the rough notes you want formatted."],
    ["the formatter's own sentinel", "NO_NOTES"],
    ["a question", "what notes would you like me to format?"],
    ["a phrase memory knows", "the team"],
    ["a placeholder-looking string", "{step1}"],
  ])("sends %s as written: %j", async (_label, message) => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    const outcome = await s.turn(said(message), `send "${message}" to #team`);

    expect(outcome.status).toBe("ok");
    expect(s.lastLlm()?.completeCalls).toBe(0);
    expect(s.shell.confirmMessages).toEqual([`${QUESTION}\n\n${message}`]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#team", text: message }]);
  });

  it("does the same with an email open — the message is what the user said, not what is on screen", async () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    const shell = new MockShell({
      context: { selectedText: "unrelated clipboard text", activeApp: null, activeWindowTitle: null },
      confirms: [true],
    });
    const sender = new FakeSender();
    const llm = new FakeLLM(said("hello guys"), "NO_NOTES");
    // A Gmail that says an email is open. Nothing may read it.
    const gmail = new FakeGmail({
      openEmail: { subject: "s", from: "a@b.c", fromName: "A", to: null, body: "email body" },
    });

    const outcome = await new Planner(llm, shell, registry, memory, memory, sender, gmail).run(
      'send "hello guys" to #team',
    );

    expect(llm.lastContext?.emailOpen).toBe(true); // the planner WAS told an email is open
    expect(outcome.status).toBe("ok");
    expect(sender.calls).toEqual([{ channel: "#team", text: "hello guys" }]);
    expect(llm.completeCalls).toBe(0);
    expect(gmail.calls).toEqual([]);
  });

  it("still FORMATS text that comes from the clipboard", async () => {
    const s = session({ confirms: [true] });

    await s.turn({ kind: "tool", name: "sendMessage", input: { channel: "#team" } }, "send these notes to #team", "• tidy notes");

    expect(s.lastLlm()?.completeCalls).toBe(1);
    expect(s.lastLlm()?.lastUserPrompt).toBe(NOTES);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#team", text: "• tidy notes" }]);
  });

  // THE ONE CASE `notes` IS NOT A MESSAGE: the model copied the whole instruction into it
  // (action-log rows 417 and 419). That is the instruction, not something to send — so it is
  // treated as no notes at all, by comparing it with the instruction. No model is asked.
  describe("when `notes` is only the instruction repeated", () => {
    const INSTRUCTION = "send these notes to the bugs channel";

    it.each([
      ["exactly", INSTRUCTION],
      ["with different case and a full stop", "Send these notes to the bugs channel."],
      ["in quotes, with extra spaces", `  "send  these notes to the  bugs channel" `],
    ])("refuses before any dialog when the clipboard is empty (%s)", async (_label, notes) => {
      const s = session({ confirms: [true], selectedText: null });

      const outcome = await s.turn(said(notes), INSTRUCTION);

      expect(outcome.status).toBe("refused");
      expect(s.shell.confirmMessages).toEqual([]);
      expect((s.sender as FakeSender).calls).toEqual([]);
      expect(s.shell.results[0]).toMatch(/^There's nothing to send\./);
      expect(s.lastLlm()?.completeCalls).toBe(0);
    });

    it("falls back to the clipboard when there is something on it", async () => {
      const s = session({ confirms: [true] });

      await s.turn(said(INSTRUCTION), INSTRUCTION, "• formatted clipboard notes");

      // The clipboard was formatted and sent; the echoed instruction went nowhere.
      expect(s.lastLlm()?.lastUserPrompt).toBe(NOTES);
      expect((s.sender as FakeSender).calls).toEqual([{ channel: "#team", text: "• formatted clipboard notes" }]);
    });

    it("does NOT mistake a message that merely appears in the instruction for the instruction", async () => {
      // The precondition for the three cases above meaning anything: only the WHOLE instruction
      // is an echo. Part of it is exactly what a quoted message is.
      const s = session({ confirms: [true], selectedText: null });

      const outcome = await s.turn(said("these notes"), INSTRUCTION);

      expect(outcome.status).toBe("ok");
      expect((s.sender as FakeSender).calls[0]?.text).toBe("these notes");
    });
  });
});

// `Tool.prepare`: the planner's one generic step for "settle what this call will actually do
// before anyone is asked about it". Pinned on a probe tool, so it is a property of the planner.
describe("Tool.prepare — arguments are settled once, before the gates", () => {
  function probe(prepare: Tool["prepare"]) {
    const events: string[] = [];
    const tool: Tool = {
      name: "probe",
      description: "",
      inputSchema: { type: "object", properties: {}, required: ["text"] },
      risk: {
        tiers: ["dangerous"],
        resolve: (args) => {
          events.push(`tier:${String(args["text"])}`);
          return Promise.resolve("dangerous" as const);
        },
      },
      prepare,
      confirmSummary: (args) => {
        events.push(`confirm:${String(args["text"])}`);
        return `Do ${String(args["text"])}?`;
      },
      handler: (args) => {
        events.push(`handler:${String(args["text"])}`);
        return Promise.resolve("done");
      },
    };
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    const shell = new MockShell({ context: contextWith(null), confirms: [true] });
    const choice: ToolChoice = { kind: "tool", name: "probe", input: { text: "raw" } };
    const run = () => new Planner(new FakeLLM(choice), shell, [tool], memory, memory).run("probe");
    const logged = () =>
      db.prepare<[], { arguments: string | null; status: string }>("SELECT arguments, status FROM action_log").all();
    return { run, events, shell, logged };
  }

  it("hands the prepared arguments to the tier, the dialog, the handler and the log", async () => {
    let calls = 0;
    const p = probe(async (args) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5)); // really asynchronous
      return { ...args, text: "PREPARED" };
    });

    await p.run();

    expect(calls).toBe(1);
    expect(p.events).toEqual(["tier:PREPARED", "confirm:PREPARED", "handler:PREPARED"]);
    expect(p.shell.confirmMessages).toEqual(["Do PREPARED?"]);
    expect(p.logged()).toEqual([{ arguments: JSON.stringify({ text: "PREPARED" }), status: "ok" }]);
  });

  it("refuses with the tool's own words, before any gate, when prepare says it cannot be done", async () => {
    const p = probe(() => {
      throw new UnresolvedReferenceError("Nothing to do that with.");
    });

    const outcome = await p.run();

    expect(outcome.status).toBe("refused");
    expect(p.events).toEqual([]); // no tier, no dialog, no handler
    expect(p.shell.confirmMessages).toEqual([]);
    expect(p.shell.results).toEqual(["Nothing to do that with."]);
  });

  it("reports a prepare that breaks as an error, and still runs nothing", async () => {
    const p = probe(() => Promise.reject(new Error("formatter exploded")));

    const outcome = await p.run();

    expect(outcome.status).toBe("error");
    expect(p.events).toEqual([]);
    expect(p.shell.confirmMessages).toEqual([]);
  });

  it("changes nothing for a tool without one", async () => {
    const p = probe(undefined);
    await p.run();
    expect(p.events).toEqual(["tier:raw", "confirm:raw", "handler:raw"]);
  });
});

describe("SlackSender.postsTo", () => {
  it("is the configured label, trimmed", () => {
    expect(new SlackSender("https://hooks.example/x", "  #social ").postsTo).toBe("#social");
  });

  it.each([undefined, "", "   "])("is null when the label is %j — never an empty destination", (label) => {
    expect(new SlackSender("https://hooks.example/x", label).postsTo).toBeNull();
  });
});

// A `.env` value that starts with `#` and is not quoted is read as a COMMENT: dotenv gives
// `SLACK_WEBHOOK_CHANNEL=#social` the value "". Found by doing exactly that on advice this repo
// gave. The app then quietly says "via your Slack webhook" with no channel, and nothing tells
// the user their setting was ignored — so startup says so, once.
describe("webhookChannelWarning", () => {
  it.each(["", "   ", "\t"])("warns when the variable is present but blank (%j)", (raw) => {
    const warning = webhookChannelWarning(raw);
    expect(warning).not.toBeNull();
    // It names the variable, says why this usually happens, and shows the form that works.
    expect(warning).toContain("SLACK_WEBHOOK_CHANNEL");
    expect(warning).toContain('SLACK_WEBHOOK_CHANNEL="#social"');
    expect(warning).toMatch(/quot/i);
  });

  it("says nothing when the variable is absent — unset is an ordinary install", () => {
    expect(webhookChannelWarning(undefined)).toBeNull();
  });

  it.each(["#social", "social", " #social "])("says nothing when it has a value (%j)", (raw) => {
    expect(webhookChannelWarning(raw)).toBeNull();
  });

  it("agrees with SlackSender about what counts as blank", () => {
    // The warning and the sender must not disagree: a value the sender treats as "no channel"
    // while startup stays silent would be the original problem again.
    for (const raw of ["", "   ", "#social", " x "]) {
      const blank = new SlackSender("https://hooks.example/x", raw).postsTo === null;
      expect(webhookChannelWarning(raw) !== null, JSON.stringify(raw)).toBe(blank);
    }
  });
});

describe("🏆 the flagship trace, end to end", () => {
  // instruction → planner → resolve(CORRECTED fact) → confirm(RESOLVED) → send.
  // The correction from M4 is what makes the send land in the right channel.
  it("a corrected fact changes where the message actually goes", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#general"); // what we believed before

    // Turn 1 — the user corrects us. Routed through the planner, not a direct write().
    await s.turn(
      { kind: "tool", name: "remember", input: { subject: "team", value: "#design-team" } },
      "no, I meant the design channel",
    );

    // Turn 2 — send to "the team". It must land in the CORRECTED channel.
    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages[0]).toContain("#design-team");
    const sender = s.sender as FakeSender;
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.channel).toBe("#design-team");
    expect(sender.calls[0]?.channel).not.toBe("#general");
    expect(s.logRows()).toContainEqual({ tool: "sendMessage", status: "ok" });
  });
});
