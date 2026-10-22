// M27, fix B, FIRST: can a helper that POLLS GetAsyncKeyState and the pointer position see a
// mouse press outside the status pill — reliably, quickly and cheaply — before anything is built
// on it? (Fix B: while the pill's list is open, a press outside the pill closes it. The pill
// cannot take focus (M23), so there is no blur to listen for.)
//
//   npx electron scripts/pill-outside-click-recon.cjs
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// !! IT MOVES THE REAL MOUSE POINTER AND CLICKS, about sixty times, for about a minute, and presses
// !! F24 once. Every click lands on one of the two windows this script draws: a plain "target"
// !! window near the top left (it takes focus when clicked, as any window would) and a pill-like
// !! window at the bottom right. F24 is bound to nothing in this app. It also opens one message
// !! box, which it closes itself. Do not touch the mouse or keyboard while it runs; the pointer is
// !! put back at the end.
//
// WHAT IT MEASURES, each a question only real Windows can answer:
//   1. Helper start-up: spawn -> READY (PowerShell + Add-Type compiling the P/Invoke class).
//   2. Fast clicks: for a poll interval of 100 ms and 50 ms, clicks held 0-120 ms. Is each one
//      seen? By what: the HIGH bit (button down right now, so a click shorter than the interval
//      can fall between two polls) or the LOW bit (pressed since the last call — documented as
//      unreliable when another process also polls)?
//   3. Reaction time: press -> the helper noticing it, and -> node receiving the line.
//   4. Inside or outside: is the pointer the helper reads at the press inside the pill's
//      electron bounds exactly when the click was inside?
//   5. Not a mouse press: an F24 key press, a window hiding itself, a message box opening, the
//      pill hidden and re-shown — none may produce a press.
//   6. Not watching: after STOP, a click produces nothing; on START, a press made BEFORE it is
//      not reported (the low bit is primed and discarded).
//   7. CPU: the helper's own processor time over 8 s watching at 50 ms, at 100 ms, and stopped.
//
// Timing uses QueryPerformanceCounter on every side — Stopwatch.GetTimestamp() in both
// PowerShell helpers and process.hrtime() in node (libuv reads QPC on Windows) — so a press time
// from one process and a detection time from another are on the same clock. The script checks
// that before relying on it.
//
// The helper here is a PROTOTYPE in the style of src/main/shell/WindowsInputInjector.ts (a
// persistent PowerShell run with -File, Add-Type compiled once, one line per message), written to
// be measured. It is not the shipped one: that is src/main/shell/WindowsPointerWatcher.ts, built
// from what this measured (50 ms, both bits, primed, mouse buttons only), and checked in real
// windows by scripts/ask-recon/pill-outside-click.ts. One difference on purpose: the shipped host
// only SAMPLES (both bits as masks, first read marked) and the press rule is judgeSample in
// TypeScript, where tests reach it; this prototype decides in C#. The reads and the interval are
// the same. Keep them in step if either changes, or this stops measuring what ships.
//
// Measured 2026-10-22 (this machine): see spec.md §5c, "The status pill" — 48/48 clicks seen,
// 32 ms median at 50 ms, no measurable CPU, ~1.5 s start-up.

const { app, BrowserWindow, dialog, screen } = require("electron");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

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

const CLOCK = String.raw`
  public static string Ms() {
    return (System.Diagnostics.Stopwatch.GetTimestamp() * 1000.0 / System.Diagnostics.Stopwatch.Frequency)
      .ToString("F2", System.Globalization.CultureInfo.InvariantCulture);
  }`;

