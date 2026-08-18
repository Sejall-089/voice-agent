import { describe, it, expect, vi, afterEach } from "vitest";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { VoiceSession } from "../src/main/shell/VoiceSession.ts";
import type { AudioClip, CapturedContext, Transcriber } from "../src/core/types.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";

// The toggle state machine, tested directly. No audio, no model, no microphone, no
// electron — the point of VoiceSession being a plain injectable class.

const CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// A plausible clip: whatever the length says, with non-empty bytes.
function clip(durationMs: number): AudioClip {
  return { wav: new Uint8Array([1, 2, 3, 4]), durationMs };
}

function setup(options: {
  transcriber: Transcriber;
  clips?: AudioClip[];
  failRecording?: string;
  maxRecordingMs?: number;
}): { shell: MockShell; session: VoiceSession; heard: string[] } {
  const shell = new MockShell({
    context: CONTEXT,
    clips: options.clips ?? [clip(1500)],
    ...(options.failRecording !== undefined ? { failRecording: options.failRecording } : {}),
  });
  const heard: string[] = [];
  const session = new VoiceSession(
    shell,
    options.transcriber,
    async (text) => {
      heard.push(text);
      await Promise.resolve();
    },
    options.maxRecordingMs !== undefined ? { maxRecordingMs: options.maxRecordingMs } : {},
  );
  return { shell, session, heard };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceSession (M7: tap-to-toggle state machine)", () => {
  it("starts idle", () => {
    const { session } = setup({ transcriber: new FakeTranscriber("hi") });
    expect(session.getState()).toBe("idle");
  });

  it("one press starts recording and announces it", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.toggle();

    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(1);
    expect(shell.voiceStates).toContainEqual({ state: "recording" });
  });

  it("a second press stops, transcribes, and delivers the transcript", async () => {
    const transcriber = new FakeTranscriber("summarize this");
    const { shell, session, heard } = setup({ transcriber });

    await session.toggle();
    await session.toggle();

    expect(shell.recordingsStopped).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
    expect(heard).toEqual(["summarize this"]);
    expect(session.getState()).toBe("idle");
    // The transcript rides back on the idle state so the bar can show what was heard.
    expect(shell.voiceStates.at(-1)).toEqual({ state: "idle", detail: "summarize this" });
  });

  it("ignores a press while transcribing — it does not start a second recording", async () => {
    // A transcriber we can hold open, so the session is genuinely mid-transcription.
    let release!: (text: string) => void;
    const transcriber: Transcriber = {
      transcribe: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const { shell, session, heard } = setup({ transcriber });

    await session.toggle(); // start
    const stopping = session.toggle(); // stop → transcribing (stays pending)
    await flush();
    expect(session.getState()).toBe("transcribing");

    await session.toggle(); // the stray press

    expect(session.getState()).toBe("transcribing"); // unchanged
    expect(shell.recordingsStarted).toBe(1); // no second capture
    expect(shell.recordingsStopped).toBe(1);

    release("open my dashboard");
    await stopping;
    expect(heard).toEqual(["open my dashboard"]); // the in-flight transcript still lands, once
    expect(session.getState()).toBe("idle");
  });

  it("auto-stops at the recording cap and still delivers the transcript", async () => {
    vi.useFakeTimers();
    const { shell, session, heard } = setup({
      transcriber: new FakeTranscriber("what do you remember about the team"),
      maxRecordingMs: 90_000,
    });

    await session.toggle();
    expect(session.getState()).toBe("recording");

    await vi.advanceTimersByTimeAsync(90_000);

    // The cap runs the SAME path as a manual press — nothing is thrown away.
    expect(shell.recordingsStopped).toBe(1);
    expect(heard).toEqual(["what do you remember about the team"]);
    expect(session.getState()).toBe("idle");
  });

  it("does not fire the cap after a manual stop", async () => {
    vi.useFakeTimers();
    const { shell, session, heard } = setup({
      transcriber: new FakeTranscriber("summarize this"),
      maxRecordingMs: 90_000,
    });

    await session.toggle();
    await session.toggle(); // manual stop well before the cap
    await vi.advanceTimersByTimeAsync(120_000);

    expect(shell.recordingsStopped).toBe(1); // not 2
    expect(heard).toEqual(["summarize this"]);
  });

  it("does not reach the planner when the transcript is blank", async () => {
    const { shell, session, heard } = setup({ transcriber: new FakeTranscriber("   \n  ") });

    await session.toggle();
    await session.toggle();

    expect(heard).toEqual([]);
    expect(session.getState()).toBe("idle");
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("skips transcription entirely for a clip too short to be speech", async () => {
    const transcriber = new FakeTranscriber("ghost text");
    const { shell, session, heard } = setup({ transcriber, clips: [clip(80)] });

    await session.toggle();
    await session.toggle();

    expect(transcriber.calls).toHaveLength(0);
    expect(heard).toEqual([]);
    expect(shell.results.at(-1)).toMatch(/didn't catch that/i);
  });

  it("returns to idle (never stranded) when transcription fails", async () => {
    const { shell, session, heard } = setup({
      transcriber: new FakeTranscriber("", "whisper exited with code 1"),
    });

    await session.toggle();
    await session.toggle();

    expect(session.getState()).toBe("idle");
    expect(heard).toEqual([]);
    expect(shell.results.at(-1)).toMatch(/whisper exited with code 1/);

    // Proof it isn't stuck: the very next press starts a fresh recording.
    await session.toggle();
    expect(session.getState()).toBe("recording");
    expect(shell.recordingsStarted).toBe(2);
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

  it("cancel discards the recording without transcribing or acting", async () => {
    const transcriber = new FakeTranscriber("this should never run");
    const { shell, session, heard } = setup({ transcriber });

    await session.toggle();
    await session.cancel();

    expect(session.getState()).toBe("idle");
    expect(shell.recordingsCancelled).toBe(1);
    expect(shell.recordingsStopped).toBe(0);
    expect(transcriber.calls).toHaveLength(0);
    expect(heard).toEqual([]);
  });

  it("cancel is a no-op when nothing is recording", async () => {
    const { shell, session } = setup({ transcriber: new FakeTranscriber("hi") });

    await session.cancel();

    expect(session.getState()).toBe("idle");
    expect(shell.recordingsCancelled).toBe(0);
  });
});
