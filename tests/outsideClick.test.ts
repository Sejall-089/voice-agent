import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// M25 addendum A: an outside click on a bar whose job is still working detaches that job — it
// moves to the pill, runs silent, keeps its Cancel. Nothing else that blurs the bar may do that.
//
// The fake window behaves as scripts/blur-recon.cjs MEASURED a real one (Electron 33, Windows):
//   - the app's own hide() of a focused window: `blur` arrives AFTER hide() returns, with
//     isVisible() already false;
//   - another window taking focus: `blur` with isVisible() still true;
//   - a message box opened on the window: `blur` with isVisible() still TRUE — so only the
//     confirm-pending guard keeps a dialog from looking like an outside click.
//
// Real: JobManager, JobRunner, Planner, WindowsShell (electron mocked) with its real Escape and
// blur handling, the instruction hotkey, VoiceSession; the two hooks wired as main.ts wires them.

const { ipcMain, shortcuts, dialogShow } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter(), shortcuts: new Map<string, () => void>(), dialogShow: vi.fn() };
});
vi.mock("electron", () => ({
  ipcMain,
  BrowserWindow: class {},
  globalShortcut: {
    register: (combo: string, handler: () => void) => (shortcuts.set(combo, handler), true),
    unregister: (combo: string) => void shortcuts.delete(combo),
    unregisterAll: () => shortcuts.clear(),
  },
  clipboard: { readText: () => "copied notes", writeText: () => undefined },
  dialog: { showMessageBox: dialogShow },
  shell: { openExternal: () => Promise.resolve() },
}));

const { WindowsShell } = await import("../src/main/shell/WindowsShell.ts");
const { VoiceSession } = await import("../src/main/shell/VoiceSession.ts");
const { createOnInstructionHotkey } = await import("../src/main/instructionHotkey.ts");
const { createStartingSomethingElse } = await import("../src/main/jobs/startingSomethingElse.ts");
const { createJobRunner } = await import("../src/main/jobs/JobRunner.ts");
const { JobManager } = await import("../src/core/jobs/JobManager.ts");
const { InMemoryJobStore } = await import("../src/core/jobs/JobStore.ts");
const { InMemorySpeechStore } = await import("../src/core/speechStore.ts");
const { InMemoryActionLog } = await import("../src/core/actionLog.ts");
const { NoopMemoryResolver } = await import("../src/core/memory/NoopMemoryResolver.ts");
const { captureContext, Planner } = await import("../src/core/planner.ts");
import type { Tool } from "../src/core/types.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  ipcMain.removeAllListeners();
  shortcuts.clear();
  dialogShow.mockReset();
});

