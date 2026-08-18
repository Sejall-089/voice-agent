import type { AudioClip, Transcriber } from "../src/core/types.ts";

// Deterministic speech-to-text stand-in. Returns canned text — no audio, no model, no
// microphone, nothing to download in CI. Records every clip it was handed so specs can
// assert transcription DID or DID NOT happen. Mirrors FakeLLM / FakeSender.
export class FakeTranscriber implements Transcriber {
  public readonly calls: AudioClip[] = [];

  constructor(
    private readonly transcript: string = "",
    private readonly throws: string | null = null,
  ) {}

  transcribe(clip: AudioClip): Promise<string> {
    this.calls.push(clip);
    if (this.throws !== null) {
      return Promise.reject(new Error(this.throws));
    }
    return Promise.resolve(this.transcript);
  }
}
