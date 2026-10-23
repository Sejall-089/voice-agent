import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// M24: a spoken clip longer than 15 s, end to end, headless.
//
// THE BUG. WindowsShell.play() waited for the renderer's `speech:ended` under a 15 s bound written
// for a quick reply. At 15 s it gave up: `isSpeaking()` went false while the clip still played
// (so a held chime played over it — M23), and the next utterance's `speech:play` made the player
// stop the clip mid-sentence. A second fault shared the timer: `SpeechPlayer.stop()` never settled
// its play(), so after every barge-in main waited the full 15 s with nothing playing, and a reply
// queued in that time was delayed or dropped as stale.
//
// WHAT IS REAL HERE: WindowsShell (electron mocked, as in WindowsShell.capture.test.ts),
// SpeechSession, SpeechPlayer, and the PRELOAD's own `api` object — ipcRenderer and contextBridge
// are mocked, so the argument order the renderer sends is the real one (a fixture that transcribed
// the preload could not catch it being wrong, which is exactly how M14 shipped it wrong).
//
// WHAT IS STOOD IN, and why each is no more lenient than the real thing:
//   - The speaker. FakeAudio plays to the (fake) clock. Like Chromium's <audio>, its play() resolves
//     only when playback has begun, and a pause() before that rejects it with an AbortError.
//   - CommandBar.tsx's speech wiring, transcribed (six lines; the component needs a DOM).
//   - The synthesizer: a WAV whose length is the text at Piper's measured rate, after a warm
//     Piper's measured latency. Both async, because the real ones are (CLAUDE.md).
//   - Every IPC hop is a timer, never synchronous: main->renderer and renderer->main both.

const { ipcMain, ipcRenderer, exposed, globalShortcut, dialogShowMessageBox } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const ipcMain = new EventEmitter();
  // The renderer's end of the pipe. Main's webContents.send() emits on it; its send() reaches
  // ipcMain. Each hop goes through a timer — see `hop` in world().
  const ipcRenderer = Object.assign(new EventEmitter(), {
    send(channel: string, ...args: unknown[]): void {
      setTimeout(() => ipcMain.emit(channel, {}, ...args), 1);
    },
  });
  const exposed: { api: unknown } = { api: null };
  const handlers = new Map<string, () => void>();
  const globalShortcut = {
    register: (combo: string, handler: () => void): boolean => {
      handlers.set(combo, handler);
      return true;
    },
    unregister: (combo: string): void => void handlers.delete(combo),
    unregisterAll: (): void => handlers.clear(),
    _handlers: handlers,
  };
  const dialogShowMessageBox = vi.fn(() => Promise.resolve({ response: 1 }));
  return { ipcMain, ipcRenderer, exposed, globalShortcut, dialogShowMessageBox };
});

