// M14 task 1 — reconnaissance against the REAL Piper binary, before any wrapper is written.
//
// WHY THIS EXISTS. M10 hand-authored a jsdom fixture from an assumption about Gmail's markup
// (`role="button"`; it was `role="link"`), every test passed, and only a live page ever said
// so. M11 wrote scripts/notion-recon.mjs so its fixture would be TRANSCRIBED instead. This is
// the same move for TTS: `FakeSynthesizer` is about to be written to enforce "everything the
// real engine cannot take", and that list has to come from watching the real engine rather
// than from what its README implies. M13's lesson says the same thing from the other side — a
// fake more lenient than the real thing hides the exact bug it exists to catch.
//
// The open questions this answers, in the order they matter:
//   Q1  Does a newline in the text produce ONE utterance, several, or silently dropped words?
//       This is the constraint the whole `core/speech.ts` flattening rule rests on, and it is
//       the direct analogue of M11's "one insertText with an embedded \n drops everything
//       after the first line" — found live, after the code assumed otherwise.
//   Q2  What does empty / whitespace-only input do? (A synthesizer that returns no audio would
//       leave playback waiting for an "ended" event that never comes, wedging the queue.)
//   Q3  What is the real cold-start cost per utterance? Piper's own docs warn that running it
//       this way reloads the model every time. The plan says measure, do not guess.
//   Q4  What audio format comes out (rate / channels / bit depth)? Decides whether the renderer
//       can just decode it, and confirms it is NOT AudioClip's 16 kHz mono.
//   Q5  How does it voice the characters `core/speech.ts` strips — bullet, asterisk, hash,
//       ellipsis? Needs ears: the WAVs are left on disk to listen to.
//   Q6  Was the garbling an ENCODING fault or a pronunciation one? ANSWERED: encoding. The
//       same sentence with and without PYTHONUTF8=1 differs, so the engine was decoding stdin
//       with the locale codepage. PiperSynthesizer now sets it by default.
//   Q7  What does the engine actually SAY on stderr when it fails? Captured rather than
//       guessed, so failure classification can be written from evidence (core/errors.ts).
//   Q8  How must a time be written to be said correctly? Q6's listening pass found "3:00" is
//       read "three zero zero" — no time normalisation, and a colon read digit by digit.
//
// Plain ESM, node built-ins only, no build step — same shape as scripts/notion-recon.mjs.
//
//   1. Install Piper (either works; the app spawns a binary and does not care which):
//        pip install piper-tts          → <venv>/Scripts/piper.exe   (maintained, v1.7.x)
//        or the archived rhasspy/piper v1.2.0 windows zip            (no Python)
//   2. Download a voice ONCE, ahead of time (never at runtime — see spec §3):
//        python -m piper.download_voices en_US-amy-medium
//   3. Set PIPER_EXE_PATH / PIPER_MODEL_PATH in .env, or pass --exe / --model.
//   4. node scripts/tts-recon.mjs
//
// Flags:
//   --exe <path>     the piper binary      (default: PIPER_EXE_PATH from .env)
//   --model <path>   the .onnx voice       (default: PIPER_MODEL_PATH from .env)
//   --out <dir>      where the WAVs land   (default: <tmp>/tts-recon)
//   --legacy         use the archived v1.2.0 flag spelling (--model/--output_file) instead of
//                    the current -m/-f. Probe 0 dumps --help so you can see which this build
//                    actually takes before trusting either.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