function world() {
  vi.useFakeTimers();
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  dialogShow.mockImplementation(() => new Promise(() => undefined)); // a dialog nobody answers

  const ran: string[] = [];
  const tools: Tool[] = [
    { name: "summarize", description: "Summarize.", inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe", background: "ok", planPhrase: "run a test step", handler: () => (ran.push("summarize"), Promise.resolve("Three points.")) },
    { name: "createIssue", description: "Create an issue.", inputSchema: { type: "object", properties: {}, required: [] },
      risk: "dangerous", background: "ok", planPhrase: "run a test step", confirmLabel: "Create issue",
      confirmSummary: () => 'Create issue "Crash on resume"?',
      handler: () => (ran.push("createIssue"), Promise.resolve("Created LIN-42.")) },
  ];
  const choice: Record<string, string> = { "summarize this": "summarize", "file the bug": "createIssue" };
  const llm = {
    async chooseTool(instruction: string) {
      await new Promise((r) => setTimeout(r, 3000));
      return { kind: "tool", name: choice[instruction], input: {} };
    },
    complete: () => Promise.resolve(""),
  };

  let clicked = false;
  const seen: { afterClick: boolean; what: string }[] = [];
  const see = (what: string): void => void seen.push({ afterClick: clicked, what });
  const win = Object.assign(new EventEmitter(), {
    visible: false,
    focused: false,
    webContents: Object.assign(new EventEmitter(), {
      send(channel: string, ...args: unknown[]): void {
        if (channel === "voice:start") setTimeout(() => ipcMain.emit("voice:started", {}, null, undefined), 1);
        if (channel === "commandbar:echo") see(`result: ${String(args[0])}`);
      },
      getURL: () => "http://localhost/index.html",
      setWindowOpenHandler: () => undefined,
    }),
    show(): void { win.visible = true; win.focused = true; win.emit("show"); },
    showInactive(): void { if (!win.visible) see("bar re-shown"); win.visible = true; win.emit("show"); },
    hide(): void {
      const hadFocus = win.focused;
      win.visible = false;
      win.focused = false;
      win.emit("hide");
      // Measured: the blur comes after hide() returns, with the window already invisible.
      if (hadFocus) setTimeout(() => win.emit("blur"), 0);
    },
    focus(): void { win.focused = true; },
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isDestroyed: () => false,
  });
  const shell = new WindowsShell(win as unknown as Electron.BrowserWindow);
  win.on("blur", () => shell.handleBlur()); // main.ts:253
  const speechCalls: string[] = [];
  shell.attachSpeech({ speak: (t: string) => see(`said: ${t}`), stop: () => void speechCalls.push("stop"), isSpeaking: () => true });

  let seq = 0;
  const manager = new JobManager({
    store: new InMemoryJobStore(), now: () => Date.now(), newId: () => `job${(seq += 1)}`,
    foregroundFree: () => shell.isForegroundFree(),
  });
  // main.ts, M25 — the focus-left hook is wrapped only to COUNT its calls.
  let focusLeftCalls = 0;
  shell.attachEscapeJob(() => void manager.escapeAttached());
  shell.attachFocusLeft(() => {
    focusLeftCalls += 1;
    manager.detachAttached("outside-click");
  });
  const run = createJobRunner({
    manager, shell, log: new InMemoryActionLog(), speech: new InMemorySpeechStore(),
    capture: () => captureContext(shell, { hasOpenEmail: () => Promise.resolve(false) }),
    buildPlanner: (parts) =>
      new Planner(llm as never, parts.shell, tools, new NoopMemoryResolver() as never, parts.log,
        undefined, undefined, undefined, undefined, undefined, parts.speech, undefined, undefined, undefined,
        () => Promise.resolve(), parts.chain, undefined, parts.gate, manager),
  });
  const voice = new VoiceSession(shell, { transcribe: () => Promise.resolve("summarize this") });
  shell.onDismissed(() => void voice.abandon());
  shell.onTypingStarted(() => void voice.abandon()); // main.ts:603 — typing cancels the recording
  const onHotkey = createOnInstructionHotkey({
    shell, dictation: null, voice, speech: { speak: () => undefined, stop: () => undefined },
    chain: { isRunning: () => manager.attachedBlocks() },
    detach: createStartingSomethingElse({ jobs: manager, pill: () => null }),
    runInstruction: run,
  });

  return {
    manager, ran, logs, win, speechCalls,
    get focusLeftCalls() { return focusLeftCalls; },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    // As the real bar does it: the first keystroke tells main the user is typing (which cancels
    // the recording the hotkey started), then Enter submits.
    type: async (text: string) => {
      onHotkey();
      await vi.advanceTimersByTimeAsync(5);
      ipcMain.emit("commandbar:typing", {});
      await vi.advanceTimersByTimeAsync(5);
      ipcMain.emit("commandbar:submit", {}, text);
    },
    hotkeyOnly: async () => {
      onHotkey();
      await vi.advanceTimersByTimeAsync(5);
    },
    // Focus goes to another window: the bar is still on screen when it blurs (measured).
    clickElsewhere: () => {
      clicked = true;
      win.focused = false;
      win.emit("blur");
    },
    escape: () => shortcuts.get("Escape")?.(),
    afterClick: () => seen.filter((s) => s.afterClick).map((s) => s.what),
  };
}

const detachedBy = (logs: string[], trigger: string): boolean =>
  logs.some((line) => line.includes(` detached by ${trigger} (`));

describe("an outside click on the bar", () => {
  it("while the job is thinking: detaches it — to the pill, silent, with its Cancel — and hides the bar", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(1000); // thinking
    w.clickElsewhere();
    await w.advance(5000);

    expect(detachedBy(w.logs, "outside-click")).toBe(true);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", attached: false, background: true, result: "Three points." });
    expect(w.ran).toEqual(["summarize"]);
    expect(w.win.visible).toBe(false);
    // Silent: its answer was neither shown in the bar nor said.
    expect(w.afterClick()).toEqual([]);
  });

  it("does not stop speech that is playing", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(1000);
    const before = w.speechCalls.length;
    w.clickElsewhere();
    await w.advance(10);

    expect(w.speechCalls.length).toBe(before);
  });

  it("with a finished result on screen: only hides the bar", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(5000); // answered, done, result showing
    w.win.focused = true; // the user is looking at it
    w.clickElsewhere();
    await w.advance(10);

    expect(w.focusLeftCalls).toBe(1); // the hook ran — and found nothing working
    expect(detachedBy(w.logs, "outside-click")).toBe(false);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", attached: true, background: false });
    expect(w.win.visible).toBe(false);
  });

  it("while recording: nothing — the bar stays pinned and nothing is detached", async () => {
    const w = world();
    await w.hotkeyOnly(); // the bar opens and the microphone starts
    await w.advance(50);
    w.clickElsewhere();
    await w.advance(10);

    expect(w.focusLeftCalls).toBe(0);
    expect(w.win.visible).toBe(true);
  });

  it("while typing (a capture is open, no job yet): only hides the bar", async () => {
    const w = world();
    await w.hotkeyOnly();
    ipcMain.emit("commandbar:typing", {}); // typing cancels the recording
    await w.advance(10);
    w.clickElsewhere();
    await w.advance(10);

    expect(w.focusLeftCalls).toBe(0);
    expect(w.win.visible).toBe(false);
    expect(w.manager.get("job1")).toBeNull();
  });
});

describe("blurs that are not an outside click", () => {
  it("Escape while thinking cancels — and its own hide's blur never reaches the outside-click hook", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(1000);
    w.escape();
    await w.advance(5000); // the hide's blur has arrived by now

    expect(w.focusLeftCalls).toBe(0);
    expect(detachedBy(w.logs, "outside-click")).toBe(false);
    expect(w.manager.get("job1")).toMatchObject({ state: "cancelled", background: false });
    expect(w.ran).toEqual([]);
  });

  it("a confirm dialog opening on a visible bar does not detach its job", async () => {
    const w = world();
    await w.type("file the bug");
    await w.advance(3500); // the model has answered; the confirm is up
    expect(dialogShow).toHaveBeenCalledTimes(1);
    // Measured: a message box on a visible window blurs it while it is still visible.
    w.win.visible = true;
    w.win.emit("blur");
    await w.advance(10);

    expect(w.focusLeftCalls).toBe(0);
    expect(w.manager.get("job1")).toMatchObject({ attached: true, background: false });
    expect(w.ran).toEqual([]); // still waiting for the answer
  });
});
