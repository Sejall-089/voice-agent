import { BUILT_IN_APPS, describeCatalog } from "../apps.ts";
import { UserFixableError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Task 15 (spec.md §6): open an installed application.
//
// The sibling of `openTarget`, and the split between them is the whole design. `openTarget`
// takes a URL — a value the model can legitimately know, and one the shell can validate on
// sight. This takes A NAME, and resolving that name to something executable happens entirely
// in the shell (`core/apps.ts` holds the catalog, `src/main/shell/appLaunch.ts` the commands).
// So the model cannot propose a path, a command, or an argument, because the input schema has
// nowhere to put one.
//
// WHY THE DESCRIPTION LISTS THE BUILT-INS BUT THE HANDLER DOES NOT CHECK THEM: a user may add
// their own apps with APPS_EXTRA, which is read from `.env` in composition — `/core` cannot
// see it and must not try. So the model is told what definitely exists, told to pass the name
// through regardless, and the SHELL holds the only authoritative list. That keeps exactly one
// copy of the closed world; a second check in here would be a copy that goes stale the first
// time someone sets APPS_EXTRA, and would refuse apps the app can actually open.
export const openAppTool: Tool = {
  name: "openApp",
  description:
    "Open an installed application on this computer. Use this for APPS — things that are " +
    "installed and have a window — and use `openTarget` instead for anything on the web (a " +
    "URL, a site, 'my dashboard'). 'Open Spotify' is this tool; 'open the Spotify web player' " +
    "is `openTarget`. Pass `app` as the name the user used, verbatim — do not translate it " +
    "into a file path, an executable name, or a command, and never add arguments. The apps " +
    `always available are: ${describeCatalog(BUILT_IN_APPS)}. The user may have configured ` +
    "others, so pass a name through even if it is not in that list and let me check.",
  inputSchema: {
    type: "object",
    properties: {
      app: {
        type: "string",
        description:
          "The app as the user named it, verbatim (e.g. 'Spotify', 'notepad', 'calc'). " +
          "A name only — never a path, command, or argument.",
      },
    },
    required: ["app"],
  },
  // Opening a window is recoverable: the user closes it. Nothing is sent, written, or
  // destroyed, so there is nothing to narrate and nothing to ask about — the same tier
  // `openTarget` has carried since M2 for opening a browser tab, and for the same reason.
  //
  // What makes this honest rather than convenient is that the tier covers the WHOLE space of
  // what this tool can do. A `reversible` claim would be a lie if the model could pass
  // `cmd.exe /c del ...`; it cannot, because the catalog is closed and lives in the shell.
  risk: "reversible",
  // `app` is a literal to match against a closed list, not a reference to look up — the same
  // call `pointAt` makes about its `target`. Memory resolution would be strictly harmful here:
  // a user who taught the app "spotify is https://open.spotify.com" would have `app: "spotify"`
  // rewritten into that URL, which then matches nothing in the catalog and refuses. Resolution
  // can only ever turn a working name into a broken one.
  resolvesReferences: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const app = typeof input["app"] === "string" ? input["app"].trim() : "";

    // Asked, not guessed. There is no sensible default app to open, and picking one would be
    // the app doing something nobody requested.
    if (app.length === 0) {
      throw new UserFixableError("Which app should I open?");
    }

    const result = await deps.shell.executeAction({ kind: "openApp", payload: app });

    // The shell's message verbatim — it is the only layer that knows the real catalog, and it
    // has already named what it CAN open. `UserFixableError` rather than a bare `Error`
    // because none of these are malfunctions: the app is not installed, the name was not one
    // of ours, the OS refused. All of them are states the user can act on, so the planner
    // shows them as they are and logs `refused` (core/errors.ts).
    if (!result.ok) {
      throw new UserFixableError(result.error ?? `I couldn't open ${app}.`);
    }

    return `Opened ${app}`;
  },
};
