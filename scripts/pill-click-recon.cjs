// M23 reconnaissance: can a window that never takes focus be CLICKED, and does a native
// dialog opened from that click come to the front without disturbing the instruction bar?
//
//   npx electron scripts/pill-click-recon.cjs
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT MOVES THE REAL MOUSE POINTER AND CLICKS, four times, on a small window it draws at the
// bottom right of the screen, and flashes three dialogs. About twenty seconds. The pointer is
// put back afterwards. Do not touch the mouse while it runs. Every dialog is closed with an
// AbortSignal: nothing is answered.
//
// WHY THIS EXISTS. The status pill is `focusable: false` and shown with `showInactive()` so it
// can never take the keyboard from whatever the user is typing into. The whole design then
// rests on three things only Windows can answer, and a fake BrowserWindow answers none of them:
//
//   1. Does a real click on a non-activating window reach its page at all?
//   2. Does that click take focus or the foreground anyway?
//   3. A detached job's confirm must NOT be parented to the bar and must not hide it (the bar
//      may be mid-capture). So what does the dialog hang off, and is it on top, topmost and
//      in the foreground when opened from a pill click — with the bar hidden, and with the bar
//      on screen (the arrangement M19 measured an UNPARENTED dialog as fully covered in)?
//
// For each arrangement it reports, from Windows itself (WindowFromPoint / GetForegroundWindow):
// how many of nine points across the dialog are the dialog, whether it is topmost, whether it
// is the foreground window, and how many `hide` and `blur` events the bar received.
//
// What it measured on 2026-10-13 (this machine, Electron 33): see the M23 entry in spec.md §9.

const { app, BrowserWindow, dialog, screen } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const WIN32 = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class Z {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
`;

// Where is the dialog, and who is in front?
const PROBE = String.raw`
param([int]$ProcId)
${WIN32}
$dlg = [IntPtr]::Zero
$cb = [Z+EnumProc]{ param($h, $l)
  $p = 0; [void][Z]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId -and [Z]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 64; [void][Z]::GetClassName($h, $sb, 64)
    if ($sb.ToString() -eq "#32770") { $script:dlg = $h }
  }
  return $true }
[void][Z]::EnumWindows($cb, [IntPtr]::Zero)
$fg = [Z]::GetForegroundWindow(); $fgPid = 0; [void][Z]::GetWindowThreadProcessId($fg, [ref]$fgPid)
if ($dlg -eq [IntPtr]::Zero) { "dialog NOT FOUND  foregroundIsOurs=$($fgPid -eq $ProcId)"; exit }
$r = New-Object Z+RECT; [void][Z]::GetWindowRect($dlg, [ref]$r)
$topmost = ([Z]::GetWindowLong($dlg, -20) -band 8) -ne 0
$hits = 0; $n = 0
foreach ($fx in 0.2, 0.5, 0.8) { foreach ($fy in 0.2, 0.5, 0.85) {
  $pt = New-Object Z+POINT; $pt.X = [int]($r.L + ($r.R - $r.L) * $fx); $pt.Y = [int]($r.T + ($r.B - $r.T) * $fy)
  $n++; if ([Z]::GetAncestor([Z]::WindowFromPoint($pt), 2) -eq $dlg) { $hits++ } } }
"dialog on top at $hits/$n  topmost=$topmost  dialogIsForeground=$($fg -eq $dlg)  foregroundIsOurs=$($fgPid -eq $ProcId)"
`;

// Is the foreground window ours? (Asked before any click, as the baseline.)
const FOREGROUND = String.raw`
param([int]$ProcId)
${WIN32}
$fg = [Z]::GetForegroundWindow(); $p = 0; [void][Z]::GetWindowThreadProcessId($fg, [ref]$p)
"foregroundIsOurs=$($p -eq $ProcId)"
`;

// One real left click at (X, Y), then the pointer goes back where it was.
const CLICK = String.raw`
param([int]$X, [int]$Y)
${WIN32}
$was = New-Object Z+POINT; [void][Z]::GetCursorPos([ref]$was)
[void][Z]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 120
[Z]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
[Z]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 150
[void][Z]::SetCursorPos($was.X, $was.Y)
"clicked $X,$Y"
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), "va-pill-"));
const scripts = { probe: PROBE, foreground: FOREGROUND, click: CLICK };
for (const [name, body] of Object.entries(scripts)) writeFileSync(join(scratch, `${name}.ps1`), body);

function ps(name, args) {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, `${name}.ps1`), ...args.map(String)],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    return `${name} failed: ${String(error.stderr || error.message).slice(0, 300)}`;
  }
}

