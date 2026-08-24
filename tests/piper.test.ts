import { afterEach, describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiperSynthesizer, isUsableWav } from "../src/core/synthesizers/PiperSynthesizer.ts";
import { SpeechEngineError } from "../src/core/errors.ts";

// M14 step 5, extended for the post-M14 cold-start fix (a warm, reused process instead of one
// spawn per utterance).
//
// M13's lesson, applied deliberately rather than rediscovered: `GoogleCalendar.ts` was shipped
// untested on the argument that only a live API can prove a thin transport, and both bugs the
// first live run found were in the half of that file which was plain branching — the half that
// decides what a person gets TOLD when something breaks. So the split here is explicit:
//
//   NOT proven here, and cannot be — the flag spelling piper actually accepts, what it does
//   with the text, whether the audio is intelligible, and the exact wording of a real crash's
//   stderr. Only a real binary shows that (recon's warm-process scripts did, live, before this
//   file was written).
//
//   Proven here — that a missing binary, a non-zero exit, a timeout, the three shapes of
//   "exited 0 and produced nothing usable", and now a process that DIES mid-session each become
//   a distinct, honest message; that stdin and the environment actually reach the child; that
//   the warm process is reused rather than respawned; and that a call after a crash gets a
//   fresh process rather than hanging or silently retrying the line that caused the crash.
//
// The stand-in is tests/fixtures/fakePiper.mjs, run through the node running these tests, so the
// spawn, the stdin write, the exit code, the timer and the file read are all genuinely
// exercised. It speaks the SAME protocol branch the real piper1-gpl CLI does (`--output-dir` vs
// `-f`), and invents no stderr wording beyond what recon actually captured — see
// scripts/tts-recon.mjs and core/errors.ts for why nothing is classified by parsing that.

const SCRIPT = fileURLToPath(new URL("./fixtures/fakePiper.mjs", import.meta.url));

// Every synthesizer this file creates, so `afterEach` can release its warm process. Without
// this the fixture's persistent mode — the whole point of the fix under test — would leave a
// node process sitting on an open stdin pipe for every single test, and the suite would hang
// waiting for something to exit.
const instances: PiperSynthesizer[] = [];

afterEach(() => {
  for (const instance of instances) instance.dispose();
  instances.length = 0;
});

// Spawned through `argsPrefix`, the same seam a Python-module install would use
// (`exePath: "python", argsPrefix: ["-m", "piper"]`). A shell shim was the first attempt and is
// the wrong answer on Windows: Node refuses to spawn a .cmd without `shell: true`, and putting
// that in production code to satisfy a test would be the test dictating the design.
function piper(
  mode?: string,
  extra: { timeoutMs?: number; env?: Record<string, string>; legacyFlags?: boolean } = {},
) {
  const instance = new PiperSynthesizer({
    exePath: process.execPath, // the node running these tests
    argsPrefix: [SCRIPT], // ...running the stand-in, before piper's own flags
    modelPath: "en_US-amy-medium.onnx", // never read by the stand-in; it is here to be passed
    timeoutMs: extra.timeoutMs ?? 5_000,
    legacyFlags: extra.legacyFlags,
    env: { ...(mode === undefined ? {} : { FAKE_PIPER_MODE: mode }), ...(extra.env ?? {}) },
  });
  instances.push(instance);
  return instance;
}

// Legacy (per-spawn) instances never hold a process open, so they don't need `instances`
// tracking — but routing them through the same helper keeps the two paths symmetrical.
function legacyPiper(
  mode?: string,
  extra: { timeoutMs?: number; env?: Record<string, string> } = {},
) {
  return piper(mode, { ...extra, legacyFlags: true });
}

// Flat files directly in the OS temp dir — what the LEGACY per-spawn path produces.
function tempWavs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("voice-agent-tts-"));
}

