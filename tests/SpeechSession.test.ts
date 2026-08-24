import { describe, it, expect } from "vitest";
import { SpeechSession } from "../src/main/shell/SpeechSession.ts";
import { VoiceSession } from "../src/main/shell/VoiceSession.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeSynthesizer } from "./FakeSynthesizer.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";
import type { CapturedContext } from "../src/core/types.ts";

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// M14 task 4. The queue and the barge-in, with no audio device and no engine.
//
// Everything here is the "ordinary logic" half of TTS that M13 said must not wait for a live
// run: what gets said, in what order, what happens when you interrupt, and what happens when
// the engine fails. Only whether the resulting audio is intelligible needs ears.

function session(options: { hold?: boolean; failWith?: string; holdPlayback?: boolean } = {}) {
  const shell = new MockShell({ context: NO_CONTEXT, holdPlayback: options.holdPlayback });
  const synth = new FakeSynthesizer({ hold: options.hold, failWith: options.failWith });
  const failures: string[] = [];
  const speech = new SpeechSession(shell, synth, {
    onFailure: (message) => failures.push(message),
  });
  return { speech, shell, synth, failures };
}

// With `hold` on, EVERY synthesis waits to be released, so a test that queues more than one has
// to keep releasing until the session goes idle. Capped rather than while-true: a hang here
// should fail the assertion below it, not the whole run.
async function releaseAll(
  speech: { isSpeaking(): boolean; settled(): Promise<void> },
  synth: FakeSynthesizer,
): Promise<void> {
  for (let i = 0; i < 20 && speech.isSpeaking(); i += 1) {
    synth.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  await speech.settled();
}

describe("SpeechSession — saying things in order", () => {
  it("says one utterance", async () => {
    const { speech, synth, shell } = session();

    speech.speak("Done.");
    await speech.settled();

    expect(synth.spoken).toEqual(["Done."]);
    expect(shell.played).toHaveLength(1);
  });

  it("drains the queue in order, one at a time", async () => {
    // A caution tool narrates and then reports; the second must not talk over the first.
    const { speech, synth } = session();

    speech.speak("Opening the reply box.");
    speech.speak("Done.");
    await speech.settled();

    expect(synth.spoken).toEqual(["Opening the reply box.", "Done."]);
  });

  it("returns immediately rather than waiting for audio", async () => {
    // The property the whole design rests on: a caution tool announces itself and then ACTS.
    // If speak() blocked, the app would say "opening the reply box" and then sit there.
    const { speech, synth } = session({ hold: true });

    speech.speak("Opening the reply box.");

    // Synthesis is still in flight and speak() has already handed control back.
    expect(synth.calls).toBe(1);
    expect(speech.isSpeaking()).toBe(true);

    synth.release();
    await speech.settled();
  });

  it("never speaks an empty utterance", async () => {
    const { speech, synth } = session();

    speech.speak("");
    speech.speak("   ");
    await speech.settled();

    expect(synth.calls).toBe(0);
  });
});

describe("SpeechSession — barge-in", () => {
  it("stops what is playing and drops what is queued", async () => {
    const { speech, shell, synth } = session({ holdPlayback: true });

    speech.speak("The first thing.");
    speech.speak("The second thing.");
    // Let the first reach the player and stay there, mid-utterance.
    await Promise.resolve();
    await Promise.resolve();

    speech.stop();
    await speech.settled();

    expect(shell.stopPlaybackCalls).toBeGreaterThanOrEqual(1);
    // The second was never even synthesized: the queue is dropped, not merely silenced.
    expect(synth.spoken).toEqual(["The first thing."]);
  });

  it("discards an utterance interrupted WHILE the engine was working", async () => {
    // The race that matters. Synthesis is async, so without a generation check the audio would
    // arrive after the barge-in and talk over the instruction the user is already speaking.
    const { speech, shell, synth } = session({ hold: true });

    speech.speak("Too late.");
    expect(synth.calls).toBe(1);

    speech.stop();
    synth.release(); // the engine finishes AFTER the interruption
    await speech.settled();

    expect(shell.played).toEqual([]);
  });

  it("is safe when nothing is being said", () => {
    const { speech, shell } = session();

    expect(() => speech.stop()).not.toThrow();
    expect(shell.stopPlaybackCalls).toBe(1); // still told the player, which must tolerate it
  });

  it("keeps working after an interruption", async () => {
    const { speech, synth } = session();

    speech.speak("Interrupted.");
    speech.stop();
    await speech.settled();

    speech.speak("The next instruction's answer.");
    await speech.settled();

    expect(synth.spoken).toContain("The next instruction's answer.");
  });

  it("says something queued after a barge-in, rather than stranding it", async () => {
    // The subtle one: stop() lands while synthesis is in flight, and a new utterance arrives
    // before the drain loop notices. The stale one must be dropped and the fresh one must still
    // be said — nothing may be left sitting in the queue with no one draining it.
    const { speech, shell, synth } = session({ hold: true });

    speech.speak("Stale.");
    speech.stop();
    speech.speak("Fresh.");
    await releaseAll(speech, synth);

    // Both reached the engine — "Stale." was already in flight when the stop landed — but only
    // the fresh one was ever played.
    expect(synth.spoken).toEqual(["Stale.", "Fresh."]);
    expect(shell.played).toHaveLength(1);
    expect(speech.isSpeaking()).toBe(false);
  });
});

describe("SpeechSession — failure", () => {
  it("does not wedge the queue when the engine fails", async () => {
    const { speech, failures } = session({ failWith: "piper exited with code 1" });

    speech.speak("One.");
    speech.speak("Two.");
    await speech.settled();

    expect(speech.isSpeaking()).toBe(false);
    expect(failures).toHaveLength(1); // both failed; the user is told once, not twice
    expect(failures[0]).toContain("piper exited with code 1");
  });

  it("reports rather than failing silently", async () => {
    // A speaker that has quietly stopped working is this project's least favourite failure —
    // indistinguishable from one that simply had nothing to say.
    const { speech, failures } = session({ failWith: "no such file" });

    speech.speak("Anything.");
    await speech.settled();

    expect(failures[0]).toContain("Couldn't say that out loud");
  });

  it("refuses text the engine could not take, and keeps going", async () => {
    // The strict fake earning its place inside the session: a leak from the cleaner shows up
    // here as a reported failure rather than as a garbled noise on a live machine.
    const { speech, failures, shell } = session();

    speech.speak("3–4 PM"); // an en dash the transform should have removed
    speech.speak("Fine though.");
    await speech.settled();

    expect(failures).toHaveLength(1);
    expect(shell.played).toHaveLength(1); // the good one still got said
  });
});

describe("the microphone is never open while the app is talking", () => {
  it("stops playback when a recording starts", async () => {
    // Enforced in the shell, at the one chokepoint every path to the microphone passes through,
    // rather than at each hotkey — M8's lesson about binding cleanup to the event and not to
    // one code path. This is not a preference: the instruction hotkey opens the bar AND the mic
    // together, so an app still speaking would be transcribed into the user's own instruction.
    const { speech, shell } = session({ holdPlayback: true });

    speech.speak("Still talking.");
    await Promise.resolve();
    await Promise.resolve();

    const before = shell.stopPlaybackCalls;
    await shell.startRecording();

    expect(shell.stopPlaybackCalls).toBeGreaterThan(before);
  });

  it("holds for the voice path too, through VoiceSession's own begin()", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, holdPlayback: true });
    const speech = new SpeechSession(shell, new FakeSynthesizer());
    const voice = new VoiceSession(shell, new FakeTranscriber("anything"));

    speech.speak("Still talking.");
    await Promise.resolve();
    await Promise.resolve();

    await voice.begin();

    expect(shell.stopPlaybackCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("SpeechSession — an utterance that has been overtaken by events", () => {
  // Found live: a confirm dialog was cancelled, and roughly five seconds later the app said
  // something about it. The summary had been sitting in the queue behind a ~5s synthesis the
  // whole time. Latency made it visible; the actual defect is that speech describes a MOMENT,
  // and a queue that always drains eventually will happily describe one that has passed.

  function clocked(staleAfterMs: number) {
    const shell = new MockShell({ context: NO_CONTEXT });
    const synth = new FakeSynthesizer({ hold: true });
    let now = 0;
    const speech = new SpeechSession(shell, synth, {
      staleAfterMs,
      now: () => now,
    });
    return { shell, synth, speech, tick: (ms: number) => (now += ms) };
  }

  it("drops one that waited too long instead of saying it", async () => {
    const { speech, synth, tick } = clocked(1000);

    speech.speak("Said promptly.");
    speech.speak("Overtaken by events.");
    tick(5000); // the first utterance is still synthesizing while the world moves on

    await releaseAll(speech, synth);

    expect(synth.spoken).toEqual(["Said promptly."]);
  });

  it("keeps saying things afterwards — staleness drops one item, it does not stop the queue", async () => {
    const { speech, synth, tick } = clocked(1000);

    speech.speak("First.");
    speech.speak("Stale.");
    tick(5000);
    await releaseAll(speech, synth);

    speech.speak("Fresh.");
    await releaseAll(speech, synth);

    expect(synth.spoken).toEqual(["First.", "Fresh."]);
    expect(speech.isSpeaking()).toBe(false);
  });

  it("measures from when it was QUEUED, not from when the queue reached it", async () => {
    // The distinction that makes this work: something queued while the engine was busy has
    // already been waiting, and the wait is exactly what makes it stale.
    const { speech, synth, tick } = clocked(1000);

    speech.speak("First.");
    tick(2000);
    speech.speak("Queued late, so still fresh.");

    await releaseAll(speech, synth);

    expect(synth.spoken).toEqual(["First.", "Queued late, so still fresh."]);
  });
});
