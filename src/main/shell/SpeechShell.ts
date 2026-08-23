// The playback half of voice output (M14) — a parallel contract next door to VoiceShell.ts, and
// for the identical reason (spec §4a): `OSShell` is what `/core` depends on, and the core brain
// has no business knowing a speaker exists any more than it knows a microphone does. Speaking is
// main-process wiring, so it gets its own interface here. `WindowsShell` implements it,
// `MockShell` implements it, a future Mac shell would implement it.
//
// Note what is NOT here: turning text into audio. That is `SpeechSynthesizer` (core/types.ts),
// behind its own interface, because the engine is swappable (Piper now, ElevenLabs later) while
// "play these bytes and let me stop them" is the same job on any OS with any engine. Splitting
// them is what lets `SpeechSession` be tested against a fake engine AND a fake speaker.

export interface SpeechShell {
  // Play one utterance to completion.
  //
  // MUST resolve when the audio finishes OR when `stopPlayback` cuts it off — never reject, and
  // never hang. The queue in SpeechSession is drained by awaiting this, so a `play` that stays
  // pending after a barge-in would strand every utterance behind it.
  play(wav: Uint8Array): Promise<void>;

  // Cut playback off now. Safe to call when nothing is playing, and safe to call twice: the one
  // thing it must always do is leave nothing audible behind it.
  stopPlayback(): void;
}
