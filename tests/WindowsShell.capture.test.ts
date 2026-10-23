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
const { ipcMain, makeWindow, globalShortcut, dialogShowMessageBox, openExternal } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  // A real EventEmitter, so listenerCount() means exactly what it means in production.
  const emitter = new EventEmitter();

  // A real registry, not a stub that always returns true — the Escape tests need to see
  // which combos are actually held right now, so they can fire the SAME callback the OS
  // would invoke and confirm registration is released when the bar is not visible.
  const handlers = new Map<string, () => void>();
  const globalShortcut = {
    register: (combo: string, handler: () => void): boolean => {
      handlers.set(combo, handler);
      return true;
    },
    unregister: (combo: string): void => {
      handlers.delete(combo);
    },
    unregisterAll: (): void => {
      handlers.clear();
    },
    _handlers: handlers, // test-only: not part of the real electron API
  };

  // A vi.fn so individual tests can control the dialog's timing (the confirm-suspension
  // test needs to hold it open) without needing electron's real dialog module at all.
  const dialogShowMessageBox = vi.fn(() => Promise.resolve({ response: 1 }));

  // Minimal stand-in for BrowserWindow: emits "show"/"hide" like the real one, which is
  // what WindowsShell's Escape (un)registration and capture cleanup are bound to.
  const makeWindow = () => {
    const win = Object.assign(new EventEmitter(), {
      visible: false,
      focused: false,
      sent: [] as { channel: string; args: unknown[] }[],
      show(): void {
        win.visible = true;
        win.focused = true;
        win.emit("show");
      },
      showInactive(): void {
        win.visible = true;
        win.emit("show"); // real Electron fires "show" for showInactive() too
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
      isDestroyed: () => false,
      webContents: {
        send(channel: string, ...args: unknown[]): void {
          win.sent.push({ channel, args });
        },
        // What the real webContents offers for refusing navigation (M21, result links). Recorded
        // rather than acted on, so a test can call the handlers exactly as Electron would.
        url: "http://localhost:5173/index.html", // test-only: what getURL() answers
        windowOpenHandler: null as ((details: { url: string }) => { action: string }) | null,
        navigationListeners: [] as ((event: { preventDefault(): void }, url: string) => void)[],
        getURL: (): string => win.webContents.url,
        setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
          win.webContents.windowOpenHandler = handler;
        },
        on(event: string, listener: (event: { preventDefault(): void }, url: string) => void): void {
          if (event === "will-navigate") win.webContents.navigationListeners.push(listener);
        },
      },
    });
    return win;
  };

  // A spy, so the result-link tests can see exactly what — if anything — reached the OS.
  const openExternal = vi.fn((_url: string) => Promise.resolve());

  return { ipcMain: emitter, makeWindow, globalShortcut, dialogShowMessageBox, openExternal };
});

vi.mock("electron", () => ({
  ipcMain,
  BrowserWindow: class {},
  globalShortcut,
  clipboard: { readText: () => "", writeText: () => undefined },
  dialog: { showMessageBox: dialogShowMessageBox },
  shell: { openExternal },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");
// VoiceSession imports no electron, so it can be wired to the mocked WindowsShell exactly
// as main.ts wires it — the only faithful way to reproduce a bug that lives in how the two
// talk to each other, not in either one alone.
const { VoiceSession } = await import("../src/main/shell/VoiceSession.ts");
const { DictationSession } = await import("../src/main/shell/DictationSession.ts");
const { createOnInstructionHotkey, CONFIRM_WAITING, CHAIN_RUNNING } = await import(
  "../src/main/instructionHotkey.ts"
);
const { combineInstructionBusy } = await import("../src/main/dictate.ts");
const { PLAYBACK_CEILING_MS } = await import("../src/main/shell/playbackLimit.ts");
const { FakeTranscriber } = await import("./FakeTranscriber.ts");
const { MockInputInjector } = await import("./MockInputInjector.ts");

// The global Escape handler currently held, if the bar is visible.
function escapeHandler(): (() => void) | undefined {
  return globalShortcut._handlers.get("Escape");
}
// What the OS delivers when Escape is pressed: a callback invoked directly, with no
// dependency on any window's focus — that independence is the entire point of the fix.
function fireEscape(): void {
  escapeHandler()?.();
}
// What the renderer sends back once its microphone is live — startRecording() awaits this
// exact reply, so any test that calls it for real has to supply one or it hangs.
function ackVoiceStarted(): void {
  ipcMain.emit("voice:started", {}, undefined);
}
// What the renderer sends back once it has stopped recording — stopRecording() awaits this
// exact reply the same way startRecording() awaits "voice:started" above.
function ackVoiceAudio(durationMs = 1500): void {
  ipcMain.emit("voice:audio", {}, { wav: new Uint8Array([1, 2, 3, 4]), durationMs });
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The global Enter ("Return") handler, armed only while a DictationSession is recording/
// stopped (M12.1's stop key) — mirrors escapeHandler()/fireEscape() above exactly.
function enterHandler(): (() => void) | undefined {
  return globalShortcut._handlers.get("Return");
}
function fireEnter(): void {
  enterHandler()?.();
}

type FakeWindow = ReturnType<typeof makeWindow>;

// The five ways the bar can go away. Cycling all of them is the point: the bug was that
// only two of them cleaned up.
const HIDE_PATHS = ["submit", "escape", "blur", "direct-window-hide", "auto-hide"] as const;
type HidePath = (typeof HIDE_PATHS)[number];

let window: FakeWindow;
let shell: InstanceType<typeof WindowsShell>;

beforeEach(() => {
  ipcMain.removeAllListeners();
  globalShortcut._handlers.clear();
  dialogShowMessageBox.mockReset();
  dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }));
  openExternal.mockClear();
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

// A renderer keydown listener on the bar's <input> only fires when that element has DOM
// focus, which requires the WINDOW to have OS focus first. That is routinely false: voice
// shows the bar via showInactive() ON PURPOSE, so the entire time the "Esc to discard" hint
// is on screen, no keyboard event can reach the renderer at all. Escape is registered as a
// GLOBAL shortcut instead, scoped to exactly the window's visible lifetime.
describe("WindowsShell Escape — works whenever the bar is visible, not only when focused", () => {
  it("is not registered before the bar has ever been shown", () => {
    expect(escapeHandler()).toBeUndefined();
  });

  it("registers Escape when the bar becomes visible and releases it once hidden", async () => {
    // Submitting alone does NOT hide the bar (it stays open for showResult), so the thing
    // that actually releases Escape here is the hide Escape itself causes.
    const capture = shell.showInput();
    expect(escapeHandler()).toBeDefined();

    fireEscape();

    await expect(capture).resolves.toBe("");
    expect(window.isVisible()).toBe(false);
    // Not held permanently — the whole point is it's scoped to "while visible".
    expect(escapeHandler()).toBeUndefined();
  });

  // M32. The case behind "Escape with the pill list open": once the bar is hidden by any route,
  // the app holds no Escape, so the key reaches whatever app is in front and the pill (which never
  // takes focus) cannot see it. Whether the real OS delivers it there is for a person (H4).
  it("holds no Escape once the bar is hidden by another route (M32)", async () => {
    void shell.showInput();
    expect(escapeHandler()).toBeDefined(); // the precondition: it was held while visible
    window.hide();
    await Promise.resolve();
    expect(escapeHandler()).toBeUndefined();
    expect(globalShortcut._handlers.has("Escape")).toBe(false);
  });

  it("closes the bar via the global shortcut even when focus is elsewhere", async () => {
    // The literal bug report: the bar is visible, but something else currently has focus
    // (the user briefly clicked away without triggering a full blur/hide — or, as below,
    // never focused the bar to begin with). A renderer keydown handler cannot see this
    // keypress at all; the global registration is what makes it work regardless.
    const capture = shell.showInput();
    window.focused = false; // focus is elsewhere; the bar is still on screen

    fireEscape();

    await expect(capture).resolves.toBe("");
    expect(window.isVisible()).toBe(false);
  });

  it("cancels a dictated recording via Escape, even though the bar was never focused", async () => {
    // The primary production case: startRecording() shows the bar with showInactive() so
    // dictating never steals focus from whatever app you're speaking into. The renderer's
    // own Escape handler is therefore DEAD CODE for the entire recording — this is the path
    // that has to carry "Esc to discard" for real.
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));

    const capture = shell.showInput();
    const recording = shell.startRecording();
    ackVoiceStarted(); // what the renderer sends back once its mic is live
    await recording;

    // Whatever the exact moment OS focus left the bar, dictating into another app only
    // works if the bar does not need to keep it — simulate focus having moved on, which is
    // the case Escape has to survive since it is not a DOM keydown listener.
    window.focused = false;
    expect(escapeHandler()).toBeDefined();

    fireEscape();

    await expect(capture).resolves.toBe("");
    expect(dismissed).toBe(1);
    expect(window.isVisible()).toBe(false);
  });

  it("does not collide with the main hotkey — independent registrations, one key each", async () => {
    const hotkeyOk = shell.registerHotkey("CommandOrControl+Shift+Space", () => undefined);
    expect(hotkeyOk).toBe(true);

    const capture = shell.showInput(); // also registers Escape
    expect(globalShortcut._handlers.has("CommandOrControl+Shift+Space")).toBe(true);
    expect(globalShortcut._handlers.has("Escape")).toBe(true);

    fireEscape(); // firing one must not touch the other
    await capture;
    expect(globalShortcut._handlers.has("CommandOrControl+Shift+Space")).toBe(true);
  });

  it("steps aside for the native confirm dialog, which already relies on Escape as Cancel", async () => {
    // confirm() is reached with the bar still open (nothing hides it between submit and the
    // confirm gate), so without this the global hook and the dialog's own cancelId would be
    // fighting over the same keypress. Since the M19 live fix confirm() also hides the bar for
    // the dialog's lifetime and brings it back — see "the bar gets out of the dialog's way".
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "send this");
    await capture;
    expect(escapeHandler()).toBeDefined();

    let resolveDialog!: (value: { response: number }) => void;
    dialogShowMessageBox.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDialog = resolve)),
    );

    const confirming = shell.confirm("Send to #design-team?");
    await Promise.resolve(); // let confirm() reach the awaited dialog call

    expect(escapeHandler()).toBeUndefined(); // ours is suspended; the dialog owns Escape now

    resolveDialog({ response: 1 }); // as if the user pressed the dialog's own Escape (Cancel)
    await expect(confirming).resolves.toBe(false);

    // Re-armed afterward, since the bar is still on screen.
    expect(escapeHandler()).toBeDefined();
  });

  // RE-JUSTIFIED FOR THE M19 LIVE FIX, not merely re-run (CLAUDE.md). This used to read "does
  // not re-arm after the dialog if the bar was hidden in the meantime", and it hid the window
  // by hand mid-dialog to set that up. confirm() now hides the bar ITSELF for every dialog, so
  // that setup no longer distinguishes anything — and the old expectation is now wrong for it:
  // a bar that was visible when the question was asked comes back, and Escape with it.
  //
  // The rule the old test was protecting survives in a different precondition: Escape is armed
  // only for a bar that is on screen, so a confirm asked with NO bar showing must leave it
  // un-armed and must not conjure a bar. Both halves are asserted, so the test can tell the two
  // rules apart.
  it("does not re-arm, or re-show anything, after a dialog asked while the bar was hidden", async () => {
    expect(window.isVisible()).toBe(false); // the precondition: no bar on screen

    let resolveDialog!: (value: { response: number }) => void;
    dialogShowMessageBox.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDialog = resolve)),
    );
    const confirming = shell.confirm("Send to #design-team?");
    await Promise.resolve();

    resolveDialog({ response: 0 });
    await confirming;

    expect(window.isVisible()).toBe(false);
    expect(escapeHandler()).toBeUndefined(); // nothing to arm Escape for
  });

  it("re-arms after the dialog for a bar that was visible when it was asked", async () => {
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "send this");
    await capture;

    let resolveDialog!: (value: { response: number }) => void;
    dialogShowMessageBox.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDialog = resolve)),
    );
    const confirming = shell.confirm("Send to #design-team?");
    await Promise.resolve();
    expect(escapeHandler()).toBeUndefined();

    resolveDialog({ response: 0 });
    await confirming;

    expect(window.isVisible()).toBe(true);
    expect(escapeHandler()).toBeDefined();
  });
});

