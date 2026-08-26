import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElementNotFoundError } from "../../core/errors.ts";
import type {
  ElementSurface,
  TargetCheck,
  NativeRect,
  UiElement,
  WindowElements,
  WindowProbe,
} from "../../core/types.ts";

// The real `ElementSurface` (M16): a PERSISTENT PowerShell child process hosting the UI
// Automation client, spawned and compiled ONCE.
//
// Modelled directly on WindowsInputInjector (M12), and for the same reasons. PowerShell rather
// than a native node addon because this repo already rebuilds better-sqlite3 twice per install
// and a second native module doubles that fragility for something PowerShell — already on every
// Windows machine this targets — does with zero new dependencies. Persistent rather than
// per-call because `Add-Type` plus loading the UIAutomation assemblies is the expensive part and
// it is paid once, not on every "where is X".
//
// WARM, WITH M14'S PIPER LESSON APPLIED. A long-lived helper process that answers questions is
// exactly the shape that produced M14's worst bug: a warm process that had died still looked
// alive, and a queued request waited forever. So: the child's `exit` fails every outstanding
// waiter immediately, `this.child` is nulled so the next call respawns rather than writing into
// a dead pipe, and every request carries its own timeout. There is no in-process caching of
// results at all — each PROBE and ENUM re-reads the tree — so a stale host cannot serve an
// answer from a previous invocation. The only state that survives a call is the compiled
// P/Invoke and the loaded assemblies.
//
// THE SCRIPT IS RUN FROM A FILE (`-File`), NOT PIPED (`-Command -`), AND THAT IS A CORRECTION
// TO M12's PATTERN RATHER THAN A PREFERENCE. WindowsInputInjector writes its script into stdin
// and then writes commands down the same pipe. Measured at M16.8: with `-Command -`, PowerShell
// treats stdin as the SCRIPT SOURCE and keeps consuming it, so `[Console]::In.ReadLine()` inside
// the loop never sees the commands. The host prints READY and then answers nothing.
//
// This was reproduced against M12's own host script, unchanged, so it is the invocation and not
// anything specific to this file. (M12's dictation does work in the shipped app, so the
// behaviour may differ under electron's spawn — but a script file removes the ambiguity
// entirely, because stdin is then exclusively the command channel and nothing else is reading
// it.) Worth carrying back to WindowsInputInjector if it ever misbehaves.
//
// PROTOCOL: one line in, one line out, over the child's stdin/stdout. Payloads cross as base64
// of UTF-8 JSON — no shell quoting, no escaping, and no chance of a control name containing a
// newline or a quote breaking the framing. Control names really do contain both: recon found VS
// Code exposing an entire source file as one element's Name.
//
//   PROBE <hwnd>  -> "PROBE <count> <base64 windowClass>"   or  "ERR <base64 message>"
//   ENUM  <hwnd>  -> "ENUM <base64 json>"                   or  "ERR <base64 message>"
//   FG            -> "FG <hwnd>"                            (the foreground window right now)
//   CHECK <hwnd>  -> "CHECK <fgHwnd> <x> <y> <w> <h>"       or  "ERR <base64 message>"
//
// `<hwnd>` of 0 means "whatever is in the foreground right now", which is only correct before
// this app's own window takes focus — M16.9 supplies the snapshot taken at hotkey time.

const STARTUP_TIMEOUT_MS = 15_000; // Add-Type + two UIAutomation assemblies on a cold machine
const PROBE_TIMEOUT_MS = 5_000; // measured at 60-370ms through the host; a liveness check, not a budget
const ENUM_TIMEOUT_MS = 20_000; // measured at ~830ms through the host, with generous headroom

const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# DPI AWARENESS FIRST, AND IT IS LOAD-BEARING. Without it Windows lies to this process about
# coordinates — recon measured it reporting 1280x720 for a 1920x1080 panel — and every rect would
# be off by the scale factor with nothing to indicate it. Set before any UIA call.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VaUia {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    public static IntPtr PerMonitorV2 = new IntPtr(-4);
    public const uint GW_HWNDNEXT = 2;
}
'@
[void][VaUia]::SetProcessDpiAwarenessContext([VaUia]::PerMonitorV2)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE    = [System.Windows.Automation.AutomationElement]
$TRUE_C = [System.Windows.Automation.Condition]::TrueCondition
$DESC  = [System.Windows.Automation.TreeScope]::Descendants

