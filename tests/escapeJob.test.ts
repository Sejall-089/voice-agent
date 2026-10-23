import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// M25 Fix 2 + E5: Escape while an instruction is still running.
//
// Before M25, Escape hid the bar and nothing else: the job went on, popped the bar back up with
// its answer, spoke it, and opened a dangerous confirm on someone who had just said never mind.
// And a voice instruction Escaped during transcription was submitted anyway. Now Escape CANCELS a
// job that has not entered a step yet (silently), DETACHES one that has (to the pill, silent, with
// its Cancel), and a transcript that finishes after Escape is thrown away.
//
// Real: JobManager, JobRunner, Planner, WindowsShell (electron mocked) with its REAL global Escape,
// the instruction hotkey handler, VoiceSession — and the Escape hook wired as main.ts wires it.
// Fake: a model that answers after 3 s (async, like the real one), whisper (1 s), the recorder,
// the speaker, the dialog.

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
  let release: (value: string) => void = () => undefined;
  const tools: Tool[] = [
    { name: "summarize", description: "Summarize.", inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe", background: "ok", planPhrase: "run a test step", handler: () => (ran.push("summarize"), Promise.resolve("Three points.")) },
    { name: "longTask", description: "A long task.", inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe", background: "ok", planPhrase: "run a test step",
      handler: () => (ran.push("longTask"), new Promise<string>((r) => (release = r))) },
    { name: "createIssue", description: "Create an issue.", inputSchema: { type: "object", properties: {}, required: [] },
      risk: "dangerous", background: "ok", planPhrase: "run a test step", confirmLabel: "Create issue",
      confirmSummary: () => 'Create issue "Crash on resume"?',
      handler: () => (ran.push("createIssue"), Promise.resolve("Created LIN-42.")) },
  ];
  const choice: Record<string, string> = { "summarize this": "summarize", "do the long task": "longTask", "file the bug": "createIssue" };
  const llm = {
    async chooseTool(instruction: string) {
      await new Promise((r) => setTimeout(r, 3000));
      return { kind: "tool", name: choice[instruction], input: {} };
    },
    complete: () => Promise.resolve(""),
  };

  // What the user can see and hear, recorded with whether it happened after Escape.
  let escaped = false;
  const seen: { afterEscape: boolean; what: string }[] = [];
  const see = (what: string): void => void seen.push({ afterEscape: escaped, what });
  const win = Object.assign(new EventEmitter(), {
    visible: false,
    focused: false,
    webContents: Object.assign(new EventEmitter(), {
      send(channel: string, ...args: unknown[]): void {
        if (channel === "voice:start") setTimeout(() => ipcMain.emit("voice:started", {}, null, undefined), 1);
        if (channel === "voice:stop") setTimeout(() => ipcMain.emit("voice:audio", {}, { wav: new Uint8Array(96_000), durationMs: 3000 }, undefined), 1);
        if (channel === "commandbar:echo") see(`result: ${String(args[0])}`);
      },
      getURL: () => "http://localhost/index.html",
      setWindowOpenHandler: () => undefined,
    }),
    show(): void { win.visible = true; win.focused = true; win.emit("show"); },
    showInactive(): void { if (!win.visible) see("bar re-shown"); win.visible = true; win.emit("show"); },
    hide(): void { win.visible = false; win.focused = false; win.emit("hide"); },
    focus(): void { win.focused = true; },
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isDestroyed: () => false,
  });
  const shell = new WindowsShell(win as unknown as Electron.BrowserWindow);
  shell.attachSpeech({ speak: (t: string) => see(`said: ${t}`), stop: () => undefined, isSpeaking: () => false });

  let seq = 0;
  const manager = new JobManager({
    store: new InMemoryJobStore(), now: () => Date.now(), newId: () => `job${(seq += 1)}`,
    foregroundFree: () => shell.isForegroundFree(),
  });
  shell.attachEscapeJob(() => void manager.escapeAttached()); // main.ts, M25
  const run = createJobRunner({
    manager, shell, log: new InMemoryActionLog(), speech: new InMemorySpeechStore(),
    capture: () => captureContext(shell, { hasOpenEmail: () => Promise.resolve(false) }),
    buildPlanner: (parts) =>
      new Planner(llm as never, parts.shell, tools, new NoopMemoryResolver() as never, parts.log,
        undefined, undefined, undefined, undefined, undefined, parts.speech, undefined, undefined, undefined,
        () => Promise.resolve(), parts.chain, undefined, parts.gate, manager),
  });
  let submitted = 0;
  const voice = new VoiceSession(shell, {
    transcribe: () => new Promise<string>((r) => setTimeout(() => r("summarize this"), 1000)),
  });
  shell.onDismissed(() => void voice.abandon()); // main.ts
  const onHotkey = createOnInstructionHotkey({
    shell, dictation: null, voice, speech: { speak: () => undefined, stop: () => undefined },
    chain: { isRunning: () => manager.attachedBlocks() },
    detach: createStartingSomethingElse({ jobs: manager, pill: () => null }),
    // Counted only when there is something to run: the hotkey hands "" on for "nothing was said",
    // and the job runner ignores it without creating a job.
    runInstruction: (text) => (text.trim().length > 0 && (submitted += 1), run(text)),
  });

  return {
    manager, ran, seen, logs,
    get submitted() { return submitted; },
    release: (value: string) => release(value),
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    type: async (text: string) => {
      onHotkey();
      await vi.advanceTimersByTimeAsync(5);
      ipcMain.emit("commandbar:submit", {}, text);
    },
    speakAndEnter: async () => {
      onHotkey();
      await vi.advanceTimersByTimeAsync(1500);
      ipcMain.emit("commandbar:submit", {}, ""); // Enter with nothing typed = run what was said
    },
    escape: () => {
      escaped = true;
      const handler = shortcuts.get("Escape");
      if (!handler) throw new Error("Escape is not registered");
      handler();
    },
    after: () => seen.filter((s) => s.afterEscape).map((s) => s.what),
  };
}

