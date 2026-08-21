import { describe, it, expect } from "vitest";
import { createOnDictateHotkey, dictationIsBusy } from "../src/main/dictate.ts";

// The mutual-exclusion rule (M12): DictationSession and VoiceSession share one microphone
// and, while dictation runs, the same BrowserWindow the instruction bar focuses. Neither
// hotkey handler may fire while the other session is mid-flight.

function toggleable(initial = "idle") {
  let state = initial;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getState: () => state,
    setState: (s: string) => (state = s),
    toggle: async () => {
      calls += 1;
    },
  };
}

describe("createOnDictateHotkey", () => {
  it("toggles dictation when no instruction voice session is running", () => {
    const dictation = toggleable("idle");
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => "idle" });

    onHotkey();

    expect(dictation.calls).toBe(1);
  });

  it("does nothing when there is no instruction voice at all (voice disabled)", () => {
    const dictation = toggleable("idle");
    const onHotkey = createOnDictateHotkey(dictation, null);

    onHotkey();

    expect(dictation.calls).toBe(1); // null means "no voice to conflict with", not "blocked"
  });

  it("ignores the dictation hotkey while the instruction bar is capturing voice", () => {
    const dictation = toggleable("idle");
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => "recording" });

    onHotkey();

    expect(dictation.calls).toBe(0);
  });

  it("still fires once the instruction voice session returns to idle", () => {
    const dictation = toggleable("idle");
    let voiceState = "transcribing";
    const onHotkey = createOnDictateHotkey(dictation, { getState: () => voiceState });

    onHotkey();
    expect(dictation.calls).toBe(0);

    voiceState = "idle";
    onHotkey();
    expect(dictation.calls).toBe(1);
  });
});

describe("dictationIsBusy", () => {
  it("is false when dictation does not exist (voice off, so dictation is off too)", () => {
    expect(dictationIsBusy(null)).toBe(false);
  });

  it("is false while idle and true in every other state", () => {
    const dictation = toggleable("idle");
    expect(dictationIsBusy(dictation)).toBe(false);

    dictation.setState("recording");
    expect(dictationIsBusy(dictation)).toBe(true);

    dictation.setState("inserting");
    expect(dictationIsBusy(dictation)).toBe(true);
  });
});
