import { describe, it, expect } from "vitest";
import {
  estimatedDurationMs,
  PIPER_BYTES_PER_SECOND,
  PLAYBACK_CEILING_MS,
  PLAYBACK_GRACE_MS,
  playbackLimitMs,
  wavDurationMs,
} from "../src/main/shell/playbackLimit.ts";

// M24. How long main waits for one spoken clip: the clip's own length from its header, else an
// estimate from its size, else a ceiling — plus a grace. Never the old 15 s.
//
// The WAVs here are built byte by byte by `wav()` below, written from the RIFF layout and NOT
// from the parser under test, so a parser bug cannot be mirrored by the fixture.

interface WavSpec {
  format?: number; // 1 PCM, 3 float, 0xFFFE extensible, 2 ADPCM...
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  fmtSize?: 16 | 18 | 40;
  byteRateOverride?: number;
  // Chunks between `fmt ` and `data`, as [id, body length]. An odd length gets its pad byte.
  extra?: [string, number][];
  dataBytes: number;
  declaredData?: number; // what the data header SAYS, if not dataBytes
  riffSize?: number;
  omitFmt?: boolean;
}

function wav(spec: WavSpec): Uint8Array {
  const format = spec.format ?? 1;
  const channels = spec.channels ?? 1;
  const sampleRate = spec.sampleRate ?? 22_050;
  const bits = spec.bitsPerSample ?? 16;
  const blockAlign = channels * (bits / 8);
  const fmtSize = spec.fmtSize ?? 16;

  const parts: number[] = [];
  const u8 = (n: number): void => void parts.push(n & 0xff);
  const u16 = (n: number): void => { u8(n); u8(n >>> 8); };
  const u32 = (n: number): void => { u16(n & 0xffff); u16(n >>> 16); };
  const ascii = (s: string): void => { for (const c of s) u8(c.charCodeAt(0)); };

  ascii("RIFF");
  u32(0); // patched below
  ascii("WAVE");
  if (spec.omitFmt !== true) {
    ascii("fmt ");
    u32(fmtSize);
    u16(format);
    u16(channels);
    u32(sampleRate);
    u32(spec.byteRateOverride ?? sampleRate * blockAlign);
    u16(blockAlign);
    u16(bits);
    for (let i = 16; i < fmtSize; i += 1) u8(0);
  }
  for (const [id, length] of spec.extra ?? []) {
    ascii(id);
    u32(length);
    for (let i = 0; i < length; i += 1) u8(0x41);
    if (length % 2 === 1) u8(0); // pad byte
  }
  ascii("data");
  u32(spec.declaredData ?? spec.dataBytes);
  const bytes = new Uint8Array(parts.length + spec.dataBytes);
  bytes.set(parts);
  const riff = spec.riffSize ?? bytes.byteLength - 8;
  new DataView(bytes.buffer).setUint32(4, riff, true);
  return bytes;
}

// One second of Piper-format audio is 44,100 bytes.
const SECOND = 44_100;

