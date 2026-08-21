import { describe, it, expect, vi, afterEach } from "vitest";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { DictationSession } from "../src/main/shell/DictationSession.ts";
import { MockInputInjector } from "./MockInputInjector.ts";
import type { AudioClip, Transcriber } from "../src/core/types.ts";
import type { ForegroundWindow } from "../src/main/shell/InputInjector.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";

// M12: system-wide dictation, tested the same way VoiceSession is (see VoiceSession.test.ts) —
// no audio, no model, no microphone, no electron, and here also no PowerShell/SendInput. The
// real WindowsInputInjector is live-only (same split as WhisperCppTranscriber/ChromeGmail: no
// test spawns a real binary or drives a real OS), so MockInputInjector stands in for it.
//
// Shape mirrors VoiceSession's toggle-era design deliberately (§ the M12 plan): tap to start,
// tap again to stop-and-type. The one thing VoiceSession never had to do is check whether
// focus moved between "started speaking" and "about to type" — that check is this file's
// most important coverage.

function clip(durationMs: number): AudioClip {
  return { wav: new Uint8Array([1, 2, 3, 4]), durationMs };
}

const NOTEPAD: ForegroundWindow = { handle: 42, title: "Untitled - Notepad" };

function setup(options: {
  transcriber: Transcriber;
  clips?: AudioClip[];
  failRecording?: string;
  maxRecordingMs?: number;
  foreground?: (ForegroundWindow | null)[];
  failTypeWith?: string;
}): { shell: MockShell; injector: MockInputInjector; session: DictationSession } {
  const shell = new MockShell({
    context: { selectedText: null, activeApp: null, activeWindowTitle: null },
    clips: options.clips ?? [clip(1500)],
    ...(options.failRecording !== undefined ? { failRecording: options.failRecording } : {}),
  });
  const injector = new MockInputInjector({
    foreground: options.foreground ?? [NOTEPAD],
    ...(options.failTypeWith !== undefined ? { failTypeWith: options.failTypeWith } : {}),
  });
  const session = new DictationSession(
    shell,
    options.transcriber,
    injector,
    options.maxRecordingMs !== undefined ? { maxRecordingMs: options.maxRecordingMs } : {},
  );
  return { shell, injector, session };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("DictationSession (M12: tap to start, tap again to type)", () => {
  it("starts idle", () => {
    const { session } = setup({ transcriber: new FakeTranscriber("hi") });
    expect(session.getState()).toBe("idle");
  });

  it("toggle() from idle captures the foreground window, narrates it, and starts recording", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.toggle();

    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(1);
    expect(shell.narrations.at(-1)).toMatch(/Untitled - Notepad/);
  });

  it("toggle() again stops, transcribes, verifies focus, and types the transcript", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("summarize this for the team"),
    });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toEqual(["summarize this for the team"]);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toBe('Typed: "summarize this for the team"');
    expect(shell.voiceStates.at(-1)).toEqual({
      state: "idle",
      detail: "summarize this for the team",
    });
  });

  it("passes through recording -> transcribing -> inserting in order", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hello") });

    await session.toggle();
    await session.toggle();

    const seen = shell.voiceStates.map((v) => v.state);
    expect(seen).toEqual(["recording", "transcribing", "inserting", "idle"]);
  });

  it("refuses to type when focus moved between speaking and typing", async () => {
    const OTHER: ForegroundWindow = { handle: 99, title: "Some Other App" };
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("this should not land anywhere"),
      foreground: [NOTEPAD, OTHER],
    });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toHaveLength(0);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/Focus moved/);
    expect(shell.results.at(-1)).toMatch(/this should not land anywhere/);
  });

  it("refuses to type when the starting focus could not be captured at all", async () => {
    // No target to compare against is treated as "unsafe to type", not "assume it's fine".
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("ghost words"),
      foreground: [null, NOTEPAD],
    });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toHaveLength(0);
    expect(shell.results.at(-1)).toMatch(/Focus moved/);
  });

  it("surfaces a short/blocked write as a refusal, never a silent partial type", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("open the file menu"),
      failTypeWith: "Typing was blocked partway through (4/38 keystrokes delivered)",
    });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toHaveLength(0); // MockInputInjector never records a failed call
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/blocked partway through/);
    expect(shell.results.at(-1)).toMatch(/open the file menu/);

    // Not stuck: the next tap starts a fresh recording.
    await session.toggle();
    expect(session.getState()).toBe("recording");
  });

  it("abandon() discards the take SILENTLY while recording", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("this should never run"),
    });

    await session.toggle();
    await session.abandon();

    expect(session.getState()).toBe("idle");
    expect(shell.recordingsCancelled).toBe(1);
    expect(injector.typed).toHaveLength(0);
    // No "didn't catch that", no message of any kind — same rule as VoiceSession.abandon().
    expect(shell.results).toEqual([]);
  });

  it("the 30s cap releases the microphone WITHOUT transcribing or typing", async () => {
    vi.useFakeTimers();
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("a very long ramble"),
      maxRecordingMs: 30_000,
    });

    await session.toggle();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.getState()).toBe("stopped");
    expect(shell.recordingsStopped).toBe(1);
    expect(injector.typed).toHaveLength(0);
    expect(shell.narrations.at(-1)).toMatch(/30s/);
  });

  it("a tap after the cap still transcribes and types what was said", async () => {
    vi.useFakeTimers();
    const { injector, session } = setup({
      transcriber: new FakeTranscriber("a very long ramble"),
      maxRecordingMs: 30_000,
    });

    await session.toggle();
    await vi.advanceTimersByTimeAsync(30_000);
    await session.toggle();

    expect(injector.typed).toEqual(["a very long ramble"]);
    expect(session.getState()).toBe("idle");
  });

  it("holds the capped recording indefinitely — it never expires on its own", async () => {
    vi.useFakeTimers();
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("held audio"),
      maxRecordingMs: 30_000,
    });

    await session.toggle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.getState()).toBe("stopped");

    await vi.advanceTimersByTimeAsync(600_000);

    expect(session.getState()).toBe("stopped");
    expect(shell.recordingsCancelled).toBe(0);
    expect(shell.recordingsStopped).toBe(1);
  });

  it("abandon() after the cap throws the held audio away", async () => {
    vi.useFakeTimers();
    const { injector, session } = setup({
      transcriber: new FakeTranscriber("held audio"),
      maxRecordingMs: 30_000,
    });

    await session.toggle();
    await vi.advanceTimersByTimeAsync(30_000);
    await session.abandon();
    await session.toggle(); // fresh recording, not a resumption

    expect(session.getState()).toBe("recording");
    expect(injector.typed).toHaveLength(0);
  });

  it("does not fire the cap after a normal stop-and-type", async () => {
    vi.useFakeTimers();
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("summarize this"),
      maxRecordingMs: 30_000,
    });

    await session.toggle();
    await session.toggle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(shell.recordingsStopped).toBe(1); // not 2
  });

  it("cycles start -> stop-and-type -> start again with no state left stuck", async () => {
    // Unlike VoiceSession's begin()/finish() split, toggle() dispatches on the CURRENT
    // state — recording means "stop and type", not "ignored". This pins that a full cycle
    // (tap, tap, tap) really does start a second, independent recording afterward.
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.toggle(); // start
    await session.toggle(); // stop, transcribe, type (resolves synchronously with FakeTranscriber)
    await session.toggle(); // start again

    expect(shell.recordingsStarted).toBe(2);
    expect(session.getState()).toBe("recording");
  });

  it("ignores a stray toggle() while a transcription is already running", async () => {
    let release!: (text: string) => void;
    const transcriber: Transcriber = {
      transcribe: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const { shell, injector, session } = setup({ transcriber });

    await session.toggle();
    const stopping = session.toggle();
    await flush();
    expect(session.getState()).toBe("transcribing");

    await session.toggle(); // the stray second tap
    expect(shell.recordingsStopped).toBe(1); // no second stop

    release("open my dashboard");
    await stopping;
    expect(injector.typed).toEqual(["open my dashboard"]); // the real one still lands
  });

  it("returns to idle, typing nothing, when the transcript is blank", async () => {
    const { shell, injector, session } = setup({ transcriber: new FakeTranscriber("   \n  ") });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toHaveLength(0);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("skips transcription entirely for a clip too short to be speech", async () => {
    const transcriber = new FakeTranscriber("ghost text");
    const { shell, injector, session } = setup({ transcriber, clips: [clip(80)] });

    await session.toggle();
    await session.toggle();

    expect(injector.typed).toHaveLength(0);
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("returns to idle (never stranded) when transcription fails", async () => {
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("", "whisper exited with code 1"),
    });

    await session.toggle();
    await session.toggle();

    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/whisper exited with code 1/);

    await session.toggle();
    expect(session.getState()).toBe("recording");
  });

  it("returns to idle when the microphone can't be opened", async () => {
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("unused"),
      failRecording: "microphone access was denied",
    });

    await session.toggle();

    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/microphone access was denied/);
  });

  it("never presses Enter or adds a newline — the transcript is typed exactly as given", async () => {
    const { injector, session } = setup({
      transcriber: new FakeTranscriber("first line\nsecond line"),
    });

    await session.toggle();
    await session.toggle();

    // Exactly one typeText() call with the raw transcript — no Enter is ever synthesized
    // around it, and no cleanup/rewrite pass runs over it (v1 is raw transcript only).
    expect(injector.typed).toEqual(["first line\nsecond line"]);
  });
});
