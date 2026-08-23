// A stand-in for the piper binary, so PiperSynthesizer's process and file handling can be
// tested without piper installed (M14 step 5).
//
// What this IS: a CLI with the same shape — reads text on stdin, takes `-m <voice>` and
// `-f <out.wav>`, writes a WAV, exits 0 — that can be told to fail in each of the specific ways
// the synthesizer has to classify.
//
// What this IS NOT: evidence about what the real piper does. It reproduces failures we already
// know are possible for ANY spawned binary (missing exe, non-zero exit, timeout, exit-0-with-
// nothing), and deliberately invents no stderr text, because the real engine's wording has not
// been captured yet and a fixture written from a guess is M10's original sin. See the note in
// core/errors.ts on why no reason is derived from parsing stderr.
//
// Driven by FAKE_PIPER_MODE so one script covers every case:
//   ok (default)  write a valid WAV and exit 0
//   fail          write to stderr and exit 1
//   silent        exit 0 having written nothing        (M11: success is not proof)
//   garbage       exit 0 having written a non-WAV file
//   empty-wav     exit 0 having written a header with no samples
//   hang          never exit                            (drives the timeout path)
//   echo-env      report PYTHONUTF8 on stderr and exit 1 (proves env plumbing)
//   echo-stdin    report the received text on stderr and exit 1 (proves stdin plumbing)

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (...names) => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return null;
};

const outPath = flag("-f", "--output_file");
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
      if (outPath) writeFileSync(outPath, "this is not a wav file at all");
      process.exit(0);
      return;

    case "empty-wav":
      if (outPath) writeFileSync(outPath, wav(0));
      process.exit(0);
      return;

    default:
      // Roughly a syllable's worth of audio per character, so a longer utterance is longer.
      if (outPath) writeFileSync(outPath, wav(Math.max(1, text.trim().length * 100)));
      process.exit(0);
  }
});