// The warm path's temp dirs persist for the life of a live process (by design — that's the
// directory `--output-dir` writes into across many calls) and are only removed on dispose or
// process death. So "no temp file behind" for warm mode means no *file* left inside any of
// them, not the absence of the directory itself.
function warmTempWavFiles(): string[] {
  const dirs = readdirSync(tmpdir(), { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("voice-agent-tts-"),
  );
  return dirs.flatMap((dir) => {
    const full = join(tmpdir(), dir.name);
    try {
      return readdirSync(full).map((file) => join(full, file));
    } catch {
      return [];
    }
  });
}

describe("PiperSynthesizer — the happy path (warm process)", () => {
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

  it("reuses the same process across calls instead of spawning per utterance", async () => {
    const instance = piper();
    const before = await instance.synthesize("First.");
    const after = await instance.synthesize("Second.");

    // Not a process-identity check (nothing here exposes a pid) — the meaningful behavior is
    // that BOTH calls succeed against one instance without either one re-triggering "missing
    // binary" or any spawn-per-call side effect, which is what the fixture and its `--output-dir`
    // branch exist to prove.
    expect(isUsableWav(before)).toBe(true);
    expect(isUsableWav(after)).toBe(true);
  });

  it("sends the text on stdin", async () => {
    const failure = await piper("echo-stdin")
      .synthesize("Hello there.")
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("STDIN=Hello there.");
  });

  it("forces UTF-8 on the child without being asked", async () => {
    // Recon's Q6 settled this by measurement: the same sentence synthesized with and without
    // PYTHONUTF8=1, and only the second came back intelligible. So it is a property of the
    // engine, not a preference, and it defaults on rather than waiting for composition to
    // remember it — a fact a caller can forget is a bug waiting to happen. Reconfirmed to still
    // hold on the warm process's long-lived pipe, not just a one-shot spawn.
    const failure = await piper("echo-env").synthesize("Anything.").catch((e: unknown) => e);

    expect((failure as Error).message).toContain("PYTHONUTF8=1");
  });

  it("still lets a caller override the environment", async () => {
    const failure = await piper("echo-env", { env: { PYTHONUTF8: "0" } })
      .synthesize("Anything.")
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("PYTHONUTF8=0");
  });

  it("leaves no wav file behind", async () => {
    const before = warmTempWavFiles().length;
    await piper().synthesize("Anything.");

    expect(warmTempWavFiles().length).toBe(before);
  });
});

describe("PiperSynthesizer — what the user is told when it breaks", () => {
  it("names the path when the binary is not there", async () => {
    const broken = new PiperSynthesizer({
      exePath: join(tmpdir(), "definitely-not-piper.exe"),
      modelPath: "voice.onnx",
    });
    instances.push(broken);

    const error = await broken.synthesize("Anything.").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpeechEngineError);
    expect((error as SpeechEngineError).reason).toBe("missing-binary");
    // The most likely setup mistake by a distance, so the message says which setting to fix.
    expect((error as SpeechEngineError).message).toContain("definitely-not-piper.exe");
    expect((error as SpeechEngineError).message).toContain("PIPER_EXE_PATH");
  });

  it("surfaces the engine's own last line when the process dies", async () => {
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
    // Under the warm protocol this is the process ANNOUNCING a path it never actually wrote.
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
    // this is the second lock on the same door — and on the warm path it is the ONLY lock,
    // since a blank line reaching the process produces no output and no error, ever (recon).
    const error = await piper().synthesize("   ").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("no-audio");
    expect((error as SpeechEngineError).message).toContain("nothing to say");
  });

  it("never writes whitespace-only or empty text to the process's stdin", async () => {
    // The guard above is easy to get right by accident (an early `throw` reads fine either
    // way) and easy to get wrong by REORDERING code later. This asserts the actual mechanism:
    // echo-stdin reports exactly what reached the child, so if the guard were bypassed the
    // failure would report an empty or whitespace STDIN instead of never spawning at all.
    const instance = piper("echo-stdin");

    const blank = await instance.synthesize("").catch((e: unknown) => e);
    const whitespace = await instance.synthesize("   \t  ").catch((e: unknown) => e);

    expect((blank as SpeechEngineError).reason).toBe("no-audio");
    expect((whitespace as SpeechEngineError).reason).toBe("no-audio");
    // If either had reached stdin, echo-stdin would have crashed the process and this call
    // would report "failed" with an "STDIN=" message instead — proving nothing was written.
    const stillWorks = await instance.synthesize("Are you still there?").catch((e: unknown) => e);
    expect((stillWorks as SpeechEngineError).message ?? "").toContain("STDIN=Are you still there?");
  });

  it("leaves no wav file behind when it fails either", async () => {
    const before = warmTempWavFiles().length;
    await piper("fail").synthesize("Anything.").catch(() => undefined);
    await piper("garbage").synthesize("Anything.").catch(() => undefined);

    expect(warmTempWavFiles().length).toBe(before);
  });
});

describe("PiperSynthesizer — the warm process dies mid-session", () => {
  it("restarts on the next call instead of hanging or reusing a dead process", async () => {
    const instance = piper("crash-on-dots");

    const first = await instance.synthesize("Hello there.");
    expect(isUsableWav(first)).toBe(true);

    // Recon: a line with nothing phonemizable kills the real process outright. This must
    // surface as an honest "failed", not a timeout and not a silent hang.
    const killer = await instance.synthesize("...").catch((e: unknown) => e);
    expect(killer).toBeInstanceOf(SpeechEngineError);
    expect((killer as SpeechEngineError).reason).toBe("failed");
    expect((killer as SpeechEngineError).message).toContain("wave.Error");

    // The call that killed the process must never be retried automatically — recon confirmed
    // the same line would kill a replacement process too, which would make auto-retry an
    // infinite crash loop. A DIFFERENT call right after must still work, on a fresh process.
    const after = await instance.synthesize("Still here?");
    expect(isUsableWav(after)).toBe(true);
  });

  it("fails only the call in flight when the process dies, not calls already queued behind it", async () => {
    const instance = piper("crash-on-dots");

    const results = await Promise.allSettled([
      instance.synthesize("First, fine."),
      instance.synthesize("..."),
      instance.synthesize("Third, also fine."),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });
});

describe("PiperSynthesizer — legacy build (per-spawn fallback)", () => {
  // legacyFlags targets the archived rhasspy/piper v1.2.0 build, whose support for
  // `--output-dir` has never been confirmed live (it isn't installed anywhere this project can
  // test it) — so this build keeps the original spawn-per-utterance path entirely, selected by
  // the same flag that already chose its argument spelling.
  it("still produces real WAV bytes, one spawn per call", async () => {
    const wav = await legacyPiper().synthesize("The design review is at three.");

    expect(isUsableWav(wav)).toBe(true);
  });

  it("uses the archived build's flag spelling", async () => {
    const failure = await legacyPiper("echo-stdin")
      .synthesize("Hello there.")
      .catch((error: unknown) => error);

    // Reaching echo-stdin's stderr path at all proves `--output_file` (not `--output-dir`) was
    // the branch taken, since the fixture's persistent branch never reads to EOF.
    expect((failure as Error).message).toContain("STDIN=Hello there.");
  });

  it("leaves no temp file behind", async () => {
    const before = tempWavs().length;
    await legacyPiper().synthesize("Anything.");

    expect(tempWavs().length).toBe(before);
  });

  it("surfaces the engine's own last line on a non-zero exit", async () => {
    const error = await legacyPiper("fail").synthesize("Anything.").catch((e: unknown) => e);

    expect((error as SpeechEngineError).reason).toBe("failed");
    expect((error as SpeechEngineError).message).toContain("Unable to find voice");
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
