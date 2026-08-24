import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speechEngineError } from "../errors.ts";
import type { SpeechSynthesizer } from "../types.ts";

// Local text-to-speech (M14). Wraps a prebuilt Piper binary — nothing leaves the machine, no
// cloud TTS, no API key. Behind the SpeechSynthesizer interface exactly as whisper.cpp sits
// behind Transcriber, and for the same reasons: tests inject a fake and never need a model, and
// swapping in ElevenLabs later touches this file and nothing else.
//
// The exe and model paths are CONSTRUCTOR ARGUMENTS: /core never reads process.env (spec §10).
// main.ts reads .env and injects them, same as the whisper paths and the Slack webhook.
//
// Why a spawned binary rather than a native binding: the same answer M7 gave. This repo already
// rebuilds better-sqlite3 twice on every install, and a second native addon would double that
// fragility. It also means the pip-installed `piper.exe` and the archived standalone build are
// interchangeable here — which one is installed is a README decision, not an architecture one.
//
// WHAT IS PROVEN AND WHAT IS NOT, stated plainly because M13 got this split wrong once:
// everything below that shapes a REQUEST — the flag spelling, what the engine does with the
// text — can only be verified by running the real thing. Everything that decides WHAT THE USER
// IS TOLD when it goes wrong is ordinary branching, and it is tested (tests/piper.test.ts)
// against a stand-in binary that reproduces each failure on demand.
//
// COLD-START FIX (post-M14). Reloading the model per utterance cost ~3s every time, live-measured
// against piper-tts 1.7.0. Recon (`--help`, the installed package's own `__main__.py`) settled
// two things a from-memory design would have gotten wrong: an HTTP mode exists but needs Flask
// (not installed) and binds 0.0.0.0 by default — the wrong trade for a local-only app — and the
// persistent mode is NOT `-f/--output_file` (which appends every line into ONE wav); it's
// `--output-dir`, which writes one timestamped file per line and announces each with
// `INFO:__main__:Wrote <path>` on stderr once the file is closed. Measured warm: ~2.9s to load
// the model on the first call, then 108–160ms after — about 20x.
//
// A warm process fails in ways a fresh spawn never had to consider, also found by running it:
// a blank line reaching stdin produces no output and no error (a hang, not an exit — this is why
// the empty-text guard below must run before ANY text reaches the process, not just be present
// somewhere), and a line with nothing phonemizable (e.g. "...") crashes the process outright
// (`wave.Error: # channels not specified`) and takes every call still queued behind it down with
// it. That crash isn't new — the old per-spawn path exits 1 on the same input — warm mode just
// makes it fatal to the session instead of to one call. The fix is restart, never retry: the line
// that killed the process would kill its replacement too.
export interface PiperOptions {
  exePath: string;
  modelPath: string;
  timeoutMs?: number;
  // Where the voice files live. Passed through so nothing is ever downloaded at synthesis time:
  // a "nothing leaves the machine" feature must not make a network call on its first utterance.
  dataDir?: string;
  // Extra environment for the child, MERGED OVER the UTF-8 defaults below rather than replacing
  // them. Present so a caller can override; not required for correct behaviour.
  env?: Record<string, string>;
  // The archived rhasspy/piper v1.2.0 build spells these `--model` / `--output_file`; the
  // maintained piper1-gpl uses `-m` / `-f`. Recon's `--help` dump says which this install takes.
  //
  // Also the switch between the two run strategies below: `--output-dir` streaming was only
  // confirmed against the maintained build, since the archived one isn't installed anywhere this
  // could be tested. Rather than assume it also supports the flag, legacy installs keep the
  // original spawn-per-utterance path — slower, but every line of it already proven.
  legacyFlags?: boolean;
  // Arguments that come BEFORE piper's own flags. The maintained build is a Python package, so
  // when its console shim is not on PATH the working invocation is the module form —
  // `exePath: "python", argsPrefix: ["-m", "piper"]` — rather than a binary. The tests use the
  // same seam to point at their stand-in, which is a convenience, not the reason it exists.
  argsPrefix?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

// NOT a preference — a property of the engine, measured. Recon's Q6 synthesized the same
// sentence twice, with and without these set, and only the second came back intelligible: the
// engine decodes stdin with the locale codepage on Windows, so an en dash arrived as the
// Windows-1252 reading of its UTF-8 bytes and was voiced as "â €". Confirmed to still hold on a
// long-lived pipe, not just a one-shot spawn, when the warm path was built.
//
// It lives HERE rather than in main.ts's composition on purpose. Composition is where choices
// go; this is a fact about how this engine has to be invoked to work at all, and a fact that a
// future caller can forget is a bug waiting to happen. Callers can still override it through
// `env`, which merges over these.
const UTF8_ENV: Record<string, string> = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

// One line of the warm process's stderr, once it has actually finished writing a file.
const WROTE_LINE = /Wrote (.+\.wav)\s*$/;

// The warm process and the bookkeeping tied to its lifetime. Replaced wholesale on restart
// rather than reset in place, so a stray event from a process that has already been superseded
// can be told apart by identity (`this.warmProcess === proc`) instead of by a flag that could
// be forgotten to update.
interface WarmProcess {
  child: ChildProcessWithoutNullStreams;
  tempDir: string;
  stderrBuf: string;
  alive: boolean;
}

// The one utterance currently in flight on the warm process, if any. Only ever one at a time —
// `synthesize` enqueues everything through `queue` below — so stderr lines and process events
// can be routed to it without a request id.
interface WarmCall {
  proc: WarmProcess;
  pendingLines: string[];
  resolve: (wavPath: string) => void;
  reject: (error: Error) => void;
}

export class PiperSynthesizer implements SpeechSynthesizer {
  private readonly timeoutMs: number;
  private warmProcess: WarmProcess | null = null;
  private currentCall: WarmCall | null = null;
  // Every warm call is chained onto this, so a second `synthesize()` never writes to stdin
  // before the first one's WAV has been read, validated, and deleted. `.then(ok, ok)` at the
  // tail means a failed call still lets the chain advance — a rejection here would otherwise
  // wedge every later utterance behind one that already failed.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PiperOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async synthesize(text: string): Promise<Uint8Array> {
    // The engine exits non-zero on empty input (recon Q2), and on the warm path a blank line
    // reaching stdin doesn't even do that — it produces nothing at all, forever, so this guard
    // is the ONLY thing standing between an empty utterance and a hung queue. Callers are not
    // supposed to reach here with nothing — SpeechSession drops empty utterances — so this is
    // the second lock on the same door, but on the warm path it is load-bearing rather than
    // defensive.
    if (text.trim().length === 0) {
      throw speechEngineError("no-audio", "there was nothing to say");
    }

