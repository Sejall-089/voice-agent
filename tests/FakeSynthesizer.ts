import type { SpeechSynthesizer } from "../src/core/types.ts";

// The stand-in for Piper (M14), and the place M13's second lesson is being paid forward:
// "a fake more lenient than the real service hides the exact bug it exists to catch."
// FakeCalendar matched on substrings where Google ANDs its search terms, and the difference the
// bug turned on was invisible under the fake. So this one REFUSES, loudly, everything the real
// path cannot take.
//
// Every rule below is either something scripts/tts-recon.mjs actually observed, or a project
// constraint labelled as one. The distinction matters: an engine limit is a fact that stays true
// if the engine is swapped for ElevenLabs, a project constraint is a decision that might not.
//
// Deliberately does NOT call core/speech.ts's own cleaner to decide what is acceptable. Checking
// the transform with the transform would only ever prove it agrees with itself; these rules are
// written out independently so a hole in the cleaner shows up as a failing test rather than as
// two bugs cancelling out.
export class FakeSynthesizer implements SpeechSynthesizer {
  // Everything it was asked to say, in order — the assertion surface for the queue tests.
  public readonly spoken: string[] = [];
  public calls = 0;

  constructor(private readonly options: { failWith?: string } = {}) {}

  synthesize(text: string): Promise<Uint8Array> {
    this.calls += 1;

    if (this.options.failWith !== undefined) {
      return Promise.reject(new Error(this.options.failWith));
    }

    const problem = unspeakable(text);
    if (problem !== null) {
      // A rejection a test can read: the message names the rule AND the offending text, because
      // "synthesis failed" would send the next person debugging the engine instead of the
      // transform that produced this.
      return Promise.reject(
        new Error(`FakeSynthesizer refused: ${problem} — got ${JSON.stringify(text)}`),
      );
    }

    this.spoken.push(text);
    return Promise.resolve(silentWav(text.length));
  }
}

// ENGINE LIMIT (recon Q2): empty and whitespace-only input make piper exit 1. It does not
// produce a silent file, so a caller that "just speaks it anyway" gets an error, and a player
// waiting on an `ended` event that never arrives would wedge the queue behind it.
// PROJECT CONSTRAINT: one call is one utterance. Recon Q1 found a newline does NOT drop the
// second line, so this is not the engine's limit — it is ours, because prosody across a line
// break is wrong and because the queue's accounting assumes one WAV per call.
// ENGINE LIMIT (recon Q5): non-ASCII punctuation arrives mis-decoded. An en dash was voiced as
// the Windows-1252 reading of its UTF-8 bytes ("â €"), which is a mangled utterance rather than
// a mispronounced character.
// PROJECT CONSTRAINT, deliberately STRICTER than the engine: markdown and list markers. Piper
// would say something for these rather than fail, and what it says is "asterisk" or nothing —
// stripping them is core/speech.ts's whole job, so a leak is a bug that must not pass silently.
export const MAX_UTTERANCE_CHARS = 400;

export function unspeakable(text: string): string | null {
  if (text.trim().length === 0) return "empty text (the real engine exits 1)";
  if (/[\r\n]/.test(text)) return "a line break (one call is one utterance)";
  if (text.length > MAX_UTTERANCE_CHARS) {
    return `${text.length} characters, over the ${MAX_UTTERANCE_CHARS} cap`;
  }

  const markup = /[•*_`#…“”‘’–—]/.exec(text);
  if (markup !== null) return `the markup character ${JSON.stringify(markup[0])}`;

  // Anything else outside printable ASCII, EXCEPT letters. Letters are allowed on purpose:
  // core/speech.ts leaves "José" alone rather than mangling a real name, and the honest fix for
  // those is the synthesizer's own encoding (spawn with PYTHONUTF8=1), not deletion upstream.
  // When step 5 proves that encoding, this rule and that decision get revisited together.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 126 && !/\p{L}/u.test(char)) {
      return `the non-ASCII character ${JSON.stringify(char)} (the engine mis-decodes these)`;
    }
    if (code < 32) return `a control character (code ${code})`;
  }

  return null;
}

// A real, parseable WAV so a player under test can read a duration off it rather than being
// handed an opaque blob. 22.05 kHz mono 16-bit — Piper's medium-voice format, per recon Q4, and
// pointedly not AudioClip's 16 kHz.
const SAMPLE_RATE = 22_050;

export function silentWav(chars: number): Uint8Array {
  // Roughly a syllable's worth of audio per character, so a longer utterance is a longer clip.
  const samples = Math.max(1, chars * 100);
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}
