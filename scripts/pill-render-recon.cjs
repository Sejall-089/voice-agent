// M23: the REAL status pill page, in a real window — what it draws, and whether a real click
// on a real row button reaches main as the request it should be.
//
//   npm run build
//   npx electron scripts/pill-render-recon.cjs [build dir, default "out"] [png dir]
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT SHOWS A SMALL WINDOW AT THE BOTTOM RIGHT, MOVES THE REAL MOUSE POINTER AND CLICKS in it,
// three times, for about ten seconds, and puts the pointer back. Do not touch the mouse while
// it runs. Nothing is approved, sent or opened: main is a recorder here.
//
// WHY THIS EXISTS. src/renderer/pill/render.test.ts draws the pill into jsdom and clicks its
// buttons there; tests/pill.test.ts asserts the window's options on a fake. Neither can say
// what the BUILT page looks like in a frameless transparent window, whether its preload bridge
// is the one the page expects, or whether a physical click on "Review…" in a window that
// cannot take focus arrives at main as `pill:action(<job id>, "review")`. CLAUDE.md: anything
// that ends in a window, a key press or a click needs a script against the real thing.
//
// It uses the built output (the real pill.html, the real bundled script, the real pill.js
// preload) and PillWindow's options, copied below — keep them in step with
// src/main/pill/PillWindow.ts.
//
// With a png dir it also saves a screenshot of each state for a person to look at.

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const buildDir = resolve(process.argv[2] ?? "out");
const pngDir = process.argv[3] ? resolve(process.argv[3]) : null;

// src/main/pill/PillWindow.ts — PILL_WINDOW_OPTIONS, verbatim.
const PILL_WINDOW_OPTIONS = {
  show: false,
  frame: false,
  transparent: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,
  skipTaskbar: true,
  hasShadow: false,
  alwaysOnTop: true,
};

const CLICK = String.raw`
param([int]$X, [int]$Y)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
$was = New-Object M+POINT; [void][M]::GetCursorPos([ref]$was)
[void][M]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 150
[M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
[M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 200
[void][M]::SetCursorPos($was.X, $was.Y)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(join(tmpdir(), "va-pillrender-"));
writeFileSync(join(scratch, "click.ps1"), CLICK);
// PowerShell is not DPI-aware, so its cursor coordinates are DIP (measured by
// scripts/pill-click-recon.cjs on this machine).
const clickAt = (x, y) =>
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "click.ps1"), String(Math.round(x)), String(Math.round(y))], { encoding: "utf8" });

const EXPANDED = {
  mode: "needs-you",
  label: "1 needs you",
  pulse: false,
  expanded: true,
  muted: false,
  notice: null,
  items: [
    { id: "job-review", title: "post the summary to #bugs", state: "needs-you", detail: "Needs your OK — Step 2 of 2 · sendMessage", actions: ["review", "cancel"] },
    { id: "job-failed", title: "file this bug in Linear", state: "failed", detail: "Linear said no.", actions: ["dismiss"] },
    { id: "job-running", title: "summarize these notes", state: "running", detail: "Running — summarize", actions: ["cancel"] },
  ],
};

app.whenReady().then(async () => {
  const preload = join(buildDir, "preload", "pill.js");
  const page = join(buildDir, "renderer", "pill.html");
  if (!existsSync(preload) || !existsSync(page)) {
    console.log(`[recon] no build at ${buildDir} (need preload/pill.js and renderer/pill.html) - run npm run build`);
    app.exit(1);
    return;
  }

  const received = [];
  ipcMain.on("pill:action", (_e, id, action) => received.push(`action(${id}, ${action})`));
  ipcMain.on("pill:expand", (_e, expanded) => received.push(`expand(${expanded})`));
  ipcMain.on("pill:mute", (_e, muted) => received.push(`mute(${muted})`));

  const { workArea } = screen.getPrimaryDisplay();
  const place = (win, width, height) =>
    win.setBounds({ x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16, width, height });

  const win = new BrowserWindow({
    ...PILL_WINDOW_OPTIONS,
    width: 232,
    height: 44,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  win.setContentProtection(true);
  await win.loadFile(page);

  const dom = (js) => win.webContents.executeJavaScript(js);
  const shot = async (name) => {
    if (pngDir === null) return;
    const image = await win.webContents.capturePage();
    writeFileSync(join(pngDir, `${name}.png`), image.toPNG());
  };
  const centreOf = async (selector) => {
    const rect = await dom(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const bounds = win.getBounds();
    return { x: bounds.x + rect.x, y: bounds.y + rect.y };
  };

  // --- Expanded ---
  place(win, 348, 348);
  win.webContents.send("pill:view", EXPANDED);
  win.showInactive();
  await sleep(700);

  console.log(`[recon] window.pill is the bridge the page got: ${await dom("Object.keys(window.pill).sort().join(',')")}`);
  console.log(`[recon] window.api (the BAR's bridge) is absent from this window: ${await dom("typeof window.api === 'undefined'")}`);
  console.log(`[recon] rows drawn:      ${JSON.stringify(await dom("[...document.querySelectorAll('.row .title')].map(n => n.textContent)"))}`);
  console.log(`[recon] buttons drawn:   ${JSON.stringify(await dom("[...document.querySelectorAll('button')].map(n => n.textContent)"))}`);
  console.log(`[recon] root classes:    ${await dom("document.getElementById('pill').className")}`);
  console.log(`[recon] overflowing horizontally: ${await dom("document.documentElement.scrollWidth > document.documentElement.clientWidth")}`);
  await shot("pill-expanded");

  const review = await centreOf(".action-review");
  clickAt(review.x, review.y);
  await sleep(300);
  console.log(`[recon] real click on "Review…"  ->  main received: ${JSON.stringify(received)}  pillFocused=${win.isFocused()}`);

  received.length = 0;
  const mute = await centreOf(".mute");
  clickAt(mute.x, mute.y);
  await sleep(300);
  console.log(`[recon] real click on the mute button  ->  ${JSON.stringify(received)}`);

  // --- Collapsed, pulsing ---
  received.length = 0;
  place(win, 232, 44);
  win.webContents.send("pill:view", { ...EXPANDED, expanded: false, pulse: true });
  await sleep(500);
  console.log(`[recon] collapsed label: ${JSON.stringify(await dom("document.querySelector('.summary .label').textContent"))}  list present: ${await dom("document.querySelector('.list') !== null")}`);
  console.log(`[recon] pulse animation running: ${await dom("getComputedStyle(document.querySelector('.summary')).animationName")}`);
  await shot("pill-collapsed");
  const summary = await centreOf(".summary");
  clickAt(summary.x, summary.y);
  await sleep(300);
  console.log(`[recon] real click on the pill itself  ->  ${JSON.stringify(received)}  pillFocused=${win.isFocused()}`);

  rmSync(scratch, { recursive: true, force: true });
  app.exit(0);
});
