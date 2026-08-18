// Pure audio maths — no DOM, no browser APIs, so it typechecks under both tsconfigs and
// is directly unit-testable. whisper.cpp wants 16 kHz mono 16-bit PCM; microphones hand us
// 44.1/48 kHz float. Normalizing here, at the capture site, keeps every Transcriber
// implementation free of resampling concerns.

export const TARGET_SAMPLE_RATE = 16_000;

// Rate-convert to 16 kHz. Box-averaging over each output sample's source window is the
// cheap anti-aliasing that keeps a 48 kHz downsample from sounding gritty to whisper.
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  if (input.length === 0) return input;

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);

    if (end <= start) {
      // Window narrower than one sample (only when up-rating): fall back to nearest.
      output[i] = input[Math.min(start, input.length - 1)];
      continue;
    }

    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = sum / (end - start);
  }

  return output;
}

// Float32 [-1, 1] → a complete 16-bit PCM WAV file (44-byte RIFF header + data).
export function encodeWav(samples: Float32Array, sampleRate: number = TARGET_SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2;
  const channels = 1;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample slightly past 1.0 would otherwise wrap to a loud click.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * bytesPerSample, Math.round(clamped * 0x7fff), true);
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