    if (this.options.legacyFlags === true) {
      return this.synthesizePerSpawn(text);
    }

    const call = this.queue.then(() => this.synthesizeWarm(text));
    this.queue = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  // Releases the warm process and its temp dir. Mirrors WindowsInputInjector's `dispose()` —
  // called once, from `will-quit`, so a ~100MB ONNX process never outlives the app.
  dispose(): void {
    const proc = this.warmProcess;
    this.warmProcess = null;
    if (proc === null) return;
    proc.alive = false;
    proc.child.stdin.end();
    proc.child.kill();
    void rm(proc.tempDir, { recursive: true, force: true }).catch(() => {
      // Best-effort. The OS temp dir gets cleaned eventually either way.
    });
  }

  // --- Warm path: one process, `--output-dir`, reused across calls ---

  private async synthesizeWarm(text: string): Promise<Uint8Array> {
    const wavPath = await this.sayOnWarmProcess(text);
    try {
      let bytes: Buffer;
      try {
        bytes = await readFile(wavPath);
      } catch {
        // Exit 0 (well, "Wrote" was announced) and no readable file. Same M11 rule as the
        // per-spawn path: a success report is not proof anything happened.
        throw speechEngineError("no-audio", "no file was written");
      }
      if (!isUsableWav(bytes)) {
        throw speechEngineError(
          "no-audio",
          `${bytes.byteLength} bytes, and not a readable WAV`,
        );
      }
      // Copied deliberately — see the per-spawn path below for why a raw readFile Buffer isn't
      // safe to hand out as-is.
      return Uint8Array.from(bytes);
    } finally {
      await unlink(wavPath).catch(() => {
        // A stray temp file is not worth failing an utterance over.
      });
    }
  }

