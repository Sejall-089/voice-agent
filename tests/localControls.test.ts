import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell, type MockShellOptions } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, ToolInput } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// M18's three local-control tools through the FULL planner: real registry, real risk gate, and
// a MockShell whose `mediaKey` action runs through the same `pressesFor` / `virtualKeyFor` the
// Windows shell uses. So what `shell.pressed` records is what Windows would have been asked
// for, not what a mock agreed to.

function harness(name: string, input: ToolInput, options: Partial<MockShellOptions> = {}) {
  const shell = new MockShell({ context: NO_CONTEXT, ...options });
  const log = new InMemoryActionLog();
  const planner = new Planner(
    new FakeLLM({ kind: "tool", name, input }),
    shell,
    registry,
    new NoopMemoryResolver(),
    log,
  );
  return { shell, log, planner };
}

describe("systemVolume", () => {
  it("sends volume up the default amount, and reports it in percent", async () => {
    const { shell, log, planner } = harness("systemVolume", { direction: "up" });

    const outcome = await planner.run("turn the volume up");

    expect(outcome.status).toBe("ok");
    // The default: 5 presses, reported as the change that was sent and never as presses.
    expect(outcome.result).toBe("Volume up about 10%");
    expect(shell.actions).toEqual([{ kind: "mediaKey", payload: "volumeUp", count: 5 }]);
    // 0xAF five times — what the OS actually saw.
    expect(shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "systemVolume" });
  });

  // The one that would be most obviously wrong if the key table were transposed: asserted here
  // through the whole planner, not just against the table, so a correct table wired up
  // backwards somewhere in between still fails.
  //
  // RE-JUSTIFIED for the percent change: the argument used to be `presses: 3` and this expected
  // 3 presses. It now passes `percent: 6`, which is the same three presses expressed the way a
  // person says it — so the test still pins the key code AND now also pins that the conversion
  // runs on the `down` path, not only on `up`.
  it("sends volume DOWN for down, and never the up key", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "down", percent: 6 });

    const outcome = await planner.run("quieter");

    expect(outcome.result).toBe("Volume down about 6%");
    expect(shell.pressed).toEqual([{ vk: 0xae, count: 3 }]);
    expect(shell.pressed[0]?.vk).not.toBe(0xaf);
  });

  // RE-JUSTIFIED: this used to prove "a press count is ignored for mute". It now proves the
  // stronger and more useful thing — the amount is ignored for mute WHATEVER UNIT it arrives
  // in. 50 would be 25 presses if the conversion ran, and 50 presses if the old press-count
  // reading survived anywhere; it is one press, so neither happens.
  it("toggles mute with exactly one press, whatever amount was asked for", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "mute", percent: 50 });

    const outcome = await planner.run("mute");

    // THE BUG THIS PREVENTS: five toggles land back where they started, which looks exactly
    // like the app ignoring you. Both the tool and the shell force one press.
    expect(outcome.result).toBe("Sent mute");
    expect(shell.actions).toEqual([{ kind: "mediaKey", payload: "mute", count: 1 }]);
    expect(shell.pressed).toEqual([{ vk: 0xad, count: 1 }]);
  });

  // THE UNITS BUG, as a planner-level regression test. Live testing found that "turn the volume
  // up by 10" had the model pass 10 and moved the volume 20% — the model said percent, the code
  // read presses. These are the numbers a person would actually say, with the presses they must
  // now produce written as literals.
  it("reads the amount as a PERCENT and converts it to presses", async () => {
    const ten = harness("systemVolume", { direction: "up", percent: 10 });
    await ten.planner.run("turn the volume up by 10");
    // 10% at 2% per press. Under the old press-count reading this was 10 presses = 20%.
    expect(ten.shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
    expect(ten.shell.results[0]).toBe("Volume up about 10%");

    const twenty = harness("systemVolume", { direction: "up", percent: 20 });
    await twenty.planner.run("turn the volume up by 20");
    expect(twenty.shell.pressed).toEqual([{ vk: 0xaf, count: 10 }]);

    // Rounds half up: 5% is 2.5 presses, and under-delivering on a small request reads as the
    // app ignoring it.
    const five = harness("systemVolume", { direction: "up", percent: 5 });
    await five.planner.run("turn it up by 5");
    expect(five.shell.pressed).toEqual([{ vk: 0xaf, count: 3 }]);
  });

  // THE RESULT TEXT, as the literal sentences a person reads and hears. The percent is what was
  // SENT (presses x 2), so a request for 5 reports 6 - and each case pins the presses beside
  // the sentence, so the text cannot drift away from what the OS was actually handed.
  it("reports the change in percent, as what was actually sent", async () => {
    const cases: [Record<string, unknown>, number, number, string][] = [
      [{ direction: "up" }, 0xaf, 5, "Volume up about 10%"],
      [{ direction: "up", percent: 10 }, 0xaf, 5, "Volume up about 10%"],
      [{ direction: "down" }, 0xae, 5, "Volume down about 10%"],
      // Asked for 5, which rounds up to 3 presses: the sentence says 6, not 5.
      [{ direction: "down", percent: 5 }, 0xae, 3, "Volume down about 6%"],
      [{ direction: "up", percent: 5 }, 0xaf, 3, "Volume up about 6%"],
      // Exactly the cap is not "capped" - nothing was withheld, so nothing is explained.
      [{ direction: "up", percent: 30 }, 0xaf, 15, "Volume up about 30%"],
      [
        { direction: "up", percent: 80 },
        0xaf,
        15,
        "Volume up about 30% (my limit per request, you asked for 80%)",
      ],
      [
        { direction: "down", percent: 80 },
        0xae,
        15,
        "Volume down about 30% (my limit per request, you asked for 80%)",
      ],
    ];

    for (const [args, vk, count, sentence] of cases) {
      const { shell, planner } = harness("systemVolume", args);
      const outcome = await planner.run("volume");
      expect(shell.pressed, sentence).toEqual([{ vk, count }]);
      expect(outcome.result, JSON.stringify(args)).toBe(sentence);
    }
  });

  it("clamps a percent through the planner, at both ends", async () => {
    const high = harness("systemVolume", { direction: "up", percent: 99 });
    await high.planner.run("turn it way up");
    // 99% would be 50 presses; the ceiling is 15 (30%).
    expect(high.shell.pressed).toEqual([{ vk: 0xaf, count: 15 }]);
    expect(high.shell.results[0]).toBe(
      "Volume up about 30% (my limit per request, you asked for 99%)",
    );

    const low = harness("systemVolume", { direction: "up", percent: 1 });
    await low.planner.run("turn it up a tiny bit");
    expect(low.shell.pressed).toEqual([{ vk: 0xaf, count: 1 }]);
    // One press is 2%, and that is what it says - not the 1% that was asked for.
    expect(low.shell.results[0]).toBe("Volume up about 2%");
  });

  it("defaults to 5 presses when no amount was given at all", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "up" });
    await planner.run("turn it up");
    expect(shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
  });

  it("defaults when the model gave a non-number", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "up", percent: "lots" });
    await planner.run("turn it up");
    expect(shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
  });

  // The old argument name must not keep working, or the bug could come back silently through a
  // model that still says `presses` — it has to be ignored, which falls back to the default.
  it("ignores a stale `presses` argument rather than honouring it", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "up", presses: 10 });
    await planner.run("turn the volume up by 10");
    // NOT 10 presses. The old reading is gone, so this is the no-amount default.
    expect(shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
  });

  it("asks which way rather than guessing a direction", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "louder" });

    const outcome = await planner.run("volume");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe("Up, down, or mute?");
    // Nothing was pressed — it refused before reaching the shell.
    expect(shell.actions).toEqual([]);
    expect(shell.pressed).toEqual([]);
  });

  it("surfaces a blocked key press as the OS's own words", async () => {
    const { shell, log, planner } = harness(
      "systemVolume",
      { direction: "up" },
      {
        // The shape WindowsInputInjector.pressKey throws on a short write — a real `KEY ERR`
        // reply turned into a message. Asserted on the MESSAGE, not the error class: the real
        // implementation throws a bare `Error`, so a type assertion would distinguish nothing.
        failMediaKeyWith:
          "The key press was blocked partway through (2/10 events delivered, Win32 error 5) - " +
          "most likely the focused window has higher privileges than this app.",
      },
    );

    const outcome = await planner.run("turn it up");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toContain("blocked partway through");
    expect(shell.results[0]).not.toMatch(/something went wrong/i);
    expect(log.entries[0]).toMatchObject({ status: "refused", tool: "systemVolume" });
  });

  it("runs with no confirm dialog and no narration", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "up" });
    await planner.run("turn it up");
    expect(shell.confirmMessages).toEqual([]);
    expect(shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  });
});

