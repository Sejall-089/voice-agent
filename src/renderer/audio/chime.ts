// Playing the needs-you chime (M23).
//
// ITS OWN `Audio` ELEMENT, deliberately not SpeechPlayer's. That player stops whatever it is
// playing before it starts the next thing, and reports every ending back to main on the one
// channel the speech queue is drained by — so a chime sent through it would cut a sentence
// off, and its ending would be taken for that sentence's. Measured before it was built
// (scripts/chime-recon.cjs): a second element plays alongside a first in a window that has
// never been shown, and pausing one leaves the other running.
//
// Nothing is reported back and nothing waits on it. A chime that fails to play is a missed
// sound, and the pill is already showing what it would have announced.

export class ChimePlayer {
  private current: HTMLAudioElement | null = null;

  constructor(
    private readonly url: string,
    // Injected so a test never constructs a real element.
    private readonly create: (url: string) => HTMLAudioElement = (url) => new Audio(url),
  ) {}

  play(): void {
    // One at a time: main already folds jobs that pause together into a single chime, and a
    // second request arriving mid-chime restarts nothing.
    if (this.current !== null) return;
    const audio = this.create(this.url);
    this.current = audio;
    const done = (): void => {
      if (this.current === audio) this.current = null;
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  }

  // The microphone is about to open. Whisper would hear the rest of it.
  stop(): void {
    const audio = this.current;
    if (audio === null) return;
    this.current = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  }
}