describe("wavDurationMs — the clip's length from its header", () => {
  it("reads a plain 44-byte-header PCM WAV", () => {
    expect(wavDurationMs(wav({ dataBytes: 30 * SECOND }))).toBe(30_000);
    expect(wavDurationMs(wav({ dataBytes: SECOND / 2 }))).toBe(500);
  });

  it("uses the header's own rate, not Piper's", () => {
    // 16 kHz stereo 16-bit is 64,000 B/s; Piper's rate would make this 1.45 s, not 1 s.
    expect(wavDurationMs(wav({ sampleRate: 16_000, channels: 2, dataBytes: 64_000 }))).toBe(1_000);
    // 32-bit float, mono, 48 kHz.
    expect(wavDurationMs(wav({ format: 3, sampleRate: 48_000, bitsPerSample: 32, dataBytes: 192_000 }))).toBe(1_000);
  });

  it("walks past fmt chunks of 18 and 40 bytes, and WAVE_FORMAT_EXTENSIBLE", () => {
    expect(wavDurationMs(wav({ fmtSize: 18, dataBytes: 2 * SECOND }))).toBe(2_000);
    expect(wavDurationMs(wav({ fmtSize: 40, format: 0xfffe, dataBytes: 2 * SECOND }))).toBe(2_000);
  });

  it("walks past chunks before data, including an odd-sized one and its pad byte", () => {
    const bytes = wav({ extra: [["LIST", 27], ["fact", 4]], dataBytes: 3 * SECOND });
    // Proves the fixture really has the odd chunk: without the pad byte the walk lands mid-chunk.
    expect(bytes.byteLength).toBe(44 + (8 + 27 + 1) + (8 + 4) + 3 * SECOND);
    expect(wavDurationMs(bytes)).toBe(3_000);
  });

  it("a truncated file: what can play is what is there, not what the header promised", () => {
    const whole = wav({ dataBytes: 10 * SECOND });
    const cut = whole.subarray(0, 44 + 4 * SECOND);
    expect(wavDurationMs(cut)).toBe(4_000);
  });

  it("a streaming header (sizes 0xFFFFFFFF, or 0): the rest of the file is the audio", () => {
    expect(wavDurationMs(wav({ dataBytes: 6 * SECOND, declaredData: 0xffffffff, riffSize: 0xffffffff }))).toBe(6_000);
    expect(wavDurationMs(wav({ dataBytes: 6 * SECOND, declaredData: 0, riffSize: 0 }))).toBe(6_000);
  });

  it("zero-length audio is 0 ms, not null", () => {
    expect(wavDurationMs(wav({ dataBytes: 0 }))).toBe(0);
  });

  it("rounds up, so a limit is never a millisecond short of the clip", () => {
    expect(wavDurationMs(wav({ dataBytes: 2 }))).toBe(1); // 0.045 ms
  });

  it("is null — not a guess — when the header cannot give an exact length", () => {
    expect(wavDurationMs(new Uint8Array([1, 2, 3]))).toBeNull(); // not a WAV
    expect(wavDurationMs(wav({ format: 2, dataBytes: SECOND }))).toBeNull(); // ADPCM: compressed
    expect(wavDurationMs(wav({ byteRateOverride: 12_345, dataBytes: SECOND }))).toBeNull(); // rate disagrees with itself
    expect(wavDurationMs(wav({ omitFmt: true, dataBytes: SECOND }))).toBeNull(); // data before any fmt
    expect(wavDurationMs(wav({ dataBytes: SECOND }).subarray(0, 30))).toBeNull(); // header itself cut off
    // A non-data chunk of unknown size: nothing after it can be found.
    const unknownChunk = wav({ dataBytes: SECOND });
    unknownChunk.set([0x4c, 0x49, 0x53, 0x54], 36); // "LIST" where "data" was
    new DataView(unknownChunk.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDurationMs(unknownChunk)).toBeNull();
  });
});

describe("estimatedDurationMs — Piper's format, when the header could not be read", () => {
  it("estimates from the byte count at 22,050 Hz 16-bit mono", () => {
    expect(PIPER_BYTES_PER_SECOND).toBe(44_100);
    expect(estimatedDurationMs(wav({ format: 2, dataBytes: 5 * SECOND }))).toBe(5_000);
  });

  it("is null for bytes that are not a WAV at all", () => {
    expect(estimatedDurationMs(new Uint8Array(100_000))).toBeNull();
  });
});

describe("playbackLimitMs — what play() actually waits", () => {
  it("is the clip's length plus the grace when the header is readable", () => {
    expect(playbackLimitMs(wav({ dataBytes: 30 * SECOND }))).toEqual({
      limitMs: 30_000 + PLAYBACK_GRACE_MS,
      basis: "header",
      clipMs: 30_000,
    });
  });

  it("falls back to the estimate plus the grace, then to the ceiling", () => {
    expect(playbackLimitMs(wav({ format: 2, dataBytes: 20 * SECOND }))).toEqual({
      limitMs: 20_000 + PLAYBACK_GRACE_MS,
      basis: "estimate",
      clipMs: 20_000,
    });
    expect(playbackLimitMs(new Uint8Array([1, 2, 3]))).toEqual({
      limitMs: PLAYBACK_CEILING_MS,
      basis: "ceiling",
      clipMs: null,
    });
  });

  it("is never the old 15 s bound for a clip longer than that, whatever the path", () => {
    for (const bytes of [
      wav({ dataBytes: 37_740 * 44.1 }), // the measured 585-character elaborate remainder
      wav({ format: 2, dataBytes: 37_740 * 44.1 }),
      new Uint8Array([0]),
    ]) {
      expect(playbackLimitMs(bytes).limitMs).toBeGreaterThan(37_740);
    }
  });

  it("the grace and the ceiling are the values this milestone chose", () => {
    // Tunable, but a change should be deliberate: the grace covers the IPC hops, blob decode
    // and device start; the ceiling is longer than anything the app has been measured to say.
    expect(PLAYBACK_GRACE_MS).toBe(5_000);
    expect(PLAYBACK_CEILING_MS).toBe(120_000);
  });
});
