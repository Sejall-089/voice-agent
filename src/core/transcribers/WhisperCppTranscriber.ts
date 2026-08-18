import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioClip, Transcriber } from "../types.ts";

// Local speech-to-text (M7). Wraps a prebuilt whisper.cpp CLI binary — nothing leaves the
// machine, no cloud STT, no API key. Behind the Transcriber interface exactly like the LLM
// sits behind LLMClient, so tests inject a fake and never need a model or a microphone.
//
// The exe and model paths are CONSTRUCTOR ARGUMENTS: /core never reads process.env
// (spec §10). main.ts reads .env and injects them, same as the Slack webhook URL.
//
// Why a spawned binary rather than a native node binding: this repo already rebuilds
// better-sqlite3 twice (node + electron) on every install. A second native addon would
// double that fragility, and whisper.cpp's own Windows releases are prebuilt and stable.

export interface WhisperCppOptions {
  exePath: string;
  modelPath: string;
  language?: string; // whisper's -l flag; "auto" lets whisper detect
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class WhisperCppTranscriber implements Transcriber {
  private readonly language: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: WhisperCppOptions) {
    this.language = options.language ?? "en";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async transcribe(clip: AudioClip): Promise<string> {
    // whisper-cli reads a file, not a stream, so the clip lands in the OS temp dir for the
    // length of one call and is deleted in the `finally` below — including on failure.
    const wavPath = join(tmpdir(), `voice-agent-${randomUUID()}.wav`);
    await writeFile(wavPath, clip.wav);

    try {
      const stdout = await this.runWhisper(wavPath);
      return cleanTranscript(stdout);
    } finally {
      await unlink(wavPath).catch(() => {
        // A stray temp file is not worth failing a transcription over.
      });
    }
  }

  private runWhisper(wavPath: string): Promise<string> {
    // -nt: no timestamps, -np: no progress prints — together they make stdout the plain
    // transcript and nothing else.
    const args = [
      "-m",
      this.options.modelPath,
      "-f",
      wavPath,
      "-l",
      this.language,
      "-nt",
      "-np",
    ];

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.options.exePath, args, { windowsHide: true });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      child.on("error", (error) => {
        clearTimeout(timer);
        // Far and away the most common failure: the path in .env is wrong.
        reject(new Error(`Could not run whisper (${this.options.exePath}): ${error.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`whisper timed out after ${Math.round(this.timeoutMs / 1000)}s.`));
          return;
        }
        if (code !== 0) {
          // stderr is where whisper explains a missing/corrupt model file.
          reject(new Error(`whisper exited with code ${code}: ${lastLine(stderr)}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

// The safe default when voice isn't configured: it never pretends to transcribe, and the
// message says exactly which two settings are missing. Mirrors UnavailableSender.
export class UnavailableTranscriber implements Transcriber {
  transcribe(_clip: AudioClip): Promise<string> {
    return Promise.reject(
      new Error(
        "Voice isn't set up — set WHISPER_EXE_PATH and WHISPER_MODEL_PATH in .env (see README).",
      ),
    );
  }
}

// whisper annotates non-speech as bracketed tokens ([BLANK_AUDIO], [MUSIC], (silence)).
// They are not something the user said, so they must not reach the planner as an
// instruction — strip them and let the empty result mean "nothing was heard".
function cleanTranscript(stdout: string): string {
  return stdout
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastLine(text: string): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "no output";
}
