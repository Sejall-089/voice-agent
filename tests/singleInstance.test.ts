import { describe, expect, it } from "vitest";
import { claimSingleInstance } from "../src/main/singleInstance.ts";

// One running instance (M23). The decision, behind a fake `app` — the real one cannot be
// imported without booting electron.
//
// The fake keeps the listener it is handed and fires it only when the test says a second
// launch happened, because that is what electron does: `second-instance` arrives later, from
// another process, never during the call that registered it.
function fakeApp(lockGranted: boolean) {
  const calls: string[] = [];
  let listener: (() => void) | null = null;
  return {
    calls,
    app: {
      requestSingleInstanceLock: () => {
        calls.push("lock");
        return lockGranted;
      },
      quit: () => {
        calls.push("quit");
      },
      on: (event: "second-instance", handler: () => void) => {
        calls.push(`on:${event}`);
        listener = handler;
      },
    },
    secondLaunch: () => listener?.(),
    hasListener: () => listener !== null,
  };
}

describe("claimSingleInstance", () => {
  it("the first instance keeps running and does not quit", () => {
    const fake = fakeApp(true);
    let shown = 0;
    expect(claimSingleInstance(fake.app, () => (shown += 1))).toBe(true);
    expect(fake.calls).toEqual(["lock", "on:second-instance"]);
    // Nothing is shown until someone actually starts a second copy.
    expect(shown).toBe(0);
  });

  it("the first instance makes itself known each time a second one is started", () => {
    const fake = fakeApp(true);
    let shown = 0;
    claimSingleInstance(fake.app, () => (shown += 1));
    fake.secondLaunch();
    fake.secondLaunch();
    expect(shown).toBe(2);
    expect(fake.calls).not.toContain("quit");
  });

  it("a second instance quits, reports false, and listens for nothing", () => {
    const fake = fakeApp(false);
    let shown = 0;
    expect(claimSingleInstance(fake.app, () => (shown += 1))).toBe(false);
    expect(fake.calls).toEqual(["lock", "quit"]);
    expect(fake.hasListener()).toBe(false);
    expect(shown).toBe(0);
  });
});