vi.mock("electron", () => ({
  ipcMain,
  ipcRenderer,
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed.api = api) },
  BrowserWindow: class {},
  globalShortcut,
  clipboard: { readText: () => "", writeText: () => undefined },
  dialog: { showMessageBox: dialogShowMessageBox },
  shell: { openExternal: () => Promise.resolve() },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");
const { SpeechSession } = await import("../src/main/shell/SpeechSession.ts");
const { DictationSession } = await import("../src/main/shell/DictationSession.ts");
const { createOnInstructionHotkey } = await import("../src/main/instructionHotkey.ts");
const { createOnDictateHotkey } = await import("../src/main/dictate.ts");
// The renderer's player uses DOM types, and tests/ is type-checked under the node config, which
// has no DOM lib — adding one would let DOM globals type-check in main-process code. So it is
// loaded through a path TypeScript does not follow, and typed by the shape this file uses.
interface SpeechPlayerLike {
  play(wav: Uint8Array, onError: (message: string) => void): Promise<void>;
  stop(): void;
}
const PLAYER_MODULE: string = "../src/renderer/audio/player.ts";
const { SpeechPlayer } = (await import(/* @vite-ignore */ PLAYER_MODULE)) as {
  SpeechPlayer: new () => SpeechPlayerLike;
};
const { PLAYBACK_GRACE_MS } = await import("../src/main/shell/playbackLimit.ts");
const { Chime } = await import("../src/core/jobs/chime.ts");
await import("../src/preload/preload.ts");
const api = exposed.api as import("../src/preload/preload.ts").CommandBarApi;

import { FakeTranscriber } from "./FakeTranscriber.ts";
import { MockInputInjector } from "./MockInputInjector.ts";
import { ScriptedLLM, tool } from "./jobWorld.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { captureContext, Planner } from "../src/core/planner.ts";
import { toSpokenResult } from "../src/core/speech.ts";
import { InMemorySpeechStore } from "../src/core/speechStore.ts";
import { elaborateTool } from "../src/core/tools/elaborate.ts";
import type { Memory, Tool } from "../src/core/types.ts";
import { createJobRunner } from "../src/main/jobs/JobRunner.ts";

// Warm Piper, measured at 108-160 ms (PiperSynthesizer.ts header).
const SYNTH_MS = 150;
// Piper's speaking rate, measured at 14.4-15.5 characters a second (M24 repro).
const CHARS_PER_SECOND = 15;
// From `play()` to sound: blob load, decode, output device start. NOT measured — chosen small. The
// tests that care about it are the ones that would pass with no grace at all if it were zero; the
// IPC hops alone (1 ms each way) already put the report after the clip's own length.
const AUDIO_START_MS = 100;
const BYTE_RATE = 22_050 * 2;

interface Clip {
  text: string;
  mainId: number | null;
  durationMs: number;
  startedAt: number | null;
  stoppedAt: number | null;
  outcome: "loading" | "playing" | "ended" | "cut";
}

interface WorldOptions {
  // Seconds of audio per text, overriding CHARS_PER_SECOND.
  seconds?: Record<string, number>;
  // Milliseconds to synthesize a text, overriding SYNTH_MS — a cold or backed-up engine.
  synthMs?: Record<string, number>;
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ipcMain.removeAllListeners();
  ipcRenderer.removeAllListeners();
  globalShortcut._handlers.clear();
  dialogShowMessageBox.mockReset();
  dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }));
});