# The narrowing condition pushed INTO UIA. Recon measured this at ~10x cheaper than pulling the
# whole tree back and filtering here, because it collapses the cross-process round-trips.
$isControl = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)
$onScreen  = New-Object System.Windows.Automation.PropertyCondition($AE::IsOffscreenProperty, $false)
$NARROW    = New-Object System.Windows.Automation.AndCondition($isControl, $onScreen)

function To-B64([string]$s) {
  if ($null -eq $s) { $s = "" }
  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}

function Get-Target([string]$raw) {
  $h = [IntPtr]::Zero
  if ($raw -eq "0") { $h = [VaUia]::GetForegroundWindow() } else { $h = [IntPtr][int64]$raw }
  if ($h -eq [IntPtr]::Zero) { throw "no target window" }
  $el = $AE::FromHandle($h)
  if ($null -eq $el) { throw "that window is gone" }
  return $el
}

function Rect-Of($r) {
  # UIA reports (-inf,-inf,0,0) for an element with no screen presence. JSON cannot carry
  # infinity, so it becomes an explicitly zero-sized rect at the origin — which every filter in
  # core/screen/elements.ts already drops on the width/height check.
  if ($null -eq $r -or [double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Width)) {
    return @{ x = 0; y = 0; width = 0; height = 0 }
  }
  return @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
}

