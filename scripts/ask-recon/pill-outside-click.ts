// M27, fix B: the SHIPPED outside-press path in real windows — the app's real PillController,
// PillWindow over the built pill page, and the real WindowsPointerWatcher (a PowerShell host
// polling GetAsyncKeyState) — driven by real clicks. scripts/pill-outside-click-recon.cjs measured
// the design on a prototype; this checks what was built from it.
//
//   node scripts/ask-recon/run.mjs pill-outside-click [png dir]
//   (BUILD_DIR=<dir> to use a build somewhere other than out/, e.g. while `npm run dev` runs)
//
// !! IT MOVES THE REAL MOUSE POINTER AND CLICKS, about ten times, for about 30 seconds, and
// !! presses F24 once (bound to nothing in this app). Every click lands on the pill this script
// !! shows at the bottom right, or on a plain "target" window it draws at the top left (which takes
// !! focus when clicked, as any window would). It opens one message box and closes it itself. Do
// !! not touch the mouse or keyboard while it runs; the pointer is put back at the end.
//
// Each line says what was expected; the last line is PASS or FAIL over all of them.
import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobManager } from "../../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../../src/core/jobs/JobStore.ts";
import { PILL_COLLAPSED } from "../../src/core/jobs/pill.ts";
import { InMemorySettings } from "../../src/core/settings.ts";
import { PillController } from "../../src/main/pill/PillController.ts";
import { PillWindow } from "../../src/main/pill/PillWindow.ts";
import { WindowsPointerWatcher } from "../../src/main/shell/WindowsPointerWatcher.ts";

const args = process.argv.slice(2);
const repo = args[args.length - 1] ?? process.cwd();
const pngDir = args.length > 1 && args[0] !== undefined ? resolve(args[0]) : null;
const buildDir = process.env["BUILD_DIR"] ?? join(repo, "out");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => console.log(`[recon] ${line}`);

// A real left click at (X, Y) or just a move, or F24 (VK 0x87) with -Key. PowerShell is not
// DPI-aware, so these are DIP (measured by scripts/pill-click-recon.cjs on this machine).
const INPUT = String.raw`
param([int]$X, [int]$Y, [int]$Click, [int]$Key)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
if ($Key -eq 1) { [M]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [M]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero); exit }
if ($Click -eq 2) { $p = New-Object M+POINT; [void][M]::GetCursorPos([ref]$p); Write-Output "$($p.X) $($p.Y)"; exit }
[void][M]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 150
if ($Click -eq 1) {
  [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100
}
`;
const scratch = mkdtempSync(join(tmpdir(), "va-pilloutside-"));
writeFileSync(join(scratch, "input.ps1"), INPUT);
const input = (x: number, y: number, click: 0 | 1 | 2, key = 0): string =>
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "input.ps1"), String(Math.round(x)), String(Math.round(y)), String(click), String(key)],
    { encoding: "utf8" },
  ).trim();

