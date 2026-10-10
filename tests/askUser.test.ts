import { describe, it, expect } from "vitest";
import { createOnInstructionHotkey } from "../src/main/instructionHotkey.ts";
import { combineInstructionBusy, createOnDictateHotkey } from "../src/main/dictate.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext } from "../src/core/types.ts";

// `askUser(question)`: one question, one typed line back — or null when the user declined to
// answer. This file pins the FAKE (MockShell) and what the two hotkeys do while a question is
// really, not nominally, waiting. The real shell's half is in tests/WindowsShell.capture.test.ts.
//
// The fake can be HELD, like `holdConfirm`, and for the same reason: the real ask stays pending
// until a person types something, and every guard below is about what must be true DURING that
// wait. A fake that answered in the same tick would have no "during" to assert on.

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Has this promise settled yet? Answered by racing it against a tick, never by a flag the code
// under test sets.
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const first = await Promise.race([promise, settle().then(() => pending)]);
  return first !== pending;
}

describe("MockShell.askUser — answered from the queue", () => {
  it("records each question and answers in order", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, asks: ["#bugs", "tomorrow"] });

    expect(await shell.askUser("Which channel?")).toBe("#bugs");
    expect(await shell.askUser("When?")).toBe("tomorrow");
    expect(shell.questions).toEqual(["Which channel?", "When?"]);
  });

  it("keeps an EMPTY answer distinct from no answer", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, asks: ["", null] });

    expect(await shell.askUser("Anything to add?")).toBe("");
    expect(await shell.askUser("Anything to add?")).toBeNull();
  });

  it("answers null when nothing was queued — a question nobody answered, never a made-up one", async () => {
    const shell = new MockShell({ context: NO_CONTEXT });

    expect(await shell.askUser("Which channel?")).toBeNull();
    expect(shell.isAskPending()).toBe(false);
  });
});

describe("MockShell.askUser — held open", () => {
  it("stays pending until answerAsk, and says so from the moment it is asked", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true });
    expect(shell.isAskPending()).toBe(false);

    const asking = shell.askUser("Which channel?");
    // Synchronously — no instant in which the question is up and the guards do not know.
    expect(shell.isAskPending()).toBe(true);
    expect(shell.questions).toEqual(["Which channel?"]);
    expect(await isSettled(asking)).toBe(false);

    shell.answerAsk("#bugs");

    expect(await asking).toBe("#bugs");
    expect(shell.isAskPending()).toBe(false);
  });

  it("can be answered with an empty line, or dismissed with null", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true });

    const empty = shell.askUser("Anything to add?");
    shell.answerAsk("");
    expect(await empty).toBe("");

    const dismissed = shell.askUser("Anything to add?");
    shell.answerAsk(null);
    expect(await dismissed).toBeNull();
  });

  it("falls back to the queue when answerAsk is given nothing, like answerConfirm", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true, asks: ["#bugs"] });

    const asking = shell.askUser("Which channel?");
    shell.answerAsk();

    expect(await asking).toBe("#bugs");
  });

  // The real shell refuses to ask while something else owns the user's attention, and the fake
  // must not be more lenient than that about the two states it can itself be in.
  it("answers null to a second question while the first is still open, and leaves the first alone", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true });

    const first = shell.askUser("Which channel?");
    const second = shell.askUser("And when?");

    expect(await second).toBeNull();
    expect(shell.questions).toEqual(["Which channel?"]); // the second was never shown
    expect(await isSettled(first)).toBe(false);

    shell.answerAsk("#bugs");
    expect(await first).toBe("#bugs");
  });

  it("answers null while a confirm dialog is waiting, without recording a question", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true, holdConfirm: true });

    const confirming = shell.confirm("Send it?");
    expect(await shell.askUser("Which channel?")).toBeNull();
    expect(shell.questions).toEqual([]);
    expect(shell.isAskPending()).toBe(false);

    shell.answerConfirm(true);
    await confirming;
  });
});

// The real handlers over a really-held question.
describe("the hotkeys while a question is genuinely waiting", () => {
  function wired() {
    const shell = new MockShell({ context: NO_CONTEXT, holdAsk: true, inputs: ["summarize this"] });
    const runs: string[] = [];
    const onHotkey = createOnInstructionHotkey({
      shell: {
        isConfirmPending: () => shell.isConfirmPending(),
        isAskPending: () => shell.isAskPending(),
        focusAsk: () => shell.focusAsk(),
        narrate: (text: string) => shell.narrate(text),
        showInput: () => shell.showInput(),
        clearPointer: () => {},
        snapshotPointTarget: () => Promise.resolve(),
      },
      dictation: null,
      voice: null,
      speech: null,
      chain: null,
      runInstruction: (instruction: string) => {
        runs.push(instruction);
        return Promise.resolve();
      },
    });

    let dictations = 0;
    const onDictate = createOnDictateHotkey(
      { begin: () => ((dictations += 1), Promise.resolve()) },
      combineInstructionBusy(null, {
        isInputCapturing: () => false,
        isConfirmPending: () => shell.isConfirmPending(),
        isAskPending: () => shell.isAskPending(),
      }),
    );

    return { shell, runs, onHotkey, onDictate, dictations: () => dictations };
  }

  it("the instruction hotkey starts nothing and puts the question back in focus", async () => {
    const w = wired();
    const asking = w.shell.askUser("Which channel?");

    w.onHotkey();
    await settle();

    expect(w.runs).toEqual([]); // no competing capture, no second run
    expect(w.shell.askFocusCalls).toBe(1);
    expect(w.shell.narrations).toEqual([]);
    // The press did not answer, dismiss or replace the question.
    expect(w.shell.isAskPending()).toBe(true);
    expect(await isSettled(asking)).toBe(false);
    expect(w.shell.questions).toEqual(["Which channel?"]);

    w.shell.answerAsk("#bugs");
    expect(await asking).toBe("#bugs");
  });

  it("the instruction hotkey works again the moment the question is answered", async () => {
    const w = wired();
    const asking = w.shell.askUser("Which channel?");
    w.onHotkey();
    await settle();
    expect(w.runs).toEqual([]);

    w.shell.answerAsk(null);
    await asking;
    w.onHotkey();
    await settle();

    expect(w.runs).toEqual(["summarize this"]);
    expect(w.shell.askFocusCalls).toBe(1); // only the blocked press refocused anything
  });

  it("the dictation hotkey is blocked for exactly as long as the question is open", async () => {
    // Dictation types into whatever has focus — which, during a question, is the answer box —
    // and its Enter-to-finish is the same key as the box's Enter-to-answer.
    const w = wired();
    const asking = w.shell.askUser("Which channel?");

    w.onDictate();
    expect(w.dictations()).toBe(0);

    w.shell.answerAsk("#bugs");
    await asking;
    w.onDictate();
    expect(w.dictations()).toBe(1);
  });
});
