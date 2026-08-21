import { describe, it, expect, vi, afterEach } from "vitest";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { DictationSession } from "../src/main/shell/DictationSession.ts";
import { MockInputInjector } from "./MockInputInjector.ts";
import type { AudioClip, Transcriber } from "../src/core/types.ts";
import type { ForegroundWindow } from "../src/main/shell/InputInjector.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";

// M12/M12.1: system-wide dictation, tested the same way VoiceSession is (see
// VoiceSession.test.ts) — no audio, no model, no microphone, no electron, and here also no
// PowerShell/SendInput. The real WindowsInputInjector is live-only (same split as
// WhisperCppTranscriber/ChromeGmail: no test spawns a real binary or drives a real OS), so
// MockInputInjector stands in for it.
//
// begin()/finish() now mirrors VoiceSession's own shape exactly (M12.1 replaced the original
// same-hotkey toggle with Enter-to-finish, once Enter could be armed as a global shortcut).
// `shell.pressStopKey()` stands in for the real global Enter press, the same way
// `ackVoiceStarted()` elsewhere stands in for the renderer's IPC ack. The one thing
// VoiceSession never had to do is check whether focus moved between "started speaking" and
// "about to type" — that check is still this file's most important coverage.

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

describe("DictationSession (M12.1: hotkey starts, Enter finishes)", () => {
  it("starts idle", () => {
    const { session } = setup({ transcriber: new FakeTranscriber("hi") });
    expect(session.getState()).toBe("idle");
  });

  it("begin() captures the foreground window, arms Enter, and narrates before recording", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.begin();

    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(1);
    expect(shell.armStopKeyCalls).toBe(1);
    expect(shell.narrations.at(-1)).toMatch(/Untitled - Notepad/);
    expect(shell.narrations.at(-1)).toMatch(/press Enter when done/);
  });

  it("pressing the stop key stops, transcribes, verifies focus, types, and disarms Enter", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("summarize this for the team"),
    });

    await session.begin();
    await shell.pressStopKey();

    expect(injector.typed).toEqual(["summarize this for the team"]);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toBe('Typed: "summarize this for the team"');
    expect(shell.voiceStates.at(-1)).toEqual({
      state: "idle",
      detail: "summarize this for the team",
    });
    expect(shell.disarmStopKeyCalls).toBe(1);
  });

  it("passes through recording -> transcribing -> inserting in order", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hello") });

    await session.begin();
    await shell.pressStopKey();

    const seen = shell.voiceStates.map((v) => v.state);
    expect(seen).toEqual(["recording", "transcribing", "inserting", "idle"]);
  });

  it("refuses to type when focus moved between speaking and typing", async () => {
    const OTHER: ForegroundWindow = { handle: 99, title: "Some Other App" };
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("this should not land anywhere"),
      foreground: [NOTEPAD, OTHER],
    });

    await session.begin();
    await shell.pressStopKey();

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

    await session.begin();
    await shell.pressStopKey();

    expect(injector.typed).toHaveLength(0);
    expect(shell.results.at(-1)).toMatch(/Focus moved/);
  });

  it("surfaces a short/blocked write as a refusal, never a silent partial type", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("open the file menu"),
      failTypeWith: "Typing was blocked partway through (4/38 keystrokes delivered)",
    });

    await session.begin();
    await shell.pressStopKey();

    expect(injector.typed).toHaveLength(0); // MockInputInjector never records a failed call
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/blocked partway through/);
    expect(shell.results.at(-1)).toMatch(/open the file menu/);

    // Not stuck: the hotkey starts a fresh recording.
    await session.begin();
    expect(session.getState()).toBe("recording");
  });

  it("abandon() discards the take SILENTLY while recording, and disarms Enter", async () => {
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("this should never run"),
    });

    await session.begin();
    await session.abandon();

    expect(session.getState()).toBe("idle");
    expect(shell.recordingsCancelled).toBe(1);
    expect(injector.typed).toHaveLength(0);
    expect(shell.disarmStopKeyCalls).toBe(1);
    // No "didn't catch that", no message of any kind — same rule as VoiceSession.abandon().
    expect(shell.results).toEqual([]);
  });

  it("a stray Enter press once idle is a harmless no-op", async () => {
    const { shell, injector, session } = setup({ transcriber: new FakeTranscriber("unused") });

    // Never armed in the first place — pressStopKey() before any begin() has nothing to call.
    await shell.pressStopKey();

    expect(session.getState()).toBe("idle");
    expect(injector.typed).toHaveLength(0);
  });

  it("the 30s cap releases the microphone WITHOUT transcribing or typing (Enter stays armed)", async () => {
    vi.useFakeTimers();
    const { shell, injector, session } = setup({
      transcriber: new FakeTranscriber("a very long ramble"),
      maxRecordingMs: 30_000,
    });

    await session.begin();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.getState()).toBe("stopped");
    expect(shell.recordingsStopped).toBe(1);
    expect(injector.typed).toHaveLength(0);
    expect(shell.narrations.at(-1)).toMatch(/30s/);
    expect(shell.narrations.at(-1)).toMatch(/press Enter/);
    expect(shell.disarmStopKeyCalls).toBe(0); // still armed — Enter still finishes it from here
  });

  it("Enter after the cap still transcribes and types what was said", async () => {
    vi.useFakeTimers();
    const { injector, session, shell } = setup({
      transcriber: new FakeTranscriber("a very long ramble"),
      maxRecordingMs: 30_000,
    });

    await session.begin();
    await vi.advanceTimersByTimeAsync(30_000);
    await shell.pressStopKey();

    expect(injector.typed).toEqual(["a very long ramble"]);
    expect(session.getState()).toBe("idle");
  });

  it("holds the capped recording indefinitely — it never expires on its own", async () => {
    vi.useFakeTimers();
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("held audio"),
      maxRecordingMs: 30_000,
    });

    await session.begin();
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

    await session.begin();
    await vi.advanceTimersByTimeAsync(30_000);
    await session.abandon();
    await session.begin(); // fresh recording, not a resumption

    expect(session.getState()).toBe("recording");
    expect(injector.typed).toHaveLength(0);
  });

  it("does not fire the cap after a normal finish", async () => {
    vi.useFakeTimers();
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("summarize this"),
      maxRecordingMs: 30_000,
    });

    await session.begin();
    await shell.pressStopKey();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(shell.recordingsStopped).toBe(1); // not 2
  });

  it("ignores begin() while already listening", async () => {
    // Mirrors VoiceSession's own "ignores begin() while already listening" test exactly — the
    // dictate hotkey is now start-only, so a repeat press mid-recording must no-op, not stop it.
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.begin();
    await session.begin();

    expect(shell.recordingsStarted).toBe(1);
    expect(session.getState()).toBe("recording");
  });

  it("cycles start -> Enter-finish -> start again with no state left stuck", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.begin();
    await shell.pressStopKey(); // stop, transcribe, type (resolves synchronously with FakeTranscriber)
    await session.begin(); // start again

    expect(shell.recordingsStarted).toBe(2);
    expect(session.getState()).toBe("recording");
  });

  it("ignores a stray Enter press while a transcription is already running", async () => {
    let release!: (text: string) => void;
    const transcriber: Transcriber = {
      transcribe: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const { shell, injector, session } = setup({ transcriber });

    await session.begin();
    const finishing = shell.pressStopKey();
    await flush();
    expect(session.getState()).toBe("transcribing");

    await shell.pressStopKey(); // the stray second Enter
    expect(shell.recordingsStopped).toBe(1); // no second stop

    release("open my dashboard");
    await finishing;
    expect(injector.typed).toEqual(["open my dashboard"]); // the real one still lands
  });

  it("returns to idle, typing nothing, when the transcript is blank", async () => {
    const { shell, injector, session } = setup({ transcriber: new FakeTranscriber("   \n  ") });

    await session.begin();
    await shell.pressStopKey();

    expect(injector.typed).toHaveLength(0);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("skips transcription entirely for a clip too short to be speech", async () => {
    const transcriber = new FakeTranscriber("ghost text");
    const { shell, injector, session } = setup({ transcriber, clips: [clip(80)] });

    await session.begin();
    await shell.pressStopKey();

    expect(injector.typed).toHaveLength(0);
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("returns to idle (never stranded) when transcription fails", async () => {
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("", "whisper exited with code 1"),
    });

    await session.begin();
    await shell.pressStopKey();

    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/whisper exited with code 1/);

    await session.begin();
    expect(session.getState()).toBe("recording");
  });

  it("returns to idle when the microphone can't be opened", async () => {
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("unused"),
      failRecording: "microphone access was denied",
    });

    await session.begin();

    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/microphone access was denied/);
  });

  it("types the raw transcript verbatim — Enter stops the session but never lands in the text", async () => {
    const { injector, session, shell } = setup({
      transcriber: new FakeTranscriber("first line\nsecond line"),
    });

    await session.begin();
    await shell.pressStopKey();

    // Exactly one typeText() call with the raw transcript — no cleanup/rewrite pass runs
    // over it (v1 is raw transcript only), and the Enter that stopped the session is not
    // itself part of what got typed.
    expect(injector.typed).toEqual(["first line\nsecond line"]);
  });
});
