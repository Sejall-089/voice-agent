// M19 live fix — reconnaissance: is the native confirm dialog covered by the instruction bar?
//
//   npx electron scripts/confirm-zorder-recon.cjs
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// WHY THIS EXISTS. The first live three-step chain showed "Step 3 of 3: Send to #social?" with
// its text and both buttons hidden behind the bar. Every test was green, and had to be: which
// of two windows is in front is not something the shell DECIDES and can log, it is something
// Windows does with real windows. tests/WindowsShell.capture.test.ts now pins what the shell
// does about it (hides the bar, parents the dialog); THIS is what says those two decisions
// produce a dialog a person can read. CLAUDE.md: a log line proves what the app decided, not
// what the user saw.
//
// It builds a window with main.ts's exact options (640x640, frameless, transparent,
// alwaysOnTop) and opens a dialog with WindowsShell.confirm()'s exact options, in each
// arrangement below. For each it asks Windows what is actually at nine points across the
// dialog's rectangle (WindowFromPoint) — "9/9" means the dialog is the top window at every one.
//
// IT CLICKS NOTHING AND ANSWERS NOTHING: every dialog is closed with an AbortSignal. Expect
// several dialogs to flash up over about fifteen seconds.
//
// ONE THING IT CANNOT SHOW, by construction: whether the dialog takes KEYBOARD focus. Launched
// from a terminal this process does not own the foreground, so Windows will not hand it focus
// whatever the code does. That is docs/M19-live-checklist.md's job, with a person's hands.
//
// What it measured on 2026-10-09 (1920x1080 at 150%):
//
//   bar shown inactive, dialog UNPARENTED   (the bug: a chain's step 3)     0/9  covered
//   bar shown inactive, dialog parented                                     9/9
//   bar hidden,         dialog parented     (the fix)                       9/9
//   parented; bar HIDDEN while the dialog is up                             9/9  still pending
//   parented; bar RE-SHOWN while the dialog is up                           9/9  still pending
//   bar hidden, dialog parented, 20,000-character message                   9/9  capped to screen
//
// Parenting is the load-bearing half: an owned window is kept above its owner whatever the
// owner does, and an owned window of a topmost window is itself topmost — so no other
// application can cover the dialog either. Hiding the bar is tidiness on top of that.

const { app, BrowserWindow, dialog, screen } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Asks Windows about THIS process's windows: finds the dialog (class #32770) and the bar, and
// reports which window is on top at nine points across the dialog.
const PROBE = String.raw`
param([int]$ProcId)
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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$dlg = [IntPtr]::Zero; $bar = [IntPtr]::Zero
$cb = [Z+EnumProc]{ param($h, $l)
  $p = 0; [void][Z]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId -and [Z]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 64; [void][Z]::GetClassName($h, $sb, 64)
    if ($sb.ToString() -eq "#32770") { $script:dlg = $h } elseif ($sb.ToString() -eq "Chrome_WidgetWin_1") { $script:bar = $h }
  }
  return $true }
[void][Z]::EnumWindows($cb, [IntPtr]::Zero)
if ($dlg -eq [IntPtr]::Zero) { "dialog NOT FOUND  barVisible=$($bar -ne [IntPtr]::Zero)"; exit }
$r = New-Object Z+RECT; [void][Z]::GetWindowRect($dlg, [ref]$r)
$topmost = ([Z]::GetWindowLong($dlg, -20) -band 8) -ne 0
$hits = 0; $n = 0
foreach ($fx in 0.2, 0.5, 0.8) { foreach ($fy in 0.2, 0.5, 0.85) {
  $pt = New-Object Z+POINT; $pt.X = [int]($r.L + ($r.R - $r.L) * $fx); $pt.Y = [int]($r.T + ($r.B - $r.T) * $fy)
  $n++; if ([Z]::GetAncestor([Z]::WindowFromPoint($pt), 2) -eq $dlg) { $hits++ } } }
"dialog on top at $hits/$n points  topmost=$topmost  barVisible=$($bar -ne [IntPtr]::Zero)  dialogHeight=$($r.B - $r.T)"
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(join(tmpdir(), "va-zorder-"));
const probePath = join(scratch, "probe.ps1");
writeFileSync(probePath, PROBE);

function probe() {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probePath, "-ProcId", String(process.pid)],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    return `probe failed: ${String(error.stderr || error.message).slice(0, 300)}`;
  }
}

// WindowsShell.confirm()'s options, verbatim.
const OPTIONS = {
  type: "question",
  buttons: ["Send", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "Confirm action",
};
const SHORT =
  "Step 3 of 3: Send to #social?\n\nNew bug filed: Created ENG-9: Login broken\nhttps://linear.app/acme/issue/ENG-9";
const LONG = `Step 2 of 3: Create this Linear issue in Engineering?\n\n${"A line of the bug report that goes on for a while. ".repeat(400)}`;

app.whenReady().then(async () => {
  // main.ts's createCommandBar(), verbatim where it matters to z-order.
  const { workArea } = screen.getPrimaryDisplay();
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

  async function arrangement(label, { before, parented, during, message = SHORT, settle = 1500 }) {
    await before();
    await sleep(400);
    const controller = new AbortController();
    let state = "still pending";
    const options = { ...OPTIONS, message, signal: controller.signal };
    const shown = parented ? dialog.showMessageBox(bar, options) : dialog.showMessageBox(options);
    shown.then(
      (value) => (state = `ANSWERED response=${value.response}`),
      () => (state = "rejected"),
    );
    await sleep(settle);
    if (during) {
      await during();
      await sleep(900);
    }
    console.log(`[recon] ${label}\n          ${probe()}  confirm=${state}`);
    controller.abort();
    await shown.catch(() => undefined);
    bar.hide();
    await sleep(400);
  }

  await arrangement("THE BUG   bar shown inactive (as after a chain's step result), dialog unparented", {
    before: () => bar.showInactive(),
    parented: false,
  });
  await arrangement("          bar shown inactive, dialog parented to the bar", {
    before: () => bar.showInactive(),
    parented: true,
  });
  await arrangement("THE FIX   bar hidden, dialog parented to the bar", {
    before: () => bar.hide(),
    parented: true,
  });
  await arrangement("          parented; the bar is HIDDEN while the dialog is up", {
    before: () => bar.showInactive(),
    parented: true,
    during: () => bar.hide(),
  });
  await arrangement("          parented; the bar is RE-SHOWN while the dialog is up", {
    before: () => bar.hide(),
    parented: true,
    during: () => bar.showInactive(),
  });
  await arrangement("THE FIX   bar hidden, dialog parented, 20,000-character message", {
    before: () => bar.hide(),
    parented: true,
    message: LONG,
    settle: 5000,
  });

  rmSync(scratch, { recursive: true, force: true });
  app.exit(0);
});