describe("mediaControl", () => {
  const CASES: readonly [string, number, string][] = [
    ["playPause", 0xb3, "Sent play or pause"],
    ["next", 0xb0, "Sent next track"],
    ["previous", 0xb1, "Sent previous track"],
  ];

  for (const [action, vk, expected] of CASES) {
    it(`sends ${action} as one press of 0x${vk.toString(16).toUpperCase()}`, async () => {
      const { shell, planner } = harness("mediaControl", { action });

      const outcome = await planner.run(action);

      expect(outcome.status).toBe("ok");
      expect(outcome.result).toBe(expected);
      expect(shell.actions).toEqual([{ kind: "mediaKey", payload: action, count: 1 }]);
      expect(shell.pressed).toEqual([{ vk, count: 1 }]);
      expect(shell.confirmMessages).toEqual([]);
    });
  }

  // `mediaControl` must not be a second route to the volume keys: that is `systemVolume`'s job,
  // with a documented press count this tool's schema has nowhere to put.
  it("refuses a volume key, which belongs to the other tool", async () => {
    for (const action of ["volumeUp", "volumeDown", "mute"]) {
      const { shell, planner } = harness("mediaControl", { action });
      const outcome = await planner.run("louder");
      expect(outcome.status, action).toBe("refused");
      expect(shell.pressed, action).toEqual([]);
    }
  });

  it("asks which one rather than guessing", async () => {
    const { shell, planner } = harness("mediaControl", { action: "stop" });

    const outcome = await planner.run("stop the music");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe("Play/pause, next, or previous?");
    expect(shell.pressed).toEqual([]);
  });

  // The honesty invariant. Nothing here can read the media session, so no result may imply it
  // knows what happened to it.
  it("never claims anything about what is playing", async () => {
    for (const [action] of CASES) {
      const { shell, planner } = harness("mediaControl", { action });
      await planner.run(action);
      const result = shell.results[0] ?? "";
      expect(result, result).not.toMatch(/playing|paused|resumed|spotify/i);
    }
  });
});