// Reproduces a real bug: typing during a live recording was closing the WHOLE BAR instead
// of just cancelling the microphone. Root cause: cancelRecording() is the one thing
// VoiceSession.abandon() calls on BOTH of its triggers (typing AND a dismissal), but only
// a dismissal should close the bar — a dismissal already closed it via whatever produced
// the dismissal in the first place (Escape's own hide() call). cancelRecording() used to
// call hide() unconditionally, so typing inherited a "close everything" behaviour that was
// only ever correct for the OTHER trigger.
describe("Typing during a recording cancels the mic only — the bar stays open", () => {
  it("keeps the bar open, focused, and its capture alive after the first keystroke", async () => {
    // Wired exactly as main.ts wires it — the bug lives in this wiring, not in VoiceSession
    // or WindowsShell alone, so testing either in isolation would miss it.
    const voice = new VoiceSession(shell, new FakeTranscriber("unused"));
    let abandoning: Promise<void> | null = null;
    shell.onTypingStarted(() => {
      abandoning = voice.abandon();
    });

    // Hotkey press: opens the bar and starts listening (src/main/main.ts's onHotkey).
    const capture = shell.showInput();
    const recording = voice.begin();
    ackVoiceStarted();
    await recording;
    expect(voice.getState()).toBe("recording");
    expect(window.isVisible()).toBe(true);

    // A keystroke: CommandBar.tsx's onChange sends this once, on the first real character.
    ipcMain.emit("commandbar:typing", {});
    await abandoning;

    // The bug: the bar used to vanish here.
    expect(window.isVisible()).toBe(true);
    expect(voice.getState()).toBe("idle"); // the RECORDING is what cancelled
    // No reset was sent — a reset is what wipes the renderer's already-typed character back
    // to empty, which is the concrete way "the bar vanishes" actually manifested.
    expect(window.sent.some((m) => m.channel === "commandbar:reset")).toBe(false);

    // The ORIGINAL showInput() capture is still the live one — the user keeps typing into
    // the same bar and Enter submits normally, exactly as if voice had never been involved.
    ipcMain.emit("commandbar:submit", {}, "summarize this");
    await expect(capture).resolves.toBe("summarize this");
  });

  it("still closes the bar when the trigger really is a dismissal (Escape)", async () => {
    // The control: removing cancelRecording()'s own hide() must not silently break the
    // case that DOES need the bar to close. Escape already closes it via its own hide()
    // call before onDismiss ever fires, so this should hold either way — proving that.
    const voice = new VoiceSession(shell, new FakeTranscriber("unused"));
    shell.onDismissed(() => void voice.abandon());

    const capture = shell.showInput();
    const recording = voice.begin();
    ackVoiceStarted();
    await recording;

    fireEscape();

    await expect(capture).resolves.toBe("");
    expect(window.isVisible()).toBe(false);
  });
});

describe("WindowsShell — a result surfaces even if the bar was blurred away mid-run", () => {
  it("re-shows the bar and delivers the result after a blur during Thinking", async () => {
    // Thinking alone does not pin the bar against a blur (only a live recording does), so
    // clicking away while the planner is still working hides it — showResult's own
    // re-show-if-hidden logic is what has to bring it back for the result to be seen at all.
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "summarize this");
    await capture;

    shell.showThinking(true);
    shell.handleBlur(); // the user clicked away while the planner was still running
    expect(window.isVisible()).toBe(false);

    shell.showResult("SUMMARY");
    shell.showThinking(false); // the finally in createRunInstruction, after showResult

    expect(window.isVisible()).toBe(true);
    const echo = window.sent.filter((m) => m.channel === "commandbar:echo").at(-1);
    expect(echo?.args[0]).toBe("SUMMARY");
  });

  it("does the same when the run was a dictated instruction", async () => {
    // Voice's own showInactive() means the bar may never have had focus to begin with, but
    // the mechanism is identical: showResult brings it back regardless of how it went away.
    const capture = shell.showInput();
    const recording = shell.startRecording();
    ackVoiceStarted();
    await recording;
    shell.showVoiceState("idle", "summarize this"); // finish() landing back at idle
    shell.showThinking(true);

    window.hide(); // stands in for however the bar ended up hidden mid-run
    await expect(capture).resolves.toBe(""); // the hide's own cleanup ends this capture

    shell.showResult("SUMMARY");
    shell.showThinking(false);

    expect(window.isVisible()).toBe(true);
    const echo = window.sent.filter((m) => m.channel === "commandbar:echo").at(-1);
    expect(echo?.args[0]).toBe("SUMMARY");
  });
});

// M12: DictationSession never calls showInput() — there is no typed-text capture to resolve,
// only a mic and a target window. Before this milestone, endCapture()'s guard was
// `pendingInput === null`, which meant it did NOTHING for a session that only ever set
// voiceState. Escape, a blur, or the window closing would have hidden the bar and left
// DictationSession's recording live and unaware, with the microphone still open and no way
// left to reach it — the opposite of "Esc discards it".
describe("WindowsShell — dictation is heard by every dismissal path, with no showInput() in flight", () => {
  it("cancels a dictated recording via Escape even though showInput() was never called", async () => {
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));

    const dictation = new DictationSession(
      shell,
      new FakeTranscriber("unused"),
      new MockInputInjector(),
    );
    const beginning = dictation.begin();
    // begin() awaits the injector's getForegroundWindow() BEFORE it ever reaches
    // shell.startRecording(), so the IPC listener startRecording() registers is not live
    // yet on this same tick — unlike calling shell.startRecording() directly (as the
    // VoiceSession tests above do). Let that resolve first, or ackVoiceStarted() fires
    // into an empty room and the recording hangs forever.
    await Promise.resolve();
    ackVoiceStarted();
    await beginning;
    expect(dictation.getState()).toBe("recording");
    expect(window.isVisible()).toBe(true); // narrate() showed it via showInactive

    fireEscape();
    await Promise.resolve();

    expect(dismissed).toBe(1);
    expect(window.isVisible()).toBe(false);
  });

  it("cancels via a direct window.hide() and via the window closing, same as blur/escape", async () => {
    for (const trigger of ["hide", "closed"] as const) {
      ipcMain.removeAllListeners();
      globalShortcut._handlers.clear();
      window = makeWindow();
      shell = new WindowsShell(window as unknown as Electron.BrowserWindow);

      let dismissed = 0;
      shell.onDismissed(() => (dismissed += 1));
      const dictation = new DictationSession(
        shell,
        new FakeTranscriber("unused"),
        new MockInputInjector(),
      );
      const beginning = dictation.begin();
      await Promise.resolve(); // let getForegroundWindow() resolve before the IPC ack
      ackVoiceStarted();
      await beginning;

      window.emit(trigger);
      await Promise.resolve();

      expect(dismissed, `trigger: ${trigger}`).toBe(1);
    }
  });

  it("does not auto-hide while dictation is inserting text", async () => {
    // pinnedAgainstBlur must cover "inserting", not just "recording"/"transcribing" — an
    // in-flight SendInput call is exactly the kind of thing the bar must stay up through.
    vi.useFakeTimers();
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));

    shell.showVoiceState("inserting");
    window.focused = false;
    shell.showResult("stale result from an earlier run");
    vi.advanceTimersByTime(60_000);

    expect(dismissed).toBe(0);
    expect(window.isVisible()).toBe(true);
  });

  it("narrate() shows the bar without stealing focus and cancels any pending auto-hide", () => {
    window.focused = false;
    shell.narrate("Dictating into — Untitled - Notepad");

    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(false); // showInactive, not show — never steals focus
    const status = window.sent.filter((m) => m.channel === "commandbar:status").at(-1);
    expect(status?.args[0]).toBe("Dictating into — Untitled - Notepad");
  });
});

