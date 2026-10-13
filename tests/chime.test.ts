import { describe, expect, it } from "vitest";
import { Chime, COALESCE_MS, shouldChime } from "../src/core/jobs/chime.ts";
import type { ChimeInput } from "../src/core/jobs/chime.ts";
import type { JobState } from "../src/core/types.ts";

// The needs-you chime (M23): the decision, and the little state around it. Audio only ever
// leaves through the fake `play` below — no test in this repo constructs a real player for it.

const base: ChimeInput = {
  state: "needs-you",
  previous: "running",
  muted: false,
  busy: false,
  lastPlayedAt: null,
  now: 100_000,
};

describe("shouldChime — the pure decision", () => {
  it("plays when a job starts waiting and nothing is in the way", () => {
    expect(shouldChime(base)).toBe("play");
  });

  it("never plays for done, failed, or any state that is not needs-you", () => {
    const others: JobState[] = ["queued", "running", "done", "failed", "cancelled", "expired", "interrupted"];
    for (const state of others) {
      expect(shouldChime({ ...base, state }), state).toBe("skip");
      // Not even when the microphone is busy: there is nothing to hold for later.
      expect(shouldChime({ ...base, state, busy: true }), state).toBe("skip");
    }
  });

  it("does not play again for a job that was already waiting", () => {
    expect(shouldChime({ ...base, previous: "needs-you" })).toBe("skip");
  });

  it("muted: skipped outright — not deferred, so nothing is saved up", () => {
    expect(shouldChime({ ...base, muted: true })).toBe("skip");
    expect(shouldChime({ ...base, muted: true, busy: true })).toBe("skip");
  });

  it("busy (dictation, recording or speech): deferred", () => {
    expect(shouldChime({ ...base, busy: true })).toBe("defer");
  });

  it("inside the coalescing window of the last chime: skipped, busy or not", () => {
    const justPlayed = { ...base, lastPlayedAt: base.now - (COALESCE_MS - 1) };
    expect(shouldChime(justPlayed)).toBe("skip");
    expect(shouldChime({ ...justPlayed, busy: true })).toBe("skip");
  });

  it("at the edge of the window it plays again", () => {
    expect(shouldChime({ ...base, lastPlayedAt: base.now - COALESCE_MS })).toBe("play");
  });

  // The full table: job state × busy × muted × inside-the-window. One rule decides each cell.
  it("the whole table", () => {
    for (const state of ["needs-you", "done", "failed"] as const) {
      for (const busy of [false, true]) {
        for (const muted of [false, true]) {
          for (const recent of [false, true]) {
            const decision = shouldChime({
              ...base,
              state,
              busy,
              muted,
              lastPlayedAt: recent ? base.now - 500 : null,
            });
            const expected =
              state !== "needs-you" || muted || recent ? "skip" : busy ? "defer" : "play";
            expect(decision, JSON.stringify({ state, busy, muted, recent })).toBe(expected);
          }
        }
      }
    }
  });
});

function harness() {
  const world = {
    now: 100_000,
    played: 0,
    muted: false,
    busy: false,
    waiting: new Set<string>(),
  };
  const chime = new Chime({
    play: () => (world.played += 1),
    isMuted: () => world.muted,
    isBusy: () => world.busy,
    isWaiting: (id) => world.waiting.has(id),
    now: () => world.now,
  });
  const pause = (id: string): void => {
    world.waiting.add(id);
    chime.onJobState(id, "needs-you", "running");
  };
  return { world, chime, pause };
}

describe("Chime — with a clock and a fake player", () => {
  it("one job waiting: one chime", () => {
    const { world, pause } = harness();
    pause("a");
    expect(world.played).toBe(1);
  });

  it("THREE JOBS PAUSING TOGETHER = ONE CHIME", () => {
    const { world, pause } = harness();
    pause("a");
    world.now += 300;
    pause("b");
    world.now += 900;
    pause("c");
    expect(world.played).toBe(1);
  });

  it("a job that pauses after the window gets its own chime", () => {
    const { world, pause } = harness();
    pause("a");
    world.now += COALESCE_MS;
    pause("b");
    expect(world.played).toBe(2);
  });

  it("no chime on done or failed, whatever came before", () => {
    const { world, chime } = harness();
    chime.onJobState("a", "done", "running");
    chime.onJobState("b", "failed", "running");
    chime.onJobState("c", "done", "needs-you");
    chime.onJobState("d", "expired", "needs-you");
    expect(world.played).toBe(0);
  });

  it("SUPPRESSED while busy, then played ONCE afterwards — if the job is still waiting", () => {
    const { world, chime, pause } = harness();
    world.busy = true; // the user is dictating
    pause("a");
    expect(world.played).toBe(0);
    expect(chime.hasDeferred()).toBe(true);

    expect(chime.flush()).toBe(false); // still dictating
    expect(world.played).toBe(0);

    world.busy = false;
    world.now += 9_000;
    expect(chime.flush()).toBe(true);
    expect(world.played).toBe(1);
    // Once. A later flush has nothing left to play.
    expect(chime.flush()).toBe(false);
    expect(world.played).toBe(1);
  });

  it("a deferred chime is DROPPED if the job was approved, expired or cancelled in the meantime", () => {
    for (const whatHappened of ["approved", "expired", "cancelled"]) {
      const { world, chime, pause } = harness();
      world.busy = true;
      pause("a");
      // While the user was still talking, the job stopped waiting.
      world.waiting.delete("a");
      world.busy = false;
      expect(chime.flush(), whatHappened).toBe(false);
      expect(world.played, whatHappened).toBe(0);
      expect(chime.hasDeferred()).toBe(false);
    }
  });

  it("several deferred jobs are one chime afterwards, as long as ANY of them still waits", () => {
    const { world, chime, pause } = harness();
    world.busy = true;
    pause("a");
    world.now += 5_000; // well outside the coalescing window: both are deferred in their own right
    pause("b");
    world.now += 5_000;
    pause("c");
    world.waiting.delete("a");
    world.waiting.delete("c");
    world.busy = false;
    expect(chime.flush()).toBe(true);
    expect(world.played).toBe(1);
  });

  it("muted while a chime was held: the held chime is dropped, not played on unmute", () => {
    const { world, chime, pause } = harness();
    world.busy = true;
    pause("a");
    world.muted = true;
    world.busy = false;
    expect(chime.flush()).toBe(false);
    world.muted = false;
    expect(chime.flush()).toBe(false);
    expect(world.played).toBe(0);
  });

  it("muted: nothing plays and nothing is held", () => {
    const { world, chime, pause } = harness();
    world.muted = true;
    pause("a");
    world.busy = true;
    pause("b");
    expect(world.played).toBe(0);
    expect(chime.hasDeferred()).toBe(false);
  });

  it("a chime played after a deferral starts a coalescing window of its own", () => {
    const { world, chime, pause } = harness();
    world.busy = true;
    pause("a");
    world.busy = false;
    world.now += 10_000;
    chime.flush();
    world.now += 500;
    pause("b"); // half a second after the deferred chime finally played
    expect(world.played).toBe(1);
  });
});
