// Generates the needs-you chime (M23): src/renderer/assets/needs-you.wav.
//
//   node scripts/make-chime.mjs
//
// The sound is made here rather than downloaded so there is no licence to track and the file
// can be rebuilt byte for byte. Two soft sine notes a fourth apart (E5 then A5), each with a
// short attack and an exponential tail, about 0.42 s in all, peaking well under full scale —
// it has to be noticed without startling someone who is mid-sentence in another window.
//
// 44.1 kHz mono 16-bit PCM. No speech engine and no network are involved in playing it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44_100;
const PEAK = 0.32;
const NOTES = [
  { hz: 659.25, startMs: 0, lengthMs: 260 },
  { hz: 880.0, startMs: 130, lengthMs: 290 },
];
const TOTAL_MS = 420;

const samples = new Float64Array(Math.round((RATE * TOTAL_MS) / 1000));
for (const note of NOTES) {
  const start = Math.round((RATE * note.startMs) / 1000);
  const length = Math.round((RATE * note.lengthMs) / 1000);
  for (let i = 0; i < length && start + i < samples.length; i += 1) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.008);
    const decay = Math.exp(-t * 11);
    // A quiet octave above the fundamental, so it reads as a bell rather than a test tone.
    const wave = Math.sin(2 * Math.PI * note.hz * t) + 0.18 * Math.sin(4 * Math.PI * note.hz * t);
    samples[start + i] += PEAK * attack * decay * wave;
  }
}
// The last 10 ms fade to exactly zero, so the file cannot end on a click.
const fade = Math.round(RATE * 0.01);
for (let i = 0; i < fade; i += 1) samples[samples.length - 1 - i] *= i / fade;

const data = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i += 1) {
  const clipped = Math.max(-1, Math.min(1, samples[i]));
  data.writeInt16LE(Math.round(clipped * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/assets/needs-you.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${header.length + data.length} bytes, ${TOTAL_MS} ms)`);