const OPTIONS = {
  type: "question",
  buttons: ["Send", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "Confirm action",
  message: "Send to #social?\n\nNew bug filed: Created ENG-9: Login broken",
};

app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();

  // main.ts's command bar, where it matters to z-order.
  const bar = new BrowserWindow({
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
  });
  await bar.loadURL(
    "data:text/html,<body style='background:rgba(30,30,30,.92);color:white;font:16px sans-serif'>the instruction bar</body>",
  );
  const barEvents = { hide: 0, blur: 0 };
  bar.on("hide", () => (barEvents.hide += 1));
  bar.on("blur", () => (barEvents.blur += 1));

  // The pill as M23 intends to build it.
  const size = { width: 220, height: 44 };
  const pill = new BrowserWindow({
    ...size,
    x: workArea.x + workArea.width - size.width - 16,
    y: workArea.y + workArea.height - size.height - 16,
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  pill.setContentProtection(true);
  await pill.loadURL(
    "data:text/html,<body style='margin:0'><button id='b' style='width:100%25;height:44px;border-radius:22px;border:0;background:%23d98a00;color:white;font:14px sans-serif'>1 needs you</button><script>let n=0;document.getElementById('b').onclick=()=>{n+=1;document.title='clicked:'+n}</script></body>",
  );
  pill.showInactive();
  await sleep(600);

  const clicks = () => Number((pill.getTitle().split(":")[1] ?? "0"));
  const bounds = pill.getBounds();
  const centreDip = { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) };
  const centrePx = screen.dipToScreenPoint(centreDip);

  console.log(`[recon] before any click: ${ps("foreground", [process.pid])}  pillFocused=${pill.isFocused()}`);

  // PowerShell is not DPI-aware, so which coordinate space its SetCursorPos takes is itself a
  // measurement: try DIP, and only if the click did not arrive, physical pixels.
  let space = "DIP";
  let at = centreDip;
  ps("click", [at.x, at.y]);
  await sleep(400);
  if (clicks() === 0) {
    space = "physical px";
    at = centrePx;
    ps("click", [at.x, at.y]);
    await sleep(400);
  }
  console.log(
    `[recon] 1. click reached the pill's page: ${clicks() > 0} (cursor space that worked: ${space}; ` +
      `DIP ${centreDip.x},${centreDip.y} / px ${Math.round(centrePx.x)},${Math.round(centrePx.y)})`,
  );
  console.log(
    `[recon] 2. after the click: pillFocused=${pill.isFocused()}  ${ps("foreground", [process.pid])}  ` +
      `bar hide=${barEvents.hide} blur=${barEvents.blur}`,
  );

  async function arrangement(label, { barShown, parent }) {
    if (barShown) bar.showInactive();
    else bar.hide();
    await sleep(500);
    barEvents.hide = 0;
    barEvents.blur = 0;
    const before = clicks();
    const controller = new AbortController();
    let state = "still pending";
    let opened = null;
    // The dialog is opened BY the click, as it will be in the app: the page's title change is
    // the stand-in for the pill's IPC message.
    const onTitle = (_event, title) => {
      // The new title is the event argument; `getTitle()` still returns the old one here.
      if (opened !== null || Number(String(title).split(":")[1] ?? "0") === before) return;
      const options = { ...OPTIONS, signal: controller.signal };
      opened = parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options);
      opened.then(
        (value) => (state = `ANSWERED response=${value.response}`),
        () => (state = "rejected"),
      );
    };
    pill.on("page-title-updated", onTitle);
    ps("click", [at.x, at.y]);
    await sleep(1500);
    pill.removeListener("page-title-updated", onTitle);
    console.log(
      `[recon] ${label}\n          ${opened === null ? "THE CLICK DID NOT OPEN A DIALOG" : ps("probe", [process.pid])}  ` +
        `confirm=${state}  pillFocused=${pill.isFocused()}  bar visible=${bar.isVisible()} hide=${barEvents.hide} blur=${barEvents.blur}`,
    );
    controller.abort();
    if (opened !== null) await opened.catch(() => undefined);
    await sleep(400);
  }

  await arrangement("3a. dialog PARENTED TO THE PILL, bar hidden", { barShown: false, parent: pill });
  await arrangement("3b. dialog PARENTED TO THE PILL, bar on screen (shown inactive)", { barShown: true, parent: pill });
  await arrangement("3c. dialog UNPARENTED, bar on screen (M19 measured this covered)", { barShown: true, parent: null });

  rmSync(scratch, { recursive: true, force: true });
  app.exit(0);
});
