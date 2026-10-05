import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { normalizeAppName } from "../src/core/apps.ts";
import type { CapturedContext, ToolInput } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// `openApp` through the FULL planner (M18) — the same wiring tools.test.ts uses, with the real
// registry, the real risk gate, and a MockShell whose `openApp` action goes through a real
// launcher over the real built-in catalog. So "it refused Photoshop" is the actual matching
// code refusing, not a mock agreeing with the test.

function harness(input: ToolInput) {
  const shell = new MockShell({ context: NO_CONTEXT });
  const log = new InMemoryActionLog();
  const llm = new FakeLLM({ kind: "tool", name: "openApp", input });
  const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);
  return { shell, log, planner };
}

describe("openApp — opening what the user named", () => {
  it("opens a built-in app by its label", async () => {
    const { shell, log, planner } = harness({ app: "Spotify" });

    const outcome = await planner.run("open Spotify");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("openApp");
    expect(outcome.result).toBe("Opened Spotify");
    // The action carries the NAME across the portability contract...
    expect(shell.actions).toEqual([{ kind: "openApp", payload: "Spotify" }]);
    // ...and the shell is what turned it into something startable.
    expect(shell.launched).toEqual(["spotify:"]);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "openApp" });
  });

  it("opens an exe-backed app, through the other io path", async () => {
    const { shell, planner } = harness({ app: "Notepad" });

    expect((await planner.run("open notepad")).status).toBe("ok");
    expect(shell.launched).toEqual(["notepad.exe"]);
  });

  it("opens an app named by an alias", async () => {
    const { shell, planner } = harness({ app: "calc" });

    const outcome = await planner.run("open calc");

    expect(outcome.status).toBe("ok");
    expect(shell.launched).toEqual(["calc.exe"]);
    // The result echoes what the USER said, not the catalog's label — the app confirms the
    // request it was given rather than quietly renaming it.
    expect(outcome.result).toBe("Opened calc");
  });

  it("opens an app named the way a person speaks", async () => {
    const { shell, planner } = harness({ app: "the File Explorer app" });

    expect((await planner.run("open the file explorer app")).status).toBe("ok");
    expect(shell.launched).toEqual(["explorer.exe"]);
  });
});

describe("openApp — refusals", () => {
  it("refuses an unknown app and says what it CAN open", async () => {
    const { shell, log, planner } = harness({ app: "Photoshop" });

    const outcome = await planner.run("open Photoshop");

    expect(outcome.status).toBe("refused");
    // The whole closed list reaches the user, so the refusal is actionable rather than a dead
    // end (spec.md §8). Asserted as the literal sentence: this is what a person reads.
    expect(shell.results[0]).toBe(
      "I can't open Photoshop — I can only open: Spotify, Notepad, Calculator and File Explorer.",
    );
    expect(shell.results[0]).not.toMatch(/something went wrong/i);
    // Nothing was started.
    expect(shell.launched).toEqual([]);
    expect(log.entries[0]).toMatchObject({ status: "refused", tool: "openApp" });
  });

  it("refuses a near miss rather than opening the nearest thing", async () => {
    const { shell, planner } = harness({ app: "spotifyy" });

    expect((await planner.run("open spotifyy")).status).toBe("refused");
    expect(shell.launched).toEqual([]);
  });

  // The model is told never to send a command, and if it does anyway the catalog refuses it —
  // there is no path from a model-written string to process creation.
  it("refuses an executable name, even one that would have worked", async () => {
    const { shell, planner } = harness({ app: "notepad.exe" });

    expect((await planner.run("open notepad.exe")).status).toBe("refused");
    expect(shell.launched).toEqual([]);
  });

  it("asks which app rather than guessing when the name is empty", async () => {
    const { shell, log, planner } = harness({ app: "   " });

    const outcome = await planner.run("open");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe("Which app should I open?");
    // It refused BEFORE the shell was asked for anything at all.
    expect(shell.actions).toEqual([]);
    expect(shell.launched).toEqual([]);
    expect(log.entries[0]).toMatchObject({ status: "refused" });
  });

  // TWO DIFFERENT LAYERS REFUSE, and which one fires depends on the shape of the argument —
  // worth pinning because the two produce different statuses and different sentences.
  //
  // A blank string is a PRESENT argument, so the planner's generic `missingRequired` check
  // (§5 step 5) passes it through and the handler's own question is what the user gets. An
  // absent `app` never reaches the handler at all: it fails validation, which is tool-agnostic
  // and reports `error`. Neither is a malfunction, both refuse before the shell is touched —
  // and the handler's check is not redundant with validation, because validation cannot see
  // the difference between "" and a name.
  it("fails validation when the argument is absent, before the handler is reached", async () => {
    const { shell, log, planner } = harness({});

    const outcome = await planner.run("open");

    expect(outcome.status).toBe("error");
    expect(shell.results[0]).toContain("Missing required information: app");
    expect(shell.actions).toEqual([]);
    expect(shell.launched).toEqual([]);
    expect(log.entries[0]).toMatchObject({ tool: "openApp" });
  });
});

describe("openApp — the gate", () => {
  // `reversible` means run it: no dialog, no narration. Asserted the way tests/risk.test.ts
  // asserts the tier generally, but on this tool, because the claim being made is about THIS
  // tool's tier and not about the gate.
  it("runs with no confirm dialog and no narration", async () => {
    const { shell, planner } = harness({ app: "Spotify" });

    await planner.run("open Spotify");

    expect(shell.confirmMessages).toEqual([]);
    // Exactly one action, and it is the launch — no `notify` ahead of it.
    expect(shell.actions).toEqual([{ kind: "openApp", payload: "Spotify" }]);
    expect(shell.actions.filter((action) => action.kind === "notify")).toEqual([]);
  });
});

