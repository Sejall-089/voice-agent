import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PointerPoint, PointerPressSource } from "./PointerPressSource.ts";

// The real PointerPressSource (M27, fix B): a PERSISTENT PowerShell host, in the style of
// WindowsInputInjector — the script written to a file and run with `-File` (never `-Command -`,
// which swallows the first command: see that file), `Add-Type` compiled once, one line per
// message over stdin/stdout.
//
// A background thread in the host polls GetAsyncKeyState for the mouse buttons every POLL_MS and
// sends what it read, with the pointer from GetCursorPos. It decides nothing: whether a sample is
// a PRESS — the first one discarded, both bits read — is `judgeSample`, below, in TypeScript,
// because a rule inside the C# string is one no test can run (a mutation removing the discard
// survived every test until it moved here). The PowerShell loop only takes commands, so samples
// arrive while no command is pending.
//
// EVERY NUMBER HERE WAS MEASURED FIRST (scripts/pill-outside-click-recon.cjs, 2026-10-22):
//
//   * BOTH BITS. The high bit (down right now) alone missed clicks shorter than the poll
//     interval: at 50 ms it caught every click held 30 ms or more, but only a quarter of 5-15 ms
//     taps. The low bit (pressed since the last call) caught all of them, 48 of 48 across both
//     intervals. Windows documents that another process polling the same state can take the low
//     bit first — so a very short tap can be missed if one is; that is on the live checklist.
//   * 50 ms. Press -> noticed: median 32 ms, max 63 ms (100 ms: median 47, max 98).
//   * CPU while polling: below what Windows measures — 0 ms of processor time in 8 s.
//   * Start-up: about 1.5 s to READY. So it is PREPARED when the pill first appears, not at the
//     click that opens the list.
//   * PRIMED: the first read after WATCH is never a press, low bit included, so the press that
//     opened the list is never reported (measured: 0 of 1). `judgeSample`.
//   * Mouse buttons only: F24, a window hiding and re-showing, a message box and the pill hidden
//     and re-shown produced 0 presses.
//
// Protocol:
//   WATCH <ms>   -> "WATCHING"        start polling; the first read is sent at once, marked first
//   STOP         -> "STOPPED"         stop polling; the thread is joined, so nothing is polled
//   QUIT                              exit
//   (async)      -> "SAMPLE <first 0|1> <down mask> <low mask> <x> <y>"
//                                     sent for the first read, then whenever what is down changes
//                                     or a low bit is set — never every poll while nothing happens

// Left, right, middle, X1, X2. NOTHING ELSE: a keyboard key is never a press.
export const WATCHED_BUTTONS: readonly number[] = [1, 2, 4, 5, 6];
export const POLL_MS = 50;
const STARTUP_TIMEOUT_MS = 10_000;

// One read of the mouse buttons: bit i of `down` and `low` is WATCHED_BUTTONS[i].
export interface PointerSample {
  // The first read after WATCH.
  first: boolean;
  // Down right now (GetAsyncKeyState's high bit).
  down: number;
  // Pressed since the previous read (its low bit) — how a press shorter than the poll is seen.
  low: number;
  point: PointerPoint;
}

export type PointerLine =
  | { type: "ready" }
  | { type: "sample"; sample: PointerSample }
  | { type: "other"; line: string };

// One line from the host. Only a well-formed SAMPLE is a sample: anything else — an
// acknowledgement, an error, half a line — is not, so a garbled line can never close the list.
export function parsePointerLine(raw: string): PointerLine {
  const line = raw.trim();
  if (line === "READY") return { type: "ready" };
  const match = /^SAMPLE ([01]) (\d+) (\d+) (-?\d+) (-?\d+)$/.exec(line);
  if (match) {
    return {
      type: "sample",
      sample: {
        first: match[1] === "1",
        down: Number(match[2]),
        low: Number(match[3]),
        point: { x: Number(match[4]), y: Number(match[5]) },
      },
    };
  }
  return { type: "other", line };
}

// IS THIS SAMPLE A PRESS? `wasDown` is what was down at the previous sample of this watch, or
// null before the first.
//
// PRIMED: the first sample after watching starts is NEVER a press, whatever its bits say — a
// button already held down when the list opened, or one pressed and released before it (the
// click that opened the list leaves its low bit set). It only records what is down. A sample
// arriving with nothing recorded yet is treated the same way: it belongs to a watch that has
// since been stopped and restarted.
//
// After that, BOTH BITS: a button that went down since the last sample (the high bit), or one
// pressed and released between two samples (the low bit — measured to be the only thing that
// catches a click shorter than the poll). A button merely still held is not a new press.
export function judgeSample(wasDown: number | null, sample: PointerSample): { press: boolean; wasDown: number } {
  if (sample.first || wasDown === null) return { press: false, wasDown: sample.down };
  const press = (sample.down & ~wasDown) !== 0 || sample.low !== 0;
  return { press, wasDown: sample.down };
}

