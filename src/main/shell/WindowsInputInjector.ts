import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ForegroundWindow, InputInjector } from "./InputInjector.ts";

// The real InputInjector (M12): a PERSISTENT PowerShell child process hosting the one
// P/Invoke declaration this needs (SendInput + GetForegroundWindow + GetWindowText). Spawned
// and compiled ONCE at construction — `Add-Type` alone measured ~500ms on this machine, which
// is a real cost paid once at app startup, not per keystroke.
//
// Why PowerShell + Add-Type rather than a native node addon (the koffi/ffi route): this repo
// already rebuilds better-sqlite3 twice on every install (see WhisperCppTranscriber.ts's own
// note on the same trade). A second native module doubles that fragility for a feature that
// PowerShell — already on every Windows machine this targets — can do with zero new
// dependencies and zero rebuilds.
//
// Protocol: one line in, one line out, over the child's stdin/stdout. Text crosses as
// base64 of UTF-16LE bytes — no shell quoting, no escaping, and it preserves the exact
// UTF-16 code unit sequence (including surrogate pairs, so emoji type correctly with no
// special case: a supplementary-plane character is just two consecutive code units, each
// sent as its own SendInput event, exactly like a physical keyboard produces one).
//
//   FG                          -> "FG <hwnd> <base64 title>"  or  "FG NONE"
//   TYPE <base64 utf16le text>  -> "TYPE OK <sent>"  or  "TYPE ERR <sent> <expected> <win32err>"
//
// The host chunks a TYPE request into small SendInput bursts with a short sleep between
// them (CHUNK_SIZE_CHARS / CHUNK_DELAY_MS below) rather than one giant burst — apps doing
// per-keystroke work (autocomplete, an IDE's own input handling) have been observed to drop
// or reorder events under a single large SendInput call.
//
// THE central contract, and the reason this class is trustworthy where M11's execCommand
// was not: SendInput returns the number of events the OS actually accepted. A short return
// is captured, paired with GetLastError() (most commonly ERROR_ACCESS_DENIED — UIPI blocking
// an unelevated process from typing into an elevated window), and surfaced as `TYPE ERR`,
// which this class turns into a THROWN error. It is never downgraded to a boolean and never
// silently swallowed — see InputInjector.ts's doc comment for why that distinction is the
// whole point.

const STARTUP_TIMEOUT_MS = 10_000; // Add-Type compiled in ~500ms locally; generous headroom for a cold machine
const FOREGROUND_TIMEOUT_MS = 5_000; // a plain user32 read; if this hangs, the host is dead
const TYPE_TIMEOUT_MS = 20_000; // covers even a very long transcript's worth of chunks

// How many characters go into one SendInput burst, and how long to pause between bursts.
// Same convention as ChromeNotion's FOCUS_SETTLE_MS/KEY_SETTLE_MS: named constants because
// these are exactly the kind of number that may need tuning after real live use, not
// literals buried in a loop.
const CHUNK_SIZE_CHARS = 25;
const CHUNK_DELAY_MS = 8;

// PowerShell script, held as one string. Built once; the ${} placeholders below are filled
// with the TS constants above so there is exactly one source of truth for the tunables.
const HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceAgentInput {
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        public int pad1;
        public int pad2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public static INPUT KeyEvent(char ch, bool keyUp) {
        INPUT inp = new INPUT();
        inp.type = INPUT_KEYBOARD;
        inp.ki.wVk = 0;
        inp.ki.wScan = (ushort)ch;
        inp.ki.dwFlags = keyUp ? (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) : KEYEVENTF_UNICODE;
        inp.ki.time = 0;
        inp.ki.dwExtraInfo = IntPtr.Zero;
        return inp;
    }
}
'@

$InputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'VoiceAgentInput+INPUT')

function Get-ForegroundTitle {
    param([IntPtr]$Handle)
    $len = [VoiceAgentInput]::GetWindowTextLength($Handle)
    if ($len -le 0) { return "" }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][VoiceAgentInput]::GetWindowText($Handle, $sb, $sb.Capacity)
    return $sb.ToString()
}

