// "There's a confirmation waiting" — is it still in the bar after the dialog has gone?
//
//   npm run build
//   node scripts/ask-recon/run.mjs confirm-waiting-line [png dir]
//
// !! IT SHOWS THE COMMAND BAR AND THE STATUS PILL, MOVES THE REAL MOUSE POINTER AND CLICKS, AND
// !! PRESSES KEYS: Ctrl+Alt+Shift+F9 (a combo registered only by this script), and Enter —
// !! sent ONLY while this script's own dialog is the foreground window. About 25 s. Do not use
// !! the mouse or keyboard while it runs. No API calls; nothing is sent anywhere.
//
// WHY THIS EXISTS (live finding after M23). The user's exact sequence: give an instruction;
// press the hotkey (it detached the job and opened the bar); type into the bar; click the
// pill's Review…; with that dialog up, press the hotkey again — blocked, and the bar says
// "There's a confirmation waiting — answer it on screen."; cancel the dialog. The bar still
// said a confirmation was waiting, with nothing waiting. The line was written by the hotkey
// guard and nothing ever took it down: a status line goes only when a result, a reset or a
// new opening of the bar replaces it, and closing a dialog or submitting in the same bar is
// none of those. The decision is pinned by tests/WindowsShell.capture.test.ts; what the
// renderer then DRAWS is what only a real window can show — so this reads the bar's DOM.
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobManager } from "../../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../../src/core/jobs/JobStore.ts";
import { PILL_COLLAPSED } from "../../src/core/jobs/pill.ts";
import { InMemorySettings } from "../../src/core/settings.ts";
import { CONFIRM_WAITING, createOnInstructionHotkey } from "../../src/main/instructionHotkey.ts";
import { PillController } from "../../src/main/pill/PillController.ts";
import { PillWindow } from "../../src/main/pill/PillWindow.ts";
import { WindowsShell } from "../../src/main/shell/WindowsShell.ts";

const args = process.argv.slice(2);
const repo = args[args.length - 1] ?? process.cwd();
const pngDir = args.length > 1 && args[0] !== undefined ? resolve(args[0]) : null;
const buildDir = process.env["BUILD_DIR"] ?? join(repo, "out");
const COMBO = "Control+Alt+Shift+F9";

const t0 = Date.now();
const log = (line: string): void => console.log(`[recon +${String(Date.now() - t0).padStart(5)}ms] ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (what: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  log(`   ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

const PS = String.raw`
param([string]$Op, [int]$X, [int]$Y, [int]$ProcId)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
function Fg { $h = [W]::GetForegroundWindow(); $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p); $c = New-Object System.Text.StringBuilder 64; [void][W]::GetClassName($h, $c, 64); $who = if ($p -eq $ProcId) { "ours" } else { "other" }; return "$who|$($c.ToString())" }
function Key([byte]$vk) { [W]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [W]::keybd_event($vk, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
if ($Op -eq "fg") { Fg }
if ($Op -eq "click") { [void][W]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 150; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 150 }
if ($Op -eq "move") { [void][W]::SetCursorPos($X, $Y) }
if ($Op -eq "hotkey") { foreach ($v in 0x11,0x12,0x10,0x78) { [W]::keybd_event([byte]$v,0,0,[UIntPtr]::Zero) }; Start-Sleep -Milliseconds 60; foreach ($v in 0x78,0x10,0x12,0x11) { [W]::keybd_event([byte]$v,0,2,[UIntPtr]::Zero) }; "sent" }
# The dialog's default button is Cancel: Enter, ONLY while this script's own dialog is in front.
if ($Op -eq "dialog-cancel") { $f = Fg; if (-not $f.StartsWith("ours|#32770")) { "refused: foreground is $f"; exit }; Key 0x0D; "sent" }
`;
const scratch = mkdtempSync(join(tmpdir(), "va-confirmline-"));
writeFileSync(join(scratch, "w.ps1"), PS);
const ps = (op: string, x = 0, y = 0): string =>
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "w.ps1"), op, String(Math.round(x)), String(Math.round(y)), String(process.pid)], { encoding: "utf8" }).trim();