function fromEnvFile(key) {
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    const value = line === undefined ? "" : line.slice(key.length + 1).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const EXE = flag("--exe", fromEnvFile("PIPER_EXE_PATH"));
const MODEL = flag("--model", fromEnvFile("PIPER_MODEL_PATH"));
const OUT_DIR = flag("--out", join(tmpdir(), "tts-recon"));
const LEGACY = has("--legacy");

if (!EXE || !MODEL) {
  console.error(
    "Need a piper binary and a voice.\n" +
      "  Set PIPER_EXE_PATH and PIPER_MODEL_PATH in .env, or pass --exe / --model.\n" +
      "  See the header of this file for how to install both.",
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

// --- running one utterance ---

function run(args, stdin, timeoutMs = 60_000, env = undefined) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(EXE, args, {
      windowsHide: true,
      env: env === undefined ? process.env : { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, elapsedMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout,
        stderr: stderr.trim(),
        elapsedMs: Date.now() - started,
      });
    });

    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function synthesize(name, text, timeoutMs, env) {
  const wav = join(OUT_DIR, `${name}.wav`);
  const args = LEGACY
    ? ["--model", MODEL, "--output_file", wav]
    : ["-m", MODEL, "-f", wav];
  return run(args, text, timeoutMs, env).then((result) => ({ ...result, wav }));
}

// --- reading the WAV back, so the answers are measured rather than eyeballed ---

function describeWav(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return { exists: false };
  }
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    return { exists: true, bytes: bytes.length, riff: false };
  }

  let channels = null;
  let sampleRate = null;
  let bits = null;
  let dataBytes = null;

  // Walk the chunks rather than assuming a 44-byte canonical header.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === "data") {
      dataBytes = size;
    }
    at += 8 + size + (size % 2);
  }

  const durationMs =
    dataBytes && sampleRate && channels && bits
      ? Math.round((dataBytes / (sampleRate * channels * (bits / 8))) * 1000)
      : null;

  return {
    exists: true,
    bytes: statSync(path).size,
    riff: true,
    channels,
    sampleRate,
    bits,
    durationMs,
  };
}

// --- the probes ---

const PROBES = [
  // Q1 — the newline question. `two_lines` is compared against the two halves run separately.
  { name: "one_line", text: "The design review is at three o'clock." },
  { name: "two_lines", text: "Line one is here.\nLine two is here." },
  { name: "line_a", text: "Line one is here." },
  { name: "line_b", text: "Line two is here." },

  // Q2 — nothing to say.
  { name: "empty", text: "" },
  { name: "whitespace", text: "   \t  " },

  // Q5 — characters core/speech.ts strips, one per file so they can be listened to in isolation.
  { name: "bullet", text: "• Wed 26 Aug, Design review" },
  { name: "markdown", text: "**bold** and `code` and # hash and _under_" },
  { name: "ellipsis", text: "Adding Design review to your calendar…" },
  // ...and the one it deliberately KEEPS. If this is not voiced as "three to four", the
  // keep-unspaced-dashes rule in speakable() is wrong and readSchedule's own spoken override
  // has to format the range itself.
  { name: "en_dash", text: "The meeting is 3:00–4:00 PM." },

  // Q3 — does synthesis time scale with length, on top of a fixed model-load cost?
  { name: "long", text: `${"The quick brown fox jumps over the lazy dog. ".repeat(8)}` },
];