// The watcher: a background thread polls every mouse button and, on a press, reads the pointer.
// The PowerShell loop only takes commands, so a press is reported while a command is awaited.
const WATCHER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class PillWatch {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  // Left, right, middle, X1, X2: any outside press counts.
  static readonly int[] Buttons = { 1, 2, 4, 5, 6 };
  static Thread worker;
  static volatile bool running;
  static int interval;
  public static long Polls;
` + CLOCK + String.raw`

  public static void Start(int ms) {
    Stop();
    interval = ms;
    running = true;
    worker = new Thread(Loop);
    worker.IsBackground = true;
    worker.Start();
  }

  public static void Stop() {
    running = false;
    if (worker != null) { worker.Join(); worker = null; }
  }

  static void Loop() {
    bool[] was = new bool[Buttons.Length];
    // PRIME: the first read of each button is discarded, low bit and all, so a press made
    // before watching started (the click that opened the list) is never reported.
    for (int i = 0; i < Buttons.Length; i++) was[i] = (GetAsyncKeyState(Buttons[i]) & 0x8000) != 0;
    while (running) {
      Thread.Sleep(interval);
      Interlocked.Increment(ref Polls);
      for (int i = 0; i < Buttons.Length; i++) {
        short s = GetAsyncKeyState(Buttons[i]);
        bool down = (s & 0x8000) != 0;
        bool low = (s & 1) != 0;
        bool edge = down && !was[i];
        if (edge || low) {
          POINT p;
          GetCursorPos(out p);
          Console.Out.WriteLine("PRESS " + Buttons[i] + " " + p.X + " " + p.Y + " " + Ms() + " " + (edge ? 1 : 0) + " " + (low ? 1 : 0));
        }
        was[i] = down;
      }
    }
  }
}
'@
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "QUIT") { [PillWatch]::Stop(); break }
  if ($line.StartsWith("WATCH ")) {
    [PillWatch]::Start([int]$line.Substring(6))
    [Console]::Out.WriteLine("WATCHING")
  } elseif ($line -eq "STOP") {
    [PillWatch]::Stop()
    [Console]::Out.WriteLine("STOPPED " + [PillWatch]::Polls)
  } elseif ($line -eq "CPU") {
    $t = [System.Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds
    [Console]::Out.WriteLine("CPU " + [int]$t)
  } elseif ($line -eq "NOW") {
    [Console]::Out.WriteLine("NOW " + [PillWatch]::Ms())
  } else {
    [Console]::Out.WriteLine("ERR")
  }
}
`;

// The clicker: moves the pointer and presses, recording when on the same clock.
const CLICKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class Clicker {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
` + CLOCK + String.raw`

  public static string Click(int x, int y, int holdMs, int button) {
    SetCursorPos(x, y);
    Thread.Sleep(60);
    uint down = button == 2 ? 0x0008u : 0x0002u;
    uint up = button == 2 ? 0x0010u : 0x0004u;
    string t0 = Ms();
    mouse_event(down, 0, 0, 0, UIntPtr.Zero);
    if (holdMs > 0) Thread.Sleep(holdMs);
    mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    return t0 + " " + Ms();
  }

  public static string Key(byte vk) {
    string t0 = Ms();
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
    return t0;
  }

  public static string Where() { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
}
'@
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "QUIT") { break }
  $p = $line.Split(' ')
  if ($p[0] -eq "CLICK") {
    [Console]::Out.WriteLine("CLICKED " + [Clicker]::Click([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4]))
  } elseif ($p[0] -eq "KEY") {
    [Console]::Out.WriteLine("KEYED " + [Clicker]::Key([byte]$p[1]))
  } elseif ($p[0] -eq "MOVE") {
    [void][Clicker]::SetCursorPos([int]$p[1], [int]$p[2])
    [Console]::Out.WriteLine("MOVED")
  } elseif ($p[0] -eq "WHERE") {
    [Console]::Out.WriteLine("WHERE " + [Clicker]::Where())
  } else {
    [Console]::Out.WriteLine("ERR")
  }
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
const scratch = mkdtempSync(join(tmpdir(), "va-pillclick-"));

// A persistent helper. Lines are matched to requests by their first word, because the watcher
// also prints PRESS lines whenever it likes.
function host(name, script) {
  const file = join(scratch, `${name}.ps1`);
  writeFileSync(file, script, "utf8");
  const spawnedAt = hrMs();
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
    stdio: "pipe",
    windowsHide: true,
  });
  const waiting = [];
  const presses = [];
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line.length === 0) continue;
      if (line.startsWith("PRESS ")) {
        const [, vk, x, y, ts, edge, low] = line.split(" ");
        presses.push({ vk: Number(vk), x: Number(x), y: Number(y), ts: Number(ts), edge: edge === "1", low: low === "1", recv: hrMs() });
        continue;
      }
      const index = waiting.findIndex((w) => line.startsWith(w.prefix));
      if (index >= 0) waiting.splice(index, 1)[0].resolve(line);
    }
  });
  const next = (prefix, ms = 15_000) =>
    new Promise((resolve, reject) => {
      const entry = { prefix, resolve };
      waiting.push(entry);
      setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i >= 0) {
          waiting.splice(i, 1);
          reject(new Error(`${name}: no "${prefix}" within ${ms} ms. stderr: ${stderr.slice(0, 400)}`));
        }
      }, ms);
    });
  const ready = next("READY").then(() => hrMs() - spawnedAt);
  const ask = (command, prefix) => {
    const reply = next(prefix);
    child.stdin.write(`${command}\n`);
    return reply;
  };
  return { ready, ask, presses, child };
}

const inside = (p, b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
const pct = (n, d) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
const stats = (xs) => {
  if (xs.length === 0) return "-";
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1);
  return `median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${s[s.length - 1].toFixed(1)} ms (n=${s.length})`;
};

app.whenReady().then(async () => {
  const log = (line) => console.log(`[recon] ${line}`);
  const { workArea } = screen.getPrimaryDisplay();

  // --- The two windows every click lands on ---
  const pill = new BrowserWindow({ ...PILL_WINDOW_OPTIONS, width: 348, height: 300 });
  pill.setBounds({ x: workArea.x + workArea.width - 348 - 16, y: workArea.y + workArea.height - 300 - 16, width: 348, height: 300 });
  await pill.loadURL("data:text/html,<body style='margin:0;background:rgba(24,24,27,.96);color:#eee;font:13px Segoe UI'>pill stand-in</body>");
  await pill.webContents.executeJavaScript("window.downs = 0; addEventListener('mousedown', () => window.downs++); 0");
  pill.showInactive();

  const target = new BrowserWindow({ width: 420, height: 300, x: workArea.x + 120, y: workArea.y + 120, title: "outside-click target" });
  await target.loadURL("data:text/html,<body style='margin:0;background:#2b2b30;color:#eee;font:16px Segoe UI;padding:20px'>Outside-click target (recon)</body>");
  target.show();
  await sleep(500);

  // --- 1. Start-up ---
  const watcher = host("watcher", WATCHER);
  const clicker = host("clicker", CLICKER);
  log(`helper start-up, spawn -> READY: watcher ${(await watcher.ready).toFixed(0)} ms, clicker ${(await clicker.ready).toFixed(0)} ms`);
  const t1 = hrMs();
  const now = Number((await watcher.ask("NOW", "NOW")).split(" ")[1]);
  const t2 = hrMs();
  const offset = now - (t1 + t2) / 2;
  const sameClock = Math.abs(offset) < 50;
  log(`clock check: helper QPC vs node hrtime differ by ${offset.toFixed(2)} ms (round trip ${(t2 - t1).toFixed(1)} ms) -> ${sameClock ? "same clock" : "NOT the same clock; receipt times below are not comparable"}`);
  const startAt = (await clicker.ask("WHERE", "WHERE")).split(" ").slice(1).map(Number);

  const pillBounds = pill.getBounds();
  const targetBounds = target.getBounds();
  const centre = (b) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const click = async (point, hold, button = 1) => {
    const [, down, up] = (await clicker.ask(`CLICK ${point.x} ${point.y} ${hold} ${button}`, "CLICKED")).split(" ").map(Number);
    return { down, up };
  };
  // Presses the watcher reported for one click, by button, from its press until 400 ms after.
  const seenFor = (c, vk) => watcher.presses.filter((p) => p.vk === vk && p.ts >= c.down - 1 && p.ts <= c.up + 400);

  // --- 2-4. Fast clicks, reaction time, inside/outside ---
  const HOLDS = [0, 5, 15, 30, 60, 120];
  const TRIALS = 4;
  for (const interval of [100, 50]) {
    await watcher.ask(`WATCH ${interval}`, "WATCHING");
    await sleep(interval * 2);
    log(`--- watching every ${interval} ms ---`);
    const detect = [];
    const deliver = [];
    let wrongSide = 0;
    let doubles = 0;
    for (const hold of HOLDS) {
      let any = 0, byEdge = 0, byLowOnly = 0, actualHold = 0;
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const at = centre(targetBounds);
        const point = { x: at.x + (trial - 2) * 15, y: at.y + (trial - 2) * 10 };
        const c = await click(point, hold);
        actualHold += c.up - c.down;
        await sleep(interval + 300);
        const seen = seenFor(c, 1);
        if (seen.length > 1) doubles += 1;
        const first = seen[0];
        if (first === undefined) continue;
        any += 1;
        if (seen.some((p) => p.edge)) byEdge += 1;
        else byLowOnly += 1;
        detect.push(first.ts - c.down);
        if (sameClock) deliver.push(first.recv - c.down);
        if (inside(first, pillBounds) || !inside(first, targetBounds)) wrongSide += 1;
      }
      log(`held ${String(hold).padStart(3)} ms (measured ${(actualHold / TRIALS).toFixed(1)}): seen ${any}/${TRIALS}; by the high bit ${byEdge}, by the low bit alone ${byLowOnly}; high bit alone would have caught ${pct(byEdge, TRIALS)}`);
    }
    log(`press -> helper noticed: ${stats(detect)}`);
    if (sameClock) log(`press -> node received the line: ${stats(deliver)}`);
    log(`outside clicks whose reported pointer was NOT in the target (or was in the pill): ${wrongSide}; clicks reported more than once: ${doubles}`);
    // A right click outside counts too.
    const rc = await click(centre(targetBounds), 30, 2);
    await sleep(interval + 300);
    log(`a right click outside: seen ${seenFor(rc, 2).length > 0}`);
    await watcher.ask("STOP", "STOPPED");
  }

  // Inside the pill: reported, and inside its bounds — so the real helper can tell it apart.
  await watcher.ask("WATCH 50", "WATCHING");
  await sleep(100);
  const downsBefore = await pill.webContents.executeJavaScript("window.downs");
  let insideOk = 0;
  for (const [i, hold] of [0, 30, 0, 30].entries()) {
    const at = centre(pillBounds);
    const c = await click({ x: at.x + (i - 2) * 20, y: at.y }, hold);
    await sleep(350);
    const first = seenFor(c, 1)[0];
    if (first !== undefined && inside(first, pillBounds)) insideOk += 1;
  }
  const downs = (await pill.webContents.executeJavaScript("window.downs")) - downsBefore;
  log(`clicks INSIDE the pill: ${insideOk}/4 reported with a pointer inside its electron bounds ${JSON.stringify(pillBounds)}; the pill page itself got ${downs}/4 mousedowns; pill focused afterwards: ${pill.isFocused()}`);

  // --- 5. Not a mouse press ---
  const quietFrom = hrMs() + (sameClock ? offset : 0);
  await clicker.ask("KEY 135", "KEYED"); // F24
  await sleep(300);
  target.hide();
  await sleep(300);
  target.show();
  await sleep(300);
  const abort = new AbortController();
  const box = dialog.showMessageBox(target, { message: "Recon: this closes itself.", buttons: ["OK"], signal: abort.signal });
  await sleep(700);
  abort.abort();
  await box.catch(() => undefined);
  await sleep(300);
  pill.hide();
  await sleep(200);
  pill.showInactive();
  await sleep(300);
  const quiet = watcher.presses.filter((p) => !sameClock || p.ts >= quietFrom);
  log(`F24, a window hiding and re-showing, a message box opening and closing, the pill hidden and re-shown: presses reported ${sameClock ? quiet.length : "(clock not shared; not measured)"}`);
  await watcher.ask("STOP", "STOPPED");

  // --- 6. Not watching ---
  const countBefore = watcher.presses.length;
  await click(centre(targetBounds), 30);
  await sleep(400);
  log(`a click while STOPPED: presses reported ${watcher.presses.length - countBefore}`);
  // A press just before START: primed and discarded.
  await click(centre(targetBounds), 0);
  await watcher.ask("WATCH 50", "WATCHING");
  await sleep(400);
  log(`a click just BEFORE watching started: presses reported ${watcher.presses.length - countBefore}`);
  await watcher.ask("STOP", "STOPPED");

  // --- 7. CPU ---
  const cpu = async () => Number((await watcher.ask("CPU", "CPU")).split(" ")[1]);
  const WINDOW = 8_000;
  for (const mode of ["50", "100", "stopped"]) {
    if (mode !== "stopped") await watcher.ask(`WATCH ${mode}`, "WATCHING");
    const a = await cpu();
    const ta = hrMs();
    await sleep(WINDOW);
    const b = await cpu();
    const tb = hrMs();
    if (mode !== "stopped") await watcher.ask("STOP", "STOPPED");
    log(`helper CPU ${mode === "stopped" ? "while STOPPED" : `watching every ${mode} ms`}: ${b - a} ms of processor time in ${(tb - ta).toFixed(0)} ms = ${((100 * (b - a)) / (tb - ta)).toFixed(2)}% of one core`);
  }

  await clicker.ask(`MOVE ${startAt[0]} ${startAt[1]}`, "MOVED");
  watcher.child.stdin.write("QUIT\n");
  clicker.child.stdin.write("QUIT\n");
  await sleep(200);
  rmSync(scratch, { recursive: true, force: true });
  app.exit(0);
});