void app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const bar = new BrowserWindow({
    width: 640, height: 640,
    x: Math.round(workArea.x + (workArea.width - 640) / 2), y: Math.round(workArea.y + (workArea.height - 640) / 2),
    show: false, frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: join(buildDir, "preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await bar.loadFile(join(buildDir, "renderer/index.html"));
  const shell = new WindowsShell(bar);
  bar.on("blur", () => shell.handleBlur());
  ipcMain.on("commandbar:typing", () => undefined);

  const manager = new JobManager({ store: new InMemoryJobStore(), foregroundFree: () => shell.isForegroundFree() });
  const pill = new PillWindow<BrowserWindow>({
    create: (options) => new BrowserWindow({ ...options, ...PILL_COLLAPSED, webPreferences: { preload: join(buildDir, "preload/pill.js"), contextIsolation: true, nodeIntegration: false } }),
    load: (win) => win.loadFile(join(buildDir, "renderer/pill.html")),
    workArea: () => screen.getPrimaryDisplay().workArea,
  });
  shell.attachDetachedDialogOwner(() => pill.window());
  const controller = new PillController({ manager, settings: new InMemorySettings(), surface: pill, playChime: () => undefined, isBusy: () => false });
  const fromPill = (e: Electron.IpcMainEvent): boolean => e.sender === pill.window()?.webContents;
  const actions: string[] = [];
  ipcMain.on("pill:action", (e, id: unknown, action: unknown) => { actions.push(String(action)); if (fromPill(e)) controller.onAction(id, action); });
  ipcMain.on("pill:expand", (e, v: unknown) => { if (fromPill(e)) controller.onExpand(v); });
  ipcMain.on("pill:hover", (e, v: unknown) => { if (fromPill(e)) controller.onHover(v); });
  ipcMain.on("pill:height", (e, v: unknown) => { if (fromPill(e)) controller.onContentHeight(v); });
  ipcMain.on("pill:mute", () => undefined);
  const pillTimer = setInterval(() => controller.tick(), 1_000);

  // The real instruction hotkey handler, wired as main.ts wires it, minus the microphone.
  const submitted: string[] = [];
  const onHotkey = createOnInstructionHotkey({
    shell, dictation: null, voice: null, speech: null, chain: null,
    detach: () => void manager.detachAttached(),
    runInstruction: (text) => { submitted.push(text); return Promise.resolve(); },
  });
  if (!globalShortcut.register(COMBO, onHotkey)) { log(`could not register ${COMBO}`); app.exit(2); return; }

  const barState = async (): Promise<{ value: string; status: string | null; thinking: boolean }> =>
    JSON.parse(String(await bar.webContents.executeJavaScript(`JSON.stringify({ value: document.querySelector('.command-input').value,
      status: document.querySelector('.command-status')?.textContent ?? null, thinking: !!document.querySelector('.voice-indicator.thinking') })`))) as { value: string; status: string | null; thinking: boolean };
  const centre = async (selector: string): Promise<{ x: number; y: number }> => {
    for (let tries = 0; tries < 25; tries += 1) {
      const w = pill.window();
      if (w !== null && w.isVisible()) {
        const r = (await w.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e === null) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)) as { x: number; y: number } | null;
        if (r !== null) { const b = w.getBounds(); return { x: b.x + r.x, y: b.y + r.y }; }
      }
      await sleep(200);
    }
    throw new Error(`the pill never showed ${selector}`);
  };

  // 1. An instruction, attached and working: a job that will reach a confirm.
  const id = manager.submit("create a issue in linear and write in notion");
  const gate = manager.gateFor(id);
  await gate.admit({ tools: ["linear__create_issue", "addToPage"], statusOnly: false });
  // 2. The hotkey: it detaches the job and opens the bar.
  log(`hotkey (detach + open the bar): ${ps("hotkey")}`);
  await sleep(1200);
  check("the job was detached", manager.get(id)?.attached === false && manager.get(id)?.background === true);
  check("the bar is open", bar.isVisible());
  // ...and the job reaches its confirm, which waits for the pill.
  await gate.enterStep({ tool: "linear__create_issue", index: 1, total: 2, foregroundOnly: false });
  const answered = gate.beforeConfirm().then(async (permit) => {
    if (permit.answer !== "go") return "not resumed";
    manager.takeConfirmPermit(id);
    try { return (await shell.confirm("Create a Linear issue?", { detached: true })) ? "approved" : "cancelled"; }
    finally { gate.leaveStep(); manager.finish(id, "cancelled", null); }
  });
  // 3. Type into the open bar.
  await bar.webContents.insertText("hello to all channels");
  await sleep(600);
  // 4. Review… in the pill: the detached dialog.
  const s = await centre(".summary"); ps("click", s.x, s.y); await sleep(1500);
  const r = await centre(".action-review"); ps("click", r.x, r.y); await sleep(1500);
  check("Review… reached the pill and the dialog is in front", actions.includes("review") && ps("fg").startsWith("ours|#32770"), `${actions.join(",")} / ${ps("fg")}`);
  // 5. The hotkey again, with the dialog up: blocked, and the bar says so.
  log(`hotkey (blocked): ${ps("hotkey")}`);
  await sleep(1000);
  const during = await barState();
  check("WHILE THE DIALOG IS UP the bar shows the line", during.status === CONFIRM_WAITING, JSON.stringify(during));
  if (pngDir !== null) writeFileSync(join(pngDir, "confirm-line-during.png"), (await bar.webContents.capturePage()).toPNG());
  // 6. Cancel the dialog.
  log(`cancel: ${ps("dialog-cancel")}`);
  log(`dialog: ${await answered}`);
  await sleep(1200);
  const after = await barState();
  check("AFTER THE DIALOG CLOSED the line is gone", after.status === null, JSON.stringify(after.status));
  check("the typed text is still there", after.value === "hello to all channels", JSON.stringify(after.value));
  check("no Thinking… without an instruction running", !after.thinking && submitted.length === 0);
  if (pngDir !== null) writeFileSync(join(pngDir, "confirm-line-after.png"), (await bar.webContents.capturePage()).toPNG());

  globalShortcut.unregisterAll();
  clearInterval(pillTimer);
  ps("move", workArea.x + 200, workArea.y + 200);
  rmSync(scratch, { recursive: true, force: true });
  log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
