import { describe, it, expect } from "vitest";
import { BUILT_IN_APPS } from "../src/core/apps.ts";
import {
  BUILT_IN_CATALOG,
  createAppLauncher,
  parseExtraApps,
  spawnDetached,
  type CatalogEntry,
  type LaunchIo,
} from "../src/main/shell/appLaunch.ts";

// The Windows half of app-launching (M18, src/main/shell/appLaunch.ts). Nothing here starts a
// process: `io` is injected, which is the point of the file existing separately from
// WindowsShell at all (CLAUDE.md — the testable logic comes apart from the transport, and the
// half that decides what a person gets TOLD is the half that has shipped broken before).

// Records what was asked of the OS, and can be told to fail like the OS would.
function recordingIo(failWith?: string): LaunchIo & { spawned: string[]; opened: string[] } {
  const spawned: string[] = [];
  const opened: string[] = [];
  return {
    spawned,
    opened,
    spawn(command: string): Promise<void> {
      spawned.push(command);
      return failWith === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(failWith));
    },
    openExternal(uri: string): Promise<void> {
      opened.push(uri);
      return failWith === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(failWith));
    },
  };
}

describe("the built-in catalog", () => {
  // The module-level join throws on a missing spec, so importing this file at all is most of
  // the check. This states the result in literals anyway, so that a changed command (a wrong
  // exe name, a protocol typo) fails here rather than at the one place it cannot be caught:
  // live, in front of a person, with the OS saying nothing useful.
  it("gives every built-in app exactly one launch spec", () => {
    expect(BUILT_IN_CATALOG).toHaveLength(BUILT_IN_APPS.length);
    const byId = new Map(BUILT_IN_CATALOG.map((entry) => [entry.id, entry.launch]));
    expect(byId.get("spotify")).toEqual({ kind: "protocol", uri: "spotify:" });
    expect(byId.get("notepad")).toEqual({ kind: "exe", command: "notepad.exe" });
    expect(byId.get("calculator")).toEqual({ kind: "exe", command: "calc.exe" });
    expect(byId.get("explorer")).toEqual({ kind: "exe", command: "explorer.exe" });
  });

  it("carries the names through from core, so one catalog serves both halves", () => {
    for (const entry of BUILT_IN_APPS) {
      const joined = BUILT_IN_CATALOG.find((candidate) => candidate.id === entry.id);
      expect(joined?.label).toBe(entry.label);
      expect(joined?.aliases).toEqual(entry.aliases);
    }
  });

  // No built-in command carries an argument. Stated as an invariant rather than left to the
  // four literals above, because the thing being protected is "we never build a command line",
  // and that has to stay true of entries added later too.
  it("has no built-in launch spec with arguments in it", () => {
    for (const entry of BUILT_IN_CATALOG) {
      const value = entry.launch.kind === "exe" ? entry.launch.command : entry.launch.uri;
      expect(value, `${entry.id} has whitespace in its launch value`).not.toMatch(/\s/);
    }
  });
});