Write-Output "READY"

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq "QUIT") { break }

    try {
        if ($line -eq "FG") {
            $h = [VoiceAgentInput]::GetForegroundWindow()
            if ($h -eq [IntPtr]::Zero) {
                Write-Output "FG NONE"
            } else {
                $title = Get-ForegroundTitle -Handle $h
                $titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($title))
                Write-Output "FG $($h.ToInt64()) $titleB64"
            }
        } elseif ($line.StartsWith("TYPE ")) {
            $b64 = $line.Substring(5)
            $bytes = [Convert]::FromBase64String($b64)
            $text = [System.Text.Encoding]::Unicode.GetString($bytes)
            $chars = $text.ToCharArray()
            $expected = $chars.Length * 2
            $sent = 0
            $lastError = 0
            $i = 0
            while ($i -lt $chars.Length) {
                $count = [Math]::Min(${CHUNK_SIZE_CHARS}, $chars.Length - $i)
                $events = New-Object 'VoiceAgentInput+INPUT[]' ($count * 2)
                for ($j = 0; $j -lt $count; $j++) {
                    $ch = $chars[$i + $j]
                    $events[$j * 2] = [VoiceAgentInput]::KeyEvent($ch, $false)
                    $events[$j * 2 + 1] = [VoiceAgentInput]::KeyEvent($ch, $true)
                }
                $result = [VoiceAgentInput]::SendInput([uint32]$events.Length, $events, $InputSize)
                $sent += [int]$result
                if ($result -ne [uint32]$events.Length) {
                    $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    break
                }
                $i += $count
                if ($i -lt $chars.Length) { Start-Sleep -Milliseconds ${CHUNK_DELAY_MS} }
            }
            if ($sent -eq $expected) {
                Write-Output "TYPE OK $sent"
            } else {
                Write-Output "TYPE ERR $sent $expected $lastError"
            }
        } else {
            Write-Output "ERR unknown-command"
        }
    } catch {
        $msg = ($_.Exception.Message -replace "\`r?\`n", " ")
        Write-Output "ERR $msg"
    }
}
`;

export class WindowsInputInjector implements InputInjector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private readonly waiters: { onLine: (line: string) => void; onExit: (error: Error) => void }[] =
    [];
  private disposed = false;

  // Lazy: the host process is spawned on first use, not at construction, so building a
  // WindowsInputInjector that is never actually used (dictation configured but never
  // triggered) never pays the ~500ms startup cost or holds a process open for nothing.
  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        { stdio: "pipe", windowsHide: true },
      );
      this.child = child;

      const timer = setTimeout(() => {
        reject(new Error("The input host did not start in time."));
      }, STARTUP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => {
        // Diagnostic only. A real failure surfaces through a rejected request instead —
        // stderr noise alone must never crash a live dictation session.
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not start the input host: ${error.message}`));
      });
      child.on("exit", () => {
        // The host died. Any request still waiting on a reply would otherwise hang forever.
        this.failAllWaiters(new Error("The input host exited unexpectedly."));
        this.child = null;
        this.ready = null;
      });

      // The first line the host ever prints is "READY", once Add-Type has compiled.
      this.waiters.push({
        onLine: (line) => {
          clearTimeout(timer);
          if (line === "READY") {
            resolve();
          } else {
            reject(new Error(`The input host did not start cleanly: ${line}`));
          }
        },
        onExit: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      child.stdin.write(HOST_SCRIPT + "\n");
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
      const waiter = this.waiters.shift();
      waiter?.onLine(line);
    }
  }

  // The host died with requests still outstanding. Fail them immediately rather than
  // making every caller sit out its own multi-second timeout waiting for a line that
  // will never arrive.
  private failAllWaiters(error: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.onExit(error);
    }
  }

  private request(command: string, timeoutMs: number): Promise<string> {
    if (!this.child || this.disposed) {
      return Promise.reject(new Error("The input host is not running."));
    }
    const child = this.child;
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
        reject(new Error("The input host did not respond in time."));
      }, timeoutMs);

      this.waiters.push(entry);
      child.stdin.write(command + "\n");
    });
  }

  async getForegroundWindow(): Promise<ForegroundWindow | null> {
    await this.ensureStarted();
    const line = await this.request("FG", FOREGROUND_TIMEOUT_MS);
    if (line === "FG NONE") return null;

    const match = /^FG (-?\d+) (\S*)$/.exec(line);
    if (!match) {
      throw new Error(`The input host returned an unreadable foreground reply: ${line}`);
    }
    const [, handleText, titleB64] = match;
    const handle = Number(handleText);
    const title = titleB64 && titleB64.length > 0 ? decodeBase64Utf16(titleB64) : null;
    return { handle, title: title && title.length > 0 ? title : null };
  }

  async typeText(text: string): Promise<void> {
    if (text.length === 0) return;
    await this.ensureStarted();
    const payload = encodeBase64Utf16(text);
    const line = await this.request(`TYPE ${payload}`, TYPE_TIMEOUT_MS);

    if (line.startsWith("TYPE OK")) return;

    if (line.startsWith("TYPE ERR")) {
      const match = /^TYPE ERR (\d+) (\d+) (-?\d+)$/.exec(line);
      if (match) {
        const [, sent, expected, win32Error] = match;
        throw new Error(
          `Typing was blocked partway through (${sent}/${expected} keystrokes delivered, ` +
            `Win32 error ${win32Error}) — most likely the focused window has higher ` +
            `privileges than this app.`,
        );
      }
    }

    throw new Error(`The input host reported a failure: ${line}`);
  }

  dispose(): void {
    this.disposed = true;
    this.child?.stdin.write("QUIT\n");
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}

function encodeBase64Utf16(text: string): string {
  return Buffer.from(text, "utf16le").toString("base64");
}

function decodeBase64Utf16(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf16le");
}
