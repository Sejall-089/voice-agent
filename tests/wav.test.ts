import { describe, it, expect } from "vitest";
import { downsampleTo16k, encodeWav, TARGET_SAMPLE_RATE } from "../src/renderer/audio/wav.ts";

// The audio format contract with whisper.cpp: 16 kHz, mono, 16-bit PCM. Pure functions, so
// this runs with no microphone and no browser.

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

describe("encodeWav", () => {
  it("writes a RIFF/WAVE header whisper.cpp will accept", () => {
    const wav = encodeWav(new Float32Array(160));

    expect(readAscii(wav, 0, 4)).toBe("RIFF");
    expect(readAscii(wav, 8, 4)).toBe("WAVE");
    expect(readAscii(wav, 12, 4)).toBe("fmt ");
    expect(readAscii(wav, 36, 4)).toBe("data");
    expect(readU16(wav, 20)).toBe(1); // PCM
    expect(readU16(wav, 22)).toBe(1); // mono
    expect(readU32(wav, 24)).toBe(TARGET_SAMPLE_RATE); // 16 kHz
    expect(readU16(wav, 34)).toBe(16); // 16-bit
  });

  it("sizes the file and the data chunk from the sample count", () => {
    const wav = encodeWav(new Float32Array(100));

    expect(wav.byteLength).toBe(44 + 200); // header + 2 bytes per sample
    expect(readU32(wav, 40)).toBe(200); // data chunk length
    expect(readU32(wav, 4)).toBe(36 + 200); // RIFF size = file size - 8
  });

  it("scales floats to 16-bit and clamps out-of-range samples instead of wrapping", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2]));
    const view = new DataView(wav.buffer, wav.byteOffset);

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
    // Without the clamp these would wrap to loud negative/positive clicks.
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32767);
  });
});

describe("downsampleTo16k", () => {
  it("converts a 48 kHz capture to a third as many samples", () => {
    const input = new Float32Array(48_000); // one second at 48 kHz
    expect(downsampleTo16k(input, 48_000)).toHaveLength(16_000); // one second at 16 kHz
  });

  it("converts a 44.1 kHz capture to the right duration", () => {
    const input = new Float32Array(44_100); // one second
    expect(downsampleTo16k(input, 44_100)).toHaveLength(16_000);
  });

  it("returns the input untouched when it is already 16 kHz", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleTo16k(input, TARGET_SAMPLE_RATE)).toBe(input);
  });

  it("averages the source window rather than dropping samples", () => {
    // 32 kHz → 16 kHz: each output sample is the mean of a pair.
    const output = downsampleTo16k(new Float32Array([0, 1, 0.5, 1.5]), 32_000);
    expect(Array.from(output)).toEqual([0.5, 1]);
  });

  it("handles an empty capture without throwing", () => {
    expect(downsampleTo16k(new Float32Array(0), 48_000)).toHaveLength(0);
  });
});