async function main() {
  console.log(`piper : ${EXE}`);
  console.log(`voice : ${MODEL}`);
  console.log(`out   : ${OUT_DIR}`);
  console.log(`flags : ${LEGACY ? "--model/--output_file (legacy)" : "-m/-f (current)"}\n`);

  // Probe 0 — what flags does THIS build actually take? Everything below assumes an answer;
  // this is the one that lets you check it instead.
  const help = await run(["--help"], null, 20_000);
  console.log("--- piper --help ---");
  console.log((help.stdout || help.stderr || help.error || "(no output)").trim());
  console.log("--- end --help ---\n");

  const results = [];
  for (const probe of PROBES) {
    const result = await synthesize(probe.name, probe.text);
    const wav = describeWav(result.wav);
    results.push({ probe, result, wav });

    const status = result.ok ? "ok" : `FAILED (code ${result.code ?? "-"})`;
    console.log(
      `${probe.name.padEnd(11)} ${status.padEnd(18)} ` +
        `${String(result.elapsedMs).padStart(6)}ms spawn+synth   ` +
        `audio ${wav.durationMs === null || wav.durationMs === undefined ? "-" : `${wav.durationMs}ms`}` +
        `${wav.exists && wav.riff ? ` ${wav.sampleRate}Hz ${wav.channels}ch ${wav.bits}bit` : ""}`,
    );
    if (!result.ok && result.stderr) console.log(`            stderr: ${lastLine(result.stderr)}`);
  }

  const by = (name) => results.find((r) => r.probe.name === name);
  const ms = (name) => by(name)?.wav.durationMs ?? null;

  console.log("\n=== answers ===\n");

  // Q1
  const both = ms("two_lines");
  const separate = (ms("line_a") ?? 0) + (ms("line_b") ?? 0);
  if (both === null) {
    console.log("Q1 newlines: two-line input produced NO usable audio — treat \\n as fatal.");
  } else if (separate > 0 && both < separate * 0.75) {
    console.log(
      `Q1 newlines: DROPPED CONTENT. Two lines gave ${both}ms of audio; the same two lines run ` +
        `separately gave ${separate}ms. core/speech.ts must flatten, and FakeSynthesizer must ` +
        `reject any text containing a newline.`,
    );
  } else {
    console.log(
      `Q1 newlines: both lines appear present (${both}ms vs ${separate}ms separately). ` +
        `Flattening is still correct for prosody, but the fake's newline rule is a project ` +
        `constraint rather than an engine limit — say so in its comment.`,
    );
  }

  // Q2
  for (const name of ["empty", "whitespace"]) {
    const r = by(name);
    console.log(
      `Q2 ${name}: exit ${r.result.ok ? "0" : (r.result.code ?? "error")}, ` +
        `${r.wav.exists ? `${r.wav.bytes} bytes, ${r.wav.durationMs ?? "?"}ms audio` : "no file written"}` +
        ` → the fake must reject this, and the planner must never emit it.`,
    );
  }

  // Q3
  const one = by("one_line");
  const long = by("long");
  console.log(
    `Q3 latency: ${one.result.elapsedMs}ms for a short line, ${long.result.elapsedMs}ms for a ` +
      `long one. Fixed overhead is roughly the smaller number — if that is bad enough to ` +
      `notice before speech starts, the escape is piper's HTTP server mode as a persistent ` +
      `process (M12's PowerShell-host precedent), not a rewrite.`,
  );

  // Q4
  console.log(
    `Q4 format: ${one.wav.sampleRate}Hz ${one.wav.channels}ch ${one.wav.bits}bit — ` +
      `${one.wav.sampleRate === 16000 ? "matches" : "does NOT match"} AudioClip's 16 kHz mono, ` +
      `which is why SpeechSynthesizer returns raw WAV bytes instead of reusing that type.`,
  );

  // Q5
  console.log(
    `\nQ5 needs ears. Play these and write down what you hear:\n` +
      ["bullet", "markdown", "ellipsis", "en_dash"]
        .map((n) => `    ${by(n)?.result.wav ?? "(not written)"}`)
        .join("\n") +
      `\n  The first three should confirm WHY core/speech.ts strips them.`,
  );

  // Q6 — SEPARATING THE TWO DEFECTS THE FIRST RUN CONFLATED.
  //
  // The en dash came back as garbled non-English sounds, reported as "a circumflex, euros".
  // That is exactly U+2013's UTF-8 bytes (E2 80 93) read as Windows-1252 — "â" + "€" + a curly
  // quote — which points at an ENCODING fault, not a pronunciation one. Python on Windows
  // decodes stdin with the locale codepage unless PYTHONUTF8 says otherwise.
  //
  // But fixing that only guarantees Piper RECEIVES an en dash. Whether it then SAYS "to" is a
  // second, independent question: espeak-ng generally treats a dash as a clause break, and
  // rendering "3:00–4:00" as "three to four" needs range-aware normalisation most front ends
  // do not do. The two probes below settle both at once:
  //
  //   * different durations  → the encoding was the fault, and PYTHONUTF8=1 fixes it
  //   * same durations       → the encoding was never the problem; look elsewhere
  //   * and then LISTEN to the utf8 one: if it does not say "three to four", the word
  //     conversion in core/speech.ts is load-bearing and stays. If it does, that rule is
  //     redundant (though harmless, and worth keeping as insurance against this env var
  //     going missing).
  const RANGE = "The meeting is 3:00–4:00 PM.";
  const raw = await synthesize("q6_dash_default_env", RANGE);
  const utf8 = await synthesize("q6_dash_pythonutf8", RANGE, undefined, {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });
  const rawMs = describeWav(raw.wav).durationMs;
  const utf8Ms = describeWav(utf8.wav).durationMs;

  console.log(
    `\nQ6 encoding: "${RANGE}"\n` +
      `    default env   ${rawMs ?? "-"}ms   ${raw.wav}\n` +
      `    PYTHONUTF8=1  ${utf8Ms ?? "-"}ms   ${utf8.wav}`,
  );
  await captureFailureText();
  await captureTimeWordings();

  if (rawMs !== null && utf8Ms !== null && Math.abs(rawMs - utf8Ms) > 150) {
    console.log(
      `  → The two differ, so the garbling WAS an encoding fault. Spawn piper with ` +
        `PYTHONUTF8=1. Now play the second file: does it say "three to four"?`,
    );
  } else {
    console.log(
      `  → No real difference, so the encoding hypothesis is WRONG and the mojibake ` +
        `diagnosis in core/speech.ts needs revisiting. Play both before concluding.`,
    );
  }
}