  private async ensureWarmProcess(): Promise<WarmProcess> {
    if (this.warmProcess !== null && this.warmProcess.alive) return this.warmProcess;

    const { exePath, modelPath, dataDir, argsPrefix } = this.options;
    const tempDir = join(tmpdir(), `voice-agent-tts-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });

    const args = [
      ...(argsPrefix ?? []),
      "-m",
      modelPath,
      "--output-dir",
      tempDir,
    ];
    if (dataDir !== undefined) args.push("--data-dir", dataDir);

    const child = spawn(exePath, args, {
      windowsHide: true,
      env: { ...process.env, ...UTF8_ENV, ...this.options.env },
    });

    const proc: WarmProcess = { child, tempDir, stderrBuf: "", alive: true };
    this.warmProcess = proc;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onWarmStderr(proc, chunk));

    child.on("error", () => {
      // Same likeliest-mistake reasoning as the per-spawn path: the exe path in .env is wrong.
      proc.alive = false;
      if (this.warmProcess === proc) this.warmProcess = null;
      this.failCurrentCall(proc, speechEngineError("missing-binary", exePath));
    });

    // The process died — a crash on unspeakable input, or something external. Whatever call was
    // waiting on it is failed with the engine's own last word, exactly like a per-spawn non-zero
    // exit; the NEXT call gets a fresh process (see `ensureWarmProcess`'s alive check above).
    // Retrying the same text here would be wrong: recon confirmed the line that killed this
    // process kills its replacement too.
    child.on("close", (code) => {
      proc.alive = false;
      if (this.warmProcess === proc) this.warmProcess = null;
      const call = this.currentCall;
      if (call !== null && call.proc === proc) {
        const detail = lastLine(call.pendingLines.join("\n")) || `exit code ${code}`;
        this.failCurrentCall(proc, speechEngineError("failed", detail));
      }
      void rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    // A child that died before reading stdin surfaces through 'error'/'close' above; an EPIPE
    // here would otherwise become an unhandled rejection and take the app with it.
    child.stdin.on("error", () => {});

    return proc;
  }

  private onWarmStderr(proc: WarmProcess, chunk: string): void {
    proc.stderrBuf += chunk;
    let newline: number;
    while ((newline = proc.stderrBuf.indexOf("\n")) !== -1) {
      const line = proc.stderrBuf.slice(0, newline).trim();
      proc.stderrBuf = proc.stderrBuf.slice(newline + 1);
      if (line.length === 0) continue;

      const call = this.currentCall;
      if (call === null || call.proc !== proc) continue;

      const wrote = WROTE_LINE.exec(line);
      if (wrote?.[1] !== undefined) {
        this.currentCall = null;
        call.resolve(wrote[1]);
        continue;
      }
      // Not a completion line — could be this call's own error output, could be startup
      // logging. Held per-call rather than globally so a failure reports THIS utterance's last
      // line, never one left over from whatever the previous call printed.
      call.pendingLines.push(line);
    }
  }

  private failCurrentCall(proc: WarmProcess, error: Error): void {
    const call = this.currentCall;
    if (call === null || call.proc !== proc) return;
    this.currentCall = null;
    call.reject(error);
  }

  // Writes one line of text to the warm process and resolves with the WAV path it reports back.
  // `currentCall` is registered synchronously, before any await, so a process that fails
  // immediately (bad exe path) is guaranteed to find a call waiting to fail rather than racing
  // it — `child.on('error'/'close')` only ever fire on a later tick.
  private sayOnWarmProcess(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      void this.ensureWarmProcess().then((proc) => {
        const timer = setTimeout(() => this.timeoutCurrentCall(), this.timeoutMs);
        this.currentCall = {
          proc,
          pendingLines: [],
          resolve: (wavPath) => {
            clearTimeout(timer);
            resolve(wavPath);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        proc.child.stdin.write(text + "\n", "utf8");
      }, reject);
    });
  }

  // A late "Wrote" after the timeout would resolve into a queue slot the next call already
  // owns, so timing out KILLS the process rather than just giving up on this one call. The kill
  // is synchronous here (marks dead, clears `warmProcess`) so the very next call is guaranteed a
  // fresh spawn instead of racing the old process's own 'close' handler to do the same thing.
  private timeoutCurrentCall(): void {
    const call = this.currentCall;
    if (call === null) return;
    this.currentCall = null;
    call.proc.alive = false;
    if (this.warmProcess === call.proc) this.warmProcess = null;
    call.proc.child.kill();
    call.reject(speechEngineError("timeout", `${Math.round(this.timeoutMs / 1000)}s`));
  }

  // --- Per-spawn path: one process per utterance, unchanged from before this fix ---
  // Selected only when `legacyFlags` is set — the one build this repo cannot recon `--output-dir`
  // against, so its working (if slower) path is kept rather than replaced on an assumption.

  private async synthesizePerSpawn(text: string): Promise<Uint8Array> {
    const wavPath = join(tmpdir(), `voice-agent-tts-${randomUUID()}.wav`);

    try {
      await this.runPiper(text, wavPath);

      let bytes: Buffer;
      try {
        bytes = await readFile(wavPath);
      } catch {
        // Exit 0 and no file at all. M11's rule in a new place: a success report is not proof
        // anything happened, and playing nothing looks exactly like the app ignoring you.
        throw speechEngineError("no-audio", "no file was written");
      }

      if (!isUsableWav(bytes)) {
        throw speechEngineError(
          "no-audio",
          `${bytes.byteLength} bytes, and not a readable WAV`,
        );
      }

      // Copied deliberately. A Buffer from readFile can be a view into a POOLED ArrayBuffer with
      // a non-zero byteOffset, so handing it out as-is means anything reaching for `.buffer`
      // (a DataView over the header, say) silently reads someone else's memory. `from` copies
      // into a fresh buffer starting at zero.
      return Uint8Array.from(bytes);
    } finally {
      await unlink(wavPath).catch(() => {
        // A stray temp file is not worth failing an utterance over.
      });
    }
  }

  private runPiper(text: string, wavPath: string): Promise<void> {
    const { exePath, modelPath, dataDir, legacyFlags, argsPrefix } = this.options;
    const args = [
      ...(argsPrefix ?? []),
      ...(legacyFlags === true
        ? ["--model", modelPath, "--output_file", wavPath]
        : ["-m", modelPath, "-f", wavPath]),
    ];
    if (dataDir !== undefined) args.push("--data-dir", dataDir);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(exePath, args, {
        windowsHide: true,
        env: { ...process.env, ...UTF8_ENV, ...this.options.env },
      });

      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      child.on("error", () => {
        // Far and away the most likely setup mistake, and the one worth naming precisely: the
        // path in .env is wrong. Node reports it here rather than through an exit code.
        clearTimeout(timer);
        reject(speechEngineError("missing-binary", exePath));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            speechEngineError("timeout", `${Math.round(this.timeoutMs / 1000)}s`),
          );
          return;
        }
        if (code !== 0) {
          // The engine's own last word, verbatim. We do not interpret it: nobody has captured
          // what this stderr actually looks like yet, and inventing a mapping from it would be
          // M13's "every 403 means revoked" all over again.
          reject(speechEngineError("failed", lastLine(stderr) || `exit code ${code}`));
          return;
        }
        resolve();
      });

      // Text goes in on stdin, one utterance per call.
      child.stdin.on("error", () => {
        // A child that died before reading stdin surfaces through 'error'/'close' above; an
        // EPIPE here would otherwise become an unhandled rejection and take the app with it.
      });
      child.stdin.end(text, "utf8");
    });
  }
}

// Is this actually playable audio, or a file that merely exists?
//
// Pure and exported so the check is testable without an engine — and it is a real check rather
// than a size heuristic, because "exit 0, empty file" and "exit 0, error message written to the
// output path" are both things a CLI can do.
export function isUsableWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false;
  const tag = (at: number): string =>
    String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return false;

  // A header with no samples after it is silence, which is indistinguishable to a listener from
  // the app having ignored them.
  return bytes.byteLength > 44;
}

function lastLine(text: string): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}
