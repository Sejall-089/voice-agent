// M30 box 1.2 — hear the unasked-step refusal through the app's real speech engine, without
// needing a model to plan a refused step first.
//
// The text is the planner's own constant (`UNASKED_STEP`, core/chain.ts), passed through the same
// `toSpokenResult` the planner's `say()` applies before it hands the line to the speech queue;
// SpeechSession passes it to `synthesize()` unchanged. The engine is built from .env exactly as
// main.ts's `createSynthesizer` builds it (PIPER_EXE_PATH, PIPER_MODEL_PATH, PIPER_DATA_DIR,
// PIPER_LEGACY_FLAGS). It does not start the app, call a model, or touch the action log.
//
// PLAYS AUDIO through the default output device (Windows' SoundPlayer, the WAV Piper wrote).
//
//   npx vite-node scripts/m30-say-refusal.ts              # synthesize and play
//   npx vite-node scripts/m30-say-refusal.ts --no-play    # synthesize only; prints the WAV path
//   npx vite-node scripts/m30-say-refusal.ts --no-text    # the other wording (nothing copied)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNASKED_STEP, UNASKED_STEP_NO_TEXT } from "../src/core/chain.ts";
import { toSpokenResult } from "../src/core/speech.ts";
import { PiperSynthesizer } from "../src/core/synthesizers/PiperSynthesizer.ts";

const exePath = process.env["PIPER_EXE_PATH"];
const modelPath = process.env["PIPER_MODEL_PATH"];
if (!exePath || !modelPath) {
  console.error("PIPER_EXE_PATH / PIPER_MODEL_PATH are not set in .env; the app does not speak either.");
  process.exit(1);
}
const dataDir = process.env["PIPER_DATA_DIR"];
const engine = new PiperSynthesizer({
  exePath,
  modelPath,
  ...(dataDir ? { dataDir } : {}),
  legacyFlags: process.env["PIPER_LEGACY_FLAGS"] === "1",
});

const reason = process.argv.includes("--no-text") ? UNASKED_STEP_NO_TEXT : UNASKED_STEP;
const spoken = toSpokenResult(reason);
console.log(`Saying: ${spoken.text}`);
if (spoken.remainder !== null) console.log(`(held back as "read the rest": ${spoken.remainder})`);

try {
  const wav = await engine.synthesize(spoken.text);
  const path = join(tmpdir(), "m30-refusal.wav");
  writeFileSync(path, wav);
  console.log(`Wrote ${wav.byteLength} bytes to ${path}`);
  if (!process.argv.includes("--no-play")) {
    const played = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`],
      { stdio: "inherit" },
    );
    if (played.status !== 0) console.error(`Playback exited with ${played.status}; open ${path} to listen.`);
  }
} finally {
  engine.dispose();
}