describe("parseExtraApps — what it accepts", () => {
  it("reads nothing out of an unset or blank value", () => {
    expect(parseExtraApps(undefined)).toEqual({ entries: [], problems: [] });
    expect(parseExtraApps("")).toEqual({ entries: [], problems: [] });
    expect(parseExtraApps("   ")).toEqual({ entries: [], problems: [] });
  });

  it("accepts a bare executable name", () => {
    const { entries, problems } = parseExtraApps("VLC=vlc.exe");
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { id: "vlc", label: "VLC", aliases: [], launch: { kind: "exe", command: "vlc.exe" } },
    ]);
  });

  it("accepts an absolute path, spaces and all", () => {
    const { entries, problems } = parseExtraApps(
      "VLC=C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    );
    expect(problems).toEqual([]);
    expect(entries[0]?.launch).toEqual({
      kind: "exe",
      command: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    });
  });

  it("accepts a quoted absolute path, because quoting it is everyone's reflex", () => {
    const { entries, problems } = parseExtraApps('VLC="C:\\Program Files\\VLC\\vlc.exe"');
    expect(problems).toEqual([]);
    expect(entries[0]?.launch).toEqual({
      kind: "exe",
      command: "C:\\Program Files\\VLC\\vlc.exe",
    });
  });

  it("accepts a bare protocol scheme", () => {
    const { entries, problems } = parseExtraApps("Slack=slack:");
    expect(problems).toEqual([]);
    expect(entries[0]?.launch).toEqual({ kind: "protocol", uri: "slack:" });
  });

  it("reads several entries and keeps the good ones when one is bad", () => {
    const { entries, problems } = parseExtraApps("Slack=slack:|Bad=oops|VLC=vlc.exe");
    expect(entries.map((entry) => entry.label)).toEqual(["Slack", "VLC"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"Bad"');
  });

  it("gives an extra app a name the launcher can actually match", () => {
    const { entries } = parseExtraApps("VS Code=code.exe");
    expect(entries[0]?.id).toBe("vs code");
    expect(entries[0]?.label).toBe("VS Code");
  });
});

// Each rejection asserts BOTH halves: the specific sentence a person is shown, and that the
// entry is absent from `entries`. The second is the one that matters — a problem reported and
// then launched anyway would be worse than silence.
describe("parseExtraApps — what it rejects, and what it says", () => {
  function reject(raw: string): { entries: CatalogEntry[]; problem: string } {
    const { entries, problems } = parseExtraApps(raw);
    expect(problems).toHaveLength(1);
    return { entries, problem: problems[0] };
  }

  it("rejects an entry with no =", () => {
    const { entries, problem } = reject("slack.exe");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA entry "slack.exe" — it needs the form Name=command.',
    );
    expect(entries).toEqual([]);
  });

  it("rejects an entry with no name", () => {
    const { entries, problem } = reject("=vlc.exe");
    expect(problem).toBe('I ignored an APPS_EXTRA entry with no name before the "=".');
    expect(entries).toEqual([]);
  });

  it("rejects an entry with no command", () => {
    const { entries, problem } = reject("VLC=");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "VLC" — there is no command after the "=".',
    );
    expect(entries).toEqual([]);
  });

  it("rejects a name with nothing matchable in it", () => {
    const { entries, problem } = reject("...=vlc.exe");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "..." — that name has no letters or digits in it.',
    );
    expect(entries).toEqual([]);
  });

  it("rejects a command with arguments", () => {
    const { entries, problem } = reject("Notepad2=notepad.exe /A");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "Notepad2" — "notepad.exe /A" has arguments, and I only ' +
        "launch a bare command.",
    );
    expect(entries).toEqual([]);
  });

  it("rejects arguments after a quoted path, where the quotes hide the space", () => {
    const { entries, problem } = reject('Thing="C:\\Program Files\\x\\y.exe" --kiosk');
    expect(problem).toContain("has arguments, and I only launch a bare command");
    expect(entries).toEqual([]);
  });

  it("rejects a relative path", () => {
    const { entries, problem } = reject("Thing=..\\tools\\thing.exe");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "Thing" — "..\\tools\\thing.exe" must be an absolute path ' +
        "with a drive letter (C:\\...\\thing.exe) or a bare name like thing.exe.",
    );
    expect(entries).toEqual([]);
  });

  it("rejects a UNC path — starting a program over the network is not what this is for", () => {
    const { entries, problem } = reject("Thing=\\\\server\\share\\thing.exe");
    expect(problem).toContain("must be an absolute path with a drive letter");
    expect(entries).toEqual([]);
  });

  // Every denied scheme, one case each. These pass the bare-scheme shape test perfectly well,
  // so the denylist is the only thing stopping them, and a quietly-dropped entry from it would
  // not show up anywhere else.
  for (const scheme of ["http", "https", "file", "javascript", "data", "vbscript"]) {
    it(`rejects ${scheme}: as a launch command`, () => {
      const { entries, problem } = reject(`Bad=${scheme}:`);
      expect(problem).toBe(
        `I ignored the APPS_EXTRA app "Bad" — "${scheme}:" is a web or scripting scheme, and ` +
          "I only open apps. Use openTarget for a website.",
      );
      expect(entries).toEqual([]);
    });
  }

  it("rejects a denied scheme whatever case it is written in", () => {
    const { entries, problem } = reject("Bad=JavaScript:");
    expect(problem).toContain("is a web or scripting scheme");
    expect(entries).toEqual([]);
  });

  // A scheme with anything after the colon is not a bare scheme, so it never reaches the
  // denylist at all — it fails the shape test first. Asserted because it is the case where a
  // payload would ride along if the shape test were loosened.
  it("rejects a protocol URI that carries a payload", () => {
    const { entries, problem } = reject("Slack=slack://channel/general");
    expect(problem).toContain("must be an absolute path ending in .exe");
    expect(entries).toEqual([]);
  });

  it("rejects something that is neither an exe nor a scheme", () => {
    const { entries, problem } = reject("Thing=oops");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "Thing" — "oops" must be an absolute path ending in .exe, ' +
        "a bare name.exe, or a protocol like slack:.",
    );
    expect(entries).toEqual([]);
  });

  it("rejects a name that collides with a built-in label", () => {
    const { entries, problem } = reject("Spotify=C:\\fake\\spotify.exe");
    expect(problem).toBe(
      'I ignored the APPS_EXTRA app "Spotify" — that name is already taken.',
    );
    expect(entries).toEqual([]);
  });

  // The collision check runs through the same `matchApp` the launcher does, so it catches a
  // clash with an ALIAS and a clash that only exists after normalization — not just an exact
  // label match. Both are ways an extra entry could otherwise shadow a built-in and silently
  // change what "open calc" starts.
  it("rejects a name that collides with a built-in alias or normalizes onto one", () => {
    expect(reject("calc=C:\\fake\\calc.exe").problem).toContain("that name is already taken");
    expect(reject("the Spotify app=C:\\fake\\s.exe").problem).toContain(
      "that name is already taken",
    );
    expect(reject("NOTEPAD=C:\\fake\\n.exe").problem).toContain("that name is already taken");
  });

  it("rejects a second entry that collides with an earlier extra entry", () => {
    const { entries, problems } = parseExtraApps("VLC=vlc.exe|vlc=C:\\other\\vlc.exe");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.launch).toEqual({ kind: "exe", command: "vlc.exe" });
    expect(problems).toEqual(['I ignored the APPS_EXTRA app "vlc" — that name is already taken.']);
  });
});

