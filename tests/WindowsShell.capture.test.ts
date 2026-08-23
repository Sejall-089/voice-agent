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
const { ipcMain, makeWindow, globalShortcut, dialogShowMessageBox } = await vi.hoisted(async () => {
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
      },
    });
    return win;
  };

  return { ipcMain: emitter, makeWindow, globalShortcut, dialogShowMessageBox };
});

vi.mock("electron", () => ({
  ipcMain,
  BrowserWindow: class {},
  globalShortcut,
  clipboard: { readText: () => "", writeText: () => undefined },
  dialog: { showMessageBox: dialogShowMessageBox },
  shell: { openExternal: () => Promise.resolve() },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");
// VoiceSession imports no electron, so it can be wired to the mocked WindowsShell exactly
// as main.ts wires it — the only faithful way to reproduce a bug that lives in how the two
// talk to each other, not in either one alone.
const { VoiceSession } = await import("../src/main/shell/VoiceSession.ts");
const { DictationSession } = await import("../src/main/shell/DictationSession.ts");
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
    // confirm() runs while the bar is still open (nothing hides it between submit and the
    // confirm gate), so without this the global hook and the dialog's own cancelId would be
    // fighting over the same keypress.
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

  it("does not re-arm after the dialog if the bar was hidden in the meantime", async () => {
    const capture = shell.showInput();
    ipcMain.emit("commandbar:submit", {}, "send this");
    await capture;

    let resolveDialog!: (value: { response: number }) => void;
    dialogShowMessageBox.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDialog = resolve)),
    );
    const confirming = shell.confirm("Send to #design-team?");
    await Promise.resolve();

    window.hide(); // something else hid the bar while the dialog was open
    resolveDialog({ response: 0 });
    await confirming;

    expect(escapeHandler()).toBeUndefined(); // nothing to arm Escape for anymore
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

  it("sends the bytes and resolves when the renderer reports back", async () => {
    const win = makeWindow();
    const shell = new WindowsShell(win as never);
    const wav = new Uint8Array([1, 2, 3]);

    const playing = shell.play(wav);
    const sent = win.sent.find((message) => message.channel === "speech:play");
    expect(sent?.args[0]).toBe(wav);

    ipcMain.emit("speech:ended", {}, undefined);
    await expect(playing).resolves.toBeUndefined();
  });

  it("resolves even when the renderer never answers", async () => {
    // The queue upstream drains by awaiting this. A play() that stayed pending after a
    // crashed or destroyed renderer would strand every utterance behind it forever.
    vi.useFakeTimers();
    try {
      const shell = new WindowsShell(makeWindow() as never);
      const playing = shell.play(new Uint8Array([1]));

      await vi.advanceTimersByTimeAsync(20_000);
      await expect(playing).resolves.toBeUndefined();
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
