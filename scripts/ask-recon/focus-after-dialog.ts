// After a background job's confirm dialog closes, does the keyboard go back to the bar — and
// ONLY when the bar had it?
//
//   npm run build
//   node scripts/ask-recon/run.mjs focus-after-dialog [png dir]
//
// !! IT SHOWS THE COMMAND BAR AND THE STATUS PILL, MOVES THE REAL MOUSE POINTER AND CLICKS,
// !! AND PRESSES KEYS: Left, Enter and Escape — sent ONLY while this script's own dialog is the
// !! foreground window — and the letter "x", sent only while this script's own bar is. It also
// !! opens and closes one small window of its own titled "focus-recon other app". About 40 s.
// !! Do not use the mouse or keyboard while it runs. No API calls; nothing is sent anywhere.
//
// WHY THIS EXISTS. Live finding after M23: typing an instruction, clicking the pill's
// "Review…", answering the dialog — and the next keystroke went nowhere. Measured with this
// script before the fix: when the dialog closes, Windows gives the foreground to the dialog's
// OWNER, the status pill, which is built never to take focus; the bar never got the keyboard
// back. The text and caret were untouched. tests/WindowsShell.capture.test.ts pins the shell's
// decision on a fake window; whether Windows then really puts the keyboard in the box, and
// whether a real key press lands after the text, only real windows can say.
//
// Three cases:
//   A  bar open and focused, half-typed  -> Review… -> approve -> the bar has the keyboard,
//      the box is focused, the caret is at the end, and a real "x" lands after the text
//   B  the same, answered with Escape    -> the same
//   C  another app in front              -> Review… -> approve -> the bar does NOT take focus
//
// WHAT IT CANNOT SHOW: a human's own click and key timing; a second monitor; what an IME does.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobManager } from "../../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../../src/core/jobs/JobStore.ts";
import { PILL_COLLAPSED } from "../../src/core/jobs/pill.ts";
import { InMemorySettings } from "../../src/core/settings.ts";
import { PillController } from "../../src/main/pill/PillController.ts";
import { PillWindow } from "../../src/main/pill/PillWindow.ts";
import { WindowsShell } from "../../src/main/shell/WindowsShell.ts";

const args = process.argv.slice(2);
const repo = args[args.length - 1] ?? process.cwd();
const pngDir = args.length > 1 && args[0] !== undefined ? resolve(args[0]) : null;
const buildDir = process.env["BUILD_DIR"] ?? join(repo, "out");
const OTHER_APP_TITLE = "focus-recon other app";

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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
function Fg {
  $h = [W]::GetForegroundWindow(); $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  $c = New-Object System.Text.StringBuilder 64; [void][W]::GetClassName($h, $c, 64)
  $t = New-Object System.Text.StringBuilder 128; [void][W]::GetWindowText($h, $t, 128)
  $who = if ($p -eq $ProcId) { "ours" } else { "other" }
  return "$who|$($c.ToString())|$($t.ToString())"
}
function Key([byte]$vk) { [W]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [W]::keybd_event($vk, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
if ($Op -eq "fg") { Fg }
if ($Op -eq "click") {
  [void][W]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 150
  [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 150
}
if ($Op -eq "move") { [void][W]::SetCursorPos($X, $Y) }
# Keys go ONLY to a window of this process that is already in front, and of the expected kind.
if ($Op -eq "dialog-approve" -or $Op -eq "dialog-escape") {
  $f = Fg; if (-not $f.StartsWith("ours|#32770|")) { "refused: foreground is $f"; exit }
  if ($Op -eq "dialog-approve") { Key 0x25; Key 0x0D } else { Key 0x1B }
  "sent"
}
if ($Op -eq "type-x") {
  $f = Fg; if (-not ($f.StartsWith("ours|Chrome_WidgetWin_1|Voice-Action Agent"))) { "refused: foreground is $f"; exit }
  Key 0x58
  "sent"
}
`;
// A window of its own, standing in for "another app", that this script opens and closes.
const OTHER_APP = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '${OTHER_APP_TITLE}'; $f.Width = 420; $f.Height = 160; $f.StartPosition = 'Manual'; $f.Left = 40; $f.Top = 40; $f.TopMost = $false; [void]$f.ShowDialog()`;

const scratch = mkdtempSync(join(tmpdir(), "va-focusrecon-"));
writeFileSync(join(scratch, "w.ps1"), PS);
const ps = (op: string, x = 0, y = 0): string =>
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "w.ps1"), op, String(Math.round(x)), String(Math.round(y)), String(process.pid)], { encoding: "utf8" }).trim();

