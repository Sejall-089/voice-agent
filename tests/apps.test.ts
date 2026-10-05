import { describe, it, expect } from "vitest";
import {
  BUILT_IN_APPS,
  describeCatalog,
  matchApp,
  normalizeAppName,
  type AppEntry,
} from "../src/core/apps.ts";

// The name catalog (M18, core/apps.ts) — the half of app-launching that has no OS in it.
// Everything here is a pure string decision, so every input below is a LITERAL: nothing asks
// the code to produce its own input (CLAUDE.md, the node-vs-electron ICU lesson), and nothing
// derives an expectation from the thing being tested.

describe("normalizeAppName", () => {
  // Written as in → out pairs so the table itself is the specification, and so a change to the
  // rules has to visibly change a literal rather than quietly agreeing with new behaviour.
  const CASES: readonly [string, string][] = [
    // The three the brief names.
    ["the Spotify app", "spotify"],
    ["  NOTEPAD. ", "notepad"],
    ["calc", "calc"],
    // Case and whitespace.
    ["SPOTIFY", "spotify"],
    ["File    Explorer", "file explorer"],
    ["\tnotepad\n", "notepad"],
    // The trailing nouns, each one.
    ["spotify app", "spotify"],
    ["spotify application", "spotify"],
    ["spotify program", "spotify"],
    // "the" only as a leading WORD — a name that merely starts with those letters survives.
    ["the calculator", "calculator"],
    ["theme", "theme"],
    // Punctuation at the ends only. Inner characters are left alone, which is what lets a real
    // name like Notepad++ ever be matchable.
    ["notepad!", "notepad"],
    ["...calc...", "calc"],
    ["notepad++", "notepad"],
    ["vs code", "vs code"],
    // Degenerate input is empty, not a partial match.
    ["", ""],
    ["   ", ""],
    ["...", ""],
    // One pass, not a loop: a second trailing noun is NOT stripped. Asserted so the single-pass
    // decision is a recorded fact rather than an accident nobody can see.
    ["spotify app program", "spotify app"],
  ];

  for (const [input, expected] of CASES) {
    it(`normalizes ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(normalizeAppName(input)).toBe(expected);
    });
  }
});

describe("matchApp", () => {
  it("matches on the id, the label and an alias", () => {
    expect(matchApp("spotify", BUILT_IN_APPS)?.id).toBe("spotify");
    expect(matchApp("File Explorer", BUILT_IN_APPS)?.id).toBe("explorer");
    expect(matchApp("calc", BUILT_IN_APPS)?.id).toBe("calculator");
    expect(matchApp("music", BUILT_IN_APPS)?.id).toBe("spotify");
    expect(matchApp("files", BUILT_IN_APPS)?.id).toBe("explorer");
  });

  it("matches through normalization, so what a person actually says lands", () => {
    expect(matchApp("the Spotify app", BUILT_IN_APPS)?.id).toBe("spotify");
    expect(matchApp("  NOTEPAD. ", BUILT_IN_APPS)?.id).toBe("notepad");
    expect(matchApp("FILE EXPLORER", BUILT_IN_APPS)?.id).toBe("explorer");
    expect(matchApp("the calculator application", BUILT_IN_APPS)?.id).toBe("calculator");
  });

  // The whole safety argument of this file: a near miss is a refusal, never an approximation.
  // Each of these would match under some plausible "helpful" rule — a typo distance, a prefix,
  // a substring, a word overlap — and every one of them has to come back null.
  it("refuses anything that is not an exact name", () => {
    expect(matchApp("spotifyy", BUILT_IN_APPS)).toBeNull(); // one typo away
    expect(matchApp("spot", BUILT_IN_APPS)).toBeNull(); // a prefix
    expect(matchApp("spotify premium", BUILT_IN_APPS)).toBeNull(); // contains the name
    expect(matchApp("my music player", BUILT_IN_APPS)).toBeNull(); // shares a word with an alias
    expect(matchApp("explore", BUILT_IN_APPS)).toBeNull(); // a prefix of an alias
    expect(matchApp("", BUILT_IN_APPS)).toBeNull();
    expect(matchApp("   ", BUILT_IN_APPS)).toBeNull();
  });

  // A name is only a name. Someone saying "open notepad.exe" is refused rather than silently
  // treated as a command, which is the input shape the whole model-never-writes-a-command rule
  // exists to keep out.
  it("refuses an executable name or a path, even one that would work", () => {
    expect(matchApp("notepad.exe", BUILT_IN_APPS)).toBeNull();
    expect(matchApp("C:\\Windows\\notepad.exe", BUILT_IN_APPS)).toBeNull();
    expect(matchApp("cmd.exe", BUILT_IN_APPS)).toBeNull();
  });

  it("matches against whatever catalog it is given, not a global one", () => {
    const tiny: readonly AppEntry[] = [{ id: "thing", label: "Thing", aliases: ["widget"] }];
    expect(matchApp("widget", tiny)?.id).toBe("thing");
    // In the built-in catalog, but not in this one.
    expect(matchApp("spotify", tiny)).toBeNull();
    expect(matchApp("anything", [])).toBeNull();
  });

  // THE INVARIANT, and it is stronger than "no two built-ins share an alias" on purpose.
  //
  // Asking only about duplicate aliases would miss an alias that collides with another entry's
  // ID or LABEL, and it would not prove the names are REACHABLE at all. This asks the question
  // that actually matters — every name of every entry resolves to that same entry — which can
  // only hold if each name is unique across the whole catalog AND normalizes to something
  // matchable. A duplicate added later fails here, because first-match-wins would hand the new
  // entry's lookup back the older one.
  it("gives every built-in a set of names that are unique and reachable", () => {
    for (const entry of BUILT_IN_APPS) {
      for (const name of [entry.id, entry.label, ...entry.aliases]) {
        expect(matchApp(name, BUILT_IN_APPS), `"${name}" does not resolve to ${entry.id}`).toBe(
          entry,
        );
      }
    }
  });

  it("has no built-in name that normalizes away to nothing", () => {
    for (const entry of BUILT_IN_APPS) {
      for (const name of [entry.id, entry.label, ...entry.aliases]) {
        expect(normalizeAppName(name).length, `"${name}" normalizes to empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe("describeCatalog", () => {
  // The literal sentence the refusal message is built from. Pinned as a string rather than
  // computed, because this is what a person reads when the app says no.
  it("names the built-in apps the way a person would", () => {
    expect(describeCatalog(BUILT_IN_APPS)).toBe("Spotify, Notepad, Calculator and File Explorer");
  });

  it("handles one, two and none", () => {
    const one: readonly AppEntry[] = [{ id: "a", label: "Alpha", aliases: [] }];
    const two: readonly AppEntry[] = [...one, { id: "b", label: "Beta", aliases: [] }];
    expect(describeCatalog(one)).toBe("Alpha");
    expect(describeCatalog(two)).toBe("Alpha and Beta");
    expect(describeCatalog([])).toBe("nothing");
  });
});
