// Playing one utterance (M14). The renderer's counterpart to MicRecorder: main owns the queue
// and the decisions, the renderer owns the device.
//
// Speech output lives here rather than in the main process for the same reason capture does —
// this is where the Web Audio APIs are — and it means the two halves of "voice" share one
// process, which is what makes "never listen while speaking" a local guarantee rather than a
// cross-process race.
//
// An <audio> element rather than AudioContext.decodeAudioData: its `ended` event is exactly the
// signal `SpeechShell.play()` has to resolve on, and there is no decode step to fail separately
// from playback. The queue upstream means only one of these is ever live at a time.

export class SpeechPlayer {
  private current: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;

  // Resolves when the utterance finishes OR when stop() cuts it off — never rejects, because
  // the queue draining upstream awaits this, and a rejection there would strand everything
  // behind it. A failure to play is reported through `onError` and still resolves.
  play(wav: Uint8Array, onError: (message: string) => void): Promise<void> {
    this.stop();

    // Copy into a fresh ArrayBuffer: the bytes arrive over IPC and may be a view into a larger
    // buffer, which Blob would otherwise take in full.
    const url = URL.createObjectURL(
      new Blob([wav.slice().buffer], { type: "audio/wav" }),
    );
    const audio = new Audio(url);
    this.current = audio;
    this.currentUrl = url;

    return new Promise<void>((resolve) => {
      const done = (): void => {
        // Only tidy up if this utterance is still the current one — stop() may already have
        // moved on to the next, and revoking its URL would kill it mid-sentence.
        if (this.current === audio) this.release();
        resolve();
      };

      audio.onended = done;
      audio.onerror = () => {
        onError("the audio device rejected the clip");
        done();
      };

      audio.play().catch((error: unknown) => {
        // The most likely cause by far is Chromium's autoplay policy, which main.ts disables
        // at startup precisely because nothing here is ever triggered by a click.
        onError(error instanceof Error ? error.message : String(error));
        done();
      });
    });
  }

  // Cut playback off now. Safe when nothing is playing, and safe to call twice.
  stop(): void {
    const audio = this.current;
    if (audio === null) return;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    this.release();
  }

  private release(): void {
    if (this.currentUrl !== null) URL.revokeObjectURL(this.currentUrl);
    this.current = null;
    this.currentUrl = null;
  }
}