// M12.1: Enter replaces the same-hotkey stop. Wired through the REAL WindowsShell
// (mocked electron), which is the only faithful way to prove the global registration itself
// works — a unit test against MockShell (DictationSession.test.ts) proves the session's own
// logic, but not that WindowsShell.armStopKey actually arms the real "Return" accelerator.
describe("WindowsShell.armStopKey — Enter finishes a live dictation, globally", () => {
  it("is not registered before any dictation session has begun", () => {
    expect(enterHandler()).toBeUndefined();
  });

  it("arms Enter once recording starts, and firing it types the transcript", async () => {
    const injector = new MockInputInjector();
    const dictation = new DictationSession(shell, new FakeTranscriber("summarize this"), injector);

    const beginning = dictation.begin();
    await Promise.resolve(); // let getForegroundWindow() resolve before the IPC ack
    ackVoiceStarted();
    await beginning;
    expect(enterHandler()).toBeDefined();

    // fireEnter() runs synchronously into finish() -> shell.stopRecording(), which registers
    // its "voice:audio" listener synchronously too (inside the Promise executor) — so the ack
    // can follow immediately, exactly like ackVoiceStarted() does for startRecording() above.
    fireEnter();
    ackVoiceAudio();
    await flush(); // drain the remaining microtasks: transcribe, focus recheck, typeText

    expect(injector.typed).toEqual(["summarize this"]);
    expect(dictation.getState()).toBe("idle");
  });

  it("disarms Enter once the session returns to idle — it does not leak into normal typing", async () => {
    const dictation = new DictationSession(
      shell,
      new FakeTranscriber("hi"),
      new MockInputInjector(),
    );

    const beginning = dictation.begin();
    await Promise.resolve();
    ackVoiceStarted();
    await beginning;
    expect(enterHandler()).toBeDefined();

    fireEnter();
    ackVoiceAudio();
    await flush();

    expect(dictation.getState()).toBe("idle");
    expect(enterHandler()).toBeUndefined(); // Enter is free again for every other app
  });

  it("Escape still cancels a live recording — Enter and Escape are independent", async () => {
    const injector = new MockInputInjector();
    const dictation = new DictationSession(shell, new FakeTranscriber("never runs"), injector);
    shell.onDismissed(() => void dictation.abandon());

    const beginning = dictation.begin();
    await Promise.resolve();
    ackVoiceStarted();
    await beginning;

    fireEscape();
    await Promise.resolve();

    expect(dictation.getState()).toBe("idle");
    expect(injector.typed).toHaveLength(0);
    expect(enterHandler()).toBeUndefined(); // abandon() -> enter("idle") disarmed it too
  });
});

describe("WindowsShell.isInputCapturing (M12.1's tightened mutual-exclusion check)", () => {
  it("is true while a showInput() capture is pending, and false once it resolves", async () => {
    expect(shell.isInputCapturing()).toBe(false);

    const capture = shell.showInput();
    expect(shell.isInputCapturing()).toBe(true);

    ipcMain.emit("commandbar:submit", {}, "typed text");
    await capture;
    expect(shell.isInputCapturing()).toBe(false);
  });
});

// --- Speech output (M14) ---
//
// The shell half of voice output: what it hands to the queue, what it sends the renderer, and
// the one invariant that has to hold here rather than at each hotkey. SpeechSession's own
// behaviour is tested against MockShell in SpeechSession.test.ts; this is the electron-shaped
// end, which is exactly the code a test that avoids electron would skip.

function fakeSpeaker() {
  const calls: string[] = [];
  return {
    calls,
    speak: (text: string) => calls.push(`speak:${text}`),
    stop: () => calls.push("stop"),
    isSpeaking: () => false,
  };
}

describe("WindowsShell — speech output", () => {
  it("hands a speak action to the queue", async () => {
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const speaker = fakeSpeaker();
    shell.attachSpeech(speaker);

    const result = await shell.executeAction({ kind: "speak", payload: "Done." });

    expect(result.ok).toBe(true);
    expect(speaker.calls).toEqual(["speak:Done."]);
  });

  it("accepts a speak action on an install that cannot speak", async () => {
    // "The app has no voice" is a supported state, not an error. A planner run must not fail
    // because the machine is silent, exactly as it does not fail with no microphone.
    const shell = new WindowsShell(makeWindow() as never);

    await expect(
      shell.executeAction({ kind: "speak", payload: "Done." }),
    ).resolves.toEqual({ ok: true });
  });

  it("stops speaking when the microphone opens", async () => {
    // THE invariant, at the chokepoint every path to the mic goes through. Not a preference:
    // the instruction hotkey opens the bar AND the mic together, so an app still speaking
    // would be transcribed by whisper into the user's own instruction.
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const speaker = fakeSpeaker();
    shell.attachSpeech(speaker);

    const started = shell.startRecording();
    ackVoiceStarted();
    await started;

    expect(speaker.calls).toContain("stop");
  });

  it("sends the bytes with a clip id, and resolves only on a report naming that clip", async () => {
    // M24: the report carries the clip's id, so one arriving late for a clip main already gave
    // up on cannot end the wait for the clip playing now.
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const wav = new Uint8Array([1, 2, 3]);
    let over = false;

    const playing = shell.play(wav).then(() => (over = true));
    const sent = win.sent.find((message) => message.channel === "speech:play");
    expect(sent?.args[0]).toBe(wav);
    const id = sent?.args[1];
    expect(typeof id).toBe("number");

    ipcMain.emit("speech:ended", {}, (id as number) + 1, undefined);
    await Promise.resolve();
    expect(over).toBe(false);

    ipcMain.emit("speech:ended", {}, id, undefined);
    await playing;
    expect(over).toBe(true);
  });

  it("resolves even when the renderer never answers — at the ceiling, for bytes of unknown length", async () => {
    // The queue upstream drains by awaiting this. A play() that stayed pending after a
    // crashed or destroyed renderer would strand every utterance behind it forever.
    //
    // RE-JUSTIFIED AT M24. This used to pass at 20 s because every clip was let go at 15 s —
    // the bound that cut long speech short. Bytes that are not a WAV have no knowable length, so
    // they now wait the ceiling: still never for ever, and never the old 15 s. The length-based
    // limit for a real WAV is covered in speechPlayback.test.ts.
    vi.useFakeTimers();
    try {
      const shell = new WindowsShell(makeWindow() as never);
      let over = false;
      const playing = shell.play(new Uint8Array([1])).then(() => (over = true));

      await vi.advanceTimersByTimeAsync(PLAYBACK_CEILING_MS - 1);
      expect(over).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await playing;
      expect(over).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the renderer to stop", () => {
    const win = makeWindow();
    const shell = new WindowsShell(win as never);

    shell.stopPlayback();

    expect(win.sent.some((message) => message.channel === "speech:stop")).toBe(true);
  });
});

describe("WindowsShell — the confirm-pending flag (M14 §8)", () => {
  it("is false when no dialog is open", () => {
    const shell = new WindowsShell(makeWindow() as never);

    expect(shell.isConfirmPending()).toBe(false);
  });

  it("is true for the whole time the dialog is on screen", async () => {
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    win.show();

    let answer: (value: { response: number }) => void = () => undefined;
    dialogShowMessageBox.mockImplementation(
      () => new Promise<{ response: number }>((resolve) => (answer = resolve)),
    );

    const asking = shell.confirm("Send this invite?");
    // Set synchronously, before anything awaits — there must be no instant where the dialog
    // is up and the guard does not know it.
    expect(shell.isConfirmPending()).toBe(true);

    answer({ response: 0 });
    await asking;
    expect(shell.isConfirmPending()).toBe(false);
  });

  it("clears on a cancel", async () => {
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    win.show();
    dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }));

    await shell.confirm("Send this invite?");

    expect(shell.isConfirmPending()).toBe(false);
  });

  it("clears even when the dialog itself throws", async () => {
    // In the `finally`, not after the await: a dialog that blew up must not leave both hotkeys
    // blocked forever with nothing on screen to answer.
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    win.show();
    dialogShowMessageBox.mockImplementation(() => Promise.reject(new Error("dialog exploded")));

    await expect(shell.confirm("Send this invite?")).rejects.toThrow("dialog exploded");
    expect(shell.isConfirmPending()).toBe(false);
  });
});

describe("WindowsShell — silencing (M14 step 7)", () => {
  it("stops speech on Escape, without needing the instruction hotkey", () => {
    // Live use found the only way to interrupt speech was the instruction hotkey, which also
    // opens the bar and the microphone — so "just be quiet" left a bar to dismiss afterwards.
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const speaker = fakeSpeaker();
    shell.attachSpeech(speaker);
    win.show(); // Escape is only ours while the bar is up

    fireEscape();

    expect(speaker.calls).toContain("stop");
  });

  it("drops speech still queued about a confirm once it has been answered", async () => {
    // The other half of the stale-narration fix. By the time the dialog is answered, anything
    // still waiting to be said about it is describing a decision already made.
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const speaker = fakeSpeaker();
    shell.attachSpeech(speaker);
    win.show();
    dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }));

    await shell.confirm("Send this invite to alex@example.com?");

    expect(speaker.calls).toContain("stop");
  });
});

