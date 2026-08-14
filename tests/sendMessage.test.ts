import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, MessageSender, ToolChoice } from "../src/core/types.ts";
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

  const turn = (choice: ToolChoice, instruction: string, completion = "FORMATTED") => {
    const planner = new Planner(
      new FakeLLM(choice, completion),
      shell,
      registry,
      memory,
      memory,
      sender,
    );
    return planner.run(instruction);
  };

  const logRows = () =>
    db
      .prepare<[], { tool: string | null; status: string }>("SELECT tool, status FROM action_log")
      .all();

  return { db, memory, shell, sender, turn, logRows };
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

  it("refuses an unresolved channel instead of sending somewhere wrong", async () => {
    const s = session({ confirms: [true] });
    // memory has never been taught what "the team" is

    const outcome = await s.turn(sendChoice("the team"), "send these notes to the team");

    // M6: unresolved reference → `refused`, not `error`. Still nothing sent.
    expect(outcome.status).toBe("refused");
    expect((s.sender as FakeSender).calls).toHaveLength(0);
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
