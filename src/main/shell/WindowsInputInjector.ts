import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostChannel, HostTimeoutError, verbOf } from "./hostChannel.ts";
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
//   KEY <vk> <count>            -> "KEY OK <sent>"   or  "KEY ERR <sent> <expected> <win32err>"
//
// Every command may be prefixed "#<id> " and its reply carries the same prefix back, so a reply
// can only ever resolve the request it names (see hostChannel.ts). READY is untagged.
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

// THE SCRIPT IS RUN FROM A FILE (`-File`), NOT PIPED (`-Command -`), AND THAT IS A FIX WITH
// MEASUREMENTS BEHIND IT. Resolved post-M18; the note that used to sit here described the
// problem and declined to act on it, which cost a live debugging session.
//
// The symptom: "The input host did not respond in time." intermittently on media keys, and the
// same command working on the next try.
//
// What was measured (`scripts/input-host-bench.ts`, `scripts/ps-stdin-probe.mjs`):
//
//   * spawn -> READY in 739ms, against a 10s budget. Cold start was never the problem.
//   * The FIRST command after READY got NO reply for its entire 10s budget, with the child
//     still alive and nothing buffered. Commands #2 onwards replied in 1-3ms — 50/50
//     back-to-back, and clean after 10s and 60s idle. So the lost reply was never late; it was
//     SWALLOWED, exactly once, per host.
//   * Isolated on a three-line script: with `-Command -` PowerShell treats stdin as the SCRIPT
//     SOURCE and keeps consuming it, so a command written down the same pipe is eaten by the
//     parser instead of reaching `[Console]::In.ReadLine()`. Waiting first does not help —
//     0ms, 50ms, 250ms and 1000ms after READY all behaved identically. With `-File` the same
//     script answered its first command in 5-8ms at every one of those delays.
//
// So a longer first-request timeout could not have fixed it (the reply never comes) and
// respawning on a timeout would have made it WORSE (every fresh host swallowed its first
// command, turning an intermittent failure into a reliable one). `-File` is the fix, and it is
// what src/main/uia/WindowsElements.ts already does for the same reason.
//
// NOTE WHAT THIS ALSO MEANS: this was never a media-key bug. The host is shared, so dictation's
// first `FG` after a launch was being swallowed too — it just presented as one odd "couldn't
// tell which window" that worked on the retry. M18 only made it visible because a volume key is
// the first thing anyone presses twice.
//
// There is deliberately NO FALLBACK to `-Command -`. It does not work; a fallback would only
// restore the bug on whichever machine took it.

const STARTUP_TIMEOUT_MS = 10_000; // Add-Type compiled in ~500ms locally; measured 739ms cold

// --- Timeouts, derived rather than picked ---------------------------------------------------
//
// EVERY BUDGET IS COMPUTED FROM THE WORK THE HOST WILL ACTUALLY DO, because a flat budget was
// already wrong before kill-on-timeout made it dangerous. `TYPE_TIMEOUT_MS` was a flat 20s, and
// the host sleeps CHUNK_DELAY_MS (40ms) PER CHARACTER — so 20_000/40 = 500 characters was the
// hard ceiling, and anything longer timed out. Dictation's cap is 90 SECONDS of speech, which
// is comfortably 1200+ characters and needs ~48s of typing. Long dictations were therefore
// already failing; once a timeout kills the host, the same budget would kill a TYPE that was
// merely halfway through and leave part of a sentence in the user's document.
//
//   budget(units) = HOST_BASE_TIMEOUT_MS + units * CHUNK_DELAY_MS * TIMEOUT_SLACK
//
//   units    verb   budget    host needs    (slack)
//   0        FG       5.0s      ~0ms        — identical to the old flat FOREGROUND timeout
//   15       KEY      6.2s      0.6s        10x
//   100      TYPE    13.0s      4.0s        3.3x
//   500      TYPE    45.0s     20.0s        2.3x   <- the old ceiling, now comfortable
//   1200     TYPE   101.0s     48.0s        2.1x   <- a full 90-second dictation
//   1800     TYPE   149.0s     72.0s        2.1x
//
// Deliberately unbounded above: the term is proportional to real work, and a hard cap would
// reintroduce exactly the failure being fixed — a legitimate long TYPE killed for being long.
const HOST_BASE_TIMEOUT_MS = 5_000;
const TIMEOUT_SLACK = 2;