export function hostScript(buttons: readonly number[] = WATCHED_BUTTONS): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class VoiceAgentPointer {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  static readonly int[] Buttons = { ${buttons.join(", ")} };
  static Thread worker;
  static volatile bool running;
  static int interval;

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

  // A SAMPLER, deciding nothing: which buttons are down (the high bit) and which were pressed
  // since the last read (the low bit), as bit masks, with the pointer. The first read after
  // WATCH is always sent, marked first; after it, only a change in what is down or a low bit
  // set. Whether a sample is a press is decided in TypeScript (judgeSample), where a test can
  // reach it.
  static void Loop() {
    bool first = true;
    int prevDown = -1;
    while (running) {
      if (!first) {
        Thread.Sleep(interval);
        if (!running) break;
      }
      int down = 0, low = 0;
      for (int i = 0; i < Buttons.Length; i++) {
        short s = GetAsyncKeyState(Buttons[i]);
        if ((s & 0x8000) != 0) down |= 1 << i;
        if ((s & 1) != 0) low |= 1 << i;
      }
      if (first || down != prevDown || low != 0) {
        POINT p;
        GetCursorPos(out p);
        Console.Out.WriteLine("SAMPLE " + (first ? 1 : 0) + " " + down + " " + low + " " + p.X + " " + p.Y);
      }
      prevDown = down;
      first = false;
    }
  }
}
'@
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "QUIT") { [VoiceAgentPointer]::Stop(); break }
  if ($line.StartsWith("WATCH ")) {
    [VoiceAgentPointer]::Start([int]$line.Substring(6))
    [Console]::Out.WriteLine("WATCHING")
  } elseif ($line -eq "STOP") {
    [VoiceAgentPointer]::Stop()
    [Console]::Out.WriteLine("STOPPED")
  } else {
    [Console]::Out.WriteLine("ERR unknown-command")
  }
}
`;
}

// Just enough of a child process to host the script. The real one wraps node's `spawn`; tests
// hand in a fake that is asynchronous the way a real process is.
export interface PointerHost {
  write(line: string): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  kill(): void;
}

export interface WindowsPointerWatcherOptions {
  spawnHost?: (scriptPath: string) => PointerHost;
  // Where the script file goes; the real one makes a fresh temp directory.
  scriptDir?: () => string;
  startupTimeoutMs?: number;
  pollMs?: number;
}

function spawnPowerShell(scriptPath: string): PointerHost {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: "pipe", windowsHide: true },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", () => {
    // Diagnostic only; a failure surfaces as a missing READY or an exit.
  });
  return {
    write: (line) => void child.stdin.write(`${line}\n`),
    onData: (listener) => void child.stdout.on("data", listener),
    onExit: (listener) => void child.on("exit", listener),
    onError: (listener) => void child.on("error", listener),
    kill: () => void child.kill(),
  };
}

export class WindowsPointerWatcher implements PointerPressSource {
  private host: PointerHost | null = null;
  private ready: Promise<void> | null = null;
  private started = false;
  private dead = false;
  private dir: string | null = null;
  private onPress: ((point: PointerPoint) => void) | null = null;
  // What was down at the last sample of the current watch, or null before its first (judgeSample).
  private wasDown: number | null = null;
  private readonly failureListeners: ((reason: string) => void)[] = [];
  private buffer = "";

  constructor(private readonly options: WindowsPointerWatcherOptions = {}) {}

  prepare(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let host: PointerHost;
      try {
        this.dir = (this.options.scriptDir ?? (() => mkdtempSync(join(tmpdir(), "va-pointer-"))))();
        const scriptPath = join(this.dir, "pointer.ps1");
        writeFileSync(scriptPath, hostScript(), "utf8");
        host = (this.options.spawnHost ?? spawnPowerShell)(scriptPath);
      } catch (error) {
        this.cleanup();
        reject(new Error(`The pointer watcher could not start: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.host = host;
      const timer = setTimeout(() => {
        if (this.started) return;
        this.dead = true;
        host.kill();
        reject(new Error("The pointer watcher did not start in time."));
      }, this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);

      host.onData((chunk) => {
        this.buffer += chunk;
        let at: number;
        while ((at = this.buffer.indexOf("\n")) >= 0) {
          const parsed = parsePointerLine(this.buffer.slice(0, at));
          this.buffer = this.buffer.slice(at + 1);
          if (parsed.type === "ready" && !this.started) {
            this.started = true;
            clearTimeout(timer);
            resolve();
          } else if (parsed.type === "sample") {
            // Only while watching: a sample that arrives after STOP was read before it, for a
            // list that has since closed.
            if (this.onPress === null) continue;
            const judged = judgeSample(this.wasDown, parsed.sample);
            this.wasDown = judged.wasDown;
            if (judged.press) this.onPress(parsed.sample.point);
          }
        }
      });
      host.onError((error) => {
        clearTimeout(timer);
        this.fail(`The pointer watcher failed: ${error.message}`, reject);
      });
      host.onExit(() => {
        clearTimeout(timer);
        this.fail("The pointer watcher exited.", reject);
      });
    });
    return this.ready;
  }

  watch(onPress: (point: PointerPoint) => void): void {
    if (!this.started || this.dead || this.host === null) return;
    this.onPress = onPress;
    // A fresh watch: its first sample primes, whatever an earlier watch left behind.
    this.wasDown = null;
    this.host.write(`WATCH ${this.options.pollMs ?? POLL_MS}`);
  }

  stop(): void {
    this.onPress = null;
    if (!this.started || this.dead || this.host === null) return;
    this.host.write("STOP");
  }

  onFailure(listener: (reason: string) => void): void {
    this.failureListeners.push(listener);
  }

  dispose(): void {
    this.onPress = null;
    if (this.host !== null && !this.dead) {
      this.dead = true;
      this.host.write("QUIT");
      this.host.kill();
    }
    this.host = null;
    this.cleanup();
  }

  // Before READY, a failure rejects `prepare`; after it, the listeners are told. Either way it is
  // said once, and nothing is reported or written to the host again.
  private fail(reason: string, reject: (error: Error) => void): void {
    const wasStarted = this.started;
    const alreadyDead = this.dead;
    this.dead = true;
    this.onPress = null;
    this.cleanup();
    if (!wasStarted) {
      reject(new Error(reason));
      return;
    }
    if (!alreadyDead) for (const listener of this.failureListeners) listener(reason);
  }

  private cleanup(): void {
    const dir = this.dir;
    this.dir = null;
    if (dir === null || this.options.scriptDir !== undefined) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS clears %TEMP% eventually.
    }
  }
}