describe("searchSpotify", () => {
  it("opens a Spotify search and says only that", async () => {
    const { shell, log, planner } = harness("searchSpotify", { query: "bohemian rhapsody" });

    const outcome = await planner.run("play bohemian rhapsody on spotify");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toEqual([
      { kind: "openUrl", payload: "https://open.spotify.com/search/bohemian%20rhapsody" },
    ]);
    expect(outcome.result).toBe(
      'Opened a Spotify search for "bohemian rhapsody" — press play on the one you want.',
    );
    // It must not imply playback, because it cannot start any.
    expect(outcome.result).not.toMatch(/\bplaying\b|now playing/i);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "searchSpotify" });
    // No process was started — this is the browser path, not openApp's.
    expect(shell.launched).toEqual([]);
  });

  // THE SECURITY-SHAPED ASSERTION: the host and path prefix are fixed in the tool, and no query
  // can move them. Each of these characters would change the meaning of a URL if it were
  // interpolated raw — `/` a new path segment, `?` a query string, `#` a fragment, `&` another
  // parameter, `:` and `//` a whole new scheme and host.
  const ENCODING: readonly [string, string][] = [
    ["kind of blue", "kind%20of%20blue"],
    ["salt & pepper", "salt%20%26%20pepper"],
    ["track #1", "track%20%231"],
    ["ac/dc", "ac%2Fdc"],
    ["who?", "who%3F"],
    ["50% off", "50%25%20off"],
    ["a=b", "a%3Db"],
    ["x+y", "x%2By"],
    ["../../etc", "..%2F..%2Fetc"],
    ["https://evil.example.com", "https%3A%2F%2Fevil.example.com"],
    ["Björk", "Bj%C3%B6rk"],
    ["坂本龍一", "%E5%9D%82%E6%9C%AC%E9%BE%8D%E4%B8%80"],
    ["Café del Mar", "Caf%C3%A9%20del%20Mar"],
  ];

  for (const [query, encoded] of ENCODING) {
    it(`encodes ${JSON.stringify(query)} into the path and nowhere else`, async () => {
      const { shell, planner } = harness("searchSpotify", { query });

      await planner.run(`search for ${query}`);

      const action = shell.actions[0];
      expect(action?.kind).toBe("openUrl");
      const url = action?.kind === "openUrl" ? action.payload : "";
      expect(url).toBe(`https://open.spotify.com/search/${encoded}`);
      // Literal host and prefix, asserted separately so a failure says which half moved.
      expect(url.startsWith("https://open.spotify.com/search/")).toBe(true);
      expect(new URL(url).host).toBe("open.spotify.com");
      expect(new URL(url).protocol).toBe("https:");
    });
  }

  it("caps a very long query instead of building an unbounded URL", async () => {
    const query = "a".repeat(500);
    const { shell, planner } = harness("searchSpotify", { query });

    await planner.run("search for a very long thing");

    const action = shell.actions[0];
    const url = action?.kind === "openUrl" ? action.payload : "";
    expect(url).toBe(`https://open.spotify.com/search/${"a".repeat(200)}`);
  });

  it("asks what to search for rather than opening an empty search", async () => {
    const { shell, planner } = harness("searchSpotify", { query: "   " });

    const outcome = await planner.run("search spotify");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe("What should I search Spotify for?");
    expect(shell.actions).toEqual([]);
  });

  it("runs with no confirm dialog and no narration", async () => {
    const { shell, planner } = harness("searchSpotify", { query: "radiohead" });
    await planner.run("search spotify for radiohead");
    expect(shell.confirmMessages).toEqual([]);
    expect(shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  });
});

