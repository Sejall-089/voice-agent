import { describe, it, expect } from "vitest";
import { InMemoryChainState } from "../src/core/chainState.ts";

// M17. Small, but it is what the hotkey guards read, so its edges are the difference between a
// blocked press and a second concurrent planner run.

describe("InMemoryChainState", () => {
  it("reports nothing running before anything starts", () => {
    const state = new InMemoryChainState();

    expect(state.isRunning()).toBe(false);
    expect(state.position()).toBeNull();
  });

  it("is running, at step 1, the moment a chain begins", () => {
    // Synchronously — begin() is called before the run's first await, so there is no window in
    // which the chain has started and the guards still say idle.
    const state = new InMemoryChainState();
    state.begin(3);

    expect(state.isRunning()).toBe(true);
    expect(state.position()).toEqual({ step: 1, total: 3 });
  });

  it("tracks the step it has reached", () => {
    const state = new InMemoryChainState();
    state.begin(3);
    state.step(2);

    expect(state.position()).toEqual({ step: 2, total: 3 });
  });

  it("stops running once the chain ends", () => {
    const state = new InMemoryChainState();
    state.begin(3);
    state.step(2);
    state.end();

    expect(state.isRunning()).toBe(false);
    expect(state.position()).toBeNull();
  });

  it("survives end() being called twice, and called when nothing ran", () => {
    // The only correct place to call it is a `finally`, so it has to tolerate both.
    const state = new InMemoryChainState();
    state.end();
    state.begin(2);
    state.end();
    state.end();

    expect(state.isRunning()).toBe(false);
  });

  it("ignores a step number outside the chain rather than reporting a nonsense position", () => {
    const state = new InMemoryChainState();
    state.begin(2);

    state.step(9);
    expect(state.position()).toEqual({ step: 2, total: 2 });

    state.step(0);
    expect(state.position()).toEqual({ step: 1, total: 2 });
  });

  it("ignores step() when no chain is running", () => {
    const state = new InMemoryChainState();
    state.step(2);

    expect(state.isRunning()).toBe(false);
    expect(state.position()).toBeNull();
  });

  it("treats a zero-step chain as not running", () => {
    // Defensive: validatePlan refuses an empty plan long before this, and a flag left set by a
    // chain that never had a step would strand the hotkeys permanently.
    const state = new InMemoryChainState();
    state.begin(0);

    expect(state.isRunning()).toBe(false);
  });

  it("lets a second begin() take over rather than stranding the flag", () => {
    // If this is ever reached the guards have failed and two runs are in flight — but the newer
    // run is the one whose end() will fire, so it must own the flag.
    const state = new InMemoryChainState();
    state.begin(3);
    state.step(3);
    state.begin(2);

    expect(state.position()).toEqual({ step: 1, total: 2 });
  });
});
