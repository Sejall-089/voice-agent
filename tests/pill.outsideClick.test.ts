import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import { IDLE_COLLAPSE_MS } from "../src/core/jobs/pill.ts";
import type { PillView, Rect } from "../src/core/jobs/pill.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import { PillController } from "../src/main/pill/PillController.ts";
import type { PointerPoint, PointerPressSource } from "../src/main/shell/PointerPressSource.ts";
import {
  hostScript,
  judgeSample,
  parsePointerLine,
  POLL_MS,
  WATCHED_BUTTONS,
  WindowsPointerWatcher,
} from "../src/main/shell/WindowsPointerWatcher.ts";
import type { PointerHost, PointerSample } from "../src/main/shell/WindowsPointerWatcher.ts";

// M27, fix B: while the pill's list is open, and only then, a mouse press OUTSIDE the pill closes
// it. The pill cannot take focus (M23), so it never blurs; until M27 an open list closed only ten
// seconds after the pointer left (M26's second live finding).
//
// The press source here is a FAKE that is asynchronous the way the real one is (CLAUDE.md, M16.9:
// a synchronous fake of an async thing cannot test ordering): `prepare` resolves after a delay, as
// the real PowerShell host does after ~1.5 s, and it FAILS with the same type the real one does —
// a plain Error, rejected from `prepare` before READY, or a reason to `onFailure` after it.

const T0 = 9_000_000_000;
const START_DELAY_MS = 15;
const flush = (ms = START_DELAY_MS + 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The pill at the bottom right of a 1280x672 work area; the bar in the middle of the screen.
const PILL: Rect = { x: 916, y: 356, width: 348, height: 300 };
const BAR_CENTRE: PointerPoint = { x: 640, y: 300 };

function fakeSource(options: { fail?: string } = {}) {
  const record = {
    prepares: 0,
    watching: false,
    watchCalls: 0,
    stopCalls: 0,
    current: null as ((point: PointerPoint) => void) | null,
    // The callback the last watch() was given, kept after stop(): a press polled just before
    // STOP can reach the controller just after it.
    last: null as ((point: PointerPoint) => void) | null,
    failureListeners: [] as ((reason: string) => void)[],
  };
  let prepared: Promise<void> | null = null;
  const source: PointerPressSource = {
    prepare: () => {
      if (prepared !== null) return prepared;
      record.prepares += 1;
      prepared = new Promise<void>((resolve, reject) =>
        setTimeout(() => (options.fail === undefined ? resolve() : reject(new Error(options.fail))), START_DELAY_MS),
      );
      return prepared;
    },
    watch: (onPress) => {
      record.watching = true;
      record.watchCalls += 1;
      record.current = onPress;
      record.last = onPress;
    },
    stop: () => {
      record.watching = false;
      record.stopCalls += 1;
      record.current = null;
    },
    onFailure: (listener) => void record.failureListeners.push(listener),
    dispose: () => undefined,
  };
  return {
    source,
    record,
    // A press, delivered as the real watcher delivers it: only while watching.
    press: (point: PointerPoint) => record.current?.(point),
    die: (reason: string) => record.failureListeners.forEach((listener) => listener(reason)),
  };
}

function world(options: { fail?: string; withSource?: boolean } = {}) {
  const clock = { now: T0 };
  let n = 0;
  const manager = new JobManager({ store: new InMemoryJobStore(), now: () => clock.now, newId: () => `job${(n += 1)}` });
  const fake = fakeSource(options);
  const views: PillView[] = [];
  const lines: string[] = [];
  let pillVisible = true;
  const controller = new PillController({
    manager,
    settings: new InMemorySettings(),
    surface: { render: (view) => void views.push(view) },
    playChime: () => undefined,
    isBusy: () => false,
    log: (line) => void lines.push(line),
    now: () => clock.now,
    ...(options.withSource === false ? {} : { outsidePresses: fake.source }),
    pillBounds: () => (pillVisible ? PILL : null),
  });
  const ended = (state: "done" | "failed" = "done"): string => {
    const id = manager.submit("summarize this");
    manager.detachAttached("hotkey");
    manager.finish(id, state, "A result.");
    return id;
  };
  const waiting = async (): Promise<string> => {
    const id = manager.submit("send these notes");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["sendMessage"], statusOnly: false });
    manager.detachAttached("hotkey");
    await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
    void gate.beforeConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return id;
  };
  return {
    clock,
    manager,
    controller,
    fake,
    views,
    lines,
    ended,
    waiting,
    hidePill: () => void (pillVisible = false),
    open: () => controller.view().expanded,
  };
}