void app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const startAt = input(0, 0, 2).split(" ").map(Number);
  const manager = new JobManager({ store: new InMemoryJobStore() });
  const lines: { at: number; line: string }[] = [];

  // main.ts's own construction of the pill, over the built page and preload.
  const pill = new PillWindow<BrowserWindow>({
    create: (options) =>
      new BrowserWindow({
        ...options,
        ...PILL_COLLAPSED,
        webPreferences: { preload: join(buildDir, "preload/pill.js"), contextIsolation: true, nodeIntegration: false },
      }),
    load: (win) => win.loadFile(join(buildDir, "renderer/pill.html")),
    workArea: () => screen.getPrimaryDisplay().workArea,
  });
  const watcher = new WindowsPointerWatcher();
  // Wired exactly as main.ts wires it.
  const controller = new PillController({
    manager,
    settings: new InMemorySettings(),
    surface: pill,
    playChime: () => undefined,
    isBusy: () => false,
    log: (line) => {
      lines.push({ at: Date.now(), line });
      console.log(`[main] ${line}`);
    },
    outsidePresses: watcher,
    pillBounds: () => {
      const win = pill.window();
      return win !== null && win.isVisible() ? win.getBounds() : null;
    },
  });
  const fromPill = (event: Electron.IpcMainEvent): boolean => event.sender === pill.window()?.webContents;
  ipcMain.on("pill:action", (event, id: unknown, action: unknown) => { if (fromPill(event)) controller.onAction(id, action); });
  ipcMain.on("pill:dismiss-all", (event) => { if (fromPill(event)) controller.onDismissAll(); });
  ipcMain.on("pill:expand", (event, expanded: unknown) => { if (fromPill(event)) controller.onExpand(expanded); });
  ipcMain.on("pill:mute", (event, muted: unknown) => { if (fromPill(event)) controller.onMute(muted); });
  ipcMain.on("pill:hover", (event, inside: unknown) => { if (fromPill(event)) controller.onHover(inside); });
  ipcMain.on("pill:height", (event, height: unknown) => { if (fromPill(event)) controller.onContentHeight(height); });
  ipcMain.on("pill:label-widths", (event, labels: unknown, widths: unknown) => { if (fromPill(event)) controller.onLabelWidths(labels, widths); });
  const timer = setInterval(() => controller.tick(), 1_000);

  const target = new BrowserWindow({ width: 420, height: 300, x: workArea.x + 120, y: workArea.y + 120, title: "outside-click target" });
  await target.loadURL("data:text/html,<body style='margin:0;background:#2b2b30;color:#eee;font:16px Segoe UI;padding:20px'>Outside-click target (recon)</body>");
  target.show();

  const win = (): BrowserWindow => {
    const w = pill.window();
    if (w === null) throw new Error("no pill window");
    return w;
  };
  const centreOf = async (selector: string): Promise<{ x: number; y: number }> => {
    const r = await win().webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    ) as { x: number; y: number };
    const b = win().getBounds();
    return { x: b.x + r.x, y: b.y + r.y };
  };
  const tb = target.getBounds();
  const targetCentre = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
  const open = (): boolean => controller.view().expanded;
  let ok = true;
  const expect = (what: string, actual: boolean, wanted: boolean): void => {
    if (actual !== wanted) ok = false;
    log(`${actual === wanted ? "ok  " : "BAD "} ${what}: ${String(actual)} (expected ${String(wanted)})`);
  };

  // Two finished background jobs: the pill appears, and the watcher is prepared now.
  for (const text of ["summarize these notes", "what's on today"]) {
    const id = manager.submit(text);
    manager.detachAttached();
    manager.finish(id, "done", "A result.");
  }
  const preparedAt = Date.now();
  await sleep(3_000);
  expect("watcher prepared when the pill appeared, before any click", lines.some((l) => l.line.includes("cannot be watched")), false);

  // 1. A real click opens it; that click must not close it.
  const summary = await centreOf(".summary");
  input(summary.x, summary.y, 1);
  await sleep(700);
  expect("1. a real click on the pill opens the list (and does not count as outside)", open(), true);
  expect("   watching began", lines.some((l) => l.line.includes("watching for presses outside the pill")), true);
  if (pngDir !== null) writeFileSync(join(pngDir, "outside-1-open.png"), (await win().webContents.capturePage()).toPNG());

  // 2. A click inside the list, on its heading: inside.
  const heading = await centreOf(".heading");
  input(heading.x, heading.y, 1);
  await sleep(500);
  expect("2. a click inside the list (its heading) leaves it open", open(), true);

  // 3. Not mouse presses: F24, a window hiding and re-showing, a message box.
  input(0, 0, 0, 1);
  await sleep(400);
  expect("3. F24 leaves it open", open(), true);
  target.hide();
  await sleep(300);
  target.showInactive();
  await sleep(400);
  expect("   a window hiding and re-showing leaves it open", open(), true);
  const abort = new AbortController();
  const box = dialog.showMessageBox(target, { message: "Recon: this closes itself.", buttons: ["OK"], signal: abort.signal });
  await sleep(700);
  abort.abort();
  await box.catch(() => undefined);
  await sleep(400);
  expect("   a message box opening and closing leaves it open", open(), true);

  // 4. A real click on another window: closes it, and watching stops.
  const before = lines.length;
  const clickAt = Date.now();
  input(targetCentre.x, targetCentre.y, 1);
  await sleep(600);
  expect("4. a real click on another window closes the list", open(), false);
  const closed = lines.slice(before).find((l) => l.line.includes("list CLOSED: a press outside the pill"));
  log(`     closed ${closed === undefined ? "-" : `${closed.at - clickAt} ms after the click command was issued (it includes ~150 ms of pointer settle and PowerShell start-up)`}`);
  expect("   watching stopped", lines.slice(before).some((l) => l.line.includes("stopped watching for presses outside the pill")), true);

  // 5. Closed: a click elsewhere changes nothing, and nothing is watched.
  const quiet = lines.length;
  input(targetCentre.x + 40, targetCentre.y, 1);
  await sleep(500);
  expect("5. a click with the list closed logs nothing and opens nothing", lines.length === quiet && !open(), true);

  // 6. Reopen, and the outside click works a second time.
  const summary2 = await centreOf(".summary");
  input(summary2.x, summary2.y, 1);
  await sleep(700);
  expect("6. reopened by a real click", open(), true);
  input(targetCentre.x - 40, targetCentre.y, 1);
  await sleep(600);
  expect("   a second outside click closes it again", open(), false);

  log(`${ok ? "PASS" : "FAIL"} (watcher prepared ${String(preparedAt)}; ${lines.length} pill log lines)`);
  input(startAt[0] ?? 0, startAt[1] ?? 0, 0);
  clearInterval(timer);
  watcher.dispose();
  pill.dispose();
  rmSync(scratch, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});