function world(options: WorldOptions = {}) {
  vi.useFakeTimers();
  const t0 = Date.now();
  const now = (): number => Date.now() - t0;

  const errors: { t: number; message: string }[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push({ t: now(), message: args.map(String).join(" ") });
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  // --- the speaker ---
  const clips: Clip[] = [];
  const bySeq = new Map<number, Clip>();
  const audible = new Set<FakeAudioLike>();
  let incomingMainId: number | null = null;
  let rejectNextPlay: string | null = null;
  const blobs = new Map<string, Uint8Array>();
  let blobSeq = 0;

  interface FakeAudioLike {
    kill(): void;
  }

  class FakeBlob {
    constructor(readonly parts: ArrayBuffer[]) {}
  }

  class FakeAudio implements FakeAudioLike {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly clip: Clip;
    private startTimer: ReturnType<typeof setTimeout> | undefined;
    private endTimer: ReturnType<typeof setTimeout> | undefined;
    private rejectStart: ((error: Error) => void) | null = null;

    constructor(url: string) {
      const bytes = blobs.get(url);
      if (bytes === undefined) throw new Error(`no blob behind ${url}`);
      const seq = new DataView(bytes.buffer, bytes.byteOffset).getUint32(44, true);
      const clip = bySeq.get(seq);
      if (clip === undefined) throw new Error(`no clip numbered ${seq}`);
      clip.mainId = incomingMainId;
      this.clip = clip;
    }

    play(): Promise<void> {
      if (rejectNextPlay !== null) {
        const message = rejectNextPlay;
        rejectNextPlay = null;
        return Promise.reject(new Error(message));
      }
      return new Promise<void>((resolve, reject) => {
        this.rejectStart = reject;
        this.startTimer = setTimeout(() => {
          this.rejectStart = null;
          this.clip.startedAt = now();
          this.clip.outcome = "playing";
          audible.add(this);
          resolve();
          this.endTimer = setTimeout(() => {
            audible.delete(this);
            this.clip.stoppedAt = now();
            this.clip.outcome = "ended";
            this.onended?.();
          }, this.clip.durationMs);
        }, AUDIO_START_MS);
      });
    }

    pause(): void {
      if (this.rejectStart !== null) {
        // What Chromium does to a play() that a pause() overtakes.
        clearTimeout(this.startTimer);
        const reject = this.rejectStart;
        this.rejectStart = null;
        this.clip.outcome = "cut";
        this.clip.stoppedAt = now();
        reject(Object.assign(new Error("The play() request was interrupted by a call to pause()."), { name: "AbortError" }));
        return;
      }
      if (this.clip.outcome === "playing") {
        clearTimeout(this.endTimer);
        audible.delete(this);
        this.clip.outcome = "cut";
        this.clip.stoppedAt = now();
      }
    }

    // A renderer crash takes the sound with it, without any event.
    kill(): void {
      clearTimeout(this.startTimer);
      clearTimeout(this.endTimer);
      audible.delete(this);
      if (this.clip.outcome === "playing") {
        this.clip.outcome = "cut";
        this.clip.stoppedAt = now();
      }
    }
  }

  vi.stubGlobal("Blob", FakeBlob);
  vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: unknown) => {
    const url = `blob:fake/${(blobSeq += 1)}`;
    blobs.set(url, new Uint8Array((blob as FakeBlob).parts[0] as ArrayBuffer));
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void blobs.delete(url));

  // --- the synthesizer ---
  let seq = 0;
  const synthesized: string[] = [];
  const synth = {
    synthesize(text: string): Promise<Uint8Array> {
      synthesized.push(text);
      const seconds = options.seconds?.[text] ?? text.length / CHARS_PER_SECOND;
      const durationMs = Math.round(seconds * 1000);
      const clip: Clip = { text, mainId: null, durationMs, startedAt: null, stoppedAt: null, outcome: "loading" };
      seq += 1;
      bySeq.set(seq, clip);
      clips.push(clip);
      // A real 22.05 kHz 16-bit mono WAV of exactly that length, with the clip's number in its
      // first samples so the speaker can say which clip it is playing.
      const dataBytes = Math.max(4, Math.round((durationMs / 1000) * BYTE_RATE) & ~1);
      const bytes = new Uint8Array(44 + dataBytes);
      const view = new DataView(bytes.buffer);
      const ascii = (at: number, s: string): void => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
      ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
      ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 22_050, true); view.setUint32(28, BYTE_RATE, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, "data"); view.setUint32(40, dataBytes, true);
      view.setUint32(44, seq, true);
      return new Promise((resolve) => setTimeout(() => resolve(bytes), options.synthMs?.[text] ?? SYNTH_MS));
    },
  };

  // --- the renderer: CommandBar.tsx:132-142, through the real preload api ---
  const renderer = {
    dead: false,
    // Clip ids (main's) whose play this renderer never acts on, as if it had hung.
    ignorePlay: new Set<number>(),
    // Clip ids whose `ended` report is held back this long after the clip is over.
    reportDelayMs: new Map<number, number>(),
    reports: [] as { t: number; id: number; error: string | undefined }[],
    crash(): void {
      renderer.dead = true;
      for (const audio of [...audible]) audio.kill();
    },
  };
  const player = new SpeechPlayer();
  const offSpeak = api.onSpeak((wav, id) => {
    if (renderer.dead || renderer.ignorePlay.has(id)) return;
    incomingMainId = id;
    let failure: string | undefined;
    void player
      .play(wav, (message) => (failure = message))
      .then(() => {
        if (renderer.dead) return;
        const report = (): void => {
          renderer.reports.push({ t: now(), id, error: failure });
          api.speechEnded(id, failure);
        };
        const delay = renderer.reportDelayMs.get(id);
        if (delay === undefined) report();
        else setTimeout(report, delay);
      });
  });
  const offStop = api.onStopSpeaking(() => {
    if (!renderer.dead) player.stop();
  });
  // The recorder, for the paths that open the microphone: it starts at once.
  const offVoice = api.onVoiceStart(() => {
    if (!renderer.dead) api.voiceStarted();
  });

  // --- main ---
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), {
    send(channel: string, ...args: unknown[]): void {
      setTimeout(() => ipcRenderer.emit(channel, {}, ...args), 1);
    },
    getURL: () => "http://localhost:5173/index.html",
    setWindowOpenHandler: () => undefined,
  });
  const win = Object.assign(new EventEmitter(), {
    visible: false,
    focused: false,
    webContents,
    show(): void { win.visible = true; win.focused = true; win.emit("show"); },
    showInactive(): void { win.visible = true; win.emit("show"); },
    hide(): void { win.visible = false; win.focused = false; win.emit("hide"); },
    focus(): void { win.focused = true; },
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isDestroyed: () => destroyed,
    destroy(): void { destroyed = true; win.emit("closed"); },
  });

  const shell = new WindowsShell(win as unknown as Electron.BrowserWindow);
  const session = new SpeechSession(shell, synth);
  shell.attachSpeech(session);

  // isSpeaking() against what the speaker is doing, every 10 ms.
  const samples: { t: number; speaking: boolean; audible: boolean }[] = [];
  const sampler = setInterval(() => {
    samples.push({ t: now(), speaking: shell.isSpeaking(), audible: audible.size > 0 });
  }, 10);

  teardown = () => {
    clearInterval(sampler);
    player.stop();
    offSpeak();
    offStop();
    offVoice();
  };

  const advance = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);
  // Advance to an absolute time since the world began.
  const until = (t: number): Promise<void> => advance(Math.max(0, t - now()));
  const clip = (text: string): Clip => {
    const found = clips.find((c) => c.text === text);
    if (found === undefined) throw new Error(`"${text}" was never synthesized`);
    return found;
  };
  // What was heard, in the order it started, and how each one ended.
  const heard = (): string[] =>
    clips
      .filter((c) => c.startedAt !== null)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((c) => `${c.text}:${c.outcome}`);
  // Every 10 ms sample at which sound was coming out while main said it was not speaking.
  const uncovered = (): number[] => samples.filter((s) => s.audible && !s.speaking).map((s) => s.t);
  const speakingAt = (t: number): boolean | undefined => samples.find((s) => s.t === t)?.speaking;
  const timeouts = (): string[] =>
    errors.map((e) => e.message).filter((m) => m.includes("did not finish or report back"));

  // The speaker refuses the next clip, as Chromium's autoplay policy would.
  const failNextPlay = (message: string): void => {
    rejectNextPlay = message;
  };

  return { shell, session, win, renderer, clips, clip, heard, synthesized, errors, samples, now, advance, until, uncovered, speakingAt, timeouts, failNextPlay };
}

