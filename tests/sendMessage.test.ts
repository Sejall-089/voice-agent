import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { UnresolvedReferenceError } from "../src/core/errors.ts";
import { checkChannel, sendMessageTool } from "../src/core/tools/sendMessage.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  CapturedContext,
  MessageSender,
  Tool,
  ToolChoice,
  ToolDeps,
  ToolInput,
} from "../src/core/types.ts";
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
    context: contextWith(options.selectedText ?? NOTES),
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

    expect(d.sender.calls).toEqual([{ channel: "#design-team", text: "FORMATTED" }]);
  });
});

describe("sendMessage — a known channel behaves as it always has", () => {
  it("asks once, about the literal channel it was given, and sends there", async () => {
    const s = session({ confirms: [true] });

    const outcome = await s.turn(sendChoice("#design-team"), "send these notes to #design-team");

    expect(outcome.status).toBe("ok");
    expect(s.shell.confirmMessages).toEqual(["Send to #design-team?"]);
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

  it("records the RESOLVED channel in the action log, the body as written", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");

    await s.turn(
      { kind: "tool", name: "sendMessage", input: { channel: "the team", notes: "the team" } },
      "send 'the team' to the team",
    );

    expect(s.loggedArgs()).toEqual([{ channel: "#design-team", notes: "the team" }]);
  });
});

// Memory resolution inspects VALUES, so before this a message body that happened to read like a
// reference was swapped for the fact it named — and posted. Only `channel` is a reference.
describe("sendMessage — the message body is never a reference", () => {
  const BODY = "the team";

  it("formats and previews the body as written when it matches a stored fact", async () => {
    const s = session({ confirms: [true] });
    s.memory.write("team", "#design-team");
    // The precondition: this body IS something memory would rewrite, given the chance.
    expect(await s.memory.resolveArgs({ notes: BODY })).toEqual({ notes: "#design-team" });

    await s.turn(
      { kind: "tool", name: "sendMessage", input: { channel: "#general", notes: BODY } },
      "send 'the team' to #general",
    );

    expect(s.shell.confirmMessages).toEqual([`Send to #general?\n\n${BODY}`]);
    expect(s.lastLlm()?.lastUserPrompt).toBe(BODY);
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
    expect(s.shell.confirmMessages).toEqual([`Step 2 of 2: Send to #design-team?\n\n${BODY}`]);
    expect((s.sender as FakeSender).calls).toEqual([{ channel: "#design-team", text: BODY }]);
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
