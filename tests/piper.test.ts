import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiperSynthesizer, isUsableWav } from "../src/core/synthesizers/PiperSynthesizer.ts";
import { SpeechEngineError } from "../src/core/errors.ts";

// M14 step 5. The half of the engine wrapper that is ordinary logic.
//
// M13's lesson, applied deliberately rather than rediscovered: `GoogleCalendar.ts` was shipped
// untested on the argument that only a live API can prove a thin transport, and both bugs the
// first live run found were in the half of that file which was plain branching — the half that
// decides what a person gets TOLD when something breaks. So the split here is explicit:
//
//   NOT proven here, and cannot be — the flag spelling piper actually accepts, what it does
//   with the text, whether the audio is intelligible. Only a real binary shows that.
//
//   Proven here — that a missing binary, a non-zero exit, a timeout, and the three shapes of
//   "exited 0 and produced nothing usable" each become a distinct, honest message; that stdin
//   and the environment actually reach the child; and that no temp file is left behind on any
//   path, including the failing ones.
//
// The stand-in is tests/fixtures/fakePiper.mjs, run through the node running these tests, so the
// spawn, the stdin write, the exit code, the timer and the file read are all genuinely
// exercised. It invents no stderr wording — see core/errors.ts on why nothing is classified by
// parsing that, and scripts/tts-recon.mjs's Q7 for how the real wording gets captured.

const SCRIPT = fileURLToPath(new URL("./fixtures/fakePiper.mjs", import.meta.url));

// Spawned through `argsPrefix`, the same seam a Python-module install would use
// (`exePath: "python", argsPrefix: ["-m", "piper"]`). A shell shim was the first attempt and is
// the wrong answer on Windows: Node refuses to spawn a .cmd without `shell: true`, and putting
// that in production code to satisfy a test would be the test dictating the design.
function piper(mode?: string, extra: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  return new PiperSynthesizer({
    exePath: process.execPath, // the node running these tests
    argsPrefix: [SCRIPT], // ...running the stand-in, before piper's own flags
    modelPath: "en_US-amy-medium.onnx", // never read by the stand-in; it is here to be passed
    timeoutMs: extra.timeoutMs ?? 5_000,
    env: { ...(mode === undefined ? {} : { FAKE_PIPER_MODE: mode }), ...(extra.env ?? {}) },
  });
}
function tempWavs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("voice-agent-tts-"));
}

describe("PiperSynthesizer — the happy path", () => {
  it("returns real WAV bytes", async () => {
    const wav = await piper().synthesize("The design review is at three.");

    expect(isUsableWav(wav)).toBe(true);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  });

  it("hands back bytes that are safe to read a header out of", async () => {
    // readFile returns a Buffer that can be a view into a POOLED ArrayBuffer at a non-zero
    // offset, so anything reaching for `.buffer` would read someone else's memory. The copy is
    // deliberate, and this is the test that would catch its removal.
    const wav = await piper().synthesize("Anything.");

    expect(wav.byteOffset).toBe(0);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(22_050);
  });

  it("sends the text on stdin", async () => {
    const failure = await piper("echo-stdin")
      .synthesize("Hello there.")
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("STDIN=Hello there.");
  });

  it("passes the environment through to the child", async () => {
    // The seam PYTHONUTF8=1 will use if recon's Q6 confirms the mojibake diagnosis. Proving the
    // plumbing now means that fix is one line of composition later, not a change to this file.
    const failure = await piper("echo-env", { env: { PYTHONUTF8: "1" } })
      .synthesize("Anything.")
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("PYTHONUTF8=1");
  });

  it("leaves no temp file behind", async () => {
    const before = tempWavs().length;
    await piper().synthesize("Anything.");

    expect(tempWavs().length).toBe(before);
  });
});

describe("PiperSynthesizer — what the user is told when it breaks", () => {
  it("names the path when the binary is not there", async () => {
    const missing = new PiperSynthesizer({
      exePath: join(tmpdir(), "definitely-not-piper.exe"),
      modelPath: "voice.onnx",
    });

    const error = await missing.synthesize("Anything.").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpeechEngineError);
    expect((error as SpeechEngineError).reason).toBe("missing-binary");
    // The most likely setup mistake by a distance, so the message says which setting to fix.
    expect((error as SpeechEngineError).message).toContain("definitely-not-piper.exe");
    expect((error as SpeechEngineError).message).toContain("PIPER_EXE_PATH");
  });

  it("surfaces the engine's own last line on a non-zero exit", async () => {
    const error = await piper("fail").synthesize("Anything.").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("failed");
    expect((error as SpeechEngineError).message).toContain("Unable to find voice");
    // The LAST line, not the whole stream: the preamble above it is noise.
    expect((error as SpeechEngineError).message).not.toContain("some preamble");
  });

  it("stops an engine that never finishes", async () => {
    const error = await piper("hang", { timeoutMs: 300 })
      .synthesize("Anything.")
      .catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("timeout");
  });

  it("does not trust an exit code of 0 — no file written", async () => {
    // M11, in a new place: Notion could report success having saved nothing, and a synthesizer
    // can exit 0 having produced nothing. Playing silence looks exactly like being ignored.
    const error = await piper("silent").synthesize("Anything.").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("no-audio");
    expect((error as SpeechEngineError).message).toContain("no file was written");
  });

  it("does not trust an exit code of 0 — the file is not audio", async () => {
    const error = await piper("garbage").synthesize("Anything.").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("no-audio");
  });

  it("does not trust an exit code of 0 — a header with no samples", async () => {
    const error = await piper("empty-wav").synthesize("Anything.").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("no-audio");
  });

  it("refuses empty text without spawning anything", async () => {
    // The engine exits non-zero on empty input (recon Q2). SpeechSession already drops these;
    // this is the second lock on the same door, and it fails clearly rather than confusingly.
    const error = await piper().synthesize("   ").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("no-audio");
    expect((error as SpeechEngineError).message).toContain("nothing to say");
  });

  it("leaves no temp file behind when it fails either", async () => {
    const before = tempWavs().length;
    await piper("fail").synthesize("Anything.").catch(() => undefined);
    await piper("garbage").synthesize("Anything.").catch(() => undefined);

    expect(tempWavs().length).toBe(before);
  });
});

describe("isUsableWav", () => {
  it("accepts a real header with samples after it", () => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WAVE"), 8);

    expect(isUsableWav(bytes)).toBe(true);
  });

  it("rejects a header with nothing after it", () => {
    const bytes = new Uint8Array(44);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WAVE"), 8);

    // Silence is indistinguishable from the app ignoring you, so it is treated as a failure.
    expect(isUsableWav(bytes)).toBe(false);
  });

  it("rejects something that is not a WAV at all", () => {
    expect(isUsableWav(new TextEncoder().encode("this is not a wav file at all"))).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(isUsableWav(new Uint8Array(0))).toBe(false);
  });
});
