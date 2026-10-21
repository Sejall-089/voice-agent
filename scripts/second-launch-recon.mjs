// Start the app a second time the way it is started in development — `npm run dev` while it is
// already running — and report what the FIRST instance shows.
//
//   node scripts/second-launch-recon.mjs
//
// !! IT STARTS THE APP TWICE, for about 30 s, each time with a scratch --user-data-dir: its own
// !! memory.db and its own single-instance lock, never yours (`app.getPath("userData")` and the
// !! lock both follow that switch — measured). It loads .env like any launch, but makes no model
// !! call and opens no connector. The first copy registers the app's global hotkeys while it
// !! runs, so close the app first if you want yours to keep them. No keys, no mouse.
//
// WHY THIS EXISTS (live finding after M23). A second `npm run dev` "exited, so the lock works" —
// and the running app said nothing. The lock had never been reached: `predev` force-rebuilds the
// SQLite binary, and while the first instance has it loaded Windows refuses to delete it (EPERM),
// so npm stopped before a second Electron was started. The single-instance logic is unit-tested
// (tests/singleInstance.test.ts) and was fine; only a real second launch, through npm, could
// show the launch never got that far.
//
// PASS means all of: the second process exited; the first instance's bar shows the
// "I'm already running" line (read from its DOM over the DevTools protocol); and the bar window
// is visible according to Windows. `document.visibilityState` is NOT used for the last one: it
// reported "visible" while the bar was hidden.
//
// PREREQUISITE: the SQLite binary built for Electron (`npm run dev` once, or
// `npm run rebuild:electron`). The first copy is started with `electron-vite dev` directly — it is
// the "already running" one, and its own startup is not what is being tested.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALREADY_RUNNING = "I'm already running — press the hotkey to give me an instruction.";
const PORT = 9333;
const scratch = mkdtempSync(join(tmpdir(), "va-second-launch-"));
const userData = join(scratch, "userData");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const vite = join(repo, "node_modules", "electron-vite", "bin", "electron-vite.js");

const t0 = Date.now();
const log = (line) => console.log(`[recon +${String(Date.now() - t0).padStart(6)}ms] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures += 1;
  log(`   ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

// Is the bar window of the instance using OUR scratch userData visible, per Windows?
writeFileSync(
  join(scratch, "bar.ps1"),
  String.raw`
param([string]$Marker)
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class VaBar { delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 public static string For(uint want) { string o = "none"; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
   if (p == want) { var t = new StringBuilder(128); GetWindowText(h, t, 128); if (t.ToString() == "Voice-Action Agent") o = IsWindowVisible(h) ? "visible" : "hidden"; } return true; }, IntPtr.Zero); return o; } }
'@
$main = Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -like "*$Marker*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -First 1
if ($null -eq $main) { "no-process" } else { [VaBar]::For([uint32]$main.ProcessId) }
`,
);
const barWindow = () =>
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "bar.ps1"), userData], { encoding: "utf8" }).trim();

const barPage = async () => {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((t) => t.type === "page" && !/pill|overlay/.test(t.url)) ?? null;
  } catch {
    return null;
  }
};
const barText = async (page) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  const reply = new Promise((r) => ws.addEventListener("message", (m) => r(JSON.parse(String(m.data)))));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.querySelector('.command-status')?.textContent ?? null", returnByValue: true } }));
  const value = (await reply).result?.result?.value ?? null;
  ws.close();
  return value;
};

// 1. The app, already running.
log("starting the first instance (electron-vite dev, scratch userData)");
const first = spawn(process.execPath, [vite, "dev", "--remoteDebuggingPort", String(PORT), "--", `--user-data-dir=${userData}`], {
  cwd: repo,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let firstOut = "";
first.stdout.on("data", (d) => (firstOut += d));
first.stderr.on("data", (d) => (firstOut += d));
const stopFirst = () => {
  try {
    execFileSync("taskkill", ["/PID", String(first.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
};

let page = null;
for (let i = 0; i < 90 && page === null; i += 1) {
  await sleep(1000);
  page = await barPage();
}
if (page === null) {
  log("the first instance never came up; its output:");
  console.log(firstOut.slice(-3000));
  stopFirst();
  process.exit(2);
}
await sleep(4000);
const before = { text: await barText(page), window: barWindow() };
log(`first instance up; bar before: window=${before.window} status=${JSON.stringify(before.text)}`);
if (before.window !== "hidden" || before.text !== null) log("   (note: the bar was not hidden and empty before the second launch)");

// 2. The second launch, exactly as typed in a terminal — `predev` included.
log("second launch: npm run dev (same scratch userData)");
const started = Date.now();
const second = spawn("cmd.exe", ["/d", "/s", "/c", "npm run dev -- -- --user-data-dir=" + userData], {
  cwd: repo,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let secondOut = "";
second.stdout.on("data", (d) => (secondOut += d));
second.stderr.on("data", (d) => (secondOut += d));
const exitCode = await Promise.race([new Promise((r) => second.on("exit", r)), sleep(120_000).then(() => "timeout")]);
log(`second launch ended: ${String(exitCode)} after ${Date.now() - started} ms`);
const said = secondOut
  .split(/\r?\n/)
  .filter((line) => /predev|native|rebuild|EPERM|EBUSY|already running|start electron/i.test(line))
  .slice(0, 8);
for (const line of said) log(`   | ${line.trim()}`);
await sleep(1500);

const after = { text: await barText(page), window: barWindow() };
check("the second process exited", exitCode !== "timeout");
check("the second process got as far as starting Electron", /start electron app/.test(secondOut));
check("the first instance's bar shows the 'already running' line", after.text === ALREADY_RUNNING, JSON.stringify(after.text));
check("the bar window is visible (per Windows)", after.window === "visible", after.window);

if (exitCode === "timeout") second.kill();
stopFirst();
await sleep(1500);
rmSync(scratch, { recursive: true, force: true });
log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