export function budgetFor(units: number): number {
  return HOST_BASE_TIMEOUT_MS + Math.max(0, units) * CHUNK_DELAY_MS * TIMEOUT_SLACK;
}

// What to tell the user when a request did not confirm. A pure function so the wording is
// actually asserted somewhere (tests/hostChannel.test.ts) — it is otherwise locked inside a
// class that cannot be imported without spawning PowerShell, which is how the rest of this
// file's error handling went untested for six milestones.
//
// BOTH MESSAGES SAY THE SAME UNCOMFORTABLE THING: we do not know whether it happened. That is
// the honest report for a request whose reply never came, and it is why nothing is retried —
// see hostChannel.ts's timeout handler. What differs is the CONSEQUENCE, and the two
// consequences are genuinely different facts rather than two phrasings of one:
//
//   KEY  — a press may have landed. Repeating it would UNDO a toggle (mute, play/pause), so
//          the user is told to look and decide.
//   TYPE — the host types one character at a time, so part of a sentence may already be sitting
//          in the user's document. Saying "that failed" would send them hunting for text that
//          is already there, and a retry would type it twice.
export function unconfirmedOutcomeMessage(verb: "KEY" | "TYPE"): string {
  return verb === "KEY"
    ? "I couldn't confirm that key press - it may or may not have gone through. Nothing was " +
        "retried, because repeating a mute or play/pause would undo it. Try again if nothing " +
        "changed."
    : "I couldn't confirm the typing finished - part of the text may have been typed into the " +
        "window already. Nothing was retried, because that would risk typing it twice. Check " +
        "the window before dictating again.";
}


// --- Diagnostics: INPUT_HOST_DEBUG=1 --------------------------------------------------------
//
// KEPT rather than deleted with the investigation that added it, and it is safe to keep for one
// specific reason: IT LOGS VERBS ONLY — `FG`, `TYPE`, `KEY` — and never an argument. A TYPE
// argument is the user's dictated text and a KEY argument is a keycode; neither belongs in a
// log. Every question this needs to answer (how long did the reply take, did the host start
// cleanly, was a reply discarded) is answerable without either, which is why the verb/argument
// split lives in `verbOf` rather than in each call site's discretion.
//
// Off by default, so it costs nothing and says nothing. This is the thing that found the
// `-Command -` swallow in a single run, and the failure it diagnoses is intermittent and
// host-level — exactly the kind that is miserable to chase without timings.
//
//   INPUT_HOST_DEBUG=1 npm run dev
//   INPUT_HOST_DEBUG=1 npx vite-node scripts/input-host-bench.ts
const DEBUG = process.env["INPUT_HOST_DEBUG"] === "1";

function hostLog(message: string): void {
  if (DEBUG) console.log(`[inputhost] ${message}`);
}

