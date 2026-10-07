// Investigating a live dictation finding (post-M18): "My name is Sejal, not Angel." was typed
// as "My aame is Sejal, not Angel." with the Heard line and the Typed log both correct — so the
// damage happened between `typeText()` and the document.
//
//   npx vite-node scripts/typing-fidelity-probe.ts -- --i-understand-this-types-into-my-windows --label worktree
//   npx vite-node scripts/typing-fidelity-probe.ts -- --i-understand-this-types-into-my-windows --label head --injector <path to another WindowsInputInjector.ts>
//
// Without that flag it prints its warning and exits 1 without spawning or opening anything.
//
// THIS SCRIPT USES THE KEYBOARD. It types through the real SendInput host into whatever has
// focus, so it opens its own Notepad document and refuses to type a character unless that
// document is the foreground window AND reads back with the sentinel it was created with.
// To stop it: click any other window. It takes focus once at startup and never again; the first
// time its document is not foreground it stops for good (the sentence in flight, at most 28
// characters, still lands wherever focus went).
//
// Like scripts/input-host-bench.ts it IMPORTS THE REAL CLASS rather than copying HOST_SCRIPT —
// and takes the path as an argument, so the same harness can drive the working tree's injector
// and the last commit's (from a separate git worktree) and tell a regression from an older bug.
//
// It mirrors DictationSession's shape per sentence: FG, then one TYPE of the exact text. Nothing
// else is typed — no separators, no newlines — because the read-back happens after EVERY
// sentence and the newly appended text is that sentence's result.
//
// The read-back is UI Automation on the document element, never the clipboard and never the
// log: CLAUDE.md, "a log line proves what the app decided, not what the user saw".

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]!;
};

const SENTENCE = "My name is Sejal, not Angel.";
const SENTINEL = "[[typing-probe-sentinel]]";
const COUNT = Number(flag("--count", "200"));
const GAP_MS = Number(flag("--gap", "0"));
const LABEL = flag("--label", "worktree");
const INJECTOR_PATH = resolve(flag("--injector", "src/main/shell/WindowsInputInjector.ts"));
const OUT_DIR = resolve(flag("--out", tmpdir()));

// THE CONSENT GATE. This script sends real keystrokes to whatever window is in front, and it has
// already gone wrong once: on its first run focus left the probe document and sentence
// fragments were typed into another application — one of them a chat box, where they were sent.
// So it does nothing at all — no host spawned, no Notepad opened — unless this flag is passed,
// and the warning is printed every time, flag or not.
const CONSENT_FLAG = "--i-understand-this-types-into-my-windows";
const WARNING = [
  "",
  "WARNING: this script TYPES ON YOUR KEYBOARD.",
  `  It sends ${COUNT} x ${SENTENCE.length} real keystrokes through SendInput, which go to WHATEVER WINDOW`,
  "  IS IN FRONT. It opens its own Notepad document and checks that document is in front before",
  "  each sentence, but a sentence already in flight (up to 28 characters) lands wherever focus",
  "  goes. It has typed into the wrong window before.",
  "  While it runs: do not touch the keyboard or mouse, and close anything you would not want",
  "  text typed into. To stop it: click any other window; it stops before the next sentence.",
  `  Expect about ${Math.ceil((COUNT * 1.6) / 60)} minute(s) for ${COUNT} sentences.`,
  "",
].join("\n");

console.log(WARNING);
if (!argv.includes(CONSENT_FLAG)) {
  console.error(`Refusing to run: pass ${CONSENT_FLAG} to confirm. Nothing was typed or opened.`);
  process.exit(1);
}

