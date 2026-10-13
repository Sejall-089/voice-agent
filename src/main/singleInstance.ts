// One running instance (M23).
//
// Before M23 a second launch was merely wasteful: two bars, two hotkey negotiations, the second
// losing. With jobs recorded in SQLite it becomes wrong — both instances open the same
// `memory.db`, and the second one's startup sweep would mark every job the first is still
// running as `interrupted`. So the second launch never gets that far.
//
// Extracted from main.ts for the usual reason (CLAUDE.md): anything left in there has no test
// that could fail. The decision is three lines, and it is exactly the kind of three lines that
// ships with the branches the wrong way round.

// Just enough of electron's `app` to decide with — a narrow structural type, the way
// instructionHotkey.ts declares what it needs rather than where it comes from.
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

// Returns true when THIS process is the one instance and should go on to start up. Returns
// false when another instance already holds the lock: this process has been told to quit and
// the caller must not build anything — no window, no database handle, no hotkey.
//
// `onSecondLaunch` runs in the FIRST instance each time someone starts another. It is how the
// running app makes itself known ("focuses the first"); what that looks like is the caller's
// business, since only it has a window to show.
export function claimSingleInstance(app: SingleInstanceApp, onSecondLaunch: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => onSecondLaunch());
  return true;
}

// What the first instance shows when a second one was started.
export const ALREADY_RUNNING = "I'm already running — press the hotkey to give me an instruction.";
