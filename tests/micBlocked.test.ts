import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// A microphone that cannot start must be reported, and the app must not act as if it is
// recording (found during M24).
//
// The renderer answers `voice:start` with `voiceStarted(error?)`. The preload used to send that
// error as the reply's FIRST argument; main's awaitRenderer reads (payload, error), so the error
// sat in the payload slot and startRecording() resolved as though the microphone had started.
// VoiceSession and DictationSession both already handle a rejected start (back to idle, "Couldn't
// start recording: …") — the rejection simply never came.
//
// The preload's REAL `api` is used (ipcRenderer and contextBridge mocked), because the bug was
// the order the preload sends in, and a test that transcribed the preload would have copied it.

const { ipcMain, ipcRenderer, exposed, globalShortcut } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const ipcMain = new EventEmitter();
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
  };
  return { ipcMain, ipcRenderer, exposed, globalShortcut };
});

vi.mock("electron", () => ({
  ipcMain,
  ipcRenderer,
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed.api = api) },
  BrowserWindow: class {},
  globalShortcut,
  clipboard: { readText: () => "", writeText: () => undefined },
  dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
  shell: { openExternal: () => Promise.resolve() },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");
const { VoiceSession } = await import("../src/main/shell/VoiceSession.ts");
const { DictationSession } = await import("../src/main/shell/DictationSession.ts");
await import("../src/preload/preload.ts");
const api = exposed.api as import("../src/preload/preload.ts").CommandBarApi;

import { FakeTranscriber } from "./FakeTranscriber.ts";
import { MockInputInjector } from "./MockInputInjector.ts";

// What Chromium's getUserMedia rejects with when the microphone is blocked, as the renderer's
// `describe(error)` would pass it on.
const BLOCKED = "NotAllowedError: Permission denied";

function world(mic: "blocked" | "works") {
  const sent: { channel: string; args: unknown[] }[] = [];
  const window = Object.assign(new EventEmitter(), {
    visible: false,
    webContents: Object.assign(new EventEmitter(), {
      send(channel: string, ...args: unknown[]): void {
        sent.push({ channel, args });
        setTimeout(() => ipcRenderer.emit(channel, {}, ...args), 1);
      },
      getURL: () => "http://localhost:5173/index.html",
      setWindowOpenHandler: () => undefined,
    }),
    show(): void { window.visible = true; window.emit("show"); },
    showInactive(): void { window.visible = true; window.emit("show"); },
    hide(): void { window.visible = false; window.emit("hide"); },
    focus(): void {},
    isVisible: () => window.visible,
    isFocused: () => false,
    isDestroyed: () => false,
  });
  const shell = new WindowsShell(window as unknown as Electron.BrowserWindow);

  // The renderer's recorder, CommandBar.tsx's onVoiceStart: start the mic, then report.
  const offVoiceStart = api.onVoiceStart(() => {
    if (mic === "blocked") api.voiceStarted(BLOCKED);
    else api.voiceStarted();
  });

  const on = (channel: string): unknown[][] =>
    sent.filter((message) => message.channel === channel).map((message) => message.args);
  return { shell, on, offVoiceStart };
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  ipcMain.removeAllListeners();
  ipcRenderer.removeAllListeners();
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}

describe("a blocked microphone (instruction hotkey's voice path)", () => {
  it("is reported, and the session does not stay recording", async () => {
    const w = world("blocked");
    cleanup = w.offVoiceStart;
    const voice = new VoiceSession(w.shell, new FakeTranscriber("unused"));

    const beginning = voice.begin();
    await settle();
    await beginning;

    expect(voice.getState()).toBe("idle");
    expect(w.on("commandbar:echo").map((args) => args[0])).toContain(
      `Couldn't start recording: ${BLOCKED}`,
    );
    // The shell is not left believing a capture is live: the last state the bar was told is idle,
    // and nothing holds the foreground.
    expect(w.on("voice:state").at(-1)?.[0]).toBe("idle");
    expect(w.shell.isForegroundFree()).toBe(true);
  });

  it("control: a microphone that starts leaves the session recording", async () => {
    // So the test above distinguishes something: the same path, with the mic working.
    const w = world("works");
    cleanup = w.offVoiceStart;
    const voice = new VoiceSession(w.shell, new FakeTranscriber("unused"));

    const beginning = voice.begin();
    await settle();
    await beginning;

    expect(voice.getState()).toBe("recording");
    expect(w.on("commandbar:echo")).toEqual([]);
  });
});

describe("a blocked microphone (dictation)", () => {
  it("is reported, and dictation does not stay recording", async () => {
    const w = world("blocked");
    cleanup = w.offVoiceStart;
    const dictation = new DictationSession(w.shell, new FakeTranscriber("unused"), new MockInputInjector());

    const beginning = dictation.begin();
    await settle();
    await beginning;

    expect(dictation.getState()).toBe("idle");
    expect(w.on("commandbar:echo").map((args) => args[0])).toContain(
      `Couldn't start recording: ${BLOCKED}`,
    );
    expect(w.on("voice:state").at(-1)?.[0]).toBe("idle");
    expect(w.shell.isForegroundFree()).toBe(true);
  });
});