const LONG = "LONG";
const NEXT = "NEXT";

describe("M24 — a clip longer than 15 s plays to its end", () => {
  it("S1: a 30 s clip is heard in full, and isSpeaking() is true for all of it", async () => {
    const w = world({ seconds: { [LONG]: 30 } });
    w.session.speak(LONG);
    await w.until(32_000);

    const long = w.clip(LONG);
    expect(long.outcome).toBe("ended");
    expect((long.stoppedAt ?? 0) - (long.startedAt ?? 0)).toBe(30_000);
    // The old bound: still speaking well past 15 s, and right up to the end.
    expect(w.speakingAt(15_200)).toBe(true);
    expect(w.speakingAt(30_200)).toBe(true);
    expect(w.uncovered()).toEqual([]);
    // ...and over promptly once it is.
    expect(w.speakingAt(30_270)).toBe(false);
    expect(w.timeouts()).toEqual([]);
  });

  it("S1: a chime held for speech plays after the clip, never over it", async () => {
    const w = world({ seconds: { [LONG]: 30 } });
    const chimes: number[] = [];
    const chime = new Chime({
      play: () => chimes.push(w.now()),
      isMuted: () => false,
      isBusy: () => w.shell.isSpeaking(), // what main.ts:654 hands the PillController
      isWaiting: () => true,
      now: w.now,
    });
    // The pill's own tick (main.ts: every 1 s).
    const tick = setInterval(() => chime.flush(), 1_000);

    w.session.speak(LONG);
    await w.until(10_000);
    expect(chime.onJobState("job1", "needs-you", "running")).toBe("defer");
    await w.until(33_000);
    clearInterval(tick);

    const long = w.clip(LONG);
    expect(long.outcome).toBe("ended");
    expect(chimes).toHaveLength(1);
    expect(chimes[0]).toBeGreaterThanOrEqual(long.stoppedAt ?? Infinity);
    expect(chimes[0]).toBeLessThanOrEqual((long.stoppedAt ?? 0) + 1_000);
  });

  it("S2: a next utterance queued during a long clip waits for it, and is then said", async () => {
    const w = world({ seconds: { [LONG]: 30, [NEXT]: 2 } });
    w.session.speak(LONG);
    await w.until(25_000); // within SpeechSession's 8 s staleness window of the clip's end
    w.session.speak(NEXT);
    await w.until(34_000);

    const long = w.clip(LONG);
    const next = w.clip(NEXT);
    expect(long.outcome).toBe("ended");
    expect(next.outcome).toBe("ended");
    expect(next.startedAt).toBeGreaterThan(long.stoppedAt ?? Infinity);
    expect(w.uncovered()).toEqual([]);
  });

  // S2/S3/S4 wait LONGER than SpeechSession's 8 s staleness window behind a clip that is still
  // playing. Before M24's stale-rule change they were dropped as stale (pinned that way for one
  // review); time behind a playing clip no longer ages an utterance, so they are said, after it.
  it("S2: queued at 10 s behind a 30 s clip (20 s of waiting) — said after it, nothing cut", async () => {
    const w = world({ seconds: { [LONG]: 30, [NEXT]: 2 } });
    w.session.speak(LONG);
    await w.until(10_000);
    w.session.speak(NEXT);
    await w.until(34_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, `${NEXT}:ended`]);
    expect(w.uncovered()).toEqual([]);
  });

  it("S3: queued at 2 s behind a 30 s clip (28 s of waiting) — said after it, nothing cut", async () => {
    // In the M24 repro this one was DROPPED (13 s old when a 15 s-capped queue reached it). Now
    // the clip plays out and EARLY is said after it.
    const w = world({ seconds: { [LONG]: 30, EARLY: 2 } });
    w.session.speak(LONG);
    await w.until(2_000);
    w.session.speak("EARLY");
    await w.until(34_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, "EARLY:ended"]);
  });

  it("S4: queued at 20 s, after the old 15 s mark — the clip is not cut, and NEXT is said after it", async () => {
    const w = world({ seconds: { [LONG]: 30, [NEXT]: 2 } });
    w.session.speak(LONG);
    await w.until(20_000);
    w.session.speak(NEXT);
    await w.until(21_000);
    // The pre-M24 cut happened here: NEXT's play() stopped LONG within 150 ms.
    expect(w.clip(LONG).outcome).toBe("playing");
    await w.until(34_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, `${NEXT}:ended`]);
    expect(w.uncovered()).toEqual([]);
  });

  it("S2+S4: several queued behind one long clip are all said, in the order they were queued", async () => {
    const w = world({ seconds: { [LONG]: 30, ONE: 1, TWO: 1, THREE: 1 } });
    w.session.speak(LONG);
    await w.until(2_000);
    w.session.speak("ONE");
    await w.until(10_000);
    w.session.speak("TWO");
    await w.until(20_000);
    w.session.speak("THREE");
    await w.until(36_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, "ONE:ended", "TWO:ended", "THREE:ended"]);
    expect(w.uncovered()).toEqual([]);
  });

  it("control: short clips back to back are unchanged", async () => {
    const w = world({ seconds: { A: 3, B: 2 } });
    w.session.speak("A");
    w.session.speak("B");
    await w.until(8_000);

    expect(w.clip("A").outcome).toBe("ended");
    expect(w.clip("B").outcome).toBe("ended");
    expect(w.clip("B").startedAt).toBeGreaterThan(w.clip("A").stoppedAt ?? Infinity);
  });
});