// Q8 — HOW SHOULD A TIME BE WRITTEN SO IT IS SAID CORRECTLY?
//
// Q6's listening pass answered more than it was asked. "3:00–4:00 PM" came back as disconnected
// digits — "three zero zero, four zero zero" — with the dash dropped silently. Two things follow:
// the engine applies NO time normalisation of its own (or "3:00" would have been "three"), and a
// colon is read digit by digit. So "11:30" would be "eleven three zero", which nobody says.
//
// core/speech.ts now removes the colon: on the hour it goes entirely, otherwise the minutes
// become a separate number, and a leading zero becomes "oh". That is reasoning from one observed
// data point, not a measurement, so these probes settle it. Play them in pairs — the raw form
// first, then what the cleaner would send — and keep whichever is actually said correctly.
async function captureTimeWordings() {
  console.log(`\nQ8 time wording. Play each PAIR and note which is said correctly:`);

  const pairs = [
    ["half past", "The meeting is at 3:30 PM.", "The meeting is at 3 30 PM."],
    ["leading zero", "The meeting is at 3:05 PM.", "The meeting is at 3 oh 5 PM."],
    ["on the hour", "The meeting is at 3:00 PM.", "The meeting is at 3 PM."],
    ["quarter to", "The meeting is at 11:45 AM.", "The meeting is at 11 45 AM."],
  ];

  for (const [label, written, spoken] of pairs) {
    const a = await synthesize(`q8_${label.replace(/\s+/g, "_")}_raw`, written);
    const b = await synthesize(`q8_${label.replace(/\s+/g, "_")}_cleaned`, spoken);
    console.log(
      `\n  ${label}\n` +
        `    as written  ${JSON.stringify(written)}\n      ${a.wav}\n` +
        `    as cleaned  ${JSON.stringify(spoken)}\n      ${b.wav}`,
    );
  }
}

// Q7 — WHAT DOES IT ACTUALLY SAY WHEN IT FAILS?
//
// PiperSynthesizer classifies failures only by things it can be certain of: a spawn error, an
// exit code, a timer, the bytes on disk. It deliberately does NOT interpret stderr, because
// nobody has seen this engine's stderr yet, and a classifier written from imagined output is
// M10's hand-authored fixture all over again — which shipped a selector that had never matched
// anything and passed every test.
//
// This prints the real thing for the two failures most likely to happen during setup. Paste the
// output into core/errors.ts's note, and only THEN is it worth teaching the classifier to tell
// "wrong voice file" from "wrong flag" — with evidence behind it.
async function captureFailureText() {
  console.log(`\nQ7 real failure output (paste these into core/errors.ts):`);

  const cases = [
    ["a voice file that does not exist", ["-m", join(OUT_DIR, "no-such-voice.onnx"), "-f", join(OUT_DIR, "q7.wav")]],
    ["a flag this build may not accept", ["--definitely-not-a-flag"]],
  ];

  for (const [label, args] of cases) {
    const result = await run(args, "Anything.", 20_000);
    console.log(
      `\n  ${label}\n` +
        `    exit ${result.code ?? result.error ?? "-"}\n` +
        `    stderr: ${result.stderr ? result.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join("\n            ") : "(nothing)"}`,
    );
  }
}

function lastLine(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
