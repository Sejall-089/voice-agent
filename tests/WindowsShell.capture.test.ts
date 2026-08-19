import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The regression test for the M8 duplicate-run bug.
//
// showInput() used to register a fresh commandbar:submit listener per call and remove it
// only on a submit or an Escape, so hiding the bar any OTHER way stranded one. Every
// stranded listener fired on the next submit: measured at six concurrent planner runs —
// twelve LLM calls, six action_log rows, six executions of the chosen tool — from a single
// keystroke.
//
// Behavioural tests did not catch it and would not catch it coming back. This one asserts
// the INVARIANT directly: no matter how many times the bar is opened and hidden, or by
// which route, the listener count stays flat and no capture is left pending.
//
// WindowsShell imports electron, so electron is mocked. That is the point — a test that
// avoids electron also avoids the code where this bug lives.

// vi.mock factories are hoisted and run during WindowsShell's own import, before this
// file's body executes, so the doubles have to be built inside vi.hoisted().
const { ipcMain, makeWindow } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  // A real EventEmitter, so listenerCount() means exactly what it means in production.
  const emitter = new EventEmitter();

  // Minimal stand-in for BrowserWindow: emits "hide" when hidden, like the real one.
  const makeWindow = () => {
    const win = Object.assign(new EventEmitter(), {
      visible: false,
      focused: false,
      sent: [] as { channel: string; args: unknown[] }[],
      show(): void {
        win.visible = true;
        win.focused = true;
      },
      showInactive(): void {
        win.visible = true;
      },
      focus(): void {
        win.focused = true;
      },
      hide(): void {
        win.visible = false;
        win.focused = false;
        win.emit("hide"); // the real BrowserWindow does this too
      },
      isVisible: () => win.visible,
      isFocused: () => win.focused,
      webContents: {
        send(channel: string, ...args: unknown[]): void {
          win.sent.push({ channel, args });
        },
      },
    });
    return win;
  };

  return { ipcMain: emitter, makeWindow };
});

