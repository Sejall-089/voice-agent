// Turning a name into a running program (M18). The Windows half of `core/apps.ts`.
//
// IMPORTS NO ELECTRON, on purpose and for the usual reason: everything in here is ordinary
// branching — which command belongs to which name, which `APPS_EXTRA` entries are acceptable,
// what the user is told when a launch fails — and CLAUDE.md's rule is that the testable logic
// comes apart from the transport. `electronShell.openExternal` and `child_process.spawn` are
// injected as `io` so every decision below runs under vitest with nothing started.

import {
  BUILT_IN_APPS,
  describeCatalog,
  matchApp,
  normalizeAppName,
  type AppEntry,
} from "../../core/apps.ts";
import { spawn } from "node:child_process";

// How one app is started. Two kinds because Windows genuinely has two: a Store app like
// Spotify is reached through its registered protocol handler (there is no stable .exe path to
// point at), and a system program is an executable on PATH.
export type LaunchSpec =
  | { kind: "protocol"; uri: string }
  | { kind: "exe"; command: string };

export type CatalogEntry = AppEntry & { launch: LaunchSpec };

// Keyed by `AppEntry.id`, so adding a name in core without a way to start it here is a
// detectable mistake rather than a silent "I can't open that".
const BUILT_IN_LAUNCH: Record<string, LaunchSpec> = {
  spotify: { kind: "protocol", uri: "spotify:" },
  notepad: { kind: "exe", command: "notepad.exe" },
  calculator: { kind: "exe", command: "calc.exe" },
  explorer: { kind: "exe", command: "explorer.exe" },
};

// The built-in catalog, joined at module load.
//
// THE THROW IS THE POINT. `BUILT_IN_APPS` and `BUILT_IN_LAUNCH` live in different files on
// different sides of the portability contract, so they can drift — and the drift that matters
// is adding a name in core and forgetting the command here, which would otherwise surface as
// the app politely refusing to open something it advertises in its own tool description. This
// fails at import instead, which means it fails in every test run and at app start.
export const BUILT_IN_CATALOG: readonly CatalogEntry[] = BUILT_IN_APPS.map((entry) => {
  const launch = BUILT_IN_LAUNCH[entry.id];
  if (launch === undefined) {
    throw new Error(
      `No launch spec for built-in app "${entry.id}" — add one to BUILT_IN_LAUNCH in appLaunch.ts.`,
    );
  }
  return { ...entry, launch };
});

// Schemes that are not applications. `http`/`https` belong to `openTarget`, which validates and
// opens web URLs already (and would be the way to smuggle an arbitrary page in through a config
// value that is supposed to name local programs). `file:` opens anything on disk; `javascript:`,
// `data:` and `vbscript:` are code, not apps, and `openExternal` on Windows will happily hand a
// scheme to whatever registered for it.
//
// A DENYLIST IS NOT THE DEFENCE HERE — the shape check is (`PROTOCOL_RE` below accepts only a
// bare scheme with nothing after the colon, so there is no payload to carry). This list exists
// because `http:` passes that shape test perfectly well, and a bare `http:` in `APPS_EXTRA`
// almost certainly means someone misunderstood what the setting is for and should be told so.
const DENIED_SCHEMES = new Set(["http", "https", "file", "javascript", "data", "vbscript"]);