// THE M19 LIVE BUG. In a three-step chain a person saw "Step 3 of 3: Send to #social?" with its
// text and both buttons covered by the instruction bar.
//
// The bar is an always-on-top window and the dialog opened unparented in the same place. What
// had been keeping them apart was a side effect — the dialog took focus, the bar blurred, the
// blur handler hid it — and that only works for a bar that HAD focus. After a chain's step 2,
// `showResult` re-shows the bar with showInactive(); an unfocused window never blurs, so step
// 3's dialog opened underneath it.
//
// WHAT THESE TESTS CAN AND CANNOT SHOW. They hold the dialog open (the shell-level equivalent of
// MockShell's `holdConfirm`) and assert what the shell DID with the window while it was up:
// hidden, parented, Escape released. That is a decision, not a picture (CLAUDE.md: a log line
// proves what the app decided, not what the user saw). Whether the dialog is actually on top is
// a z-order fact about real windows — measured by scripts/confirm-zorder-recon.cjs, and seen by
// a person in docs/M19-live-checklist.md.
describe("WindowsShell — the bar gets out of the confirm dialog's way (M19 live fix)", () => {
  // A dialog that stays up until the test answers it. `calls` is every showMessageBox call's
  // arguments, so a test can see what the dialog was parented to.
  function holdDialog() {
    const answers: ((value: { response: number }) => void)[] = [];
    dialogShowMessageBox.mockImplementation(
      () => new Promise<{ response: number }>((resolve) => answers.push(resolve)),
    );
    return {
      answer: (response: number): void => answers.shift()?.({ response }),
      calls: (): unknown[][] => dialogShowMessageBox.mock.calls as unknown as unknown[][],
    };
  }

  // A typed run up to the moment a gate fires: bar open, FOCUSED, input submitted.
  async function submitted(): Promise<void> {
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "file this bug and tell the team");
    await capture;
  }

  const sentOn = (channel: string): unknown[] =>
    window.sent.filter((entry) => entry.channel === channel).map((entry) => entry.args[0]);

  it("reproduces the chain: a result shown INACTIVE between two confirms no longer leaves the bar up", async () => {
    const dialog = holdDialog();
    await submitted();

    // Step 2's gate. The bar had focus, so even the old code got this one right.
    const second = shell.confirm("Step 2 of 3: Create this Linear issue in Engineering?");
    await Promise.resolve();
    expect(window.isVisible()).toBe(false);
    dialog.answer(0);
    await expect(second).resolves.toBe(true);

    // Step 2's result: the bar is visible again and — this is the precondition the bug needs —
    // NOT focused, so no blur will ever hide it.
    shell.showResult("Created SEJ-9: Login broken");
    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(false);

    // Step 3's gate, the one that was covered.
    const third = shell.confirm("Step 3 of 3: Send to #social?");
    await Promise.resolve();
    expect(shell.isConfirmPending()).toBe(true);
    expect(window.isVisible()).toBe(false);
    expect(escapeHandler()).toBeUndefined();

    dialog.answer(0);
    await expect(third).resolves.toBe(true);
  });

  it("parents every dialog to the bar window, so Windows keeps it above the bar and above other apps", async () => {
    const dialog = holdDialog();
    await submitted();

    const asking = shell.confirm("Send to #social?");
    await Promise.resolve();

    const [parent, options] = dialog.calls()[0] ?? [];
    expect(parent).toBe(window);
    // The safety properties of the dialog itself are untouched by the reparenting.
    expect(options).toMatchObject({
      buttons: ["Send", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Send to #social?",
    });

    dialog.answer(1);
    await asking;
  });

  it("hides the bar whether or not it had focus", async () => {
    for (const focused of [true, false]) {
      const dialog = holdDialog();
      window = makeWindow();
      shell = new WindowsShell(window as unknown as Electron.BrowserWindow);
      if (focused) window.show();
      else window.showInactive();
      expect(window.isFocused()).toBe(focused);

      const asking = shell.confirm("Send?");
      await Promise.resolve();
      expect(window.isVisible(), `focused: ${String(focused)}`).toBe(false);

      dialog.answer(1);
      await asking;
    }
  });

  it("does not treat hiding for the dialog as a dismissal", async () => {
    const dialog = holdDialog();
    let dismissed = 0;
    shell.onDismissed(() => (dismissed += 1));
    await submitted();
    const resetsBefore = sentOn("commandbar:reset").length;

    const asking = shell.confirm("Send?");
    await Promise.resolve();

    // Nothing was abandoned and the bar's contents were not wiped: it is coming back.
    expect(dismissed).toBe(0);
    expect(sentOn("commandbar:reset")).toHaveLength(resetsBefore);

    dialog.answer(0);
    await asking;
    expect(dismissed).toBe(0);
  });

  it("keeps the bar hidden, and Escape released, whatever tries to show it while the dialog is up", async () => {
    vi.useFakeTimers();
    const dialog = holdDialog();
    await submitted();
    // An auto-hide already ticking from an earlier, unfocused result.
    window.focused = false;
    shell.showResult("an earlier result");

    const resetsBefore = sentOn("commandbar:reset").length;
    let answered: boolean | null = null;
    const asking = shell.confirm("Step 3 of 3: Send to #social?").then((value) => {
      answered = value;
      return value;
    });
    await Promise.resolve();

    const check = (what: string): void => {
      expect(window.isVisible(), what).toBe(false);
      expect(escapeHandler(), what).toBeUndefined();
      expect(shell.isConfirmPending(), what).toBe(true);
      expect(answered, what).toBeNull();
      // Nothing ran the dismissal path either: the bar's contents are intact for its return.
      expect(sentOn("commandbar:reset"), what).toHaveLength(resetsBefore);
    };
    check("at the start");

    // FIRST, before anything else touches the bar: the auto-hide timer that was already
    // ticking. It must come first because narrate() cancels that timer as a side effect — with
    // the order the other way round this step asserted on a timer that no longer existed, and a
    // mutation removing the cancel in confirm() survived it.
    vi.advanceTimersByTime(60_000);
    check("after the earlier auto-hide timer's deadline");

    // The instruction hotkey's "there's a confirmation waiting" goes out through narrate() —
    // the path that used to re-show the bar straight over the dialog it was pointing at.
    shell.narrate("There's a confirmation waiting — answer it on screen.");
    check("after narrate()");
    shell.showResult("a result that landed late");
    check("after showResult()");
    shell.handleBlur();
    check("after a blur");

    // The words were still delivered — only the window was left alone.
    expect(sentOn("commandbar:status")).toContain(
      "There's a confirmation waiting — answer it on screen.",
    );
    expect(sentOn("commandbar:echo")).toContain("a result that landed late");

    dialog.answer(1);
    await expect(asking).resolves.toBe(false);
  });

  // Escape is bound to the window's "show" event. Even if some path this file has not thought
  // of DOES show the bar mid-dialog, the key must stay with the dialog — where it means Cancel.
  it("does not take Escape back even if the window itself is shown mid-dialog", async () => {
    const dialog = holdDialog();
    await submitted();
    const asking = shell.confirm("Send?");
    await Promise.resolve();

    window.showInactive(); // behind the shell's back
    expect(escapeHandler()).toBeUndefined();

    dialog.answer(1);
    await asking;
    // And it is re-armed afterwards, because that bar is now on screen.
    expect(escapeHandler()).toBeDefined();
  });

  it("brings the bar back after the answer, unfocused, with Escape re-armed", async () => {
    for (const response of [0, 1]) {
      const dialog = holdDialog();
      window = makeWindow();
      shell = new WindowsShell(window as unknown as Electron.BrowserWindow);
      await submitted();

      const asking = shell.confirm("Send?");
      await Promise.resolve();
      dialog.answer(response);
      await asking;

      expect(window.isVisible(), `response ${response}`).toBe(true);
      // showInactive, never show: the answer was given in the dialog and the bar must not
      // pull focus back from wherever it went.
      expect(window.isFocused(), `response ${response}`).toBe(false);
      expect(escapeHandler(), `response ${response}`).toBeDefined();
    }
  });

  it("shows the result of the approved action in the restored bar", async () => {
    const dialog = holdDialog();
    await submitted();
    const asking = shell.confirm("Step 3 of 3: Send to #social?");
    await Promise.resolve();
    dialog.answer(0);
    await asking;

    shell.showResult("Sent to #social.");

    expect(window.isVisible()).toBe(true);
    expect(sentOn("commandbar:echo")).toContain("Sent to #social.");
  });

  it("does not leave a restored, unfocused bar on screen forever", async () => {
    // A cancelled lone confirm produces no result, so nothing else would ever hide this bar:
    // it has no focus to lose. It gets the same auto-hide an unfocused result gets.
    vi.useFakeTimers();
    const dialog = holdDialog();
    await submitted();
    const asking = shell.confirm("Send?");
    await Promise.resolve();
    dialog.answer(1);
    await asking;
    expect(window.isVisible()).toBe(true);

    vi.advanceTimersByTime(13_000);
    expect(window.isVisible()).toBe(false);
  });

  it("does not conjure a bar for a confirm that was asked with none showing", async () => {
    const dialog = holdDialog();
    expect(window.isVisible()).toBe(false);

    const asking = shell.confirm("Send?");
    await Promise.resolve();
    // Still parented: the dialog must be topmost even with no bar on screen.
    expect(dialog.calls()[0]?.[0]).toBe(window);
    dialog.answer(0);
    await asking;

    expect(window.isVisible()).toBe(false);
    expect(escapeHandler()).toBeUndefined();
  });

  it("restores the bar and clears the flag even when the dialog throws", async () => {
    await submitted();
    dialogShowMessageBox.mockImplementation(() => Promise.reject(new Error("dialog exploded")));

    await expect(shell.confirm("Send?")).rejects.toThrow("dialog exploded");

    expect(shell.isConfirmPending()).toBe(false);
    expect(window.isVisible()).toBe(true);
    expect(escapeHandler()).toBeDefined();
  });

  // The real hotkey handler over the real shell. Guard order is unchanged — this is what the
  // user-visible half of it now does while a dialog is up.
  it("answers the instruction hotkey with 'confirmation waiting' without opening the bar over the dialog", async () => {
    const dialog = holdDialog();
    await submitted();
    const speaker = fakeSpeaker();
    let ran = 0;
    const onHotkey = createOnInstructionHotkey({
      shell,
      dictation: null,
      voice: null,
      speech: speaker,
      // A chain is running too, as it is when a chained step is parked at its gate. Confirm
      // pending must still be the answer given.
      chain: { isRunning: () => true },
      runInstruction: () => {
        ran += 1;
        return Promise.resolve();
      },
    });

    const asking = shell.confirm("Step 3 of 3: Send to #social?");
    await Promise.resolve();
    onHotkey();
    await flush();

    expect(sentOn("commandbar:status")).toContain(CONFIRM_WAITING);
    expect(sentOn("commandbar:status")).not.toContain(CHAIN_RUNNING);
    expect(speaker.calls.some((call) => call.startsWith("speak:"))).toBe(true);
    expect(window.isVisible()).toBe(false);
    expect(escapeHandler()).toBeUndefined();
    expect(shell.isConfirmPending()).toBe(true);
    expect(ran).toBe(0);

    dialog.answer(1);
    await asking;
  });
});

