import { describe, expect, it } from "vitest";
import type { ToolChoice } from "../src/core/types.ts";
import { UNAVAILABLE, harness, notFound, plan, step } from "./botChainHarness.ts";

// M22 prompt 7, live finding (a): "send these notes to the second channel", a LONE send with no
// memory entry, was refused with "teach me with: remember …" — the question was only ever asked
// inside a chain. In bot mode a lone send now asks the same question, through the same machinery
// (`settleReferences` on a plan of one step): the answer is checked in Slack before it is saved,
// "Saved: …" is shown, and the send goes on to its ordinary dialog. Webhook mode is M21.

const send = (channel: string): ToolChoice => ({ kind: "tool", name: "sendMessage", input: { channel } });
const QUESTION = "Before I start: which channel do you mean by 'the second channel'?";
const M21_LONE_REFUSAL =
  'I don\'t know which channel "the second channel" means — teach me with: remember the second channel is #your-channel.';
const NOTES = { selectedText: "the notes", activeApp: null, activeWindowTitle: null };
const writes = (events: string[]) => events.filter((e) => e.startsWith("write:"));

describe("bot mode: a lone send to an unknown phrase asks which channel", () => {
  it("asks, saves Slack's #name, and goes on to the ordinary dialog", async () => {
    const h = harness(send("the second channel"), { asks: ["#help"], context: NOTES });
    const outcome = await h.planner.run("send these notes to the second channel");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("sendMessage");
    expect(outcome.chain).toBeUndefined();
    expect(h.shell.questions).toEqual([QUESTION]);
    expect(h.notified()[0]).toBe("Saved: the second channel = #help");
    expect(h.facts()).toEqual([{ subject: "second channel", value: "#help", active: 1 }]);
    expect(h.shell.confirmMessages).toEqual(["Send to #help?\n\nFORMATTED"]);
    expect(h.sender.calls).toEqual([{ channel: "#help", text: "FORMATTED" }]);
  });

  it("saves Slack's spelling of the answer", async () => {
    const h = harness(send("the second channel"), { asks: [" HELP "], context: NOTES });
    await h.planner.run("send these notes to the second channel");
    expect(h.facts()).toEqual([{ subject: "second channel", value: "#help", active: 1 }]);
  });

  it("checks the answer in Slack BEFORE anything is saved", async () => {
    const h = harness(send("the second channel"), { asks: ["#help"], context: NOTES });
    await h.planner.run("send these notes to the second channel");
    const checked = h.events.indexOf("resolve:#help");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("write:second channel=#help")).toBeGreaterThan(checked);
    expect(writes(h.events.slice(0, checked))).toEqual([]);
  });

  it("asks before the formatter is paid for", async () => {
    const h = harness(send("the second channel"), { asks: [null], context: NOTES });
    await h.planner.run("send these notes to the second channel");
    expect(h.llm.completeCalls).toBe(0);
  });

  it("re-asks with similar channels when Slack has no such channel, then gives up in the M21 words", async () => {
    const h = harness(send("the second channel"), { asks: ["#hel", "#nope", "#help"], context: NOTES });
    const outcome = await h.planner.run("send these notes to the second channel");

    expect(h.shell.questions).toEqual([
      QUESTION,
      `${notFound("#hel", " Similar channels: #help.")} Which channel do you mean by 'the second channel'?`,
    ]);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([M21_LONE_REFUSAL]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.sender.calls).toEqual([]);
    expect(h.facts()).toEqual([]);
  });

  it("refuses with the tool's words, and saves nothing, when nobody answers", async () => {
    const h = harness(send("the second channel"), { asks: [null], context: NOTES });
    const outcome = await h.planner.run("send these notes to the second channel");
    expect(outcome.status).toBe("refused");
    expect(outcome.tool).toBe("sendMessage");
    expect(h.shell.results).toEqual([M21_LONE_REFUSAL]);
    expect(h.facts()).toEqual([]);
  });

  it("refuses, saves nothing and sends nothing when Slack cannot check the answer", async () => {
    // Directory call 0 is the lookup of "second" (not found); call 1 checks the answer.
    const h = harness(send("the second channel"), { asks: ["#help"], failOn: { 1: "network" }, context: NOTES });
    const outcome = await h.planner.run("send these notes to the second channel");

    expect(outcome.status).toBe("refused");
    expect(outcome.tool).toBe("sendMessage");
    expect(outcome.chain).toBeUndefined();
    expect(h.shell.results).toEqual([UNAVAILABLE.network]);
    expect(writes(h.events)).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.sender.calls).toEqual([]);
    expect(h.log.entries.at(-1)).toMatchObject({ tool: "sendMessage", status: "refused" });
  });

  it("refuses without asking when Slack cannot be asked during the lookup", async () => {
    const h = harness(send("the second channel"), { asks: ["#help"], failOn: { 0: "timeout" }, context: NOTES });
    const outcome = await h.planner.run("send these notes to the second channel");
    expect(h.shell.questions).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([UNAVAILABLE.timeout]);
    expect(h.facts()).toEqual([]);
  });

  it("asks for a one-step plan too", async () => {
    const h = harness(plan([step("sendMessage", { channel: "the second channel", notes: "hi" }, "send it")]), {
      asks: ["#help"],
    });
    const outcome = await h.planner.run("send hi to the second channel");
    expect(h.shell.questions).toEqual([QUESTION]);
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls).toEqual([{ channel: "#help", text: "hi" }]);
  });
});

