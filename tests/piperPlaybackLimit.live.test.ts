import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PiperSynthesizer } from "../src/core/synthesizers/PiperSynthesizer.ts";
import { toSpokenResult } from "../src/core/speech.ts";
import { PLAYBACK_GRACE_MS, playbackLimitMs } from "../src/main/shell/playbackLimit.ts";

// M24, against the REAL engine: does the limit play() computes cover what Piper actually writes?
//
// Opt-in (`M24_PIPER_LIVE=1`), like the evals: it needs this machine's Piper binary and voice
// (PIPER_EXE_PATH / PIPER_MODEL_PATH in .env). It writes WAVs and plays nothing. The text is the
// one the M24 repro measured: its `elaborate` remainder was 585 characters, 37.7 s of audio.
//
// The clip's length is measured here with a reader written independently of playbackLimit.ts,
// so the check is "the limit covers the real file", not "the parser agrees with itself".

const SELECTED = process.env["M24_PIPER_LIVE"] === "1";

function piperEnv(): Record<string, string> {
  const path = ".env";
  if (!existsSync(path)) return {};
  const pairs = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => /^\s*(PIPER_[A-Z_]+)\s*=\s*"?([^"#]*?)"?\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1], match[2]] as const);
  return Object.fromEntries(pairs);
}

// Independent: the data chunk is found by searching for its tag, and the rate is the fmt chunk's
// sampleRate × channels × bytes per sample, not its stored byte rate.
function measuredMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = Buffer.from(bytes).toString("latin1");
  const fmt = text.indexOf("fmt ");
  const data = text.indexOf("data", fmt);
  const channels = view.getUint16(fmt + 10, true);
  const sampleRate = view.getUint32(fmt + 12, true);
  const bits = view.getUint16(fmt + 22, true);
  const samples = (bytes.byteLength - (data + 8)) / (channels * (bits / 8));
  return (samples / sampleRate) * 1000;
}

const env = piperEnv();
const CONFIGURED = SELECTED && Boolean(env["PIPER_EXE_PATH"]) && Boolean(env["PIPER_MODEL_PATH"]);

describe.skipIf(!CONFIGURED)("M24 live: the playback limit covers real Piper output", () => {
  it("an elaborate remainder over 30 s gets a limit of its own length plus the grace", async () => {
    const result =
      "Alex wrote about the Q3 launch. The design review moved from Tuesday to Thursday at 3 PM because two of the reviewers are travelling. " +
      "Priya wants final mockups for the onboarding flow by Wednesday evening, and the copy for the pricing page still needs legal sign off. " +
      "Marketing asked whether the launch blog post can go out a day early, which would mean freezing the feature list by Monday. " +
      "The mobile team flagged a crash on Android 14 when the app resumes from background, and they think it is related to the new session cache. " +
      "Sam is out next week, so questions about the analytics dashboard should go to Jordan instead. " +
      "Finally, the team offsite is confirmed for the 14th, and everyone should book travel by Friday.";
    const remainder = toSpokenResult(result).remainder ?? "";
    expect(remainder.length).toBe(585); // the text the repro measured

    const piper = new PiperSynthesizer({
      exePath: env["PIPER_EXE_PATH"] ?? "",
      modelPath: env["PIPER_MODEL_PATH"] ?? "",
      ...(env["PIPER_DATA_DIR"] ? { dataDir: env["PIPER_DATA_DIR"] } : {}),
      legacyFlags: env["PIPER_LEGACY_FLAGS"] === "1",
    });
    try {
      const wav = await piper.synthesize(remainder);
      const actual = measuredMs(wav);
      const limit = playbackLimitMs(wav);
      console.log(
        `[M24 live] ${remainder.length} chars -> ${(actual / 1000).toFixed(2)} s of audio; ` +
          `limit ${(limit.limitMs / 1000).toFixed(2)} s (${limit.basis})`,
      );

      expect(actual).toBeGreaterThan(30_000);
      expect(limit.basis).toBe("header");
      expect(limit.limitMs).toBeGreaterThanOrEqual(actual + PLAYBACK_GRACE_MS);
      expect(limit.limitMs).toBeLessThan(actual + PLAYBACK_GRACE_MS + 1);
    } finally {
      piper.dispose();
    }
  }, 120_000);
});
