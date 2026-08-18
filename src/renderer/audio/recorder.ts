import { downsampleTo16k, encodeWav, TARGET_SAMPLE_RATE } from "./wav.ts";

// Microphone capture, renderer-side (M7). The command-bar window already exists and has
// Web Audio, so raw PCM is available with no ffmpeg and no native audio module — we take
// Float32 frames straight off the graph and encode the WAV ourselves.
//
// ScriptProcessorNode is deprecated in favour of AudioWorklet, but a worklet needs a
// separately-bundled module file for one buffer copy. Not worth it here.

const FRAME_SIZE = 4096;

export interface RecordedClip {
  wav: Uint8Array;
  durationMs: number;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];

  isRecording(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return; // already recording; the state machine owns the toggle

    // Browser echo-cancellation/noise-suppression genuinely help whisper on a laptop mic.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.chunks = [];
    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);

    this.processor.onaudioprocess = (event): void => {
      // The event buffer is reused by the browser — copy, don't retain.
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };

    this.source.connect(this.processor);
    // ScriptProcessor only fires while connected to a destination. Route it through a
    // muted gain node so nothing is played back into the speakers.
    const silence = this.context.createGain();
    silence.gain.value = 0;
    this.processor.connect(silence);
    silence.connect(this.context.destination);
  }

  async stop(): Promise<RecordedClip> {
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const chunks = this.chunks;
    await this.teardown();

    const samples = concat(chunks);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    const wav = encodeWav(downsampleTo16k(samples, sampleRate));
    return { wav, durationMs };
  }

  async cancel(): Promise<void> {
    await this.teardown();
  }

  // Releasing the mic track is the point: leave it open and Windows keeps showing "this app
  // is using your microphone" long after the recording ended.
  private async teardown(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    this.chunks = [];
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
