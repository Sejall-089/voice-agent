import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
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

describe("openApp — memory never rewrites the app name", () => {
  // `resolvesReferences: false`, and this is the test that distinguishes it from the default.
  //
  // Without the flag this is a REAL bug rather than a theoretical one: `remember spotify is
  // <url>` stores `target:spotify`, memory resolution rewrites `app: "spotify"` into that URL
  // before the handler runs, the catalog cannot match a URL, and the app refuses to open
  // something it opened perfectly well yesterday. So the fact is taught here for real, through
  // a real SqliteMemory, and the launch is asserted to be unaffected.
  it("opens Spotify even when a fact named 'spotify' is stored", async () => {
    const db = createDatabase(":memory:");
    const memory = new SqliteMemory(db);
    memory.write("target:spotify", "https://open.spotify.com");
    // The precondition — memory really would resolve this name if it were allowed to.
    expect(memory.resolve("spotify")?.value).toBe("https://open.spotify.com");

    const shell = new MockShell({ context: NO_CONTEXT });
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name: "openApp", input: { app: "spotify" } }),
      shell,
      registry,
      memory,
      memory,
    );

    const outcome = await planner.run("open spotify");

    expect(outcome.status).toBe("ok");
    expect(shell.actions).toEqual([{ kind: "openApp", payload: "spotify" }]);
    expect(shell.launched).toEqual(["spotify:"]);
    db.close();
  });
});
