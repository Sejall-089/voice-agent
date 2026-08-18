import { describe, it, expect, vi, afterEach } from "vitest";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { VoiceSession } from "../src/main/shell/VoiceSession.ts";
import type { AudioClip, CapturedContext, Transcriber } from "../src/core/types.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";

// The capture session, tested directly. No audio, no model, no microphone, no electron —
// the point of VoiceSession being a plain injectable class.
//
// M8 replaced the two-hotkey toggle with a session tied to the command bar: begin() when
// the bar opens, finish() when Enter is pressed, abandon() when you type instead.

const CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

function clip(durationMs: number): AudioClip {
  return { wav: new Uint8Array([1, 2, 3, 4]), durationMs };
}

function setup(options: {
  transcriber: Transcriber;
  clips?: AudioClip[];
  failRecording?: string;
  maxRecordingMs?: number;
}): { shell: MockShell; session: VoiceSession } {
  const shell = new MockShell({
    context: CONTEXT,
    clips: options.clips ?? [clip(1500)],
    ...(options.failRecording !== undefined ? { failRecording: options.failRecording } : {}),
  });
  const session = new VoiceSession(
    shell,
    options.transcriber,
    options.maxRecordingMs !== undefined ? { maxRecordingMs: options.maxRecordingMs } : {},
  );
  return { shell, session };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceSession (M8: one hotkey, bar-lifetime capture)", () => {
  it("starts idle", () => {
    const { session } = setup({ transcriber: new FakeTranscriber("hi") });
    expect(session.getState()).toBe("idle");
  });

  it("begin() opens the microphone and announces that it is listening", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.begin();

    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(1);
    expect(shell.voiceStates).toContainEqual({ state: "recording" });
  });

  it("finish() stops, transcribes, and returns what was said", async () => {
    const transcriber = new FakeTranscriber("summarize this");
    const { shell, session } = setup({ transcriber });

    await session.begin();
    const spoken = await session.finish();

    expect(spoken).toBe("summarize this");
    expect(shell.recordingsStopped).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
    expect(session.getState()).toBe("idle");
    // The transcript rides back on the idle state so the bar can show what it heard.
    expect(shell.voiceStates.at(-1)).toEqual({ state: "idle", detail: "summarize this" });
  });

  it("abandon() discards the take SILENTLY — typing is not an error", async () => {
    const transcriber = new FakeTranscriber("this should never run");
    const { shell, session } = setup({ transcriber });

    await session.begin();
    await session.abandon();

    expect(session.getState()).toBe("idle");
    expect(shell.recordingsCancelled).toBe(1);
    expect(shell.recordingsStopped).toBe(0);
    expect(transcriber.calls).toHaveLength(0);
    // The load-bearing assertion: no "didn't catch that", no message of any kind.
    expect(shell.results).toEqual([]);
  });

  it("returns nothing from a finish() after the session was abandoned", async () => {
    // Exactly the typed path: you spoke nothing, typed something, and Enter must run the
    // typed text without a stray transcript arriving behind it.
    const transcriber = new FakeTranscriber("ghost words");
    const { session } = setup({ transcriber });

    await session.begin();
    await session.abandon();

    expect(await session.finish()).toBe("");
    expect(transcriber.calls).toHaveLength(0);
  });

  it("the 90s cap releases the microphone WITHOUT transcribing or acting", async () => {
    vi.useFakeTimers();
    const transcriber = new FakeTranscriber("a very long ramble");
    const { shell, session } = setup({ transcriber, maxRecordingMs: 90_000 });

    await session.begin();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(session.getState()).toBe("stopped");
    expect(shell.recordingsStopped).toBe(1); // mic released
    expect(transcriber.calls).toHaveLength(0); // but no whisper work yet
    expect(shell.voiceStates.at(-1)).toEqual({ state: "stopped" });
  });

  it("Enter after the cap still runs what was said", async () => {
    vi.useFakeTimers();
    const { session } = setup({
      transcriber: new FakeTranscriber("a very long ramble"),
      maxRecordingMs: 90_000,
    });

    await session.begin();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(await session.finish()).toBe("a very long ramble");
    expect(session.getState()).toBe("idle");
  });

  it("abandon() after the cap throws the held audio away", async () => {
    vi.useFakeTimers();
    const transcriber = new FakeTranscriber("held audio");
    const { session } = setup({ transcriber, maxRecordingMs: 90_000 });

    await session.begin();
    await vi.advanceTimersByTimeAsync(90_000);
    await session.abandon();

    expect(await session.finish()).toBe("");
    expect(transcriber.calls).toHaveLength(0);
  });

  it("does not fire the cap after a normal finish", async () => {
    vi.useFakeTimers();
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("summarize this"),
      maxRecordingMs: 90_000,
    });

    await session.begin();
    await session.finish();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(shell.recordingsStopped).toBe(1); // not 2
  });

  it("ignores begin() while already listening", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.begin();
    await session.begin();

    expect(shell.recordingsStarted).toBe(1);
  });

  it("ignores finish() while a transcription is already running", async () => {
    let release!: (text: string) => void;
    const transcriber: Transcriber = {
      transcribe: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const { shell, session } = setup({ transcriber });

    await session.begin();
    const finishing = session.finish();
    await flush();
    expect(session.getState()).toBe("transcribing");

    expect(await session.finish()).toBe(""); // the stray second Enter
    expect(shell.recordingsStopped).toBe(1); // no second stop

    release("open my dashboard");
    expect(await finishing).toBe("open my dashboard"); // the real one still lands
  });

  it("returns nothing, and says so, when the transcript is blank", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("   \n  ") });

    await session.begin();

    expect(await session.finish()).toBe("");
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("skips transcription entirely for a clip too short to be speech", async () => {
    const transcriber = new FakeTranscriber("ghost text");
    const { shell, session } = setup({ transcriber, clips: [clip(80)] });

    await session.begin();

    expect(await session.finish()).toBe("");
    expect(transcriber.calls).toHaveLength(0);
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("returns to idle (never stranded) when transcription fails", async () => {
    const { shell, session } = setup({
      transcriber: new FakeTranscriber("", "whisper exited with code 1"),
    });

    await session.begin();

    expect(await session.finish()).toBe("");
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/whisper exited with code 1/);

    // Proof it isn't stuck: the next bar opening records again.
    await session.begin();
    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(2);
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

  it("finish() on an idle session is a harmless no-op", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    expect(await session.finish()).toBe("");
    expect(shell.recordingsStopped).toBe(0);
  });
});
