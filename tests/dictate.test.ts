import { describe, it, expect } from "vitest";
import {
  createOnDictateHotkey,
  dictationIsBusy,
  combineInstructionBusy,
} from "../src/main/dictate.ts";

// The mutual-exclusion rule (M12, widened M12.1): DictationSession and VoiceSession share one
// microphone and, while dictation runs, the same BrowserWindow the instruction bar focuses.
// Neither hotkey handler may fire while the other session is mid-flight. M12.1 widened the
// dictation-hotkey side specifically: once Enter is a global trigger both flows can reach for,
// it must stay blocked for the bar's WHOLE open lifetime, not just while voice is recording —
// see combineInstructionBusy below.

function startable(initial = "idle") {
  let state = initial;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getState: () => state,
    setState: (s: string) => (state = s),
    begin: async () => {
      calls += 1;
    },
  };
}

describe("createOnDictateHotkey", () => {
  it("starts dictation when no instruction voice session is running", () => {
    const dictation = startable("idle");
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => "idle" });

    onHotkey();

    expect(dictation.calls).toBe(1);
  });

  it("does nothing when there is no busy-state to check (voice disabled)", () => {
    const dictation = startable("idle");
    const onHotkey = createOnDictateHotkey(dictation, null);

    onHotkey();

    expect(dictation.calls).toBe(1); // null means "nothing to conflict with", not "blocked"
  });

  it("ignores the dictation hotkey while the instruction bar is capturing voice", () => {
    const dictation = startable("idle");
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => "recording" });

    onHotkey();

    expect(dictation.calls).toBe(0);
  });

  it("still fires once the busy-state returns to idle", () => {
    const dictation = startable("idle");
    let busy = "transcribing";
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => busy });

    onHotkey();
    expect(dictation.calls).toBe(0);

    busy = "idle";
    onHotkey();
    expect(dictation.calls).toBe(1);
  });
});

describe("dictationIsBusy", () => {
  it("is false when dictation does not exist (voice off, so dictation is off too)", () => {
    expect(dictationIsBusy(null)).toBe(false);
  });

  it("is false while idle and true in every other state", () => {
    const dictation = startable("idle");
    expect(dictationIsBusy(dictation)).toBe(false);

    dictation.setState("recording");
    expect(dictationIsBusy(dictation)).toBe(true);

    dictation.setState("inserting");
    expect(dictationIsBusy(dictation)).toBe(true);
  });
});

describe("combineInstructionBusy (M12.1)", () => {
  it("is idle when neither voice nor the bar is busy", () => {
    const busy = combineInstructionBusy({ getState: () => "idle" }, { isInputCapturing: () => false });
    expect(busy.getState()).toBe("idle");
  });

  it("is busy while voice is recording, exactly as before", () => {
    const busy = combineInstructionBusy(
      { getState: () => "recording" },
      { isInputCapturing: () => false },
    );
    expect(busy.getState()).not.toBe("idle");
  });

  it("is busy while the bar is open, even if voice itself has already gone idle", () => {
    // The exact gap M12.1 closes: voice was abandoned (commandbar:typing fired) but the bar
    // is still open with unsubmitted typed text — dictation's Enter must not collide with it.
    const busy = combineInstructionBusy(
      { getState: () => "idle" },
      { isInputCapturing: () => true },
    );
    expect(busy.getState()).not.toBe("idle");
  });

  it("is idle when there is no voice session at all and the bar isn't capturing", () => {
    const busy = combineInstructionBusy(null, { isInputCapturing: () => false });
    expect(busy.getState()).toBe("idle");
  });
});