// A bare scheme and nothing else: `slack:`, `spotify:`, `ms-settings:`. No host, no path, no
// query — if a URI could carry a payload, `APPS_EXTRA` would be a way to make the app open
// arbitrary content rather than an app.
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:$/i;
// `notepad.exe`, `vlc.exe` — resolved on PATH by the OS.
const BARE_EXE_RE = /^[A-Za-z0-9._-]+\.exe$/i;
// `C:\Program Files\VideoLAN\VLC\vlc.exe`. A drive letter is required: a relative path would
// resolve against this process's working directory, which is not something a user setting
// should get to reach into, and a UNC path (`\\server\share`) means starting a program over the
// network, which is not what this setting is for.
const ABSOLUTE_EXE_RE = /^[A-Za-z]:[\\/].*\.exe$/i;
// Something after the `.exe` — i.e. arguments. See `parseExtraApps` for why that is refused.
const EXE_WITH_ARGUMENTS_RE = /\.exe["']?\s+\S/i;

export interface ExtraAppsResult {
  entries: CatalogEntry[];
  // One line per rejected entry, written to be shown to a person at startup. A malformed entry
  // is NEVER silently dropped: a config value that does nothing and says nothing is
  // indistinguishable from the feature being broken.
  problems: string[];
}

// Parse `APPS_EXTRA`: `Name=command|Name2=command2`.
//
// WHY ARGUMENTS ARE REFUSED OUTRIGHT, rather than passed through: `spawn` is called with
// `shell: false` (see `spawnDetached`), so an argument string would not be parsed by a shell
// anyway — it would be handed to the program as one literal argv entry, which is almost never
// what someone writing `notepad.exe /A` meant. Supporting it properly means tokenizing a
// command line, and a half-correct tokenizer in front of process creation is a bad trade for a
// capability spec.md §2 lists as out of scope. So the rule is stated and enforced, not fudged.
export function parseExtraApps(raw: string | undefined): ExtraAppsResult {
  const entries: CatalogEntry[] = [];
  const problems: string[] = [];

  if (raw === undefined || raw.trim().length === 0) return { entries, problems };

  for (const chunk of raw.split("|")) {
    if (chunk.trim().length === 0) continue;

    const separator = chunk.indexOf("=");
    if (separator === -1) {
      problems.push(
        `I ignored the APPS_EXTRA entry "${chunk.trim()}" — it needs the form Name=command.`,
      );
      continue;
    }

    const label = chunk.slice(0, separator).trim();
    // Surrounding quotes are stripped because a path with spaces is the normal case for this
    // setting and quoting it is the reflex anyone would have.
    const command = stripQuotes(chunk.slice(separator + 1).trim());

    if (label.length === 0) {
      problems.push(`I ignored an APPS_EXTRA entry with no name before the "=".`);
      continue;
    }
    if (command.length === 0) {
      problems.push(`I ignored the APPS_EXTRA app "${label}" — there is no command after the "=".`);
      continue;
    }
    // A name made entirely of punctuation normalizes to nothing, so `matchApp` could never
    // return it and the entry would sit in the catalog unreachable — present in the "I can only
    // open:" list and impossible to ask for. Rejected rather than stored.
    const id = normalizeAppName(label);
    if (id.length === 0) {
      problems.push(
        `I ignored the APPS_EXTRA app "${label}" — that name has no letters or digits in it.`,
      );
      continue;
    }
    if (matchApp(label, BUILT_IN_APPS) !== null || matchApp(label, entries) !== null) {
      problems.push(`I ignored the APPS_EXTRA app "${label}" — that name is already taken.`);
      continue;
    }

    const launch = parseLaunchSpec(command);
    if (typeof launch === "string") {
      problems.push(`I ignored the APPS_EXTRA app "${label}" — ${launch}`);
      continue;
    }

    entries.push({ id, label, aliases: [], launch });
  }

  return { entries, problems };
}

// A `LaunchSpec`, or the reason there isn't one (a sentence that completes "I ignored X — ").
function parseLaunchSpec(command: string): LaunchSpec | string {
  if (EXE_WITH_ARGUMENTS_RE.test(command)) {
    return `"${command}" has arguments, and I only launch a bare command.`;
  }

  if (/\.exe$/i.test(command)) {
    if (BARE_EXE_RE.test(command) || ABSOLUTE_EXE_RE.test(command)) {
      return { kind: "exe", command };
    }
    return (
      `"${command}" must be an absolute path with a drive letter ` +
      `(C:\\...\\thing.exe) or a bare name like thing.exe.`
    );
  }

  if (PROTOCOL_RE.test(command)) {
    const scheme = command.slice(0, -1).toLowerCase();
    if (DENIED_SCHEMES.has(scheme)) {
      return `"${command}" is a web or scripting scheme, and I only open apps. Use openTarget for a website.`;
    }
    return { kind: "protocol", uri: command };
  }

  return (
    `"${command}" must be an absolute path ending in .exe, a bare name.exe, ` +
    `or a protocol like slack:.`
  );
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

// The two ways a program actually gets started, injected so every decision above is testable
// with nothing running. Mirrors `OSShell.executeAction`'s own contract: the real
// implementations are `spawnDetached` and `electronShell.openExternal`.
export interface LaunchIo {
  spawn(command: string): Promise<void>;
  openExternal(uri: string): Promise<void>;
}

export interface AppLauncher {
  // Returns rather than throws, matching `OSShell.executeAction` — the shell's job is to report
  // what happened, and the tool turns that into something the user reads.
  launch(name: string): Promise<{ ok: boolean; error?: string }>;
}

export function createAppLauncher(
  catalog: readonly CatalogEntry[],
  io: LaunchIo,
): AppLauncher {
  return {
    async launch(name: string): Promise<{ ok: boolean; error?: string }> {
      const entry = matchApp(name, catalog);

      // Refused BEFORE `io` is touched. The whole point of the catalog is that an unmatched
      // name never reaches process creation, so this is the assertion that matters most in
      // tests/appLaunch.test.ts: not just that the message is right, but that nothing ran.
      if (entry === null) {
        return {
          ok: false,
          error: `I can't open ${name.trim()} — I can only open: ${describeCatalog(catalog)}.`,
        };
      }

      try {
        if (entry.launch.kind === "protocol") {
          await io.openExternal(entry.launch.uri);
        } else {
          await io.spawn(entry.launch.command);
        }
      } catch (error) {
        // The OS's own words, not a diagnosis. Same rule `speechEngineError("failed")` follows:
        // we do not know what this install's failures look like yet, and guessing sends someone
        // to fix the wrong thing.
        const reason = error instanceof Error ? error.message : String(error);
        // THE ONE FAILURE THAT IS NOW KNOWN, from a live run rather than a guess: Spotify not
        // installed. `openExternal("spotify:")` rejected with
        //   "Failed to open: No application is associated with the specified file for this
        //    operation. (0x483)"
        // which is Win32 ERROR_NO_ASSOCIATION - nothing is registered for the protocol. That
        // is a diagnosis this code can stand behind, so it is said plainly and the raw text is
        // kept out of what the user reads. Everything else still falls through verbatim.
        if (isNoAssociation(reason)) {
          return { ok: false, error: `${entry.label} doesn't seem to be installed.` };
        }
        return { ok: false, error: `I couldn't start ${entry.label}: ${reason}` };
      }

      return { ok: true };
    },
  };
}

// Matched on the CODE first: the sentence in front of it is Windows' own and is localized, so
// on a non-English install only "(0x483)" survives. The English text is accepted too in case a
// caller ever strips the code.
function isNoAssociation(reason: string): boolean {
  return /\(0x483\)/i.test(reason) || /no application is associated/i.test(reason);
}

// Start a program and stop caring about it.
//
// `shell: false` is load-bearing: with no shell in the way there is nothing to interpret a
// metacharacter, so the command is handed to the OS as a literal program name. `detached` +
// `unref()` mean the launched app outlives us — closing the assistant must not close the user's
// Notepad.
//
// Resolves on `spawn`, which is the OS confirming it created the process, and rejects on
// `error`, which is where "that file does not exist" arrives. Resolving on neither — just
// calling spawn and returning — would be M11's mistake again: reporting success as proof that
// something happened (CLAUDE.md).
export function spawnDetached(command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [], { shell: false, detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", (error: Error) => {
      reject(error);
    });
  });
}