describe("an open list closes on a press outside the pill (M27, fix B)", () => {
  it("THE LIVE FINDING: a press elsewhere closes the open list, and watching stops", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    expect(w.fake.record.watching).toBe(true);
    w.fake.press({ x: 100, y: 100 });
    expect(w.open()).toBe(false);
    expect(w.fake.record.watching).toBe(false);
    expect(w.lines.some((line) => line.endsWith("list CLOSED: a press outside the pill"))).toBe(true);
  });

  it("a press on the instruction bar counts as outside", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    w.fake.press(BAR_CENTRE);
    expect(w.open()).toBe(false);
  });

  it("A PRESS INSIDE THE PILL DOES NOT CLOSE IT — anywhere inside, edges included; one pixel past the edge does", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    const insides: PointerPoint[] = [
      { x: PILL.x + 170, y: PILL.y + 150 }, // a row
      { x: PILL.x, y: PILL.y }, // top-left corner
      { x: PILL.x + PILL.width - 1, y: PILL.y + PILL.height - 1 }, // bottom-right corner
    ];
    for (const point of insides) {
      w.fake.press(point);
      expect(w.open(), JSON.stringify(point)).toBe(true);
      expect(w.fake.record.watching).toBe(true);
    }
    w.fake.press({ x: PILL.x + PILL.width, y: PILL.y + 10 }); // just past the right edge
    expect(w.open()).toBe(false);
  });

  it("PREPARED when the pill first appears — not before it, and not at the click that opens the list", async () => {
    const w = world();
    expect(w.fake.record.prepares).toBe(0); // no pill yet
    w.ended();
    expect(w.fake.record.prepares).toBe(1); // the pill is on screen: start it now
    await flush();
    w.controller.onExpand(true);
    w.controller.onExpand(false);
    w.controller.onExpand(true);
    expect(w.fake.record.prepares).toBe(1);
  });

  it("NO POLLING WHILE CLOSED: watched only while open, and stopped by every way the list closes", async () => {
    const w = world();
    w.ended();
    w.ended("failed");
    const waiting = await w.waiting();
    await flush();
    expect(w.fake.record.watchCalls).toBe(0); // the pill is up, the list is not open

    const closers: [string, () => void][] = [
      ["a second click", () => w.controller.onExpand(false)],
      ["the hotkey", () => w.controller.collapse()],
      ["Review…", () => w.controller.onAction(waiting, "review")],
      [
        "ten seconds with the pointer off it",
        () => {
          w.controller.onHover(false);
          w.clock.now += IDLE_COLLAPSE_MS;
          w.controller.tick();
        },
      ],
    ];
    for (const [name, close] of closers) {
      w.controller.onExpand(true);
      expect(w.fake.record.watching, `open, before: ${name}`).toBe(true);
      close();
      expect(w.open(), name).toBe(false);
      expect(w.fake.record.watching, `after: ${name}`).toBe(false);
    }
    // Every watch was matched by a stop.
    expect(w.fake.record.stopCalls).toBe(w.fake.record.watchCalls);
    expect(w.fake.record.watchCalls).toBe(closers.length);
  });

  it("emptied with the list open — the last rows dismissed — stops watching too", async () => {
    const w = world();
    w.ended();
    w.ended("failed");
    await flush();
    w.controller.onExpand(true);
    expect(w.fake.record.watching).toBe(true);
    w.controller.onDismissAll();
    expect(w.controller.view().mode).toBe("hidden"); // the precondition: nothing is left
    expect(w.open()).toBe(false);
    expect(w.fake.record.watching).toBe(false);
  });

  it("a press that arrives after the list closed is ignored", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    w.controller.onExpand(false);
    const drawn = w.views.length;
    w.fake.record.last?.({ x: 10, y: 10 }); // polled before STOP, delivered after
    expect(w.open()).toBe(false);
    expect(w.views.length).toBe(drawn);
    expect(w.lines.some((line) => line.includes("a press outside the pill"))).toBe(false);
  });

  it("opened BEFORE the watcher was ready: watching starts as soon as it is, if the list is still open", async () => {
    const w = world();
    w.ended();
    w.controller.onExpand(true); // straight away, while it is starting
    expect(w.fake.record.watching).toBe(false);
    await flush();
    expect(w.fake.record.watching).toBe(true);
    w.fake.press({ x: 5, y: 5 });
    expect(w.open()).toBe(false);

    const v = world();
    v.ended();
    v.controller.onExpand(true);
    v.controller.onExpand(false); // closed again before it was ready
    await flush();
    expect(v.fake.record.watchCalls).toBe(0);
  });

  it("with no pill on screen there is nothing to be outside of", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    w.hidePill();
    w.fake.press({ x: 5, y: 5 });
    expect(w.open()).toBe(true);
  });
});

