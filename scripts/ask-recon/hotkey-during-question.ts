// Recon: press the instruction hotkey while a question is open — on a REAL window.
//
//   node scripts/ask-recon/run.mjs hotkey-during-question typed
//   node scripts/ask-recon/run.mjs hotkey-during-question dictated
//
// !! SENDS REAL KEYSTROKES (Ctrl+Alt+Shift+F9, three times) AND FLASHES A WINDOW for about ten
// !! seconds. See run.mjs. Do not type while it runs. It makes no API calls.
//
// WHY THIS EXISTS. `shell.askUser` puts a question in the command bar, and the instruction hotkey
// is supposed to give that question focus back rather than open a competing capture over it.
// tests/WindowsShell.capture.test.ts pins that against a fake window. Reported live (M21): "I
// pressed the hotkey while the question was open and a fresh, empty bar replaced it." Whether a
// real BrowserWindow, the real renderer and a key press arriving through the OS behave like the
// fake is exactly what a fake cannot say — so this is the whole hotkey path as main.ts wires
// it: the real handler, a real VoiceSession, createRunInstruction, and a stand-in planner whose
// run asks one question the way a chain's pre-flight does.
//
// The microphone is Chromium's FAKE device (--use-fake-device-for-media-stream): nothing is
// recorded from the real one. The context is not read at all — there is no real planner here.
//
// WHAT IT CHECKS, from the rendered DOM and the shell's own state after the second press:
//
//   - the question is still pending and still on screen
//   - the half-typed answer ("#bu") is still in the box
//   - no capture was opened (`commandbar:show` never sent) and nothing was run
//
// Measured 2026-10-10, both modes: all three hold. The guard was not the bug — see
// dismissed-then-again.ts for what was.
import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { WindowsShell } from "../../src/main/shell/WindowsShell.ts";
import { VoiceSession } from "../../src/main/shell/VoiceSession.ts";
import { createOnInstructionHotkey } from "../../src/main/instructionHotkey.ts";
import { createRunInstruction } from "../../src/main/runInstruction.ts";

const [MODE, REPO] = process.argv.slice(-2) as [string, string];
const COMBO = "Control+Alt+Shift+F9";
const QUESTION = "Before I start: which channel do you mean by 'the bugs channel'?";

const t0 = Date.now();
const log = (line: string): void => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${line}`);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

// A window that will not go away is the worst thing this script can leave behind.
setTimeout(() => {
  console.log("\nRESULT  watchdog: gave up and exited");
  app.exit(3);
}, 45_000);

void app.whenReady().then(async () => {
  if (MODE !== "typed" && MODE !== "dictated") {
    console.error("usage: node scripts/ask-recon/run.mjs hotkey-during-question <typed|dictated>");
    app.exit(2);
    return;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    x: Math.round(workArea.x + (workArea.width - 640) / 2),
    y: Math.round(workArea.y + (workArea.height - 640) / 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(REPO, "out/preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  session.defaultSession.setPermissionRequestHandler((_c, permission, callback) => callback(permission === "media"));

  // Everything main sends and the renderer sends back, in order, with timestamps.
  const sent: string[] = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel: string, ...args: unknown[]): void => {
    sent.push(channel);
    if (channel !== "speech:stop") log(`main -> renderer: ${channel} ${JSON.stringify(args).slice(0, 70)}`);
    realSend(channel, ...args);
  };
  for (const event of ["show", "hide", "blur", "focus"] as const) {
    win.on(event as "show", () => log(`window event: ${event}`));
  }
  for (const channel of ["commandbar:submit", "commandbar:close", "commandbar:typing"]) {
    ipcMain.on(channel, (_e, ...args: unknown[]) => log(`renderer -> main: ${channel} ${JSON.stringify(args)}`));
  }

  const shell = new WindowsShell(win);
  win.on("blur", () => shell.handleBlur());

  const voice = new VoiceSession(shell, {
    transcribe: async () => {
      await wait(400);
      return "File this email as a bug on GitHub and post it in the bugs channel.";
    },
  });
  shell.onTypingStarted(() => void voice.abandon());
  shell.onDismissed(() => void voice.abandon());
  // As main.ts does with POINTING_ENABLED=1: an async read of the foreground before the bar.
  shell.attachTargetSnapshot(() => wait(15));

  let runs = 0;
  let answer: string | null | undefined;
  const planner = {
    run: async (instruction: string) => {
      runs += 1;
      log(`RUN ${runs}: ${JSON.stringify(instruction)}`);
      await wait(1200); // "the model thinking"
      answer = await shell.askUser(QUESTION);
      log(`askUser resolved: ${JSON.stringify(answer)}`);
      return { status: "refused" as const, tool: null, result: null };
    },
  };
  const onHotkey = createOnInstructionHotkey({
    shell,
    dictation: null,
    voice,
    speech: null,
    chain: null,
    runInstruction: createRunInstruction(planner, shell),
  });
  log(`registered ${COMBO}: ${shell.registerHotkey(COMBO, () => (log("GLOBAL HOTKEY FIRED"), onHotkey()))}`);

  await win.loadFile(join(REPO, "out/renderer/index.html"));
  await wait(300);

  const pressCombo = (): void => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%+{F9}')",
    ]);
  };
  const enter = (): void => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  };
  const onScreen = async (): Promise<{ question: string | null; input: string | null }> =>
    JSON.parse(
      (await win.webContents.executeJavaScript(
        `JSON.stringify({ question: document.querySelector('.command-question')?.textContent ?? null,
           input: document.querySelector('.command-input')?.value ?? null })`,
      )) as string,
    ) as { question: string | null; input: string | null };

  log(`=== mode: ${MODE} ===`);
  log("--- press 1: open the bar ---");
  pressCombo();
  await wait(2200);
  if (MODE === "typed") {
    await win.webContents.insertText("file this and tell the bugs channel");
    await wait(300);
  }
  enter();
  await wait(2800);

  const before = await onScreen();
  log(`question up: pending=${shell.isAskPending()} rendered=${JSON.stringify(before.question)}`);
  await win.webContents.insertText("#bu");
  await wait(300);

  const showsBefore = sent.filter((channel) => channel === "commandbar:show").length;
  const runsBefore = runs;
  log("--- press 2: while the question is open ---");
  pressCombo();
  await wait(2200);

  const after = await onScreen();
  const checks: [string, boolean][] = [
    ["the question is still pending", shell.isAskPending()],
    ["the question is still rendered", after.question === QUESTION],
    ["the half-typed answer is still in the box", after.input === "#bu"],
    ["no capture was opened", sent.filter((c) => c === "commandbar:show").length === showsBefore && !shell.isInputCapturing()],
    ["nothing new was run", runs === runsBefore],
    ["the question was not answered or dismissed", answer === undefined],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  console.log(`\nRESULT  ${checks.every(([, ok]) => ok) ? "the press refocused the question" : "THE PRESS DISTURBED THE QUESTION"}`);
  // Exiting closes the window with the question still open; the stand-in run then tries to
  // clear "Thinking…" on a window that is gone. Expected here, and not worth a stack trace.
  process.on("unhandledRejection", () => undefined);
  app.exit(checks.every(([, ok]) => ok) ? 0 : 1);
});