describe("none of the three lets memory rewrite its argument", () => {
  // `resolvesReferences: false` on all three, for the reason `pointAt` and `openApp` set it:
  // these arguments are literals, and resolution can only turn a working one into a broken one.
  // Taught for real through a real SqliteMemory, the way openApp.test.ts does.
  it("searches for the words the user said, not a URL stored under them", async () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    // THE KEY IS WHAT `normalizeReference` PRODUCES, not what the user says: "my favourite
    // album" normalizes to "favourite album" (memory/normalize.ts strips a leading my/the).
    // Writing it under the literal phrase is a real mistake that silently neuters this test —
    // the first draft did exactly that, the precondition below failed, and without that
    // precondition it would have passed whether the flag was set or not.
    memory.write("target:favourite album", "https://example.com/album");
    // TWO PRECONDITIONS, because the flag only matters if resolution would otherwise fire.
    // `resolveArgs` resolves a value only when it LOOKS vague (/^(my|the)\s+/ in
    // SqliteMemory.ts), so a query with no such prefix would never have been touched and the
    // test would prove nothing about `resolvesReferences`.
    expect(memory.resolve("my favourite album")?.value).toBe("https://example.com/album");
    expect(/^\s*(my|the)\s+\S/i.test("my favourite album")).toBe(true);

    const shell = new MockShell({ context: NO_CONTEXT });
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name: "searchSpotify", input: { query: "my favourite album" } }),
      shell,
      registry,
      memory,
      memory,
    );

    const outcome = await planner.run("play my favourite album on spotify");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toEqual([
      { kind: "openUrl", payload: "https://open.spotify.com/search/my%20favourite%20album" },
    ]);
    db.close();
  });
});