void app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  // The real command bar, with main.ts's options, page and preload.
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

  const barState = async (): Promise<{ hasFocus: boolean; active: string; value: string; caret: [number, number] }> =>
    JSON.parse(String(await bar.webContents.executeJavaScript(`(() => { const b = document.querySelector('.command-input');
      return JSON.stringify({ hasFocus: document.hasFocus(), active: document.activeElement === b ? 'textarea' : (document.activeElement?.tagName ?? 'none'),
        value: b.value, caret: [b.selectionStart, b.selectionEnd] }); })()`))) as { hasFocus: boolean; active: string; value: string; caret: [number, number] };
  const centre = async (selector: string): Promise<{ x: number; y: number }> => {
    // Waits for it: the pill draws on its own tick, and the panel re-renders when it opens.
    for (let tries = 0; tries < 25; tries += 1) {
      const w = pill.window();
      if (w !== null && w.isVisible()) {
        const r = (await w.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e === null) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)) as { x: number; y: number } | null;
        if (r !== null) {
          const b = w.getBounds();
          return { x: b.x + r.x, y: b.y + r.y };
        }
      }
      await sleep(200);
    }
    throw new Error(`the pill never showed ${selector} (window ${pill.window() === null ? "missing" : `visible=${String(pill.window()?.isVisible())}`}; mode=${controller.view().mode})`);
  };
  const shot = async (name: string): Promise<void> => {
    if (pngDir !== null) writeFileSync(join(pngDir, `${name}.png`), (await bar.webContents.capturePage()).toPNG());
  };

  // A background job, paused at a confirm. Resumed by the pill's Review…, it asks the REAL
  // shell for the detached dialog, as the planner does. The answer comes back WRAPPED: an async
  // function returning a bare promise would be flattened by `await`, and the caller would wait
  // for an answer to a dialog nobody has opened yet.
  const waitingJob = async (): Promise<{ answered: Promise<string> }> => {
    const id = manager.submit("send these notes to fun channel");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    manager.detachAttached();
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    const answered = gate.beforeConfirm().then(async (permit) => {
      if (permit.answer !== "go") return "not resumed";
      manager.takeConfirmPermit(id);
      try {
        return (await shell.confirm("Send to #fun?", { detached: true })) ? "approved" : "cancelled";
      } catch (e) {
        return `threw: ${String(e)}`;
      } finally {
        gate.leaveStep();
        manager.finish(id, "done", null);
      }
    });
    return { answered };
  };

  // Click the pill open, wait for it to settle, then click Review… — re-reading the button's
  // position after the panel has been measured and resized, so the click lands on it.
  const review = async (): Promise<boolean> => {
    const s = await centre(".summary");
    ps("click", s.x, s.y);
    await sleep(1_500);
    actions.length = 0;
    const r = await centre(".action-review");
    ps("click", r.x, r.y);
    await sleep(1_500);
    return actions.includes("review");
  };

  const caseFocused = async (label: string, answer: "dialog-approve" | "dialog-escape"): Promise<void> => {
    log(`${label}`);
    const { answered } = await waitingJob();
    await sleep(600);
    const capture = shell.showInput();
    await sleep(600);
    await bar.webContents.insertText("remind me to call");
    await sleep(300);
    const before = await barState();
    check("the bar is in front and the box has the text", ps("fg").startsWith("ours|Chrome_WidgetWin_1|Voice-Action Agent") && before.active === "textarea", JSON.stringify(before));
    check("the click on Review… reached the pill as 'review'", await review(), actions.join(","));
    check("the dialog is in front", ps("fg").startsWith("ours|#32770|"), ps("fg"));
    log(`   answering: ${ps(answer)}`);
    log(`   dialog: ${await answered}`);
    await sleep(900);
    const after = await barState();
    const fg = ps("fg");
    check("THE BAR IS THE FOREGROUND WINDOW again", fg.startsWith("ours|Chrome_WidgetWin_1|Voice-Action Agent"), fg);
    check("the bar window reports focus", bar.isFocused());
    check("the box is the focused element", after.hasFocus && after.active === "textarea", JSON.stringify(after));
    check("the text is unchanged", after.value === "remind me to call", JSON.stringify(after.value));
    check("the caret is at the end, nothing selected", after.caret[0] === 17 && after.caret[1] === 17, JSON.stringify(after.caret));
    check("the pill never reports focus", pill.window()?.isFocused() !== true);
    log(`   real keypress: ${ps("type-x")}`);
    await sleep(500);
    const typed = await barState();
    check("a REAL 'x' keypress landed after the text", typed.value === "remind me to callx", JSON.stringify(typed.value));
    await shot(`focus-${answer}`);
    // Close the capture the way Escape would, so the next case starts clean.
    ipcMain.emit("commandbar:close", {});
    await capture;
    await sleep(800);
  };

  await caseFocused("A. bar focused, half-typed -> Review… -> APPROVE", "dialog-approve");
  await caseFocused("B. bar focused, half-typed -> Review… -> ESCAPE", "dialog-escape");

  // C. Another app in front.
  log("C. another app in front -> Review… -> approve");
  const { answered } = await waitingJob();
  await sleep(600);
  const other = spawn("powershell.exe", ["-NoProfile", "-Command", OTHER_APP], { stdio: "ignore" });
  await sleep(2_500);
  const fgBefore = ps("fg");
  check("the other app is in front", fgBefore.startsWith("other|") && fgBefore.endsWith(OTHER_APP_TITLE), fgBefore);
  check("the click on Review… reached the pill as 'review'", await review(), actions.join(","));
  log(`   answering: ${ps("dialog-approve")}`);
  log(`   dialog: ${await answered}`);
  await sleep(900);
  const fgAfter = ps("fg");
  check("THE BAR DID NOT TAKE FOCUS", !fgAfter.startsWith("ours|Chrome_WidgetWin_1|Voice-Action Agent") && !bar.isFocused(), fgAfter);
  check("the bar was not opened", !bar.isVisible());
  log(`   (where Windows left the foreground: ${fgAfter})`);
  other.kill();

  clearInterval(pillTimer);
  ps("move", workArea.x + 200, workArea.y + 200);
  rmSync(scratch, { recursive: true, force: true });
  log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