describe("bot mode: lone sends that need no question still do not ask", () => {
  it("a memory hit goes straight to the dialog", async () => {
    const h = harness(send("the second channel"), { facts: { "second channel": "#social" }, context: NOTES });
    await h.planner.run("send these notes to the second channel");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.confirmMessages).toEqual(["Send to #social?\n\nFORMATTED"]);
  });

  it("'the help channel' is found in Slack without asking, and nothing is saved", async () => {
    const h = harness(send("the help channel"), { context: NOTES });
    await h.planner.run("send these notes to the help channel");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.confirmMessages).toEqual(["Send to #help?\n\nFORMATTED"]);
    expect(h.facts()).toEqual([]);
    expect(writes(h.events)).toEqual([]);
  });

  it("a literal channel goes straight to the dialog", async () => {
    const h = harness(send("#social"), { context: NOTES });
    await h.planner.run("send these notes to #social");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.confirmMessages).toEqual(["Send to #social?\n\nFORMATTED"]);
  });
});

// As main.ts builds it: in webhook mode the planner is handed NO directory. (With one handed in
// anyway, a lone send's `prepare` — which is not given the sender — would consult it: the prompt 4
// exception pinned in tests/sendMessage.webhookMode.test.ts. The question is still never asked.)
describe("webhook mode: a lone send never asks (M21)", () => {
  it.each(["none", "webhook"] as const)("mode %s: the M21 refusal, no question, no Slack lookup", async (mode) => {
    const h = harness(send("the second channel"), { mode, asks: ["#help"], context: NOTES, directory: false });
    const outcome = await h.planner.run("send these notes to the second channel");
    expect(outcome.status).toBe("refused");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.results).toEqual([M21_LONE_REFUSAL]);
    expect(h.directory.calls).toEqual([]);
    expect(h.facts()).toEqual([]);
  });

  it.each(["none", "webhook"] as const)("mode %s with a directory handed in anyway: still never asks", async (mode) => {
    const h = harness(send("the second channel"), { mode, asks: ["#help"], context: NOTES });
    await h.planner.run("send these notes to the second channel");
    expect(h.shell.questions).toEqual([]);
    expect(h.shell.results).toEqual([M21_LONE_REFUSAL]);
    expect(h.facts()).toEqual([]);
  });
});

describe("bot mode: the lone ask's texts", () => {
  it("never mention a webhook, and ask only through the question and the dialog title", async () => {
    const runs = [
      harness(send("the second channel"), { asks: ["#help"], context: NOTES }),
      harness(send("the second channel"), { asks: ["#hel", "#nope"], context: NOTES }),
      harness(send("the second channel"), { asks: ["#help"], failOn: { 1: "network" }, context: NOTES }),
      harness(send("the second channel"), { asks: [null], context: NOTES }),
    ];
    let questions = 0;
    for (const h of runs) {
      await h.planner.run("send these notes to the second channel");
      for (const text of h.texts()) expect(text, text).not.toMatch(/webhook/i);
      for (const text of [...h.shell.results, ...h.notified()]) expect(text, text).not.toContain("?");
      for (const dialog of h.shell.confirmMessages) {
        const [title, ...rest] = dialog.split("\n");
        expect(title).toMatch(/^Send to #[a-z0-9-]+\?$/);
        expect(rest.join("\n")).not.toContain("?");
      }
      for (const question of h.shell.questions) {
        questions += 1;
        expect(question.match(/\?/g)?.length, question).toBe(1);
      }
    }
    expect(questions).toBeGreaterThanOrEqual(5);
  });
});