describe("M24 — the staleness rule counts waiting, not listening", () => {
  it("a synthesis backlog still drops what waited more than 8 s with nothing playing", async () => {
    // A cold or backed-up engine: 10 s to synthesize A. Nothing plays during that time, so B's
    // wait is real waiting — the case the rule was written for (M14 live: a dialog cancelled
    // 5 s before the app spoke about it).
    const w = world({ seconds: { A: 1, B: 1, C: 1 }, synthMs: { A: 10_000 } });
    w.session.speak("A");
    await w.until(500);
    w.session.speak("B"); // will have waited ~9.5 s of not-playing when its turn comes
    await w.until(9_500);
    w.session.speak("C"); // ~1.5 s of not-playing: fresh
    await w.until(15_000);

    expect(w.heard()).toEqual(["A:ended", "C:ended"]);
    expect(w.synthesized).not.toContain("B");
  });

  it("time with nothing playing AFTER a long clip still counts", async () => {
    // Y waits behind LONG (not counted), then behind X's 9 s synthesis (counted) — and X's own
    // second of playing (not counted). ~9 s of real waiting: dropped.
    const w = world({ seconds: { [LONG]: 30, X: 1, Y: 1 }, synthMs: { X: 9_000 } });
    w.session.speak(LONG);
    await w.until(10_000);
    w.session.speak("X");
    await w.until(11_000);
    w.session.speak("Y");
    await w.until(45_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, "X:ended"]);
    expect(w.synthesized).not.toContain("Y");
  });

  it("back-to-back long clips, each followed by a short 'Sent.', are all said in order", async () => {
    const w = world({ seconds: { L1: 20, L2: 20, "Sent.": 0.8 } });
    w.session.speak("L1");
    await w.until(1_000);
    w.session.speak("Sent.");
    await w.until(2_000);
    w.session.speak("L2");
    await w.until(3_000);
    w.session.speak("Sent.");
    await w.until(46_000);

    expect(w.heard()).toEqual(["L1:ended", "Sent.:ended", "L2:ended", "Sent.:ended"]);
    expect(w.uncovered()).toEqual([]);
  });

  it("the 8-item cap still drops the OLDEST of what is waiting", async () => {
    const queued = Array.from({ length: 10 }, (_, i) => `Q${i}`);
    const w = world({ seconds: { [LONG]: 30, ...Object.fromEntries(queued.map((q) => [q, 1])) } });
    w.session.speak(LONG);
    await w.until(5_000);
    for (const q of queued) w.session.speak(q);
    await w.until(45_000);

    expect(w.heard()).toEqual([`${LONG}:ended`, ...queued.slice(2).map((q) => `${q}:ended`)]);
  });
});

