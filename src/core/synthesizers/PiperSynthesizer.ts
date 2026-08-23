import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
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

export interface PiperOptions {
  exePath: string;
  modelPath: string;
  timeoutMs?: number;
  // Where the voice files live. Passed through so nothing is ever downloaded at synthesis time:
  // a "nothing leaves the machine" feature must not make a network call on its first utterance.
  dataDir?: string;
  // Extra environment for the child. This exists for one specific, evidenced reason: recon
  // heard an en dash come back as the Windows-1252 reading of its UTF-8 bytes, which points at
  // the engine decoding stdin with the locale codepage. `PYTHONUTF8=1` is the fix if that
  // diagnosis holds (scripts/tts-recon.mjs's Q6 settles it). Injected rather than hardcoded so
  // the answer changes one line of composition, not this file.
  env?: Record<string, string>;
  // The archived rhasspy/piper v1.2.0 build spells these `--model` / `--output_file`; the
  // maintained piper1-gpl uses `-m` / `-f`. Recon's `--help` dump says which this install takes.
  legacyFlags?: boolean;
  // Arguments that come BEFORE piper's own flags. The maintained build is a Python package, so
  // when its console shim is not on PATH the working invocation is the module form —
  // `exePath: "python", argsPrefix: ["-m", "piper"]` — rather than a binary. The tests use the
  // same seam to point at their stand-in, which is a convenience, not the reason it exists.
  argsPrefix?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class PiperSynthesizer implements SpeechSynthesizer {
  private readonly timeoutMs: number;

  constructor(private readonly options: PiperOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async synthesize(text: string): Promise<Uint8Array> {
    // The engine exits non-zero on empty input (recon Q2), so this would be a confusing failure
    // rather than a silence. Callers are not supposed to reach here with nothing — SpeechSession
    // drops empty utterances — so this is the second lock on the same door.
    if (text.trim().length === 0) {
      throw speechEngineError("no-audio", "there was nothing to say");
    }

    // Piper writes a file rather than streaming a WAV to stdout, so the utterance lands in the
    // OS temp dir for the length of one call and is deleted in the `finally` below — including
    // on failure. Same discipline as WhisperCppTranscriber's temp clip.
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
        env: this.options.env === undefined
          ? process.env
          : { ...process.env, ...this.options.env },
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