vi.mock("electron", () => ({
  ipcMain,
  BrowserWindow: class {},
  globalShortcut: { register: () => true, unregisterAll: () => undefined },
  clipboard: { readText: () => "", writeText: () => undefined },
  dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
  shell: { openExternal: () => Promise.resolve() },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");

type FakeWindow = ReturnType<typeof makeWindow>;

// The five ways the bar can go away. Cycling all of them is the point: the bug was that
// only two of them cleaned up.
const HIDE_PATHS = ["submit", "escape", "blur", "direct-window-hide", "auto-hide"] as const;
type HidePath = (typeof HIDE_PATHS)[number];

let window: FakeWindow;
let shell: InstanceType<typeof WindowsShell>;

beforeEach(() => {
  ipcMain.removeAllListeners();
  window = makeWindow();
  shell = new WindowsShell(window as unknown as Electron.BrowserWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

function hideVia(path: HidePath, text = "typed text"): void {
  switch (path) {
    case "submit":
      ipcMain.emit("commandbar:submit", {}, text);
      break;
    case "escape":
      ipcMain.emit("commandbar:close", {});
      break;
    case "blur":
      shell.handleBlur();
      break;
    case "direct-window-hide":
      // The path that regresses: something hides the window without going through hide().
      window.hide();
      break;
    case "auto-hide":
      // The auto-hide exists only for a bar that does NOT have focus (the voice path shows
      // it with showInactive), so simulate attention being elsewhere before the result
      // lands — otherwise showResult correctly declines to schedule anything.
      window.focused = false;
      shell.showResult("a result");
      vi.advanceTimersByTime(13_000);
      break;
  }
}

describe("WindowsShell.showInput cleanup (M8 regression guard)", () => {
  it("keeps the IPC listener count FLAT across 20 open/hide cycles on every hide path", async () => {
    vi.useFakeTimers();
    const submitListenersAtRest = ipcMain.listenerCount("commandbar:submit");
    const closeListenersAtRest = ipcMain.listenerCount("commandbar:close");
    expect(submitListenersAtRest).toBe(1); // registered once, in the constructor
    expect(closeListenersAtRest).toBe(1);

    const settled: string[] = [];
    for (let i = 0; i < 20; i++) {
      const capture = shell.showInput();
      void capture.then((text) => settled.push(text));
      hideVia(HIDE_PATHS[i % HIDE_PATHS.length] as HidePath);
      await Promise.resolve();
    }

    // THE assertion. Reintroduce per-call listeners and this goes red.
    expect(ipcMain.listenerCount("commandbar:submit")).toBe(submitListenersAtRest);
    expect(ipcMain.listenerCount("commandbar:close")).toBe(closeListenersAtRest);
    // The other half of the same bug: a capture left pending forever is also a leak.
    expect(settled).toHaveLength(20);
  });

  it("delivers ONE submit to ONE caller after many abandoned openings", async () => {
    // The exact shape of the original bug: 19 abandoned bar openings, then one keystroke.
    // Before the fix that produced 20 planner runs.
    const runs: string[] = [];
    for (let i = 0; i < 19; i++) {
      void shell.showInput().then((text) => runs.push(text));
      shell.handleBlur();
      await Promise.resolve();
    }
    expect(runs.filter((t) => t.length > 0)).toHaveLength(0); // all dismissed, none ran

    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "summarize this");

    await expect(capture).resolves.toBe("summarize this");
    expect(runs.filter((t) => t.length > 0)).toHaveLength(0); // no stragglers fired too
  });

  it("ends the capture when the window is closed rather than leaving it pending", async () => {
    const capture = shell.showInput();
    window.emit("closed");
    await expect(capture).resolves.toBe("");
  });

  it("reports a dismissal to onDismissed for every hide path except submit", async () => {
    for (const path of HIDE_PATHS) {
      ipcMain.removeAllListeners();
      window = makeWindow();
      shell = new WindowsShell(window as unknown as Electron.BrowserWindow);
      vi.useFakeTimers();

      let dismissed = 0;
      shell.onDismissed(() => (dismissed += 1));

      const capture = shell.showInput();
      hideVia(path);
      await capture;

      // Submitting is a decision, not a dismissal — voice must keep its transcript there.
      expect(dismissed, `hide path: ${path}`).toBe(path === "submit" ? 0 : 1);
      vi.useRealTimers();
    }
  });

  it("refuses to auto-hide while voice is holding a capped, unsubmitted recording", async () => {
    // The regression this guards: auto-hide is the ONLY automatic route to hide(), and
    // hide() tells voice to discard. Before this, "stopped" did not count as busy, so a
    // pending auto-hide timer could throw away a recording the user had not decided about.
    vi.useFakeTimers();
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));

    const capture = shell.showInput();
    shell.showVoiceState("recording");
    shell.showVoiceState("stopped"); // the 90s cap: mic released, audio held

    // A stale result lands while the bar is unfocused, which is what schedules auto-hide.
    window.focused = false;
    shell.showResult("a result from an earlier instruction");
    vi.advanceTimersByTime(60_000);

    expect(dismissed).toBe(0); // nothing discarded the held audio
    expect(window.isVisible()).toBe(true); // and the bar is still there to press Enter on

    // Still submittable, which is the whole point.
    ipcMain.emit("commandbar:submit", {}, "");
    await expect(capture).resolves.toBe("");
    expect(dismissed).toBe(0); // submitting is not a dismissal
  });

  it("still auto-hides a plain result once voice has nothing pending", async () => {
    // The control: the auto-hide must not be broken outright by the guard above.
    vi.useFakeTimers();
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "summarize this");
    await capture;

    shell.showVoiceState("idle");
    window.focused = false;
    shell.showResult("SUMMARY");
    vi.advanceTimersByTime(60_000);

    expect(window.isVisible()).toBe(false);
  });

  it("does not dismiss a bar that was never capturing", () => {
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));

    shell.handleBlur(); // no showInput() in flight
    expect(dismissed).toBe(0);
  });

  it("keeps the bar open on blur while the microphone is live, but not once it is stopped", async () => {
    // voiceBusy protects a live recording from a blur. A "stopped" bar has already released
    // the mic, so it must dismiss like any other — otherwise it sits there with a pending
    // capture and no auto-hide, which is how it behaved before this was narrowed.
    const recording = shell.showInput();
    shell.showVoiceState("recording");
    shell.handleBlur();
    expect(window.isVisible()).toBe(true);

    shell.showVoiceState("stopped");
    shell.handleBlur();
    await expect(recording).resolves.toBe("");
    expect(window.isVisible()).toBe(false);
  });
});
