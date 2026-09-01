import { describe, it, expect } from "vitest";
import {
  CHAIN_RUNNING,
  CONFIRM_WAITING,
  createOnInstructionHotkey,
} from "../src/main/instructionHotkey.ts";

// M14 §8. The guard that was designed, approved, and then never built.
//
// It was found by a person driving the real app: a createEvent invite sat on screen unanswered
// while the instruction hotkey started a whole second planner run, which transcribed, answered,
// spoke and displayed itself over the top of the dialog it should have been blocked by.
//
// The reason nothing failed first is that the handler lived inside main.ts, which boots
// electron and therefore cannot be imported by a test. It is a separate module now. Everything
// below would have failed on the commit that shipped without the guard, which is the only
// property of this file that actually matters.

function harness(
  options: {
    confirmPending?: boolean;
    dictating?: boolean;
    typed?: string;
    // M17. A chain partway through — the second long-lived state a press can land in.
    chaining?: boolean;
  } = {},
) {
  const events: string[] = [];
  let confirmPending = options.confirmPending ?? false;
  let chaining = options.chaining ?? false;

  const shell = {
    isConfirmPending: () => confirmPending,
    narrate: (text: string) => events.push(`narrate:${text}`),
    showInput: () => {
      events.push("showInput");
      return Promise.resolve(options.typed ?? "");
    },
    clearPointer: () => events.push("clearPointer"),
    // M16.9, CORRECTED AT M16.11. This fake used to be SYNCHRONOUS, and that is exactly why the
    // test below passed while the shipped app was broken.
    //
    // The real implementation asks a PowerShell host for GetForegroundWindow(), which is
    // asynchronous — and on the first press it also spawns that host (~918ms). Recording only
    // that the CALL happened before showInput() proves nothing: what has to happen first is the
    // READ. A synchronous fake cannot tell those apart, so it reported a green test on a code
    // path that captured the command bar every single time.
    //
    // Now async, resolving on a later tick, and it records the resolution separately from the
    // call. CLAUDE.md's rule about fakes drifting from the real thing, learned again.
    snapshotPointTarget: () => {
      events.push("snapshotTarget:called");
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          events.push("snapshotTarget:read");
          resolve();
        }, 0);
      });
    },
  };
  const voice = {
    begin: () => {
      events.push("mic");
      return Promise.resolve();
    },
    finish: () => Promise.resolve("what's in my calendar today?"),
  };
  const speech = {
    speak: (text: string) => events.push(`speak:${text}`),
    stop: () => events.push("stop"),
  };
  const dictation = options.dictating === true ? { getState: () => "recording" } : null;

  const onHotkey = createOnInstructionHotkey({
    shell,
    dictation,
    voice,
    speech,
    chain: { isRunning: () => chaining },
    runInstruction: (instruction: string) => {
      events.push(`run:${instruction}`);
      return Promise.resolve();
    },
  });

  return {
    onHotkey,
    events,
    release: () => (confirmPending = false),
    finishChain: () => (chaining = false),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the instruction hotkey while a confirm is waiting", () => {
  it("starts no planner run", async () => {
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    expect(events.filter((e) => e.startsWith("run:"))).toEqual([]);
  });

  it("does not open the bar or the microphone", async () => {
    // showInput() calls window.focus(), which takes focus OFF the dialog, and window.show()
    // re-registers the global Escape that confirm() released so the dialog's own cancel would
    // work. Both are damage done on the way to the second run, not just noise.
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("showInput");
    expect(events).not.toContain("mic");
  });

  it("says so rather than doing nothing", async () => {
    // A hotkey that silently ignores you is indistinguishable from a broken app — this
    // project's own stated worst failure (spec §4a).
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    expect(events).toContain(`narrate:${CONFIRM_WAITING}`);
    expect(events.some((e) => e.startsWith("speak:"))).toBe(true);
  });

  it("speaks it through the cleaner, so no em dash reaches the engine", async () => {
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    const spoken = events.find((e) => e.startsWith("speak:")) ?? "";
    expect(spoken).not.toContain("—");
    expect(CONFIRM_WAITING).toContain("—"); // the written form does have one
  });

  it("leaves the pointing marker alone", async () => {
    // M15, and the same reasoning as the barge-in above: a press that was IGNORED changed
    // nothing, so it must not silently clear the answer still on screen. The marker is only
    // dismissed by a press that actually starts something.
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("clearPointer");
  });

  it("does not cut off the confirm question it is answering about", async () => {
    // The barge-in stop must not fire on this path: the dialog's own question may still be
    // being read out, and silencing it to say "there's a confirmation waiting" is absurd.
    const { onHotkey, events } = harness({ confirmPending: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("stop");
  });

  it("works normally again once the dialog is answered", async () => {
    // The flag must not strand the hotkey. WindowsShell clears it in a `finally` so even a
    // dialog that throws cannot leave the app deaf.
    const { onHotkey, events, release } = harness({ confirmPending: true });

    onHotkey();
    await settle();
    release();
    onHotkey();
    await settle();

    expect(events).toContain("run:what's in my calendar today?");
  });
});

describe("the instruction hotkey otherwise", () => {
  it("opens the bar, starts the microphone, and runs what was said", async () => {
    const { onHotkey, events } = harness();

    onHotkey();
    await settle();

    expect(events).toContain("showInput");
    expect(events).toContain("mic");
    expect(events).toContain("run:what's in my calendar today?");
  });

  it("runs typed text without waiting on the transcript", async () => {
    const { onHotkey, events } = harness({ typed: "summarize this" });

    onHotkey();
    await settle();

    expect(events).toContain("run:summarize this");
  });

  it("stops any speech before listening", async () => {
    // The app must be quiet before the microphone opens, or whisper transcribes its own voice
    // into the user's instruction.
    const { onHotkey, events } = harness();

    onHotkey();
    await settle();

    expect(events.indexOf("stop")).toBeLessThan(events.indexOf("mic"));
  });

  it("takes down the pointing marker before the next question", async () => {
    // A marker answers a question asked at a moment. Reaching for the hotkey is the clearest
    // signal that the moment has passed, and a highlight left floating over another app while a
    // new instruction runs is pointing at the answer to the wrong question.
    const { onHotkey, events } = harness();

    onHotkey();
    await settle();

    expect(events.indexOf("clearPointer")).toBeLessThan(events.indexOf("showInput"));
  });

  it("stays out of the way while dictation is running", async () => {
    const { onHotkey, events } = harness({ dictating: true });

    onHotkey();
    await settle();

    // Nothing at all — including no clearPointer. Dictation owns the screen and the microphone,
    // and an ignored press must leave every one of them exactly as it found them.
    expect(events).toEqual([]);
  });
});

// M16.9. The one ordering that matters in this file, and the one nothing else could catch: the
// target snapshot has to be taken BEFORE showInput(), because showInput() calls window.focus()
// and makes this app the foreground window. Taken after, it would record the command bar every
// single time and pointAt would read its own UI.
//
// Exactly the mistake DictationSession already avoids by capturing getForegroundWindow() before
// opening the microphone — same problem, same one-line answer, and worth an assertion rather
// than a comment because a later refactor moving one line would break it silently.
describe("the target snapshot", () => {
  it("happens before the bar takes focus", async () => {
    const { onHotkey, events } = harness({ typed: "where is the file menu" });
    onHotkey();
    await settle();

    // The CALL happening first is not the property that matters.
    expect(events.indexOf("snapshotTarget:called")).toBeLessThan(events.indexOf("showInput"));
    // THIS is the property. The foreground has to be READ before the bar takes focus; if the
    // read lands afterwards it records the command bar, which is what shipped and what M16.11
    // found by hand.
    expect(events.indexOf("snapshotTarget:read")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("snapshotTarget:read")).toBeLessThan(events.indexOf("showInput"));
  });

  it("is NOT taken when the press was ignored for a pending confirm", async () => {
    // A press that changed nothing must not move the target either — otherwise answering a
    // dialog would silently repoint the next question at whatever was in front then.
    const { onHotkey, events } = harness({ confirmPending: true });
    onHotkey();
    await settle();

    expect(events).not.toContain("snapshotTarget:called");
  });

  it("is NOT taken while dictation is running", async () => {
    const { onHotkey, events } = harness({ dictating: true });
    onHotkey();
    await settle();

    expect(events).not.toContain("snapshotTarget:called");
  });
});

// M17. The second long-lived state a press can land in. A chain is on screen for three steps
// rather than one, so reaching for the hotkey partway through is an ordinary thing to do — and
// without a guard it starts a second concurrent planner run over a sequence that is still
// acting inside Chrome. Exactly the M14 §8 failure, with a much wider window to hit.
describe("the instruction hotkey while a chain is still running", () => {
  it("starts no second planner run", async () => {
    const { onHotkey, events } = harness({ chaining: true });

    onHotkey();
    await settle();

    expect(events.filter((e) => e.startsWith("run:"))).toEqual([]);
  });

  it("does not open the bar or the microphone", async () => {
    const { onHotkey, events } = harness({ chaining: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("showInput");
    expect(events).not.toContain("mic");
  });

  it("says so rather than doing nothing", async () => {
    const { onHotkey, events } = harness({ chaining: true });

    onHotkey();
    await settle();

    expect(events).toContain(`narrate:${CHAIN_RUNNING}`);
    // Spoken through the same cleaner every other utterance goes through, so this line cannot
    // be the one that sends an em dash to the engine — the written form has one.
    const spoken = events.find((e) => e.startsWith("speak:")) ?? "";
    expect(spoken).toContain("partway through");
    expect(spoken).not.toContain("—");
    expect(CHAIN_RUNNING).toContain("—");
  });

  it("does not move the pointing target or clear the marker", async () => {
    // Same rule as the confirm guard: a press that was IGNORED changed nothing.
    const { onHotkey, events } = harness({ chaining: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("clearPointer");
    expect(events).not.toContain("snapshotTarget:called");
  });

  it("works normally again once the chain finishes", async () => {
    const { onHotkey, events, finishChain } = harness({ chaining: true });

    onHotkey();
    await settle();
    finishChain();
    onHotkey();
    await settle();

    expect(events).toContain("run:what's in my calendar today?");
  });
});

// THE REQUIRED REGRESSION TEST (M17 plan, "Verification"): the M14 §8 guard at step N of N.
//
// Inside a chain, a step parked at its confirm gate makes BOTH guards' conditions true at the
// same moment — proven at the planner level in tests/planner.chain.test.ts, where the held
// dialog has `isConfirmPending()` and `chain.isRunning()` both reporting true. What this file
// has to pin is which of the two ANSWERS, because only one of them names something the user can
// act on. A chain guard that ran first would tell someone to wait for a chain that is, in fact,
// waiting for them — a dialog they would then never think to look for.
describe("the instruction hotkey when a chain is parked at a confirm dialog", () => {
  it("still starts nothing", async () => {
    const { onHotkey, events } = harness({ chaining: true, confirmPending: true });

    onHotkey();
    await settle();

    expect(events.filter((e) => e.startsWith("run:"))).toEqual([]);
    expect(events).not.toContain("showInput");
    expect(events).not.toContain("mic");
  });

  it("points at the dialog, not at the chain", async () => {
    // The ordering assertion. This is what distinguishes the two guards being in the right
    // order from them merely both existing — swap them and only this test fails.
    const { onHotkey, events } = harness({ chaining: true, confirmPending: true });

    onHotkey();
    await settle();

    expect(events).toContain(`narrate:${CONFIRM_WAITING}`);
    expect(events).not.toContain(`narrate:${CHAIN_RUNNING}`);
  });

  it("does not cut off the confirm question it is answering about", async () => {
    // The confirm guard's own barge-in rule has to survive being reached from inside a chain:
    // the dialog's question may still be being read out.
    const { onHotkey, events } = harness({ chaining: true, confirmPending: true });

    onHotkey();
    await settle();

    expect(events).not.toContain("stop");
  });
});