interface Fg {
  handle: number;
  title: string | null;
}
interface Injector {
  getForegroundWindow(): Promise<Fg | null>;
  typeText(text: string): Promise<void>;
  dispose(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- The reader: a second, separate PowerShell host that only LOOKS -------------------------
// FIND <title fragment> -> "HWND <n>" | "NONE"
// ACTIVATE <hwnd>       -> "ACTIVATE <True|False>"   (SetForegroundWindow; injects no input)
// READ <hwnd>           -> "TEXT <class> <base64 utf16le>" | "ERR ..."
const READER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TypingProbeWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    // A background process is not normally allowed to take the foreground. Attaching to the
    // current foreground thread's input queue for the duration of the call is the standard way
    // to be allowed to, and it sends no keyboard or mouse input.
    public static bool Activate(IntPtr h) {
        uint pid;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        if (IsIconic(h)) ShowWindow(h, 9);
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return ok;
    }
}
'@
$A = [System.Windows.Automation.AutomationElement]
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$editCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$cond = New-Object System.Windows.Automation.OrCondition (,[System.Windows.Automation.Condition[]]@($docCond, $editCond))
Write-Output "READY"
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try {
        if ($line.StartsWith("FIND ")) {
            $frag = $line.Substring(5)
            $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$frag*" } | Select-Object -First 1
            if ($null -eq $p) { Write-Output "NONE" } else { Write-Output "HWND $($p.MainWindowHandle.ToInt64())" }
        } elseif ($line.StartsWith("ACTIVATE ")) {
            $h = [IntPtr][int64]$line.Substring(9)
            Write-Output "ACTIVATE $([TypingProbeWin]::Activate($h))"
        } elseif ($line.StartsWith("READ ")) {
            $h = [IntPtr][int64]$line.Substring(5)
            $root = $A::FromHandle($h)
            $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            $text = $null
            $cls = "-"
            foreach ($el in $els) {
                $pat = $null
                if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
                    $text = $pat.DocumentRange.GetText(-1)
                    if ($el.Current.ClassName) { $cls = $el.Current.ClassName }
                    break
                }
            }
            if ($null -eq $text) {
                Write-Output "ERR no-text-element"
            } else {
                Write-Output "TEXT $cls $([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($text)))"
            }
        } else {
            Write-Output "ERR unknown-command"
        }
    } catch {
        Write-Output ("ERR " + ($_.Exception.Message -replace "[\\r\\n]+", " "))
    }
}
`;

class Reader {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly lines: string[] = [];
  private waiter: ((line: string) => void) | null = null;

  constructor(dir: string) {
    const path = join(dir, "reader.ps1");
    writeFileSync(path, READER_SCRIPT, "utf8");
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path],
      { stdio: "pipe", windowsHide: true },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, "");
        this.buffer = this.buffer.slice(i + 1);
        if (line.length === 0) continue;
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w(line);
        } else this.lines.push(line);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => process.stderr.write(`[reader stderr] ${chunk}`));
  }

  next(timeoutMs: number): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        rej(new Error("The reader host did not respond in time."));
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        res(line);
      };
    });
  }

  ask(command: string, timeoutMs = 15_000): Promise<string> {
    this.child.stdin.write(`${command}\n`);
    return this.next(timeoutMs);
  }

  async find(fragment: string): Promise<number | null> {
    const line = await this.ask(`FIND ${fragment}`, 30_000);
    const m = /^HWND (-?\d+)$/.exec(line);
    return m ? Number(m[1]) : null;
  }

  async read(hwnd: number): Promise<{ cls: string; text: string }> {
    const line = await this.ask(`READ ${hwnd}`);
    const m = /^TEXT (\S+) (\S*)$/.exec(line);
    if (!m) throw new Error(`Could not read the document back: ${line}`);
    return { cls: m[1]!, text: Buffer.from(m[2]!, "base64").toString("utf16le") };
  }

  dispose(): void {
    this.child.kill();
  }
}

// The typed text, with the sentinel the file was created with removed. The caret may start at
// either end of the document, so the sentinel may end up before or after what gets typed. null
// means the sentinel is damaged or gone — this is no longer provably our document.
function bodyOf(text: string): string | null {
  const t = text.replace(/[\r\n]+$/, "");
  if (t.endsWith(SENTINEL)) return t.slice(0, t.length - SENTINEL.length);
  if (t.startsWith(SENTINEL)) return t.slice(SENTINEL.length);
  return null;
}

// --- Where a mismatch falls -----------------------------------------------------------------
interface EditOp {
  op: "sub" | "del" | "ins";
  pos: number; // index into the EXPECTED sentence (for ins: the index it was inserted before)
  expected: string;
  got: string;
  note: string;
}

function align(expected: string, actual: string): EditOp[] {
  const n = expected.length;
  const m = actual.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array<number>(m + 1).fill(0));
    d[i]![0] = i;
  }
  for (let j = 0; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = expected[i - 1] === actual[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  const ops: EditOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1)) {
      if (expected[i - 1] !== actual[j - 1]) {
        const e = expected[i - 1]!;
        const g = actual[j - 1]!;
        const note =
          g === expected[i] ? "got the NEXT expected char" : g === expected[i - 2] ? "got the PREVIOUS expected char" : "";
        ops.push({ op: "sub", pos: i - 1, expected: e, got: g, note });
      }
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: "del", pos: i - 1, expected: expected[i - 1]!, got: "", note: "" });
      i--;
    } else {
      const g = actual[j - 1]!;
      const note = g === expected[i - 1] ? "repeat of the char before it" : g === expected[i] ? "duplicate of the char after it" : "";
      ops.push({ op: "ins", pos: i, expected: "", got: g, note });
      j--;
    }
  }
  return ops.reverse();
}

interface Iteration {
  n: number;
  typeMs: number;
  actual: string;
  ok: boolean;
  excluded: string | null; // why this iteration cannot be trusted as a typing result
  error: string | null;
  ops: EditOp[];
}

const show = (s: string): string => JSON.stringify(s);

async function main(): Promise<void> {
  console.log(`[probe] label=${LABEL} count=${COUNT} gap=${GAP_MS}ms`);
  console.log(`[probe] injector: ${INJECTOR_PATH}`);
  console.log(`[probe] sentence: ${show(SENTENCE)} (${SENTENCE.length} UTF-16 code units)`);

  const mod = (await import(pathToFileURL(INJECTOR_PATH).href)) as { WindowsInputInjector: new () => Injector };
  const injector = new mod.WindowsInputInjector();

  const dir = mkdtempSync(join(tmpdir(), "typing-probe-"));
  const docName = `typing-probe-${LABEL}-${Date.now()}.txt`;
  const docPath = join(dir, docName);
  writeFileSync(docPath, SENTINEL, "utf8");
  const reader = new Reader(dir);

  const iterations: Iteration[] = [];
  let aborted: string | null = null;
  let docClass = "?";
  let finalBody = "";

  try {
    if ((await reader.next(30_000)) !== "READY") throw new Error("The reader host did not start cleanly.");

    // Warm the input host with a harmless FG. The last commit's `-Command -` host swallows its
    // first command, so a first-try timeout there is expected and is not this probe's subject.
    for (let attempt = 1; ; attempt++) {
      try {
        await injector.getForegroundWindow();
        console.log(`[probe] input host answered FG on attempt ${attempt}`);
        break;
      } catch (error) {
        console.log(`[probe] warm-up FG attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt >= 3) throw error;
      }
    }

    spawn("notepad.exe", [docPath], { detached: true, stdio: "ignore" }).unref();

    let hwnd: number | null = null;
    for (let i = 0; i < 30 && hwnd === null; i++) {
      await sleep(500);
      hwnd = await reader.find(docName);
    }
    if (hwnd === null) throw new Error(`No window titled *${docName}* appeared. Nothing was typed.`);
    const target = hwnd;
    console.log(`[probe] probe document window: hwnd=${target}`);

    const isTarget = (fg: Fg | null): boolean =>
      fg !== null && fg.handle === target && fg.title !== null && fg.title.includes(docName);

    const waitForFocus = async (budgetMs: number): Promise<boolean> => {
      const until = Date.now() + budgetMs;
      let nagged = 0;
      for (;;) {
        const fg = await injector.getForegroundWindow();
        if (isTarget(fg)) return true;
        if (Date.now() > until) return false;
        if (Date.now() - nagged > 5_000) {
          nagged = Date.now();
          const activated = await reader.ask(`ACTIVATE ${target}`);
          // Handle and a yes/no only — never the title of whatever else the user has open.
          console.log(
            `[probe] waiting for focus (foreground hwnd=${fg?.handle ?? "none"}, want ${target}, ` +
              `title matches: ${fg?.title?.includes(docName) === true}, ${activated}) — CLICK INSIDE ${docName}`,
          );
        }
        await sleep(250);
      }
    };

    if (!(await waitForFocus(90_000))) throw new Error("The probe document never became the foreground window. Nothing was typed.");

    // Prove the reader before a single key: it must return exactly the sentinel the file holds.
    const first = await reader.read(target);
    docClass = first.cls;
    if (bodyOf(first.text) !== "") {
      throw new Error(`The read-back did not return the sentinel (got ${show(first.text.slice(0, 80))}). Nothing was typed.`);
    }
    console.log(`[probe] read-back verified against the sentinel (control class ${docClass}). Typing starts in 3s — hands off the keyboard.`);
    await sleep(3_000);

    let prev = "";
    for (let n = 1; n <= COUNT; n++) {
      // THE KILL SWITCH, and it must never fight the user. Focus is taken ONCE, at startup; from
      // here on, the document not being foreground ends the run on the spot. An earlier version
      // waited and re-activated the window every 5s — which meant clicking away to stop it got
      // focus yanked back, and sentences were typed into whatever the user had clicked.
      if (!isTarget(await injector.getForegroundWindow())) {
        aborted = `focus was not on the probe document before sentence ${n} — stopped, nothing more typed`;
        break;
      }

      const it: Iteration = { n, typeMs: 0, actual: "", ok: false, excluded: null, error: null, ops: [] };
      const t0 = Date.now();
      try {
        await injector.typeText(SENTENCE);
      } catch (error) {
        it.error = error instanceof Error ? error.message : String(error);
      }
      it.typeMs = Date.now() - t0;

      // TYPE OK means SendInput accepted the events, not that Notepad has drawn them. Read until
      // two consecutive reads agree.
      let body: string | null = null;
      let last: string | null | undefined;
      await sleep(120);
      for (let tries = 0; tries < 25; tries++) {
        body = bodyOf((await reader.read(target)).text);
        if (body === last) break;
        last = body;
        await sleep(80);
      }

      if (body === null) {
        aborted = `the sentinel was damaged or gone after sentence ${n} — stopped typing`;
        it.excluded = "sentinel lost";
        iterations.push(it);
        break;
      }
      if (!body.startsWith(prev)) it.excluded = "text typed BEFORE this sentence changed";
      else if (!isTarget(await injector.getForegroundWindow())) it.excluded = "focus left the document during this sentence";
      else if (it.error !== null) it.excluded = "typeText threw";

      it.actual = body.slice(prev.length);
      it.ok = it.excluded === null && it.actual === SENTENCE;
      if (!it.ok) it.ops = align(SENTENCE, it.actual);
      prev = body;
      iterations.push(it);

      if (!it.ok) console.log(`[probe] #${n} MISMATCH ${show(it.actual)}${it.excluded ? ` (EXCLUDED: ${it.excluded})` : ""}`);
      else if (n % 20 === 0) console.log(`[probe] ${n}/${COUNT} typed, ${iterations.filter((x) => !x.ok).length} mismatched so far`);

      if (it.excluded !== null) {
        aborted = `sentence ${n}: ${it.excluded} — stopped, nothing more typed`;
        break;
      }
      if (GAP_MS > 0) await sleep(GAP_MS);
    }

    // One last read a full second later: anything that arrived late shows up as a difference
    // between this and what the per-sentence reads added up to.
    await sleep(1_000);
    finalBody = bodyOf((await reader.read(target)).text) ?? "<sentinel lost>";
    if (finalBody !== prev) console.log("[probe] WARNING: the document changed after the last per-sentence read");
  } catch (error) {
    aborted = error instanceof Error ? error.message : String(error);
  } finally {
    injector.dispose();
    reader.dispose();
  }

  // --- Report ---------------------------------------------------------------------------------
  const counted = iterations.filter((x) => x.excluded === null);
  const bad = counted.filter((x) => !x.ok);
  const excluded = iterations.filter((x) => x.excluded !== null);
  const times = counted.map((x) => x.typeMs).sort((a, b) => a - b);
  const median = times.length > 0 ? times[Math.floor(times.length / 2)]! : 0;

  console.log("");
  console.log(`=== ${LABEL} ===`);
  if (aborted !== null) console.log(`ABORTED: ${aborted}`);
  console.log(`sentences typed: ${iterations.length}   counted: ${counted.length}   excluded: ${excluded.length}`);
  console.log(`mismatched: ${bad.length}/${counted.length}`);
  console.log(`typeText() ms: min ${times[0] ?? 0}  median ${median}  max ${times[times.length - 1] ?? 0}`);
  console.log(`final document == sum of per-sentence reads: ${finalBody === iterations.map((x) => x.actual).join("")}`);

  const byPos = new Map<number, EditOp[]>();
  for (const it of bad) for (const op of it.ops) byPos.set(op.pos, [...(byPos.get(op.pos) ?? []), op]);
  if (bad.length > 0) {
    console.log("");
    console.log("by position in the sentence (CHUNK_SIZE_CHARS is 1, so every position is its own chunk):");
    for (let p = 0; p <= SENTENCE.length; p++) {
      const ops = byPos.get(p);
      if (!ops) continue;
      const kinds = new Map<string, number>();
      for (const op of ops) {
        const key = `${op.op} ${show(op.expected)}->${show(op.got)}${op.note ? ` [${op.note}]` : ""}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      const where = p === 0 ? "FIRST char" : p >= SENTENCE.length - 1 ? "LAST char" : SENTENCE[p - 1] === " " ? "first char of a word" : "";
      console.log(`  pos ${String(p).padStart(2)} ${show(SENTENCE[p] ?? "<end>")} ${where}`);
      for (const [key, c] of kinds) console.log(`      ${c}x ${key}`);
    }
    console.log("");
    console.log("every mismatch:");
    for (const it of bad) console.log(`  #${String(it.n).padStart(3)} ${it.typeMs}ms ${show(it.actual)}`);
  }
  for (const it of excluded) console.log(`  excluded #${it.n}: ${it.excluded} ${show(it.actual)}${it.error ? ` — ${it.error}` : ""}`);

  const outPath = join(OUT_DIR, `typing-fidelity-${LABEL}-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ label: LABEL, injector: INJECTOR_PATH, sentence: SENTENCE, count: COUNT, gapMs: GAP_MS, docClass, aborted, finalBody, iterations }, null, 2),
    "utf8",
  );
  console.log("");
  console.log(`full results: ${outPath}`);
  console.log(`The Notepad document (${docName}) is left open for inspection — close it without saving.`);
}

void main().then(() => process.exit(0));