describe("when the watcher cannot watch, the list works as before — and the log says so", () => {
  it("IT FAILS TO START: said once in the log; the list still opens, and closes ten seconds after the pointer leaves", async () => {
    const w = world({ fail: "The pointer watcher did not start in time." });
    w.ended();
    await flush();
    const said = w.lines.filter((line) => line.includes("outside presses cannot be watched"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("The pointer watcher did not start in time.");

    w.controller.onExpand(true);
    expect(w.open()).toBe(true);
    expect(w.fake.record.watchCalls).toBe(0);
    w.controller.onHover(false);
    w.clock.now += IDLE_COLLAPSE_MS - 1;
    w.controller.tick();
    expect(w.open()).toBe(true);
    w.clock.now += 1;
    w.controller.tick();
    expect(w.open()).toBe(false);
    // Not retried at the next open: the click is not when to start it.
    w.controller.onExpand(true);
    expect(w.fake.record.prepares).toBe(1);
  });

  it("IT DIES LATER: said once, watching ends, and the list still closes on its own", async () => {
    const w = world();
    w.ended();
    await flush();
    w.controller.onExpand(true);
    expect(w.fake.record.watching).toBe(true);
    w.fake.die("The pointer watcher exited.");
    w.fake.die("The pointer watcher exited.");
    expect(w.lines.filter((line) => line.includes("outside presses cannot be watched (The pointer watcher exited.)"))).toHaveLength(1);
    w.controller.onExpand(false);
    w.controller.onExpand(true);
    expect(w.fake.record.watchCalls).toBe(1); // not watched again
    w.controller.onHover(false);
    w.clock.now += IDLE_COLLAPSE_MS;
    w.controller.tick();
    expect(w.open()).toBe(false);
  });

  it("with no watcher at all (none passed), nothing changes from before M27", async () => {
    const w = world({ withSource: false });
    w.ended();
    await flush();
    w.controller.onExpand(true);
    expect(w.open()).toBe(true);
    expect(w.lines.some((line) => line.includes("outside presses"))).toBe(false);
  });
});

// --- The real watcher, against a fake host process ---

// Asynchronous like a real process: what it prints arrives on a later tick.
function fakeHost() {
  const written: string[] = [];
  let onData: (chunk: string) => void = () => undefined;
  let onExit: () => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;
  let killed = false;
  const host: PointerHost = {
    write: (line) => void written.push(line),
    onData: (listener) => void (onData = listener),
    onExit: (listener) => void (onExit = listener),
    onError: (listener) => void (onError = listener),
    kill: () => void (killed = true),
  };
  return {
    host,
    written,
    print: (chunk: string): Promise<void> => new Promise((resolve) => setTimeout(() => (onData(chunk), resolve()), 1)),
    exit: () => onExit(),
    error: (error: Error) => onError(error),
    killed: () => killed,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function watcherWith(host: ReturnType<typeof fakeHost>, options: { startupTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "va-pointer-test-"));
  dirs.push(dir);
  let spawns = 0;
  const watcher = new WindowsPointerWatcher({
    spawnHost: () => {
      spawns += 1;
      return host.host;
    },
    scriptDir: () => dir,
    ...options,
  });
  return { watcher, dir, spawns: () => spawns };
}

describe("WindowsPointerWatcher — the transport, with the process faked", () => {
  it("MOUSE BUTTONS ONLY: left, right, middle, X1, X2 — no keyboard key can be a press", () => {
    expect([...WATCHED_BUTTONS]).toEqual([1, 2, 4, 5, 6]);
    expect(hostScript()).toContain("static readonly int[] Buttons = { 1, 2, 4, 5, 6 };");
    expect(POLL_MS).toBe(50);
  });

  it("only a well-formed SAMPLE line is a sample", () => {
    expect(parsePointerLine("SAMPLE 0 1 0 12 -40\r")).toEqual({
      type: "sample",
      sample: { first: false, down: 1, low: 0, point: { x: 12, y: -40 } },
    });
    expect(parsePointerLine("READY")).toEqual({ type: "ready" });
    for (const line of [
      "WATCHING",
      "STOPPED",
      "ERR unknown-command",
      "PRESS 12 40",
      "SAMPLE 0 1 0 12",
      "SAMPLE 2 1 0 12 40",
      "SAMPLE 0 -1 0 12 40",
      "SAMPLE 0 a 0 12 40",
      "SAMPLE 0 1 0 12 40 9",
      "",
    ]) {
      expect(parsePointerLine(line).type, line).toBe("other");
    }
  });

  // The rule that decides a press, now in TypeScript so it can be tested: when it lived in the
  // C# string, removing "discard the first poll" failed NO test (M27 mutation pass).
  describe("judgeSample: what counts as a press", () => {
    const sample = (first: boolean, down: number, low: number): PointerSample => ({ first, down, low, point: { x: 1, y: 2 } });
    const run = (samples: PointerSample[]): boolean[] => {
      let was: number | null = null;
      return samples.map((s) => {
        const judged = judgeSample(was, s);
        was = judged.wasDown;
        return judged.press;
      });
    };

    it("A BUTTON ALREADY DOWN WHEN WATCHING STARTS IS NOT A PRESS — not when it is seen, not while held, not when it is let go", () => {
      // Left held at the first read (its low bit set too, from when it went down); still held;
      // let go.
      expect(run([sample(true, 0b1, 0b1), sample(false, 0b1, 0), sample(false, 0, 0)])).toEqual([false, false, false]);
    });

    it("the click that opened the list — pressed and released before watching, its low bit still set — is not a press", () => {
      expect(run([sample(true, 0, 0b1), sample(false, 0, 0)])).toEqual([false, false]);
    });

    it("after the first read: a button going down is a press; held, it is not again; a tap between reads (low bit only) is", () => {
      expect(
        run([
          sample(true, 0, 0),
          sample(false, 0b1, 0b1), // left down
          sample(false, 0b1, 0), // still held
          sample(false, 0, 0), // released
          sample(false, 0, 0b10), // right tapped between two reads: only the low bit saw it
          sample(false, 0b100, 0), // middle down, low bit taken by someone else: the high bit still sees it
        ]),
      ).toEqual([false, true, false, false, true, true]);
    });

    it("a second button going down while the first is held is a press", () => {
      expect(run([sample(true, 0b1, 0), sample(false, 0b11, 0b10)])).toEqual([false, true]);
    });

    it("a sample with nothing recorded yet (left from a stopped watch) primes, whatever its bits", () => {
      expect(judgeSample(null, sample(false, 0b1, 0b1))).toEqual({ press: false, wasDown: 0b1 });
    });
  });

  it("THROUGH THE WATCHER: a button held when watching starts, and the opening click's low bit, never reach the listener", async () => {
    const host = fakeHost();
    const { watcher } = watcherWith(host);
    const ready = watcher.prepare();
    await host.print("READY\n");
    await ready;
    const presses: PointerPoint[] = [];
    watcher.watch((point) => void presses.push(point));
    await host.print("WATCHING\nSAMPLE 1 1 1 500 500\nSAMPLE 0 0 0 500 500\n");
    expect(presses).toEqual([]);
    await host.print("SAMPLE 0 1 1 30 40\n");
    expect(presses).toEqual([{ x: 30, y: 40 }]);
    // A new watch primes again: a button held across stop and watch is not a press.
    watcher.stop();
    watcher.watch((point) => void presses.push(point));
    await host.print("SAMPLE 1 1 0 9 9\nSAMPLE 0 0 0 9 9\n");
    expect(presses).toHaveLength(1);
  });

  it("starts once, writes the script it runs, and is ready on READY — even split across chunks", async () => {
    const host = fakeHost();
    const { watcher, dir, spawns } = watcherWith(host);
    const ready = watcher.prepare();
    expect(watcher.prepare()).toBe(ready);
    expect(spawns()).toBe(1);
    expect(readFileSync(join(dir, "pointer.ps1"), "utf8")).toBe(hostScript());
    await host.print("REA");
    await host.print("DY\r\n");
    await expect(ready).resolves.toBeUndefined();
  });

  it("watches at 50 ms, reports presses only while watching, and stops", async () => {
    const host = fakeHost();
    const { watcher } = watcherWith(host);
    const ready = watcher.prepare();
    await host.print("READY\n");
    await ready;
    const presses: PointerPoint[] = [];
    watcher.watch((point) => void presses.push(point));
    expect(host.written).toEqual(["WATCH 50"]);
    await host.print("WATCHING\nSAMPLE 1 0 0 0 0\nSAMPLE 0 1 1 100 200\nERR nope\nSAMPLE 0 0 0 100 200\nSAMPLE 0 0 1 3 4\n");
    expect(presses).toEqual([{ x: 100, y: 200 }, { x: 3, y: 4 }]);
    watcher.stop();
    expect(host.written).toEqual(["WATCH 50", "STOP"]);
    await host.print("SAMPLE 0 1 1 7 8\nSTOPPED\n"); // read before STOP, arriving after
    expect(presses).toHaveLength(2);
  });

  it("FAILS TO START, as an Error: the host exits before READY, the spawn throws, or READY never comes", async () => {
    const exits = fakeHost();
    const early = watcherWith(exits).watcher.prepare();
    exits.exit();
    await expect(early).rejects.toThrow(new Error("The pointer watcher exited."));

    const throwsDir = mkdtempSync(join(tmpdir(), "va-pointer-test-"));
    dirs.push(throwsDir);
    const throws = new WindowsPointerWatcher({
      spawnHost: () => {
        throw new Error("spawn powershell.exe ENOENT");
      },
      scriptDir: () => throwsDir,
    });
    await expect(throws.prepare()).rejects.toThrow("The pointer watcher could not start: spawn powershell.exe ENOENT");

    const silent = fakeHost();
    const slow = watcherWith(silent, { startupTimeoutMs: 20 });
    await expect(slow.watcher.prepare()).rejects.toThrow("The pointer watcher did not start in time.");
    expect(silent.killed()).toBe(true);
  });

  it("DIES AFTER READY: the failure listeners are told once, and nothing more is written to it", async () => {
    const host = fakeHost();
    const { watcher } = watcherWith(host);
    const reasons: string[] = [];
    watcher.onFailure((reason) => void reasons.push(reason));
    const ready = watcher.prepare();
    await host.print("READY\n");
    await ready;
    host.exit();
    host.error(new Error("EPIPE"));
    expect(reasons).toEqual(["The pointer watcher exited."]);
    watcher.watch(() => undefined);
    watcher.stop();
    expect(host.written).toEqual([]);
  });

  it("dispose quits and kills the host, and is not reported as a failure", async () => {
    const host = fakeHost();
    const { watcher } = watcherWith(host);
    const reasons: string[] = [];
    watcher.onFailure((reason) => void reasons.push(reason));
    const ready = watcher.prepare();
    await host.print("READY\n");
    await ready;
    watcher.dispose();
    host.exit();
    expect(host.written).toEqual(["QUIT"]);
    expect(host.killed()).toBe(true);
    expect(reasons).toEqual([]);
  });
});