// How many characters go into one SendInput burst, and how long to pause between bursts.
// Same convention as ChromeNotion's FOCUS_SETTLE_MS/KEY_SETTLE_MS: named constants because
// these are exactly the kind of number that may need tuning after real live use, not
// literals buried in a loop.
const CHUNK_SIZE_CHARS = 1;
// 40ms, not 8ms: live testing found that faster gaps between chunks could trip Windows'
// own key-repeat handling — KEYEVENTF_UNICODE events carry no real virtual-key code
// (wVk=0), and a rapid-enough stream of them was observed to cause genuine OS-level
// character repetition ("mmmmmm", "IIIIIIII") on longer dictations, not an app rendering
// issue. Confirmed fixed at this value on a previously-corrupted long sentence.
const CHUNK_DELAY_MS = 40;

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

    // M18. A REAL key, not a character. The mirror image of KeyEvent above: the virtual-key
    // code goes in wVk and wScan is empty, where KeyEvent puts the character in wScan and
    // leaves wVk at 0. That difference is the whole point - a media key carries no character,
    // and the application owning the Windows media session is listening for the keycode.
    public static INPUT VkEvent(ushort vk, bool keyUp) {
        INPUT inp = new INPUT();
        inp.type = INPUT_KEYBOARD;
        inp.ki.wVk = vk;
        inp.ki.wScan = 0;
        inp.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0u;
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
    $raw = [Console]::In.ReadLine()
    if ($null -eq $raw) { break }

    # Request ids (post-M18). A command may arrive tagged "#<id> <command>"; every reply to it
    # is prefixed with the same "#<id> ". Untagged commands still work and answer untagged, so
    # READY above needs no tag and a hand-driven host is still usable.
    #
    # This is the SECOND line of defence, not the first: killing the host on a timeout is what
    # actually prevents a stale reply existing. The id is what makes a stale reply harmless if
    # one ever does, instead of being handed to whichever request is next in the queue.
    $tag = ""
    $line = $raw
    if ($raw.StartsWith("#")) {
        $sp = $raw.IndexOf(" ")
        if ($sp -gt 0) {
            $tag = $raw.Substring(0, $sp) + " "
            $line = $raw.Substring($sp + 1)
        }
    }

    if ($line -eq "QUIT") { break }

    try {
        if ($line -eq "FG") {
            $h = [VoiceAgentInput]::GetForegroundWindow()
            if ($h -eq [IntPtr]::Zero) {
                Write-Output "\${tag}FG NONE"
            } else {
                $title = Get-ForegroundTitle -Handle $h
                $titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($title))
                Write-Output "\${tag}FG $($h.ToInt64()) $titleB64"
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
                Write-Output "\${tag}TYPE OK $sent"
            } else {
                Write-Output "\${tag}TYPE ERR $sent $expected $lastError"
            }
        } elseif ($line.StartsWith("KEY ")) {
            $parts = $line.Substring(4).Split(' ')
            $vk = [uint16]$parts[0]
            $count = [int]$parts[1]
            $expected = $count * 2
            $sent = 0
            $lastError = 0
            for ($k = 0; $k -lt $count; $k++) {
                $events = New-Object 'VoiceAgentInput+INPUT[]' 2
                $events[0] = [VoiceAgentInput]::VkEvent($vk, $false)
                $events[1] = [VoiceAgentInput]::VkEvent($vk, $true)
                $result = [VoiceAgentInput]::SendInput([uint32]2, $events, $InputSize)
                $sent += [int]$result
                if ($result -ne [uint32]2) {
                    $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    break
                }
                # The same gap TYPE uses between chunks, and for the same measured reason
                # (M12.1): synthetic key events closer together than this tripped Windows own
                # key-repeat handling. A volume key is exactly the place a user would notice
                # that as a stuck key.
                if ($k -lt ($count - 1)) { Start-Sleep -Milliseconds ${CHUNK_DELAY_MS} }
            }
            if ($sent -eq $expected) {
                Write-Output "\${tag}KEY OK $sent"
            } else {
                Write-Output "\${tag}KEY ERR $sent $expected $lastError"
            }
        } else {
            Write-Output "\${tag}ERR unknown-command"
        }
    } catch {
        $msg = ($_.Exception.Message -replace "\`r?\`n", " ")
        Write-Output "\${tag}ERR $msg"
    }
}
`;

export class WindowsInputInjector implements InputInjector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private channel: HostChannel | null = null;
  // Where HOST_SCRIPT was written for `-File`. Removed in dispose() AND when the host exits on
  // its own, so a long-running app does not leave a temp directory per crashed host.
  private scriptDir: string | null = null;
  private disposed = false;

  // Lazy: the host process is spawned on first use, not at construction, so building a
  // WindowsInputInjector that is never actually used (dictation configured but never
  // triggered) never pays the startup cost or holds a process open for nothing.
  //
  // It also RESPAWNS. A channel that timed out has killed its host and is poisoned, so the next
  // call starts a clean process rather than talking to a corpse. That is safe only because of
  // the `-File` fix at the top of this file: under `-Command -` every fresh host swallowed its
  // first command, so respawning would have made a timeout permanent instead of transient.
  private ensureStarted(): Promise<void> {
    if (this.channel?.isPoisoned() === true) {
      this.teardown();
    }
    if (this.ready) return this.ready;

    const spawnedAt = Date.now();

    this.ready = new Promise<void>((resolve, reject) => {
      // THE SCRIPT GOES TO A FILE. A random directory name per host (mkdtemp), so two hosts —
      // or two app instances — can never write over each other.
      let scriptPath: string;
      try {
        this.scriptDir = mkdtempSync(join(tmpdir(), "va-input-"));
        scriptPath = join(this.scriptDir, "host.ps1");
        writeFileSync(scriptPath, HOST_SCRIPT, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.ready = null;
        reject(
          new Error(
            `Could not write the input host script to a temporary file: ${detail}. ` +
              "Typing and media keys will not work until that is fixed.",
          ),
        );
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        // Exactly the invocation src/main/uia/WindowsElements.ts uses, execution-policy flag
        // included. The path is passed as its own argv entry with `shell` off, so a temp
        // directory containing spaces needs no quoting and cannot be re-split.
        child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { stdio: "pipe", windowsHide: true },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.cleanupScriptDir();
        this.ready = null;
        reject(new Error(`Could not start the input host: ${detail}`));
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        hostLog(`spawn -> TIMEOUT after ${Date.now() - spawnedAt}ms (budget=${STARTUP_TIMEOUT_MS}ms)`);
        reject(new Error("The input host did not start in time."));
      }, STARTUP_TIMEOUT_MS);

      // The handshake is the one untagged line the host ever prints.
      let started = false;
      const channel = new HostChannel(
        {
          write: (line: string) => child.stdin.write(`${line}\n`),
          kill: () => {
            child.kill();
          },
        },
        {
          onUntagged: (line: string) => {
            if (started) {
              hostLog(`unexpected untagged line verb=${verbOf(line)}`);
              return;
            }
            started = true;
            clearTimeout(timer);
            if (line === "READY") {
              hostLog(`spawn -> READY in ${Date.now() - spawnedAt}ms (budget=${STARTUP_TIMEOUT_MS}ms)`);
              resolve();
            } else {
              hostLog(`spawn -> UNEXPECTED first line after ${Date.now() - spawnedAt}ms`);
              reject(new Error(`The input host did not start cleanly: ${line}`));
            }
          },
          onLog: hostLog,
        },
      );
      this.channel = channel;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => channel.receive(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => {
        // Diagnostic only. A real failure surfaces through a rejected request instead —
        // stderr noise alone must never crash a live dictation session.
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        channel.failAll(new Error(`The input host failed: ${error.message}`));
        reject(new Error(`Could not start the input host: ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        hostLog(`host EXITED code=${code} signal=${signal} pending=${channel.pendingCount()}`);
        // The host died. Any request still waiting on a reply would otherwise hang forever.
        channel.failAll(new Error("The input host exited unexpectedly."));
        this.child = null;
        this.ready = null;
        this.cleanupScriptDir();
      });
    });

    return this.ready;
  }

  // Forget a dead or poisoned host so the next ensureStarted() builds a fresh one.
  private teardown(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
    this.channel = null;
    this.cleanupScriptDir();
  }

  private cleanupScriptDir(): void {
    const dir = this.scriptDir;
    this.scriptDir = null;
    if (dir === null) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp directory we could not remove is not worth failing a key press over; the OS
      // clears %TEMP% eventually.
    }
  }

  private async request(command: string, budgetMs: number): Promise<string> {
    await this.ensureStarted();
    const channel = this.channel;
    if (channel === null || this.disposed) {
      throw new Error("The input host is not running.");
    }
    return channel.request(command, budgetMs);
  }

  async getForegroundWindow(): Promise<ForegroundWindow | null> {
    // No chunked work, so the base budget — numerically identical to the flat 5s this used
    // before the budgets were derived.
    const line = await this.request("FG", budgetFor(0));
    if (line === "FG NONE") return null;

    const match = /^FG (-?\d+) (\S*)$/.exec(line);
    if (!match) {
      throw new Error(
        `The input host returned an unreadable foreground reply: ${line}`,
      );
    }
    const [, handleText, titleB64] = match;
    const handle = Number(handleText);
    const title =
      titleB64 && titleB64.length > 0 ? decodeBase64Utf16(titleB64) : null;
    return { handle, title: title && title.length > 0 ? title : null };
  }

  async typeText(text: string): Promise<void> {
    if (text.length === 0) return;
    const payload = encodeBase64Utf16(text);

    // SCALED BY LENGTH, because the host sleeps CHUNK_DELAY_MS per character. A flat budget
    // killed any transcript over 500 characters — see the budget table at the top.
    let line: string;
    try {
      line = await this.request(`TYPE ${payload}`, budgetFor(text.length));
    } catch (error) {
      if (error instanceof HostTimeoutError) {
        // SAY THAT TEXT MAY ALREADY BE IN THE DOCUMENT. A timed-out TYPE is not "nothing
        // happened": the host types one character at a time, so a request that did not confirm
        // may have delivered some, most, or all of it into whatever had focus. Claiming it
        // failed would send the user looking for text that is already there, and retrying
        // would double it — so nothing is retried and the uncertainty is stated.
        throw new Error(unconfirmedOutcomeMessage("TYPE"));
      }
      throw error;
    }

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

  // M18. The same request/reply shape as typeText, and the same refusal to swallow a short
  // write. `count` arrives already resolved by core/media.ts's `pressesFor` - this is the
  // transport and decides no policy - but the range is re-checked here anyway, because a
  // keycode is the one value in this file that reaches the OS verbatim.
  async pressKey(vk: number, count: number): Promise<void> {
    if (!Number.isInteger(vk) || vk < 1 || vk > 254) {
      throw new Error(`Refusing to press a virtual key outside 1-254: ${vk}`);
    }
    if (!Number.isInteger(count) || count < 1) return;

    // Scaled by press count for the same reason TYPE is, from the same constants.
    let line: string;
    try {
      line = await this.request(`KEY ${vk} ${count}`, budgetFor(count));
    } catch (error) {
      if (error instanceof HostTimeoutError) {
        // SAY THAT IT MAY ALREADY HAVE HAPPENED, and say why nothing was retried. For a toggle
        // this is the whole point: pressing mute or play/pause a second time would UNDO the
        // thing the user asked for, so an unconfirmed press must never be repeated
        // automatically. The honest report is the uncertainty.
        throw new Error(unconfirmedOutcomeMessage("KEY"));
      }
      throw error;
    }

    if (line.startsWith("KEY OK")) return;

    if (line.startsWith("KEY ERR")) {
      const match = /^KEY ERR (\d+) (\d+) (-?\d+)$/.exec(line);
      if (match) {
        const [, sent, expected, win32Error] = match;
        throw new Error(
          `The key press was blocked partway through (${sent}/${expected} events delivered, ` +
            `Win32 error ${win32Error}) - most likely the focused window has higher ` +
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
