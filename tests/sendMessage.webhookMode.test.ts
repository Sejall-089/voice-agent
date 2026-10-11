import { describe, expect, it } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { ChannelDirectory, MessageSender, SendResult, ToolChoice } from "../src/core/types.ts";
import { FakeChannelDirectory } from "./FakeChannelDirectory.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";

// M22 prompt 4. A sender that does not say it is a bot is a WEBHOOK, exactly as every sender was in
// M21 — `mode` undefined and `mode: "webhook"` must produce the M21 texts character for character.
// (The full M21 suite in tests/sendMessage.test.ts runs untouched; this pins the mode rule itself.)

class FakeWebhookSender extends FakeSender {
  readonly mode = "webhook" as const;
}

const NOTE_UNKNOWN = "(You asked for #help. A webhook posts to its own channel and ignores this.)";

function run(sender: MessageSender, directory?: ChannelDirectory) {
  const memory = new SqliteMemory(createDatabase(":memory:"));
  const shell = new MockShell({
    context: { selectedText: "notes", activeApp: null, activeWindowTitle: null },
    confirms: [true],
  });
  const choice: ToolChoice = { kind: "tool", name: "sendMessage", input: { channel: "#help" } };
  const llm = new FakeLLM(choice, "FORMATTED");
  const planner = new Planner(
    llm, shell, registry, memory, memory, sender,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => Promise.resolve(), undefined, directory,
  );
  return planner.run("send these to #help").then((outcome) => ({ outcome, shell }));
}

const makers: [string, (result?: SendResult, postsTo?: string | null) => FakeSender][] = [
  ["mode undefined", (result = { ok: true }, postsTo = null) => new FakeSender(result, false, postsTo)],
  ['mode "webhook"', (result = { ok: true }, postsTo = null) => new FakeWebhookSender(result, false, postsTo)],
];

describe.each(makers)("webhook mode (%s) keeps the M21 texts", (_label, make) => {
  it("the dialog, with no channel configured", async () => {
    const { shell } = await run(make());
    expect(shell.confirmMessages).toEqual([`Send via your Slack webhook?\n${NOTE_UNKNOWN}\n\nFORMATTED`]);
  });

  it("the dialog, with the webhook's channel configured", async () => {
    const { shell } = await run(make({ ok: true }, "#social"));
    expect(shell.confirmMessages).toEqual([
      "Send to #social via your Slack webhook?\n(You asked for #help; the webhook posts to its own channel.)\n\nFORMATTED",
    ]);
  });

  it("the result", async () => {
    const { shell } = await run(make());
    expect(shell.results).toEqual([`Sent via your Slack webhook.\n${NOTE_UNKNOWN}\n\nFORMATTED`]);
  });

  it("the failure", async () => {
    const error = "Slack rejected the message (HTTP 404).";
    const { shell } = await run(make({ ok: false, error }));
    expect(shell.results).toEqual([
      `Something went wrong: Could not send via your Slack webhook: ${error}\n${NOTE_UNKNOWN}`,
    ]);
  });
});

// main.ts hands the planner a directory ONLY in bot mode. If one is ever passed alongside a webhook
// sender, the dialog and the send still follow the SENDER's mode and stay M21's; only `prepare`,
// which is not given the sender, reads the directory's presence. Pinned so that reach is known.
describe("a directory next to a webhook sender", () => {
  it("leaves the dialog and the result as M21's; only prepare consults it", async () => {
    const directory = new FakeChannelDirectory({ channels: [{ id: "C1", name: "help" }], delayMs: 5 });
    const { shell, outcome } = await run(new FakeSender(), directory);
    expect(outcome.status).toBe("ok");
    expect(shell.confirmMessages).toEqual([`Send via your Slack webhook?\n${NOTE_UNKNOWN}\n\nFORMATTED`]);
    expect(shell.results).toEqual([`Sent via your Slack webhook.\n${NOTE_UNKNOWN}\n\nFORMATTED`]);
    expect(directory.calls).toEqual(["#help"]);
  });
});
