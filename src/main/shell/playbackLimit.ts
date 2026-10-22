// How long main waits for one spoken clip to finish playing (M24).
//
// Main does not hear the audio: the renderer plays it and reports `speech:ended`. Main still
// has to stop waiting at SOME point, or a renderer that hangs without crashing would wedge the
// speech queue for ever — the app silent, and the chime (which waits for speech) held for good.
//
// Until M24 that point was RENDERER_REPLY_TIMEOUT_MS, a 15 s bound written in M7 for a reply
// ("the microphone is on") and reused in M14 for a wait that lasts as long as the clip does.
// Anything longer than 15 s was treated as finished at 15 s: `isSpeaking()` went false while
// the user was still listening, a held chime played over it, and the next utterance's
// `speech:play` stopped it mid-sentence. M23 measured the first, the M24 repro the second.
//
// So the bound is now the clip's OWN length, read from the bytes main is about to send, plus a
// grace for everything between `speech:play` and `ended` that is not audio. Pure, and no
// electron, so every rule here is tested directly (tests/playbackLimit.test.ts).

// What the clip's length does not cover: the IPC hop each way, the <audio> element loading and
// decoding a blob, and the output device starting. Each is tens of milliseconds, measured by
// nobody yet; five seconds is two orders of magnitude of margin over that. It only ever costs
// anything when the renderer has stopped answering — a clip that ends normally ends the wait
// the moment its report arrives, however much grace was left.
export const PLAYBACK_GRACE_MS = 5_000;

// When nothing about the clip's length can be known — the bytes are not a WAV at all. Generous
// on purpose: too short is the M24 bug again, and too long only matters if the renderer has
// also stopped answering. Two minutes is longer than anything `elaborate` has been measured to
// say (a 585-character remainder is 37.7 s).
export const PLAYBACK_CEILING_MS = 120_000;

// The format Piper writes for the configured voice, used only to ESTIMATE a length when a WAV's
// header cannot be read. 22,050 Hz, 16-bit, mono — read from the voice's own .onnx.json
// (`"sample_rate": 22050`) and the WAVs it produced. A different voice may differ, which is why
// this is a fallback and the header is always preferred.
export const PIPER_BYTES_PER_SECOND = 22_050 * 2;

// The size a streaming writer puts in a RIFF or data header when it did not know the length.
const UNKNOWN_SIZE = 0xffffffff;

// Formats whose header byte rate is exactly sampleRate × blockAlign, so length = bytes / rate.
const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;
const EXTENSIBLE = 0xfffe;

// The clip's exact length from its header, or null when the header cannot be trusted for one.
//
// Walks the chunks rather than assuming the 44-byte layout, because real WAVs carry `LIST` and
// other chunks before `data`, and a `fmt ` chunk can be 16, 18 or 40 bytes. Handles the two ways
// a data size can be wrong without the header being useless:
//   - truncated: the file ends before the size it declares — what can play is what is there;
//   - streaming: the size is 0xFFFFFFFF or 0 — the writer did not know it; the rest of the
//     file is the audio.
// Null (not a guess) for anything else: not RIFF/WAVE, no `fmt ` before `data`, a compressed or
// unknown format, or a byte rate that does not match its own sample rate and block size.
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (!isRiffWave(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let byteRate: number | null = null;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;

    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) return null;
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const rate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      if (format !== PCM && format !== IEEE_FLOAT && format !== EXTENSIBLE) return null;
      if (channels === 0 || sampleRate === 0 || blockAlign === 0) return null;
      if (rate !== sampleRate * blockAlign) return null;
      byteRate = rate;
    } else if (id === "data") {
      if (byteRate === null) return null;
      const present = bytes.byteLength - body;
      const declared = size === UNKNOWN_SIZE || size === 0 ? present : size;
      return Math.ceil((Math.min(declared, present) / byteRate) * 1000);
    }

    // A chunk whose size is unknown can only be the last one, and it was not `data`.
    if (size === UNKNOWN_SIZE) return null;
    // Chunks are word-aligned: an odd-sized chunk is followed by one pad byte.
    at = body + size + (size & 1);
  }
  return null;
}

// A length estimated from the byte count alone, as if the clip were Piper's own format with the
// canonical 44-byte header — for a RIFF/WAVE whose header could not be read. Null when the bytes
// are not a WAV at all, since then they are not Piper's either and the estimate would mean
// nothing.
export function estimatedDurationMs(bytes: Uint8Array): number | null {
  if (!isRiffWave(bytes)) return null;
  return Math.ceil((Math.max(0, bytes.byteLength - 44) / PIPER_BYTES_PER_SECOND) * 1000);
}

export interface PlaybackLimit {
  limitMs: number;
  // Where the length came from — said in the log line when a wait runs out, because "it waited
  // 2 minutes" means something different when the header was unreadable.
  basis: "header" | "estimate" | "ceiling";
  // The clip's length as far as it could be known; null for the ceiling.
  clipMs: number | null;
}

// How long to wait for this clip's `speech:ended` before moving on. Never the old 15 s.
export function playbackLimitMs(bytes: Uint8Array): PlaybackLimit {
  const exact = wavDurationMs(bytes);
  if (exact !== null) return { limitMs: exact + PLAYBACK_GRACE_MS, basis: "header", clipMs: exact };
  const estimate = estimatedDurationMs(bytes);
  if (estimate !== null) {
    return { limitMs: estimate + PLAYBACK_GRACE_MS, basis: "estimate", clipMs: estimate };
  }
  return { limitMs: PLAYBACK_CEILING_MS, basis: "ceiling", clipMs: null };
}

function isRiffWave(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && tag(bytes, 0) === "RIFF" && tag(bytes, 8) === "WAVE";
}

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}