describe("M24 — a barge-in ends main's wait at once, and what follows is said", () => {
  it("S5: stop() mid-clip, then a result 0.5 s later — the result is synthesized and heard", async () => {
    const w = world({ seconds: { CONFIRM: 10, "Sent.": 0.8 } });
    w.session.speak("CONFIRM");
    await w.until(2_000);
    w.session.stop();
    await w.until(2_010);
    // Over within a few IPC hops — not at 15 s, and not at the clip's own length.
    expect(w.shell.isSpeaking()).toBe(false);
    await w.until(2_500);
    w.session.speak("Sent.");
    await w.until(4_000);

    expect(w.clip("CONFIRM").outcome).toBe("cut");
    expect(w.clip("Sent.").outcome).toBe("ended");
    expect(w.timeouts()).toEqual([]);
  });

  it("S5: a confirm answered while its question is still being spoken — the result is heard", async () => {
    const w = world({ seconds: { "Send this reply to alex?": 6, "Sent.": 0.8 } });
    let answer: (value: { response: number }) => void = () => undefined;
    dialogShowMessageBox.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    w.win.show();

    w.session.speak("Send this reply to alex?");
    const asking = w.shell.confirm("Send this reply to alex@example.com?");
    await w.until(2_000);
    answer({ response: 0 }); // Send, while the question is still playing
    expect(await asking).toBe(true);
    // What the planner does next: the handler runs, and its result is spoken.
    w.session.speak("Sent.");
    await w.until(4_000);

    expect(w.clip("Send this reply to alex?").outcome).toBe("cut");
    expect(w.clip("Sent.").outcome).toBe("ended");
  });

  it("a stop() during the device's start-up is an ordinary end, not a logged failure", async () => {
    // Chromium rejects a play() that a pause() overtakes. That rejection is the stop, already
    // reported; logging it as a playback failure would print one on every quick barge-in.
    const w = world({ seconds: { [LONG]: 30 } });
    w.session.speak(LONG);
    await w.until(SYNTH_MS + 1 + 50); // the clip has reached the renderer; the device is starting
    w.session.stop();
    await w.until(1_000);

    expect(w.clip(LONG).startedAt).toBeNull();
    expect(w.renderer.reports).toHaveLength(1);
    expect(w.renderer.reports[0]?.error).toBeUndefined();
    expect(w.errors).toEqual([]);
    expect(w.shell.isSpeaking()).toBe(false);
  });

  // Each user gesture that silences the app, through the code it really runs.
  const gestures: [string, (w: ReturnType<typeof world>) => void][] = [
    ["Escape", () => globalShortcut._handlers.get("Escape")?.()],
    ["the microphone opening", (w) => void w.shell.startRecording()],
    [
      "the dictation hotkey",
      // main.ts:592 ALSO calls speech.stop() inline before this — that line has no test that
      // could fail (it lives in main.ts). This is the path's own guarantee: dictation opens the
      // microphone, and the microphone opening stops speech.
      (w) =>
        createOnDictateHotkey(
          new DictationSession(w.shell, new FakeTranscriber("unused"), new MockInputInjector()),
          null,
        )(),
    ],
    [
      "the instruction hotkey",
      (w) =>
        createOnInstructionHotkey({
          shell: w.shell,
          dictation: null,
          voice: null,
          speech: w.session,
          chain: null,
          runInstruction: () => Promise.resolve(),
        })(),
    ],
  ];

  for (const [name, press] of gestures) {
    it(`${name} stops a long clip mid-sentence and unblocks the queue`, async () => {
      const w = world({ seconds: { [LONG]: 30, AFTER: 1 } });
      w.win.show(); // Escape is only the app's while the bar is up
      w.session.speak(LONG);
      await w.until(3_000);
      expect(w.clip(LONG).outcome).toBe("playing");

      press(w);
      await w.until(3_050);
      expect(w.clip(LONG).outcome).toBe("cut");
      expect(w.shell.isSpeaking()).toBe(false);

      w.session.speak("AFTER");
      await w.until(5_000);
      expect(w.clip("AFTER").outcome).toBe("ended");
      expect(w.timeouts()).toEqual([]);
    });
  }
});