// `askUser(question)`: the command bar, reused to put one question and take one typed line back.
//
// It differs from `showInput()` in every way that matters to the person looking at it, and each
// difference below is a decision that was made on purpose:
//
//   - an EMPTY answer is an answer (""); only Escape, the timeout, or the bar going away is null
//   - clicking away does NOT dismiss it — the user may be looking up the thing being asked for
//   - it cancels itself after 60 seconds, so nothing can wait on it forever
//   - it never takes the bar from something already using it: it answers null and touches nothing
describe("WindowsShell.askUser", () => {
  const sentOn = (channel: string): unknown[] =>
    window.sent.filter((message) => message.channel === channel).map((message) => message.args[0]);
  const answer = (text: string): void => {
    ipcMain.emit("commandbar:submit", {}, text);
  };
  // Settled yet? Raced against a tick, never read from a flag the shell sets about itself.
  async function isSettled(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol("pending");
    const first = await Promise.race([promise, flush().then(() => pending)]);
    return first !== pending;
  }

  it("shows and focuses the bar with the question, and resolves with what was typed", async () => {
    const asking = shell.askUser("Which channel is the bugs channel?");

    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(true);
    expect(sentOn("commandbar:ask")).toEqual(["Which channel is the bugs channel?"]);
    expect(await isSettled(asking)).toBe(false);

    answer("#bugs");

    await expect(asking).resolves.toBe("#bugs");
    // The question is taken down, and the bar stays: whatever asked is still running.
    expect(sentOn("commandbar:ask")).toEqual(["Which channel is the bugs channel?", null]);
    expect(window.isVisible()).toBe(true);
  });

  it("resolves an empty answer as an empty string — never as null", async () => {
    const asking = shell.askUser("Anything to add?");
    answer("");
    await expect(asking).resolves.toBe("");
  });

  it("resolves null on Escape, and the bar goes away", async () => {
    const asking = shell.askUser("Which channel?");
    expect(escapeHandler()).toBeDefined();

    fireEscape();

    await expect(asking).resolves.toBeNull();
    expect(window.isVisible()).toBe(false);
  });

  it("resolves null when the bar goes away by a route nobody wrote a handler for", async () => {
    // Bound to the window's own events, like the capture cleanup above: a question nobody can
    // see must not stay pending because the thing that hid it was impolite about it.
    const hidden = shell.askUser("Which channel?");
    window.hide();
    await expect(hidden).resolves.toBeNull();

    const closed = shell.askUser("Which channel?");
    window.emit("closed");
    await expect(closed).resolves.toBeNull();
  });

  it("reports isAskPending from the instant it is asked until every way out", async () => {
    vi.useFakeTimers();
    const waysOut: Record<string, () => void> = {
      answered: () => answer("#bugs"),
      "answered with nothing": () => answer(""),
      escape: () => fireEscape(),
      "timed out": () => vi.advanceTimersByTime(60_000),
      "window hidden": () => window.hide(),
    };

    for (const [name, leave] of Object.entries(waysOut)) {
      expect(shell.isAskPending(), `before: ${name}`).toBe(false);
      const asking = shell.askUser("Which channel?");
      // Synchronously. No instant in which the question is up and a hotkey guard cannot know.
      expect(shell.isAskPending(), `during: ${name}`).toBe(true);
      leave();
      await asking;
      expect(shell.isAskPending(), `after: ${name}`).toBe(false);
    }
  });

  it("stays up when the user clicks away, and can still be answered", async () => {
    const asking = shell.askUser("Which channel?");

    window.focused = false;
    shell.handleBlur();

    expect(window.isVisible()).toBe(true);
    expect(await isSettled(asking)).toBe(false);
    // The precondition for that meaning anything: with no question open, the same blur hides
    // the bar. (Asserted last, on a fresh opening, so it cannot disturb the question above.)
    answer("#bugs");
    await expect(asking).resolves.toBe("#bugs");

    void shell.showInput();
    shell.handleBlur();
    expect(window.isVisible()).toBe(false);
  });

  it("is not taken down by the auto-hide while it waits unfocused", async () => {
    vi.useFakeTimers();
    const asking = shell.askUser("Which channel?");
    window.focused = false;
    // Something else reports a result into the unfocused bar, which arms the 12s auto-hide.
    shell.showResult("an unrelated result");

    vi.advanceTimersByTime(13_000);

    expect(window.isVisible()).toBe(true);
    expect(shell.isAskPending()).toBe(true);
    answer("#bugs");
    await expect(asking).resolves.toBe("#bugs");
  });

  it("cancels itself after 60 seconds, exactly as Escape would", async () => {
    vi.useFakeTimers();
    let settled: string | null | undefined;
    void shell.askUser("Which channel?").then((value) => (settled = value));

    vi.advanceTimersByTime(59_999);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(window.isVisible()).toBe(true);

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(settled).toBeNull();
    expect(window.isVisible()).toBe(false);
    expect(sentOn("speech:stop").length).toBeGreaterThan(0); // Escape's own "be quiet"
  });

  it("leaves no timer behind: an answered question cannot cancel the next one early", async () => {
    vi.useFakeTimers();
    const first = shell.askUser("Which channel?");
    vi.advanceTimersByTime(50_000);
    answer("#bugs");
    await first;

    const second = shell.askUser("And when?");
    // 65s after the FIRST question, 15s after this one.
    vi.advanceTimersByTime(15_000);

    expect(shell.isAskPending()).toBe(true);
    expect(window.isVisible()).toBe(true);
    answer("tomorrow");
    await expect(second).resolves.toBe("tomorrow");
  });

  it("keeps an answer and an instruction apart: each submit reaches only the thing that is open", async () => {
    const asking = shell.askUser("Which channel?");
    answer("#bugs");
    await expect(asking).resolves.toBe("#bugs");

    const capture = shell.showInput();
    expect(shell.isAskPending()).toBe(false);
    ipcMain.emit("commandbar:submit", {}, "summarize this");
    await expect(capture).resolves.toBe("summarize this");
  });

  it("holds the IPC listener count flat across twenty questions", async () => {
    const atRest = ipcMain.listenerCount("commandbar:submit");
    for (let i = 0; i < 20; i++) {
      const asking = shell.askUser("Which channel?");
      if (i % 2 === 0) answer("#bugs");
      else fireEscape();
      await asking;
    }
    expect(ipcMain.listenerCount("commandbar:submit")).toBe(atRest);
  });

  // IT NEVER TAKES THE BAR FROM SOMETHING ALREADY USING IT. Each case: null, at once, and not
  // one message sent or one window call made — the thing in flight cannot tell it was asked.
  describe("when the bar is already busy", () => {
    it("answers null and leaves an open instruction capture untouched", async () => {
      const capture = shell.showInput();
      const sentBefore = window.sent.length;

      await expect(shell.askUser("Which channel?")).resolves.toBeNull();

      expect(window.sent.length).toBe(sentBefore);
      expect(shell.isAskPending()).toBe(false);
      expect(shell.isInputCapturing()).toBe(true);
      ipcMain.emit("commandbar:submit", {}, "summarize this");
      await expect(capture).resolves.toBe("summarize this");
    });

    it.each(["recording", "stopped", "transcribing", "inserting"] as const)(
      "answers null while voice is %s, without showing or focusing anything",
      async (state) => {
        shell.showVoiceState(state);
        const sentBefore = window.sent.length;
        const focusedBefore = window.isFocused();

        await expect(shell.askUser("Which channel?")).resolves.toBeNull();

        expect(window.sent.length).toBe(sentBefore);
        expect(window.isFocused()).toBe(focusedBefore);
        expect(shell.isAskPending()).toBe(false);
      },
    );

    it("answers null while a confirm dialog is up", async () => {
      let close: (value: { response: number }) => void = () => undefined;
      dialogShowMessageBox.mockImplementation(
        () => new Promise<{ response: number }>((resolve) => (close = resolve)),
      );
      const confirming = shell.confirm("Send it?");

      await expect(shell.askUser("Which channel?")).resolves.toBeNull();

      expect(sentOn("commandbar:ask")).toEqual([]);
      expect(shell.isConfirmPending()).toBe(true);
      close({ response: 1 });
      await confirming;
    });

    it("answers null to a second question, and the first is still there to answer", async () => {
      const first = shell.askUser("Which channel?");

      await expect(shell.askUser("And when?")).resolves.toBeNull();

      expect(sentOn("commandbar:ask")).toEqual(["Which channel?"]);
      answer("#bugs");
      await expect(first).resolves.toBe("#bugs");
    });
  });

  // Pinned rather than designed: a confirm from some other run hides the bar for its dialog, and
  // a hidden question is ended. Fail-closed — the asker hears null — and it cannot strand.
  it("is ended with null if a confirm dialog takes the screen while it is open", async () => {
    const asking = shell.askUser("Which channel?");

    await shell.confirm("Send it?");

    await expect(asking).resolves.toBeNull();
  });

  describe("focusAsk", () => {
    it("gives the question focus back without resetting what was typed", async () => {
      const asking = shell.askUser("Which channel?");
      window.focused = false; // clicked away to look something up
      const before = window.sent.length;

      shell.focusAsk();

      expect(window.isFocused()).toBe(true);
      const since = window.sent.slice(before).map((message) => message.channel);
      expect(since).toEqual(["commandbar:focus"]); // not :show, not :reset — the text survives
      answer("#bugs");
      await asking;
    });

    it("does nothing at all when no question is open", () => {
      shell.focusAsk();

      expect(window.isVisible()).toBe(false);
      expect(window.isFocused()).toBe(false);
      expect(window.sent).toEqual([]);
    });
  });

  // The real handlers over the real shell.
  it("turns an instruction-hotkey press into a refocus: no second capture, no run", async () => {
    let ran = 0;
    const onHotkey = createOnInstructionHotkey({
      shell,
      dictation: null,
      voice: null,
      speech: null,
      chain: { isRunning: () => true }, // as when a chain is what asked
      runInstruction: () => {
        ran += 1;
        return Promise.resolve();
      },
    });
    const asking = shell.askUser("Which channel?");
    window.focused = false;

    onHotkey();
    await flush();

    expect(window.isFocused()).toBe(true);
    expect(sentOn("commandbar:show")).toEqual([]); // showInput() never ran
    expect(sentOn("commandbar:status")).toEqual([]); // and it was not told to wait for a chain
    expect(shell.isInputCapturing()).toBe(false);
    expect(shell.isAskPending()).toBe(true);
    expect(ran).toBe(0);

    answer("#bugs");
    await expect(asking).resolves.toBe("#bugs");
    expect(ran).toBe(0);
  });

  it("holds the dictation hotkey's guard busy for exactly as long as the question is open", async () => {
    const busy = combineInstructionBusy(null, shell);
    expect(busy.getState()).toBe("idle");

    const asking = shell.askUser("Which channel?");
    expect(busy.getState()).toBe("asking");

    answer("#bugs");
    await asking;
    expect(busy.getState()).toBe("idle");
  });
});

