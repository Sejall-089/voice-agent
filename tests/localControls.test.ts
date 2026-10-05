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
  it("sends volume up the default number of times", async () => {
    const { shell, log, planner } = harness("systemVolume", { direction: "up" });

    const outcome = await planner.run("turn the volume up");

    expect(outcome.status).toBe("ok");
    expect(outcome.result).toBe("Sent volume up 5 times");
    expect(shell.actions).toEqual([{ kind: "mediaKey", payload: "volumeUp", count: 5 }]);
    // 0xAF five times — what the OS actually saw.
    expect(shell.pressed).toEqual([{ vk: 0xaf, count: 5 }]);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "systemVolume" });
  });

  // The one that would be most obviously wrong if the key table were transposed: asserted here
  // through the whole planner, not just against the table, so a correct table wired up
  // backwards somewhere in between still fails.
  it("sends volume DOWN for down, and never the up key", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "down", presses: 3 });

    const outcome = await planner.run("quieter");

    expect(outcome.result).toBe("Sent volume down 3 times");
    expect(shell.pressed).toEqual([{ vk: 0xae, count: 3 }]);
    expect(shell.pressed[0]?.vk).not.toBe(0xaf);
  });

  it("toggles mute with exactly one press, whatever count was asked for", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "mute", presses: 5 });

    const outcome = await planner.run("mute");

    // THE BUG THIS PREVENTS: five toggles land back where they started, which looks exactly
    // like the app ignoring you. Both the tool and the shell force one press.
    expect(outcome.result).toBe("Sent mute");
    expect(shell.actions).toEqual([{ kind: "mediaKey", payload: "mute", count: 1 }]);
    expect(shell.pressed).toEqual([{ vk: 0xad, count: 1 }]);
  });

  it("clamps a press count through the planner, at both ends", async () => {
    const high = harness("systemVolume", { direction: "up", presses: 99 });
    await high.planner.run("turn it way up");
    expect(high.shell.pressed).toEqual([{ vk: 0xaf, count: 15 }]);
    expect(high.shell.results[0]).toBe("Sent volume up 15 times");

    const low = harness("systemVolume", { direction: "up", presses: 0 });
    await low.planner.run("turn it up a bit");
    expect(low.shell.pressed).toEqual([{ vk: 0xaf, count: 1 }]);
    // One press reads as a plain sentence rather than "1 times".
    expect(low.shell.results[0]).toBe("Sent volume up");
  });

  it("defaults the count when the model gave a non-number", async () => {
    const { shell, planner } = harness("systemVolume", { direction: "up", presses: "lots" });
    await planner.run("turn it up");
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