describe("M24 — when the renderer cannot answer", () => {
  it("a renderer that never reports back is let go at the clip's length plus the grace — not before, not never", async () => {
    // 20 s, not 10: 10 s + the 5 s grace is exactly the old 15 s bound, and a test at that length
    // passed with the bound put back (found by the M24 mutation pass).
    const w = world({ seconds: { [LONG]: 20, [NEXT]: 1 } });
    w.renderer.ignorePlay.add(1); // main's first clip
    w.session.speak(LONG);
    const sentAt = SYNTH_MS; // play() is called the moment synthesis resolves
    const releaseAt = sentAt + 20_000 + PLAYBACK_GRACE_MS;

    await w.until(23_000);
    w.session.speak(NEXT); // fresh enough to survive the wait
    await w.until(releaseAt - 1);
    expect(w.shell.isSpeaking()).toBe(true);
    expect(w.synthesized).toEqual([LONG]);
    await w.until(releaseAt);
    expect(w.timeouts()).toEqual([
      "[WindowsShell] playback did not finish or report back within 25.0 s for a 20.0 s clip (header); moving on.",
    ]);
    // The queue continues.
    await w.until(releaseAt + 2_000);
    expect(w.clip(NEXT).outcome).toBe("ended");
  });

  it("a late report for a clip main gave up on does not end the next clip's wait", async () => {
    const w = world({ seconds: { A: 4, B: 10 } });
    // A plays in full, but its report is held back past A's limit (4 s + grace).
    w.renderer.reportDelayMs.set(1, PLAYBACK_GRACE_MS + 2_000);
    w.session.speak("A");
    await w.until(8_000);
    w.session.speak("B");
    await w.until(30_000);

    const b = w.clip("B");
    const lateReport = w.renderer.reports.find((r) => r.id === 1);
    // The precondition: A's report really did arrive while B was playing.
    expect(lateReport?.t).toBeGreaterThan(b.startedAt ?? Infinity);
    expect(lateReport?.t).toBeLessThan(b.stoppedAt ?? 0);
    expect(b.outcome).toBe("ended");
    expect(w.uncovered()).toEqual([]);
  });

  it("a renderer that crashes mid-clip ends the wait promptly", async () => {
    const w = world({ seconds: { [LONG]: 30, AFTER: 1 } });
    w.session.speak(LONG);
    await w.until(5_000);
    w.renderer.crash();
    w.win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await w.until(5_010);

    expect(w.shell.isSpeaking()).toBe(false);
    expect(w.errors.map((e) => e.message)).toEqual([
      "[WindowsShell] the renderer went away mid-clip (crashed)",
    ]);
  });

  it("a window closed mid-clip ends the wait promptly, and a later play() on it resolves at once", async () => {
    const w = world({ seconds: { [LONG]: 30, AFTER: 1 } });
    w.session.speak(LONG);
    await w.until(5_000);
    w.renderer.crash();
    w.win.destroy();
    await w.until(5_010);
    expect(w.shell.isSpeaking()).toBe(false);

    w.session.speak("AFTER");
    await w.until(5_200);
    expect(w.synthesized).toEqual([LONG, "AFTER"]);
    expect(w.shell.isSpeaking()).toBe(false);
  });

  it("a clip the renderer could not play is logged with the renderer's own reason", async () => {
    const w = world({ seconds: { A: 3 } });
    const err = "NotAllowedError: play() failed because the user didn't interact with the document first.";
    // The speaker refuses, so the message travels the real path: player -> onError -> preload ->
    // main. Before M24 it arrived where main never looked.
    w.failNextPlay(err);
    w.session.speak("A");
    await w.until(1_000);

    expect(w.errors.map((e) => e.message)).toEqual([`[WindowsShell] playback failed: ${err}`]);
    expect(w.shell.isSpeaking()).toBe(false);
  });
});