// Result links (M21). The renderer draws certain URLs as links and, on a click, asks main to
// open one. Main does not take the renderer's word for it: the renderer is the process showing
// text other people wrote, so whatever arrives on this channel is checked again from scratch,
// and anything that fails is dropped with NO side effect — nothing opened, nothing shown.
describe("WindowsShell — opening a result link", () => {
  const GITHUB = "https://github.com/Sejall-089/throwaway_repo/issues/3";
  const LINEAR = "https://linear.app/sejal/issue/SEJ-7/login-button-does-nothing";
  const fromRenderer = (payload: unknown): void => {
    ipcMain.emit("commandbar:open-link", {}, payload);
  };

  it.each([GITHUB, LINEAR])("opens %s in the default browser, exactly once, exactly as sent", async (url) => {
    fromRenderer(url);
    await flush();

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ["an allowed host as a subdomain label of another", "https://github.com.evil.com/Sejall-089/x/issues/3"],
    ["an allowed host in another host's path", "https://evil.com/github.com/x"],
    ["no scheme at all", "evil.com/github.com"],
    ["http", "http://github.com/Sejall-089/x/issues/3"],
    ["javascript:", "javascript:alert(document.cookie)"],
    ["file:", "file:///C:/Windows/System32/calc.exe"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a username", "https://user@github.com/Sejall-089/x"],
    ["a username and password", "https://user:secret@github.com/x"],
    ["the real host used as a username", "https://github.com@evil.com/x"],
    ["a subdomain of an allowed host", "https://gist.github.com/x"],
    ["an explicit port", "https://github.com:8443/x"],
    ["an app protocol", "spotify:track:123"],
    ["a good URL with a second one after a newline", `${GITHUB}\nhttps://evil.com`],
    ["a good URL with leading whitespace", ` ${GITHUB}`],
    ["an empty string", ""],
  ])("REJECTS %s sent straight to main, and does nothing at all", async (_label, url) => {
    const sentBefore = window.sent.length;

    fromRenderer(url);
    await flush();

    expect(openExternal).not.toHaveBeenCalled();
    // No side effect of any kind: nothing sent back to the renderer, the bar not shown.
    expect(window.sent.length).toBe(sentBefore);
    expect(window.isVisible()).toBe(false);
  });

  it.each([[undefined], [null], [42], [{ url: GITHUB }], [[GITHUB]]])(
    "rejects a payload that is not a string (%j) without throwing",
    async (payload) => {
      expect(() => fromRenderer(payload)).not.toThrow();
      await flush();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it("reports whether it opened anything, to a direct caller", async () => {
    await expect(shell.openResultLink(GITHUB)).resolves.toBe(true);
    await expect(shell.openResultLink("https://github.com.evil.com/x")).resolves.toBe(false);
    expect(openExternal.mock.calls).toEqual([[GITHUB]]);
  });

  it("goes through the existing openUrl action — one path to the OS, not a second one", async () => {
    const seen: unknown[] = [];
    const real = shell.executeAction.bind(shell);
    shell.executeAction = (action) => {
      seen.push(action);
      return real(action);
    };

    fromRenderer(GITHUB);
    await flush();

    expect(seen).toEqual([{ kind: "openUrl", payload: GITHUB }]);
  });

  it("holds the listener count flat: one handler for the app's lifetime", () => {
    expect(ipcMain.listenerCount("commandbar:open-link")).toBe(1);
  });
});

// The bar's own window must never navigate. It is the app's UI with the preload bridge attached;
// a web page loaded INTO it would have that bridge in reach. A click on a result link asks main
// to open the default browser (above) — and these two refusals are the backstop for the day a
// click is ever handled by the browser instead of by our handler.
describe("WindowsShell — the bar cannot be navigated", () => {
  it("denies every new window, whatever the URL", () => {
    const handler = window.webContents.windowOpenHandler;
    expect(handler).not.toBeNull();

    for (const url of [
      "https://github.com/Sejall-089/throwaway_repo/issues/3", // even an allowed one
      "https://evil.com/",
      "about:blank",
      "file:///C:/x",
    ]) {
      expect(handler?.({ url }), url).toEqual({ action: "deny" });
    }
    expect(openExternal).not.toHaveBeenCalled(); // denying is all it does
  });

  it.each([
    "https://github.com/Sejall-089/throwaway_repo/issues/3",
    "https://evil.com/",
    "file:///C:/Windows/System32/calc.exe",
    "http://localhost:5173/other.html",
  ])("prevents the window navigating to %s", (url) => {
    expect(window.webContents.navigationListeners).toHaveLength(1);
    const event = { preventDefault: vi.fn() };

    window.webContents.navigationListeners[0]?.(event, url);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("lets the page reload itself, so the dev server's hot reload keeps working", () => {
    // The one navigation that is not a navigation AWAY: the same URL the window is already on.
    const event = { preventDefault: vi.fn() };

    window.webContents.navigationListeners[0]?.(event, window.webContents.getURL());

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

// The approve button's label (M21). It used to be "Send" for everything — including a create.
// What must NOT change with it is everything that makes the dialog safe: Cancel is still the
// second button, still the default (a stray Enter), and still what Escape means.
describe("WindowsShell.confirm — the approve button's label", () => {
  type Options = { buttons: string[]; defaultId: number; cancelId: number; message: string };
  const optionsOf = (call: number): Options =>
    (dialogShowMessageBox.mock.calls[call] as unknown as [unknown, Options])[1];

  it.each(["Create issue", "Create event", "Move event", "Send reply", "Send"])(
    "shows %j on the approve button, with Cancel still second, default and Escape",
    async (label) => {
      await shell.confirm("Do it?", { approveLabel: label });

      expect(optionsOf(0)).toMatchObject({
        buttons: [label, "Cancel"],
        defaultId: 1, // Cancel — a stray Enter approves nothing
        cancelId: 1, // Escape, or closing the dialog, is Cancel
        message: "Do it?",
      });
    },
  );

  it("says 'Send' when it is given no label", async () => {
    await shell.confirm("Do it?");
    await shell.confirm("Do it?", {});
    expect(optionsOf(0).buttons).toEqual(["Send", "Cancel"]);
    expect(optionsOf(1).buttons).toEqual(["Send", "Cancel"]);
  });

  it.each(["", "   "])("never shows an empty button: a blank label (%j) falls back to 'Send'", async (blank) => {
    await shell.confirm("Do it?", { approveLabel: blank });
    expect(optionsOf(0).buttons).toEqual(["Send", "Cancel"]);
  });

  it("is still cancelled by Escape and by the default button, whatever the label says", async () => {
    // Index 1 is what Electron reports for the Cancel button, for Escape (cancelId) and for
    // Enter on the default (defaultId). A label is a word; it changes none of that.
    dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }));
    await expect(shell.confirm("Create this issue?", { approveLabel: "Create issue" })).resolves.toBe(false);
  });

  it("is approved only by the first button, whatever the label says", async () => {
    dialogShowMessageBox.mockImplementation(() => Promise.resolve({ response: 0 }));
    await expect(shell.confirm("Create this issue?", { approveLabel: "Create issue" })).resolves.toBe(true);
  });

  it("keeps the message exactly as given — the label is not added to it or taken from it", async () => {
    const message = "Step 2 of 3: Create this GitHub issue in o/r?\n\nTitle: Cancel\n\nSend";
    await shell.confirm(message, { approveLabel: "Create issue" });
    expect(optionsOf(0).message).toBe(message);
    expect(optionsOf(0).buttons).toEqual(["Create issue", "Cancel"]);
  });
});

// M23. A DETACHED job's confirm — opened by a click in the status pill, at a moment when the
// bar may be mid-instruction, holding a question, or speaking. Addition B: it must not be
// parented to the bar, must not hide it, must not run the bar's hide handler (which ends a
// capture and a question), and must not stop speech. Only an attached confirm keeps M19's
// behaviour — and each test below states the attached behaviour as its contrast, so "the bar
// was left alone" cannot pass merely because nothing happens to the bar in this harness.
describe("WindowsShell.confirm — a detached job's dialog leaves the bar alone (M23)", () => {
  function holdDialog() {
    const answers: ((value: { response: number }) => void)[] = [];
    dialogShowMessageBox.mockImplementation(
      () => new Promise<{ response: number }>((resolve) => answers.push(resolve)),
    );
    return {
      answer: (response: number): void => answers.shift()?.({ response }),
      calls: (): unknown[][] => dialogShowMessageBox.mock.calls as unknown as unknown[][],
    };
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const hides = (): { count: number } => {
    const seen = { count: 0 };
    window.on("hide", () => (seen.count += 1));
    return seen;
  };
  const speaker = () => {
    const calls = { stop: 0 };
    shell.attachSpeech({ speak: () => undefined, stop: () => (calls.stop += 1), isSpeaking: () => true });
    return calls;
  };

  // The status pill's window, which a detached dialog hangs off. Attached for every test here,
  // as main.ts attaches it — without one a detached dialog is refused (see the tests below).
  let pillWindow: FakeWindow;
  beforeEach(() => {
    pillWindow = makeWindow();
    shell.attachDetachedDialogOwner(() => pillWindow as unknown as Electron.BrowserWindow);
  });

  it("with an instruction CAPTURE open: the bar stays up, focused, and the capture stays pending", async () => {
    const dialog = holdDialog();
    const pill = pillWindow;
    const hidden = hides();
    const capture = shell.showInput(); // the user is typing an instruction
    let captured: string | null = null;
    void capture.then((text) => (captured = text));

    const asking = shell.confirm("Send to #social?", { detached: true });
    await tick();

    expect(shell.isConfirmPending()).toBe(true); // both hotkeys are still blocked by it
    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(true);
    expect(hidden.count).toBe(0);
    expect(shell.isInputCapturing()).toBe(true);
    expect(captured).toBeNull();
    // Parented to the PILL, never the bar.
    expect(dialog.calls()[0]?.[0]).toBe(pill);
    expect(dialog.calls()[0]?.[0]).not.toBe(window);

    dialog.answer(0);
    await expect(asking).resolves.toBe(true);
    expect(hidden.count).toBe(0);
    expect(shell.isInputCapturing()).toBe(true);
    expect(captured).toBeNull();

    // The capture is still the user's to finish.
    ipcMain.emit("commandbar:submit", {}, "what I was typing");
    await expect(capture).resolves.toBe("what I was typing");
  });

  it("CONTRAST — an attached confirm in the same position hides the bar and ends the capture", async () => {
    const dialog = holdDialog();
    const hidden = hides();
    const capture = shell.showInput();
    const asking = shell.confirm("Send to #social?");
    await tick();
    expect(window.isVisible()).toBe(false);
    expect(hidden.count).toBe(1);
    await expect(capture).resolves.toBe("");
    expect(dialog.calls()[0]?.[0]).toBe(window);
    dialog.answer(1);
    await asking;
  });

  it("with a QUESTION open: it stays on screen and stays pending", async () => {
    const dialog = holdDialog();
    const asked = shell.askUser("Which channel is the bugs channel?");
    let answered: string | null = "PENDING";
    void asked.then((value) => (answered = value));
    const hidden = hides();

    const asking = shell.confirm("Send to #social?", { detached: true });
    await tick();
    expect(shell.isAskPending()).toBe(true);
    expect(window.isVisible()).toBe(true);
    expect(hidden.count).toBe(0);

    dialog.answer(1);
    await expect(asking).resolves.toBe(false);
    expect(shell.isAskPending()).toBe(true);
    expect(answered).toBe("PENDING");

    ipcMain.emit("commandbar:submit", {}, "#bugs");
    await expect(asked).resolves.toBe("#bugs");
  });

  it("a blur while it is up — the dialog taking the keyboard — does not dismiss the bar", async () => {
    const dialog = holdDialog();
    const capture = shell.showInput();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();

    shell.handleBlur();
    expect(window.isVisible()).toBe(true);
    expect(shell.isInputCapturing()).toBe(true);

    dialog.answer(1);
    await asking;
    ipcMain.emit("commandbar:submit", {}, "still here");
    await expect(capture).resolves.toBe("still here");
  });

  it("does NOT stop the app speaking; an attached confirm still does", async () => {
    const dialog = holdDialog();
    const speech = speaker();

    const detached = shell.confirm("Send?", { detached: true });
    await tick();
    dialog.answer(0);
    await detached;
    expect(speech.stop).toBe(0);

    const attached = shell.confirm("Send?");
    await tick();
    dialog.answer(0);
    await attached;
    expect(speech.stop).toBe(1);
  });

  it("steps the global Escape hook aside while it is up, and re-arms it for a bar that is still open", async () => {
    const dialog = holdDialog();
    void shell.showInput();
    expect(escapeHandler()).toBeDefined();

    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    // The dialog owns Escape as its own Cancel. Left armed, the bar's hook would eat the key —
    // and hide the bar, ending the capture this dialog was never meant to touch.
    expect(escapeHandler()).toBeUndefined();

    dialog.answer(1);
    await asking;
    expect(escapeHandler()).toBeDefined();
  });

  it("with the bar hidden it stays hidden: nothing was taken away, so nothing is restored", async () => {
    const dialog = holdDialog();
    expect(window.isVisible()).toBe(false);
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    dialog.answer(0);
    await asking;
    expect(window.isVisible()).toBe(false);
    expect(escapeHandler()).toBeUndefined();
  });

  it("text that reaches a hidden bar while it is up is shown once it has closed", async () => {
    const dialog = holdDialog();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();

    shell.showResult("An attached job's answer."); // some OTHER job, in front of the user
    expect(window.isVisible()).toBe(false); // not over a dialog

    dialog.answer(1);
    await asking;
    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(false);
    expect(window.sent.filter((entry) => entry.channel === "commandbar:echo").map((entry) => entry.args[0])).toEqual([
      "An attached job's answer.",
    ]);
  });

  it("is the real dialog with the tool's own label, parented to the pill", async () => {
    const dialog = holdDialog();
    const asking = shell.confirm("Send?", { detached: true, approveLabel: "Create issue" });
    await tick();
    const call = dialog.calls()[0] ?? [];
    expect(call[0]).toBe(pillWindow);
    expect(call[1]).toMatchObject({ buttons: ["Create issue", "Cancel"], defaultId: 1, cancelId: 1, message: "Send?" });
    dialog.answer(1);
    await asking;
  });

  // NEVER UNPARENTED. Measured (scripts/pill-click-recon.cjs): an unparented dialog is fully
  // covered by a visible bar. So with no live pill a detached confirm is refused outright —
  // no dialog is opened, the request fails as an error (never as a "no"), and nothing is left
  // pending to block the hotkeys.
  it.each([
    ["no owner was ever attached", (): void => {
      window = makeWindow();
      shell = new WindowsShell(window as unknown as Electron.BrowserWindow);
    }],
    ["the owner callback returns null", (): void => shell.attachDetachedDialogOwner(() => null)],
    ["the pill window has been destroyed", (): void => {
      const dead = Object.assign(makeWindow(), { isDestroyed: () => true });
      shell.attachDetachedDialogOwner(() => dead as unknown as Electron.BrowserWindow);
    }],
  ])("REFUSED with no dialog at all when %s", async (_name, arrange) => {
    const dialog = holdDialog();
    arrange();
    const capture = shell.showInput();

    await expect(shell.confirm("Send?", { detached: true })).rejects.toThrow("no status pill");

    expect(dialog.calls()).toEqual([]);
    expect(shell.isConfirmPending()).toBe(false);
    // And the bar it must not disturb was not disturbed by the refusal either.
    expect(window.isVisible()).toBe(true);
    expect(shell.isInputCapturing()).toBe(true);
    expect(escapeHandler()).toBeDefined();
    ipcMain.emit("commandbar:submit", {}, "x");
    await capture;

    // An ATTACHED confirm needs no pill and is unaffected.
    const attached = shell.confirm("Send?");
    await tick();
    expect(dialog.calls().length).toBe(1);
    dialog.answer(1);
    await attached;
  });

  it("the hotkey's 'a confirmation is waiting' line does not pop the bar up after the dialog closes", async () => {
    const dialog = holdDialog();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    shell.narrate("There's a confirmation waiting — answer it on screen.");
    expect(window.isVisible()).toBe(false);
    dialog.answer(1);
    await asking;
    // Stale the instant the dialog was answered: it is not shown afterwards.
    expect(window.isVisible()).toBe(false);
  });

  it("a result landing in a VISIBLE, unfocused bar during someone else's dialog still auto-hides", async () => {
    vi.useFakeTimers();
    const dialog = holdDialog();
    window.showInactive(); // an attached job's bar, never focused (the voice path)
    const asking = shell.confirm("Send?", { detached: true });
    await Promise.resolve();

    shell.showResult("An attached job's answer.");
    expect(window.isVisible()).toBe(true);

    dialog.answer(1);
    await vi.advanceTimersByTimeAsync(0);
    await asking;
    // Nothing about the detached dialog closing hides this bar, and it has no focus to lose.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(window.isVisible()).toBe(false);
  });

  it("ONE DIALOG AT A TIME: a second confirm waits for the first, and the guard holds throughout", async () => {
    const dialog = holdDialog();
    const first = shell.confirm("First?");
    const second = shell.confirm("Second?", { detached: true });
    await tick();
    expect(dialog.calls().length).toBe(1);
    expect(shell.isConfirmPending()).toBe(true);

    dialog.answer(0);
    await expect(first).resolves.toBe(true);
    // The first was answered — and under the old boolean this is where the flag cleared with
    // a second dialog about to be on screen.
    expect(shell.isConfirmPending()).toBe(true);
    await tick();
    expect(dialog.calls().length).toBe(2);
    expect((dialog.calls()[1] ?? []).at(-1)).toMatchObject({ message: "Second?" });

    dialog.answer(1);
    await expect(second).resolves.toBe(false);
    expect(shell.isConfirmPending()).toBe(false);
  });

  it("a dialog that throws does not strand the one queued behind it", async () => {
    let calls = 0;
    dialogShowMessageBox.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("dialog exploded")) : Promise.resolve({ response: 0 });
    });
    const first = shell.confirm("First?", { detached: true });
    const second = shell.confirm("Second?", { detached: true });
    await expect(first).rejects.toThrow("dialog exploded");
    await expect(second).resolves.toBe(true);
    expect(shell.isConfirmPending()).toBe(false);
  });

  it("isForegroundFree: not during a dialog, a question, a capture or a recording", async () => {
    expect(shell.isForegroundFree()).toBe(true);

    const dialog = holdDialog();
    const asking = shell.confirm("Send?", { detached: true });
    expect(shell.isForegroundFree()).toBe(false);
    dialog.answer(1);
    await asking;
    expect(shell.isForegroundFree()).toBe(true);

    const capture = shell.showInput();
    expect(shell.isForegroundFree()).toBe(false);
    ipcMain.emit("commandbar:submit", {}, "x");
    await capture;
    expect(shell.isForegroundFree()).toBe(true);

    const asked = shell.askUser("Which?");
    expect(shell.isForegroundFree()).toBe(false);
    ipcMain.emit("commandbar:submit", {}, "#bugs");
    await asked;

    shell.showVoiceState("recording");
    expect(shell.isForegroundFree()).toBe(false);
    shell.showVoiceState("idle");
    expect(shell.isForegroundFree()).toBe(true);
  });

  it("the chime has its own channel, and opening the microphone cuts it off", async () => {
    shell.playChime();
    const channels = (): string[] => window.sent.map((entry) => entry.channel);
    expect(channels()).toContain("chime:play");
    // Never through the speech player, whose single reply would end an utterance early.
    expect(channels()).not.toContain("speech:play");

    const started = shell.startRecording();
    ipcMain.emit("voice:started", {});
    await started;
    const sent = channels();
    expect(sent).toContain("chime:stop");
    expect(sent.indexOf("chime:stop")).toBeLessThan(sent.indexOf("voice:start"));
  });
});

// THE KEYBOARD GOES BACK TO THE BAR after a detached dialog — if, and only if, the bar had it.
//
// Live finding after M23, then measured with real windows: the user was typing an instruction,
// clicked "Review…" in the pill, answered the dialog, and the next keystroke went nowhere.
// Windows hands the foreground back to the dialog's OWNER when it closes — the pill, which is
// built never to take focus — and nothing gave it back to the bar. The text and the caret were
// never touched.
//
// The fake dialog below does what the OS does to the bar: the moment the dialog opens, the bar
// loses focus. Whether focus comes BACK is then entirely up to the shell.
describe("WindowsShell — the bar gets the keyboard back after a detached dialog (M23 follow-up)", () => {
  let pill: FakeWindow;
  let pillFocusCalls = 0;
  beforeEach(() => {
    pill = makeWindow();
    pillFocusCalls = 0;
    pill.focus = (): void => {
      pillFocusCalls += 1;
    };
    shell.attachDetachedDialogOwner(() => pill as unknown as Electron.BrowserWindow);
  });

  function holdDialog() {
    const answers: { answer: (value: { response: number }) => void; fail: (error: Error) => void }[] = [];
    dialogShowMessageBox.mockImplementation(
      () =>
        new Promise<{ response: number }>((resolve, reject) => {
          // What Windows does: the dialog takes the keyboard from whatever had it.
          window.focused = false;
          answers.push({ answer: resolve, fail: reject });
        }),
    );
    return {
      answer: (response: number): void => answers.shift()?.answer({ response }),
      fail: (): void => answers.shift()?.fail(new Error("dialog exploded")),
      open: (): number => answers.length,
    };
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const focusRequests = (): number => window.sent.filter((entry) => entry.channel === "commandbar:focus").length;
  // The user is typing an instruction: the bar is open and has the keyboard.
  const typing = (): Promise<string> => {
    const capture = shell.showInput();
    expect(window.isFocused()).toBe(true);
    return capture;
  };

  it.each([
    ["approved", 0],
    ["cancelled", 1],
  ])("bar open and focused -> dialog %s -> the bar has the keyboard again, and the box is asked to take it", async (_name, response) => {
    const dialog = holdDialog();
    const capture = typing();
    const asking = shell.confirm("Send to #fun?", { detached: true });
    await tick();
    expect(window.isFocused()).toBe(false); // the dialog has it

    dialog.answer(response);
    await asking;
    expect(window.isFocused()).toBe(true);
    expect(focusRequests()).toBe(1);
    // Nothing that would clear what was typed: no reset, no show, and the capture is still open.
    expect(window.sent.map((entry) => entry.channel)).not.toContain("commandbar:reset");
    expect(window.sent.filter((entry) => entry.channel === "commandbar:show")).toHaveLength(1); // the original opening only
    expect(shell.isInputCapturing()).toBe(true);
    ipcMain.emit("commandbar:submit", {}, "remind me to call");
    await expect(capture).resolves.toBe("remind me to call");
  });

  it("Escape in the dialog is a cancel, and gives the keyboard back the same way", async () => {
    // Escape is the dialog's own Cancel (cancelId 1): it arrives here as response 1.
    const dialog = holdDialog();
    void typing();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    expect(escapeHandler()).toBeUndefined(); // the dialog owns Escape while it is up
    dialog.answer(1);
    await expect(asking).resolves.toBe(false);
    expect(window.isFocused()).toBe(true);
    expect(focusRequests()).toBe(1);
  });

  it("a dialog that THROWS still gives the keyboard back", async () => {
    const dialog = holdDialog();
    void typing();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    dialog.fail();
    await expect(asking).rejects.toThrow("dialog exploded");
    expect(window.isFocused()).toBe(true);
    expect(focusRequests()).toBe(1);
  });

  it("TWO QUEUED DIALOGS: the keyboard comes back ONCE, after the last — not between them", async () => {
    const dialog = holdDialog();
    void typing();
    const first = shell.confirm("First?", { detached: true });
    const second = shell.confirm("Second?", { detached: true });
    await tick();

    dialog.answer(0);
    await first;
    await tick();
    // The second dialog is up now. Focus was NOT handed to the bar in between: it would have
    // been taken straight back, and the bar would have flashed active under a dialog.
    expect(dialog.open()).toBe(1);
    expect(focusRequests()).toBe(0);
    expect(window.isFocused()).toBe(false);

    dialog.answer(1);
    await second;
    expect(window.isFocused()).toBe(true);
    expect(focusRequests()).toBe(1);
  });

  it("BAR CLOSED: nothing is focused — the app does not pull the keyboard to itself", async () => {
    const dialog = holdDialog();
    expect(window.isVisible()).toBe(false);
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    dialog.answer(0);
    await asking;
    expect(window.isFocused()).toBe(false);
    expect(window.isVisible()).toBe(false);
    expect(focusRequests()).toBe(0);
  });

  it("BAR OPEN BUT NOT FOCUSED (the user was in another app): nothing is focused", async () => {
    const dialog = holdDialog();
    window.showInactive(); // e.g. a result on screen while the user works elsewhere
    expect(window.isFocused()).toBe(false);
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    dialog.answer(0);
    await asking;
    expect(window.isFocused()).toBe(false);
    expect(focusRequests()).toBe(0);
  });

  it("the bar was focused when the dialog opened but was CLOSED before it was answered: nothing is reopened or focused", async () => {
    const dialog = holdDialog();
    void typing();
    const asking = shell.confirm("Send?", { detached: true });
    await tick();
    window.hide(); // closed while the dialog was up
    dialog.answer(1);
    await asking;
    expect(window.isVisible()).toBe(false);
    expect(window.isFocused()).toBe(false);
    expect(focusRequests()).toBe(0);
  });

  it("the record does not leak into the next dialog: a later one with the bar unfocused restores nothing", async () => {
    const dialog = holdDialog();
    void typing();
    const first = shell.confirm("First?", { detached: true });
    await tick();
    dialog.answer(0);
    await first;
    expect(focusRequests()).toBe(1);

    window.focused = false; // the user went to another app
    const later = shell.confirm("Later?", { detached: true });
    await tick();
    dialog.answer(0);
    await later;
    expect(window.isFocused()).toBe(false);
    expect(focusRequests()).toBe(1);
  });

  it("AN ATTACHED CONFIRM IS UNCHANGED: the bar is hidden, restored inactive, never focused or sent a focus request", async () => {
    const dialog = holdDialog();
    void typing();
    const asking = shell.confirm("Send?");
    await tick();
    expect(window.isVisible()).toBe(false); // M19: hidden for the dialog's lifetime
    dialog.answer(0);
    await asking;
    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(false); // showInactive, as before
    expect(focusRequests()).toBe(0);
  });

  it("THE PILL NEVER TAKES FOCUS: the dialog hangs off it, and nothing ever focuses it", async () => {
    for (const setup of ["focused bar", "closed bar", "unfocused bar"]) {
      const dialog = holdDialog();
      if (setup === "focused bar") void typing();
      if (setup === "unfocused bar") window.showInactive();
      const asking = shell.confirm("Send?", { detached: true });
      await tick();
      dialog.answer(0);
      await asking;
      window.hide();
    }
    expect(pillFocusCalls).toBe(0);
  });
});

// "There's a confirmation waiting" — shown while it is true, taken down once it is not (live
// finding after M23). The user's sequence: a detached job's dialog up, the bar OPEN with a
// half-typed instruction, the hotkey pressed (blocked, so the bar says a confirmation is
// waiting), the dialog cancelled — and the bar still said so, with nothing waiting. Nothing ever
// took the line down: closing a dialog does not reset a bar it never hid. The real-window half
// (what the renderer then draws) is scripts/ask-recon/confirm-waiting-line.ts.

describe("WindowsShell — the 'confirmation waiting' line comes down when nothing is waiting", () => {
  beforeEach(() => {
    const pill = makeWindow();
    shell.attachDetachedDialogOwner(() => pill as unknown as Electron.BrowserWindow);
  });

  function holdDialog() {
    const answers: { answer: (value: { response: number }) => void; fail: (error: Error) => void }[] = [];
    dialogShowMessageBox.mockImplementation(
      () => new Promise<{ response: number }>((resolve, reject) => answers.push({ answer: resolve, fail: reject })),
    );
    return {
      answer: (response: number): void => answers.shift()?.answer({ response }),
      fail: (): void => answers.shift()?.fail(new Error("dialog exploded")),
    };
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  // Every status line sent to the bar, in order; null is "take it down".
  const statusLines = (): unknown[] => window.sent.filter((e) => e.channel === "commandbar:status").map((e) => e.args[0]);
  // The real hotkey handler, as main.ts wires it, minus the microphone.
  const pressHotkey = (): void =>
    createOnInstructionHotkey({ shell, dictation: null, voice: null, speech: null, chain: null, runInstruction: () => Promise.resolve() })();

  async function blockedPressDuringADialog(detached = true) {
    const dialog = holdDialog();
    void shell.showInput(); // the bar is open, an instruction half typed
    const asking = shell.confirm("Create a Linear issue?", { detached });
    await tick();
    pressHotkey();
    return { dialog, asking };
  }

  it("a hotkey pressed while a dialog is up PUTS THE LINE IN THE OPEN BAR, and it stays while the dialog does", async () => {
    const { dialog, asking } = await blockedPressDuringADialog();
    expect(statusLines()).toEqual([CONFIRM_WAITING]);
    await tick();
    expect(statusLines()).toEqual([CONFIRM_WAITING]); // not taken down while it is true
    dialog.answer(1);
    await asking;
  });

  it.each([
    ["approved", 0],
    ["cancelled", 1],
    ["Escape (the dialog's cancelId)", 1],
  ])("the dialog %s -> the line is taken down", async (_name, response) => {
    const { dialog, asking } = await blockedPressDuringADialog();
    dialog.answer(response);
    await asking;
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]);
  });

  it("a dialog that THROWS -> the line is taken down too", async () => {
    const { dialog, asking } = await blockedPressDuringADialog();
    dialog.fail();
    await expect(asking).rejects.toThrow("dialog exploded");
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]);
  });

  it("an ATTACHED dialog the same way: the line does not come back with the bar", async () => {
    const { dialog, asking } = await blockedPressDuringADialog(false);
    dialog.answer(1);
    await asking;
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]);
  });

  it("TWO QUEUED DIALOGS: taken down only after the LAST — while the second is up it is still true", async () => {
    const dialog = holdDialog();
    void shell.showInput();
    const first = shell.confirm("First?", { detached: true });
    const second = shell.confirm("Second?", { detached: true });
    await tick();
    pressHotkey();
    dialog.answer(0);
    await first;
    await tick();
    expect(statusLines()).toEqual([CONFIRM_WAITING]);
    dialog.answer(1);
    await second;
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]);
  });

  it("A DIFFERENT STATUS set meanwhile SURVIVES the dialog closing", async () => {
    const { dialog, asking } = await blockedPressDuringADialog();
    shell.narrate("Reading the open email and drafting a reply…"); // something else, still true
    dialog.answer(1);
    await asking;
    expect(statusLines()).toEqual([CONFIRM_WAITING, "Reading the open email and drafting a reply…"]);
  });

  it("a RESULT that replaced it meanwhile is not followed by a stray clear", async () => {
    const { dialog, asking } = await blockedPressDuringADialog();
    shell.showResult("Sent to #fun."); // the renderer drops the status line for a result
    dialog.answer(1);
    await asking;
    expect(statusLines()).toEqual([CONFIRM_WAITING]);
  });

  it("a NEW INSTRUCTION submitted in the same bar takes it down (while the dialog is still up)", async () => {
    const { dialog, asking } = await blockedPressDuringADialog();
    ipcMain.emit("commandbar:submit", {}, "hello to all channels");
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]);
    dialog.answer(1);
    await asking;
    expect(statusLines()).toEqual([CONFIRM_WAITING, null]); // and nothing more when it closes
  });

  it("any other status is never taken down by a submit", async () => {
    void shell.showInput();
    shell.narrate("Reading the open email…");
    ipcMain.emit("commandbar:submit", {}, "do it");
    expect(statusLines()).toEqual(["Reading the open email…"]);
  });
});