describe("Escape while the instruction is still being planned", () => {
  it("cancels it: nothing runs, the bar does not come back, nothing is said, nothing in the pill", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(1000); // the model is thinking
    w.escape();
    await w.advance(5000);

    expect(w.ran).toEqual([]);
    expect(w.after()).toEqual([]);
    const job = w.manager.get("job1");
    expect(job).toMatchObject({ state: "cancelled", attached: false, background: false });
    // What it would have said went to its own record, where nobody is shown it.
    expect(job?.lines).toEqual(["Cancelled before it started. Nothing was run."]);
  });

  it("a dangerous action never reaches its dialog", async () => {
    const w = world();
    await w.type("file the bug");
    await w.advance(1000);
    w.escape();
    await w.advance(5000);

    expect(dialogShow).not.toHaveBeenCalled();
    expect(w.ran).toEqual([]);
    expect(w.manager.get("job1")?.state).toBe("cancelled");
  });
});

describe("Escape after the instruction has started a step", () => {
  it("detaches it: it carries on silently in the pill, with the trigger in the log", async () => {
    const w = world();
    await w.type("do the long task");
    await w.advance(3500); // planned, admitted, and inside its handler
    expect(w.ran).toEqual(["longTask"]);

    w.escape();
    await w.advance(10);
    expect(w.manager.get("job1")).toMatchObject({ state: "running", attached: false, background: true });
    expect(w.logs.some((line) => /job job1 detached by escape \("do the long task", running, step 1\/1\)/.test(line))).toBe(true);

    w.release("Long task done.");
    await w.advance(100);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", result: "Long task done." });
    // Not cut short, and not shown or said in front of the user either.
    expect(w.after()).toEqual([]);
  });
});

describe("Escape during transcription (E5)", () => {
  it("throws the transcript away: no instruction is run at all", async () => {
    const w = world();
    await w.speakAndEnter(); // whisper takes 1 s from here
    await w.advance(500);
    w.escape();
    await w.advance(6000);

    expect(w.manager.get("job1")).toBeNull();
    expect(w.submitted).toBe(0);
    expect(w.ran).toEqual([]);
    expect(w.after()).toEqual([]);
  });

  it("control: without Escape the same voice instruction runs", async () => {
    const w = world();
    await w.speakAndEnter();
    await w.advance(6000);

    expect(w.ran).toEqual(["summarize"]);
  });
});

describe("Escape with nothing running", () => {
  it("changes no job", async () => {
    const w = world();
    await w.type("summarize this");
    await w.advance(6000); // done
    expect(w.manager.escapeAttached()).toBe("none");
    expect(w.manager.get("job1")?.state).toBe("done");
  });
});
