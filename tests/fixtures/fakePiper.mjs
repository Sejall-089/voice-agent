// A stand-in for the piper binary, so PiperSynthesizer's process and file handling can be
// tested without piper installed (M14 step 5, extended for the post-M14 cold-start fix).
//
// What this IS: a CLI with the same shape as the REAL piper1-gpl `__main__.py` — it branches on
// `-f/--output_file` (one file, read stdin to EOF, exit) vs `--output-dir` (persistent: one WAV
// per stdin LINE, `INFO:__main__:Wrote <path>` on stderr per line, keeps reading) exactly like
// the real CLI does, because that branch is what PiperSynthesizer's warm-vs-per-spawn selection
// depends on.
//
// What this IS NOT: evidence about what the real piper does. It reproduces failures already
// confirmed live against piper-tts 1.7.0 (missing exe, non-zero exit, timeout, exit-0-with-
// nothing, and — new — a line that kills the process outright), and invents no stderr text
// beyond what recon actually captured. See the note in core/errors.ts on why no reason is
// derived from parsing stderr.
//
// Driven by FAKE_PIPER_MODE so one script covers every case:
//   ok (default)     write a valid WAV per line and keep going
//   fail             write to stderr and exit 1 on the FIRST line (per-spawn: whole call fails;
//                    warm: the process dies, proving the restart path)
//   crash-on-dots    only lines that are pure punctuation (recon's "...") kill the process;
//                    every other line succeeds — this is what makes the restart test possible,
//                    since a plain "fail" mode can't tell a good call from the killer one
//   silent           announce a path but never write it            (M11: success isn't proof)
//   garbage          announce a path and write a non-WAV file there
//   empty-wav        announce a path and write a header with no samples
//   hang             never respond to any line                      (drives the timeout path)
//   echo-env         report PYTHONUTF8 on stderr and exit 1 on the first line (env plumbing)
//   echo-stdin       report the received line on stderr and exit 1 (stdin plumbing)

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (...names) => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return null;
};

const outFile = flag("-f", "--output_file", "--output-file");
const outDir = flag("-d", "--output-dir", "--output_dir");
const mode = process.env.FAKE_PIPER_MODE ?? "ok";

function wav(samples) {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(22050, 24);
  buffer.writeUInt32LE(22050 * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

if (outDir !== null) {
  // --- Persistent mode: the protocol the cold-start fix relies on ---
  let seq = 0;
  let buf = "";

  const nextPath = () => join(outDir, `${Date.now()}-${(seq += 1)}.wav`);
  const wrote = (path) => process.stderr.write(`INFO:__main__:Wrote ${path}\n`);

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    // Real piper's `for line in lines(): if line:` silently skips a blank line — no output,
    // no error, ever (recon). Reproduced by doing nothing at all.
    if (line.length === 0) return;

    switch (mode) {
      case "hang":
        return; // never respond to this or any line
      case "fail":
        process.stderr.write("some preamble the engine prints\n");
        process.stderr.write("Unable to find voice: en_US-nope-medium\n");
        process.exit(1);
        return;
      case "echo-env":
        process.stderr.write(`PYTHONUTF8=${process.env.PYTHONUTF8 ?? "(unset)"}\n`);
        process.exit(1);
        return;
      case "echo-stdin":
        process.stderr.write(`STDIN=${line}\n`);
        process.exit(1);
        return;
      case "crash-on-dots": {
        // Recon: a line with nothing phonemizable (e.g. "...") crashes the real process with
        // this exact traceback tail. Anything else behaves like "ok" and the process survives.
        if (/^[.\s]+$/.test(line)) {
          process.stderr.write("Traceback (most recent call last):\n");
          process.stderr.write("wave.Error: # channels not specified\n");
          process.exit(1);
          return;
        }
        const path = nextPath();
        writeFileSync(path, wav(Math.max(1, line.length * 100)));
        wrote(path);
        return;
      }
      case "silent": {
        wrote(nextPath()); // announced, never actually written — exit-0-and-nothing's warm shape
        return;
      }
      case "garbage": {
        const path = nextPath();
        writeFileSync(path, "this is not a wav file at all");
        wrote(path);
        return;
      }
      case "empty-wav": {
        const path = nextPath();
        writeFileSync(path, wav(0));
        wrote(path);
        return;
      }
      default: {
        const path = nextPath();
        writeFileSync(path, wav(Math.max(1, line.length * 100)));
        wrote(path);
      }
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  process.stdin.on("end", () => process.exit(0));

  // A backstop so "hang" mode never leaves an orphan process behind for the rest of the run,
  // same reasoning as the per-spawn fixture's own timer below.
  if (mode === "hang") setTimeout(() => process.exit(0), 10_000);
} else {
  // --- Per-spawn mode: one call, read stdin to EOF, write one file, exit ---
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    switch (mode) {
      case "hang":
        // Never exits on its own timescale, but DOES give up eventually: on Windows the
        // synthesizer kills a shim rather than this grandchild, so without a backstop a
        // timeout test would leave an orphan process behind for the rest of the run.
        setTimeout(() => process.exit(0), 10_000);
        return;

      case "fail":
        process.stderr.write("some preamble the engine prints\n");
        process.stderr.write("Unable to find voice: en_US-nope-medium\n");
        process.exit(1);
        return;

      case "echo-env":
        process.stderr.write(`PYTHONUTF8=${process.env.PYTHONUTF8 ?? "(unset)"}\n`);
        process.exit(1);
        return;

      case "echo-stdin":
        process.stderr.write(`STDIN=${text}\n`);
        process.exit(1);
        return;

      case "silent":
        process.exit(0);
        return;

      case "garbage":
        if (outFile) writeFileSync(outFile, "this is not a wav file at all");
        process.exit(0);
        return;

      case "empty-wav":
        if (outFile) writeFileSync(outFile, wav(0));
        process.exit(0);
        return;

      default:
        // Roughly a syllable's worth of audio per character, so a longer utterance is longer.
        if (outFile) writeFileSync(outFile, wav(Math.max(1, text.trim().length * 100)));
        process.exit(0);
    }
  });
}