describe("M24 — SpeechPlayer on its own", () => {
  it("stop() settles the clip's play() exactly once, and so does the next play()", async () => {
    vi.useFakeTimers();
    const made: { paused: number; onended: (() => void) | null }[] = [];
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal(
      "Audio",
      class {
        paused = 0;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          made.push(this);
        }
        play(): Promise<void> {
          return Promise.resolve();
        }
        pause(): void {
          this.paused += 1;
        }
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const player = new SpeechPlayer();
    let first = 0;
    let second = 0;
    void player.play(new Uint8Array(4), () => undefined).then(() => (first += 1));
    await Promise.resolve();
    expect(first).toBe(0);

    void player.play(new Uint8Array(4), () => undefined).then(() => (second += 1)); // stops the first
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toBe(1);
    expect(made[0]?.paused).toBe(1);

    player.stop();
    player.stop(); // safe twice
    made[1]?.onended?.(); // a stray event after the stop changes nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(1);
  });
});

describe("M24 — simulation: a job's long answer, then 'read the rest'", () => {
  it("both are heard end to end through the real job runner, planner and shell", async () => {
    // A result whose spoken head is longer than 15 s, and a remainder longer than 30 s.
    const LONG_RESULT =
      "Alex wrote about the Q3 launch, and the design review has moved from Tuesday to Thursday afternoon because two of the reviewers are travelling that week. " +
      "Priya wants the final onboarding mockups by Wednesday evening. " +
      "The copy for the pricing page still needs legal sign off, and marketing asked whether the launch blog post can go out a day early, which would mean freezing the feature list by Monday. " +
      "The mobile team flagged a crash on Android 14 when the app resumes from the background, and they think it is related to the new session cache. " +
      "Sam is out next week, so questions about the analytics dashboard should go to Jordan instead. " +
      "Finally, the team offsite is confirmed for the 14th, and everyone should book travel by Friday.";
    const spoken = toSpokenResult(LONG_RESULT);
    const head = spoken.text;
    const rest = spoken.remainder ?? "";
    // Preconditions: the two clips really are past the old bound, at Piper's measured rate.
    expect(head.length / CHARS_PER_SECOND).toBeGreaterThan(15);
    expect(rest.length / CHARS_PER_SECOND).toBeGreaterThan(30);

    const w = world();
    const readInbox: Tool = {
      name: "readInbox",
      description: "Summarize the inbox.",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      planPhrase: "run a test step",
      handler: () => Promise.resolve(LONG_RESULT),
    };
    const llm = new ScriptedLLM({
      "what's in my inbox": tool("readInbox"),
      "read the rest": tool("elaborate"),
    });
    const speechStore = new InMemorySpeechStore();
    let jobSeq = 0;
    const manager = new JobManager({
      store: new InMemoryJobStore(),
      now: () => Date.now(),
      newId: () => `job${(jobSeq += 1)}`,
      foregroundFree: () => w.shell.isForegroundFree(),
    });
    const gmail = { hasOpenEmail: () => Promise.resolve(false) };
    const run = createJobRunner({
      manager,
      shell: w.shell,
      log: new InMemoryActionLog(),
      speech: speechStore,
      capture: () => captureContext(w.shell, gmail),
      buildPlanner: (parts) =>
        new Planner(
          llm,
          parts.shell,
          [readInbox, elaborateTool],
          new NoopMemoryResolver() as Memory,
          parts.log,
          undefined, undefined, undefined, undefined, undefined,
          parts.speech,
          undefined, undefined, undefined,
          () => Promise.resolve(),
          parts.chain,
          undefined,
          parts.gate,
          manager,
        ),
    });

    void run("what's in my inbox");
    await w.until(25_000);
    const first = w.clip(head);
    expect(first.outcome).toBe("ended");
    expect((first.stoppedAt ?? 0) - (first.startedAt ?? 0)).toBe(first.durationMs);
    // The bar auto-hid (12 s after an unfocused result) while the head was still playing, and
    // that did not cut it.
    expect(w.win.isVisible()).toBe(false);

    void run("read the rest");
    await w.until(80_000);
    const second = w.clip(rest);
    expect(second.outcome).toBe("ended");
    expect(second.durationMs).toBeGreaterThan(30_000);
    expect((second.stoppedAt ?? 0) - (second.startedAt ?? 0)).toBe(second.durationMs);

    expect(w.synthesized).toEqual([head, rest]);
    expect(w.uncovered()).toEqual([]);
    expect(w.timeouts()).toEqual([]);
  });
});