Write-Output "READY"

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(" ")
  $cmd = $parts[0]
  $arg = if ($parts.Length -gt 1) { $parts[1] } else { "0" }

  try {
    if ($cmd -eq "PROBE") {
      $el = Get-Target $arg
      $n = $el.FindAll($DESC, $NARROW).Count
      $cls = ""
      try { $cls = $el.Current.ClassName } catch { }
      Write-Output ("PROBE {0} {1}" -f $n, (To-B64 $cls))
    }
    elseif ($cmd -eq "ENUM") {
      $el = Get-Target $arg
      # NARROWED AT THE SOURCE, and this is the single biggest cost in the milestone.
      # Measured on a real VS Code window at M16.8: pulling the whole tree took 9541ms for 3026
      # elements; the same window through this condition took 826ms for 174 — and produced a
      # BYTE-IDENTICAL candidate list (85 both ways, 0 lost, 0 gained). The elements it skips are
      # exactly the ones core/screen/elements.ts drops anyway, so this is a pre-filter rather than
      # a second opinion, and isPointable still re-checks offscreen and enabled on what arrives.
      $rows = New-Object System.Collections.ArrayList
      foreach ($e in $el.FindAll($DESC, $NARROW)) {
        try {
          $c = $e.Current
          [void]$rows.Add(@{
            controlType  = $c.ControlType.ProgrammaticName.Replace("ControlType.", "")
            name         = $c.Name
            rect         = (Rect-Of $c.BoundingRectangle)
            enabled      = [bool]$c.IsEnabled
            offscreen    = [bool]$c.IsOffscreen
            focusable    = [bool]$c.IsKeyboardFocusable
            automationId = $c.AutomationId
          })
        } catch { }
      }
      $w = $el.Current
      $payload = @{
        windowTitle = $w.Name
        windowClass = $w.ClassName
        windowRect  = (Rect-Of $w.BoundingRectangle)
        elements    = $rows.ToArray()
      }
      $json = $payload | ConvertTo-Json -Depth 6 -Compress
      Write-Output ("ENUM {0}" -f (To-B64 $json))
    }
    elseif ($cmd -eq "FG") {
      # ARG IS A COMMA-SEPARATED LIST OF THIS APP'S OWN WINDOW HANDLES, AND SKIPPING THEM IS
      # DEFENCE IN DEPTH RATHER THAN THE PRIMARY FIX (M16.11).
      #
      # The primary fix is that the caller now AWAITS this before its bar takes focus. But the
      # bug that made it necessary — the app recording ITSELF as the target window — was bad
      # enough that it is worth being unable to express at all. If the foreground is one of ours,
      # walk down the Z-order to the first visible, titled window that is not.
      $own = @()
      if ($arg -ne "0") { $own = $arg.Split(",") | ForEach-Object { [int64]$_ } }
      $h = [VaUia]::GetForegroundWindow()
      $guard = 0
      while ($h -ne [IntPtr]::Zero -and $guard -lt 50) {
        $isOurs = $own -contains $h.ToInt64()
        if (-not $isOurs -and [VaUia]::IsWindowVisible($h) -and [VaUia]::GetWindowTextLength($h) -gt 0) { break }
        $h = [VaUia]::GetWindow($h, [VaUia]::GW_HWNDNEXT)
        $guard += 1
      }
      Write-Output ("FG {0}" -f $h.ToInt64())
    }
    elseif ($cmd -eq "CHECK") {
      # Cheap, and deliberately so: this runs immediately before the marker is drawn, so it must
      # not add another enumeration's worth of latency to a call that has already spent one.
      $el = Get-Target $arg
      $r = Rect-Of $el.Current.BoundingRectangle
      $fg = ([VaUia]::GetForegroundWindow()).ToInt64()
      Write-Output ("CHECK {0} {1} {2} {3} {4}" -f $fg, $r.x, $r.y, $r.width, $r.height)
    }
    else {
      Write-Output ("ERR {0}" -f (To-B64 ("unknown command: " + $cmd)))
    }
  } catch {
    Write-Output ("ERR {0}" -f (To-B64 $_.Exception.Message))
  }
}
`;

export interface WindowsElementsOptions {
  // This app's own top-level window handles. Needed because the command bar necessarily HOLDS
  // focus for the whole of a pointAt call, so "is the target still foreground" is always false —
  // the real question is whether focus has moved to a THIRD application.
  ownWindows: () => number[];
  // The window the user was looking at, captured BEFORE the command bar took focus (M16.9).
  // Returning null means "whatever is in the foreground now", which is right only for a caller
  // that has not stolen focus.
  target: () => number | null;
}

export class WindowsElements implements ElementSurface {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptDir: string | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private readonly waiters: {
    onLine: (line: string) => void;
    onExit: (error: Error) => void;
  }[] = [];
  private disposed = false;

  constructor(private readonly options: WindowsElementsOptions) {}

  async probe(): Promise<WindowProbe> {
    const line = await this.send(`PROBE ${this.handle()}`, PROBE_TIMEOUT_MS);
    const parts = line.split(" ");
    if (parts[0] !== "PROBE") throw this.hostError(line);
    return {
      count: Number(parts[1] ?? 0),
      windowClass: decode(parts[2] ?? ""),
    };
  }

  // Capture the window the user is looking at, BEFORE this app's bar takes focus (M16.9). The
  // handle is held until the next snapshot; `target` in the options is what M16.9's wiring reads
  // it back through.
  async snapshotForeground(): Promise<number | null> {
    // Our own handles go with the request, so the host can refuse to name one of them.
    const own = this.options.ownWindows().filter((h) => Number.isSafeInteger(h) && h !== 0);
    const line = await this.send(`FG ${own.length > 0 ? own.join(",") : "0"}`, PROBE_TIMEOUT_MS);
    const parts = line.split(" ");
    if (parts[0] !== "FG") return null;
    const handle = Number(parts[1] ?? 0);
    return Number.isSafeInteger(handle) && handle !== 0 ? handle : null;
  }

  async verifyTarget(): Promise<TargetCheck> {
    const line = await this.send(`CHECK ${this.handle()}`, PROBE_TIMEOUT_MS);
    const parts = line.split(" ");
    if (parts[0] !== "CHECK") throw this.hostError(line);

    const foreground = Number(parts[1] ?? 0);
    const target = Number(this.options.target() ?? 0);
    const ours = this.options.ownWindows();

    return {
      // Current if focus is on the window we read, or on one of our own windows (the bar, the
      // overlay). Anything else means the user has moved to a third application.
      stillCurrent: foreground === target || ours.includes(foreground),
      rect: {
        x: Number(parts[2] ?? 0),
        y: Number(parts[3] ?? 0),
        width: Number(parts[4] ?? 0),
        height: Number(parts[5] ?? 0),
      },
    };
  }

  async enumerate(): Promise<WindowElements> {
    const line = await this.send(`ENUM ${this.handle()}`, ENUM_TIMEOUT_MS);
    const parts = line.split(" ");
    if (parts[0] !== "ENUM") throw this.hostError(line);
    return parseWindow(decode(parts[1] ?? ""));
  }

  dispose(): void {
    this.disposed = true;
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.ready = null;
    if (this.scriptDir) {
      try {
        rmSync(this.scriptDir, { recursive: true, force: true });
      } catch {
        // A temp file we could not remove is not worth failing shutdown over.
      }
      this.scriptDir = null;
    }
  }

  private handle(): string {
    return String(this.options.target() ?? 0);
  }

  // Every failure the HOST reports becomes an `unreadable` refusal, not a crash. From the user's
  // side "that window is gone" and "this build cannot read windows" want the same thing said:
  // the controls could not be read, click it yourself.
  private hostError(line: string): ElementNotFoundError {
    const detail = line.startsWith("ERR ") ? decode(line.slice(4)) : line;
    return new ElementNotFoundError(
      "unreadable",
      `I couldn't read that window's controls${detail ? `: ${detail}` : "."}`,
    );
  }

  private async send(command: string, timeoutMs: number): Promise<string> {
    await this.ensureStarted();
    const child = this.child;
    if (!child || this.disposed) {
      throw new ElementNotFoundError("unreadable", "The window reader is not running.");
    }

    return new Promise<string>((resolve, reject) => {
      const entry = {
        onLine: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        onExit: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new ElementNotFoundError(
            "unreadable",
            "Reading that window's controls took too long.",
          ),
        );
      }, timeoutMs);

      this.waiters.push(entry);
      child.stdin.write(`${command}\n`);
    });
  }

  // Lazy: spawned on first use, not at construction, so an install where pointing is configured
  // but never triggered never pays the startup cost or holds a process open for nothing.
  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      // Written fresh per host, and removed on dispose. A stable path would be shared between
      // two running copies of the app, which is a race for no benefit.
      this.scriptDir = mkdtempSync(join(tmpdir(), "va-uia-"));
      const scriptPath = join(this.scriptDir, "host.ps1");
      writeFileSync(scriptPath, HOST_SCRIPT, "utf8");

      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: "pipe", windowsHide: true },
      );
      this.child = child;

      const timer = setTimeout(() => {
        reject(
          new ElementNotFoundError("unreadable", "The window reader did not start in time."),
        );
      }, STARTUP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => {
        // Diagnostic only. A real failure surfaces as a rejected request or an ERR line; stderr
        // noise must never take down a live session.
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          new ElementNotFoundError(
            "unreadable",
            `Could not start the window reader: ${error.message}`,
          ),
        );
      });

      // M14's Piper lesson: a warm helper that has died must not leave callers waiting on a line
      // that will never come, and the next call must respawn rather than write into a dead pipe.
      child.on("exit", () => {
        this.failAllWaiters(
          new ElementNotFoundError("unreadable", "The window reader stopped unexpectedly."),
        );
        this.child = null;
        this.ready = null;
      });

      this.waiters.push({
        onLine: (line) => {
          clearTimeout(timer);
          if (line === "READY") resolve();
          else
            reject(
              new ElementNotFoundError(
                "unreadable",
                `The window reader did not start cleanly: ${line}`,
              ),
            );
        },
        onExit: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      // Nothing is written to stdin here. With `-File` the script is already loaded, and stdin
      // belongs entirely to the command protocol — which is the whole point of the change.
    });

    return this.ready;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.waiters.shift()?.onLine(line);
    }
  }

  private failAllWaiters(error: Error): void {
    while (this.waiters.length > 0) this.waiters.shift()?.onExit(error);
  }
}

function decode(b64: string): string {
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

// THE PARSING IS SEPARATED FROM THE TRANSPORT ON PURPOSE — M13's lesson, applied again. The
// spawn is live-only; this is ordinary branching that decides what the app believes about a
// window, so it is exported and tested against literal payloads rather than waiting for a real
// desktop to produce a malformed one.
export function parseWindow(json: string): WindowElements {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new ElementNotFoundError(
      "unreadable",
      "I couldn't make sense of what that window reported.",
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new ElementNotFoundError(
      "unreadable",
      "I couldn't make sense of what that window reported.",
    );
  }

  const record = payload as Record<string, unknown>;
  return {
    windowTitle: asString(record["windowTitle"]),
    windowClass: asString(record["windowClass"]),
    windowRect: asRect(record["windowRect"]),
    elements: Array.isArray(record["elements"])
      ? record["elements"].map(asElement)
      : [],
  };
}

function asElement(raw: unknown): UiElement {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    controlType: asString(r["controlType"]),
    name: asString(r["name"]),
    rect: asRect(r["rect"]),
    enabled: r["enabled"] !== false,
    offscreen: r["offscreen"] === true,
    focusable: r["focusable"] === true,
    automationId: asString(r["automationId"]),
  };
}

function asRect(raw: unknown): NativeRect {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    x: asNumber(r["x"]),
    y: asNumber(r["y"]),
    width: asNumber(r["width"]),
    height: asNumber(r["height"]),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