describe("createAppLauncher", () => {
  it("starts an exe through spawn, with the command and nothing else", async () => {
    const io = recordingIo();
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("Notepad");

    expect(result).toEqual({ ok: true });
    expect(io.spawned).toEqual(["notepad.exe"]);
    expect(io.opened).toEqual([]); // not the protocol path
  });

  it("starts a protocol app through openExternal, not spawn", async () => {
    const io = recordingIo();
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("Spotify");

    expect(result).toEqual({ ok: true });
    expect(io.opened).toEqual(["spotify:"]);
    expect(io.spawned).toEqual([]);
  });

  it("resolves an alias and a spoken form to the right command", async () => {
    const io = recordingIo();
    const launcher = createAppLauncher(BUILT_IN_CATALOG, io);

    await launcher.launch("calc");
    await launcher.launch("the Spotify app");
    await launcher.launch("files");

    expect(io.spawned).toEqual(["calc.exe", "explorer.exe"]);
    expect(io.opened).toEqual(["spotify:"]);
  });

  // The assertion that matters most in this file: an unmatched name never reaches process
  // creation. Not "it returns an error" — that nothing ran.
  it("refuses an unknown name without touching io at all", async () => {
    const io = recordingIo();
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("Photoshop");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "I can't open Photoshop — I can only open: Spotify, Notepad, Calculator and File Explorer.",
    );
    expect(io.spawned).toEqual([]);
    expect(io.opened).toEqual([]);
  });

  it("names the catalog it was actually given, not the built-in one", async () => {
    const io = recordingIo();
    const catalog: readonly CatalogEntry[] = [
      { id: "thing", label: "Thing", aliases: [], launch: { kind: "exe", command: "thing.exe" } },
    ];

    const result = await createAppLauncher(catalog, io).launch("Spotify");

    expect(result.error).toBe("I can't open Spotify — I can only open: Thing.");
    expect(io.spawned).toEqual([]);
  });

  it("surfaces an io failure as the OS's own words, under the app's label", async () => {
    const io = recordingIo("spawn notepad.exe ENOENT");
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("notepad");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("I couldn't start Notepad: spawn notepad.exe ENOENT");
    // It really did try — this is a failure to START, not a refusal to try.
    expect(io.spawned).toEqual(["notepad.exe"]);
  });

  // RE-JUSTIFIED after the live pass. This test used to feed the launcher "No application is
  // registered for spotify:" — a sentence written from an assumption, which the real thing
  // never says. The text below is what `openExternal("spotify:")` actually rejected with on a
  // machine without Spotify, transcribed as a literal (CLAUDE.md: a fake's failure shape drifts
  // from the real one silently).
  const NOT_INSTALLED =
    "Failed to open: No application is associated with the specified file for this operation. (0x483)";

  it("says an app with no registered protocol handler isn't installed, without the raw reason", async () => {
    const io = recordingIo(NOT_INSTALLED);
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("Spotify");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Spotify doesn't seem to be installed.");
    expect(result.error).not.toMatch(/0x483|Failed to open|associated/);
    // It really did try the protocol — this is a failed launch, not a refusal.
    expect(io.opened).toEqual(["spotify:"]);
  });

  it("names the app that was asked for, not Spotify, for an APPS_EXTRA protocol", async () => {
    const io = recordingIo(NOT_INSTALLED);
    const { entries } = parseExtraApps("Slack=slack:");
    const result = await createAppLauncher([...BUILT_IN_CATALOG, ...entries], io).launch("slack");

    expect(result.error).toBe("Slack doesn't seem to be installed.");
  });

  it("recognises the error by its code alone, since Windows localizes the sentence", async () => {
    const io = recordingIo("Failed to open: (0x483)");
    const result = await createAppLauncher(BUILT_IN_CATALOG, io).launch("Spotify");

    expect(result.error).toBe("Spotify doesn't seem to be installed.");
  });

  // The other half: ONLY that case is rewritten. A different protocol failure, and a different
  // Win32 code in the same "Failed to open: ... (0x..)" shape, keep their own reason.
  it("still shows any other protocol failure in its own words", async () => {
    const denied = recordingIo("Failed to open: Access is denied. (0x5)");
    expect((await createAppLauncher(BUILT_IN_CATALOG, denied).launch("Spotify")).error).toBe(
      "I couldn't start Spotify: Failed to open: Access is denied. (0x5)",
    );

    const other = recordingIo("The operation was canceled by the user.");
    expect((await createAppLauncher(BUILT_IN_CATALOG, other).launch("Spotify")).error).toBe(
      "I couldn't start Spotify: The operation was canceled by the user.",
    );
  });

  it("launches an APPS_EXTRA app through the same path as a built-in", async () => {
    const io = recordingIo();
    const { entries } = parseExtraApps("VLC=C:\\Program Files\\VLC\\vlc.exe");
    const launcher = createAppLauncher([...BUILT_IN_CATALOG, ...entries], io);

    expect(await launcher.launch("vlc")).toEqual({ ok: true });
    expect(io.spawned).toEqual(["C:\\Program Files\\VLC\\vlc.exe"]);
  });

  it("still refuses an entry that parseExtraApps rejected", async () => {
    const io = recordingIo();
    const { entries } = parseExtraApps("Bad=notepad.exe /A");
    const launcher = createAppLauncher([...BUILT_IN_CATALOG, ...entries], io);

    const result = await launcher.launch("Bad");

    expect(result.ok).toBe(false);
    expect(io.spawned).toEqual([]);
    expect(io.opened).toEqual([]);
  });
});

// `spawnDetached` IS the transport, so only the one property that can be proved without
// leaving a process behind is proved here: a command the OS cannot start REJECTS. That is the
// M11 rule in its original form — an operation reporting success is not proof it did anything —
// and a `spawn` wrapper that resolved on call rather than on the `spawn` event would pass
// everything else in this file while reporting success for a program that does not exist.
//
// The success path deliberately has no test: starting a real program and detaching it is
// exactly what must not happen in a suite, so it lives on the live checklist instead.
describe("spawnDetached", () => {
  it("rejects when the OS cannot start the command", async () => {
    await expect(
      spawnDetached("voice-agent-definitely-not-a-real-program-xq9.exe"),
    ).rejects.toThrow();
  });
});