// THE SPLIT between `openApp` and `openTarget` (M18 step 3).
//
// What is NOT tested here, and cannot be: which of the two the model picks. Every test in this
// repo drives tool choice through `FakeLLM`, so a test asserting "'open Spotify' chooses
// openApp" would only be asserting the fixture. That half is genuinely live-only and is on
// docs/M18-live-checklist.md.
//
// What IS testable is that neither tool wanders into the other's territory when it is the one
// that got called — which is the actual new risk, because before M18 "open X" had exactly one
// destination and now it has two. The memory path these tests deliberately do NOT re-assert:
// memory resolving "my dashboard" into a URL and `openUrl` firing is already covered by
// memory-integration.test.ts and remember.test.ts, and a third copy would be a test that
// cannot fail under a wrong implementation.
describe("openApp and openTarget stay on their own side", () => {
  function run(name: string, input: ToolInput) {
    const shell = new MockShell({ context: NO_CONTEXT });
    const log = new InMemoryActionLog();
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name, input }),
      shell,
      registry,
      new NoopMemoryResolver(),
      log,
    );
    return { shell, planner };
  }

  it("sends the same word to two different shell actions", async () => {
    const asApp = run("openApp", { app: "Spotify" });
    await asApp.planner.run("open Spotify");
    expect(asApp.shell.actions).toEqual([{ kind: "openApp", payload: "Spotify" }]);

    const asSite = run("openTarget", { target: "Spotify", url: "https://open.spotify.com" });
    await asSite.planner.run("open the Spotify web player");
    expect(asSite.shell.actions).toEqual([
      { kind: "openUrl", payload: "https://open.spotify.com/" },
    ]);
    // The browser path starts no process, which is the half that would be a real bug.
    expect(asSite.shell.launched).toEqual([]);
  });

  // openApp's arrival must not have made openTarget more willing to guess. A bare app name
  // with no URL is still an honest "I don't know that yet", not an invented spotify.com.
  it("openTarget still refuses a bare app name rather than inventing a URL", async () => {
    const { shell, planner } = run("openTarget", { target: "Spotify" });

    const outcome = await planner.run("open Spotify");

    expect(outcome.status).toBe("refused");
    expect(shell.actions).toEqual([]);
    expect(shell.launched).toEqual([]);
  });

  // And the reverse: a URL handed to openApp is refused, not launched. The catalog is names
  // only, so there is no entry a URL could ever match — asserted because this is the direction
  // where a "helpful" normalization would turn a web request into a process launch.
  it("openApp refuses a URL rather than treating it as something to start", async () => {
    const { shell, planner } = run("openApp", { app: "https://open.spotify.com" });

    const outcome = await planner.run("open spotify.com");

    expect(outcome.status).toBe("refused");
    expect(shell.launched).toEqual([]);
    expect(shell.results[0]).toContain("I can only open:");
  });
});

describe("openApp - memory never rewrites the app name", () => {
  // `resolvesReferences: false`, and this is the test that has to DISTINGUISH it from the
  // default rather than merely pass alongside it.
  //
  // Without the flag this is a real bug: a stored fact gets substituted into `app` before the
  // handler runs, the catalog cannot match a URL, and the app refuses to open something it
  // opened perfectly well yesterday.
  //
  // THE FIRST VERSION OF THIS TEST PROVED NOTHING, and it is worth recording why. It used
  // `app: "spotify"` with a fact under `target:spotify` - and `resolveArgs` only considers a
  // value that LOOKS vague, /^(my|the)\s+/ (src/core/memory/SqliteMemory.ts), so plain
  // "spotify" was never a resolution candidate at all. The test passed, and would have passed
  // identically with `resolvesReferences: true`. Caught by writing the sibling test for
  // `searchSpotify`, whose precondition failed and exposed the whole shape of the mistake.
  it('opens Spotify even when a fact named "the Spotify app" is stored', async () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    // The key is what `normalizeReference` PRODUCES, not the phrase the user says: "the Spotify
    // app" normalizes to "spotify app" (memory/normalize.ts strips a leading my/the).
    memory.write("target:spotify app", "https://open.spotify.com");

    // THREE PRECONDITIONS, because the flag only matters when all three hold.
    // 1. The value is shaped so that resolveArgs would even try.
    expect(/^\s*(my|the)\s+\S/i.test("the Spotify app")).toBe(true);
    // 2. Resolution would find something to substitute.
    expect(memory.resolve("the Spotify app")?.value).toBe("https://open.spotify.com");
    // 3. The unresolved name still reaches the catalog, so an `ok` outcome is possible at all.
    expect(normalizeAppName("the Spotify app")).toBe("spotify");

    const shell = new MockShell({ context: NO_CONTEXT });
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name: "openApp", input: { app: "the Spotify app" } }),
      shell,
      registry,
      memory,
      memory,
    );

    const outcome = await planner.run("open the spotify app");

    // With resolution ON, `app` would be "https://open.spotify.com/", which matches nothing in
    // the catalog - so this would be a refusal with nothing launched.
    expect(outcome.status).toBe("ok");
    expect(shell.actions).toEqual([{ kind: "openApp", payload: "the Spotify app" }]);
    expect(shell.launched).toEqual(["spotify:"]);
    db.close();
  });
});
