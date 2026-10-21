// Which runtime the SQLite binary was last built for, and what `npm run dev` should do about it.
//
// `better_sqlite3.node` is built for ONE runtime at a time: `npm test` rebuilds it for node and
// `npm run dev` for Electron (the two ABIs differ, and loading the wrong one fails). Both rebuilds
// first delete the file — which Windows refuses while a running app has it loaded.
//
// WHY THIS EXISTS (live finding after M23). A second `npm run dev` while the app was running
// never reached the single-instance lock: `predev`'s forced rebuild failed with EPERM and npm
// stopped before Electron was started, so the running app never heard about it. The fix is to
// skip the rebuild when the binary is in use — but ONLY when it is known to be the Electron
// build. Something else can hold it too (a test run holds the node build), and starting Electron
// on that would trade a clear EPERM for a crash when the database opens.
//
// So every rebuild records what it built, in a stamp file next to the package: cleared before
// the rebuild starts (a rebuild that fails half way leaves no stamp, never a stale one) and
// written only once it has succeeded. It lives inside node_modules/better-sqlite3, so reinstalling
// the package takes the stamp with it.
//
// Run by node directly (type stripping), from scripts/predev.mjs. No electron, no repo imports.

export type NativeTarget = "electron" | "node";

export const STAMP_RELATIVE = "node_modules/better-sqlite3/.native-target";
export const BINARY_RELATIVE = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";

// Just the calls this needs, so a test can hand in a fake filesystem.
export interface NativeFs {
  openSync(path: string, flags: string): number;
  closeSync(fd: number): void;
  readFileSync(path: string, encoding: "utf8"): string;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

// Is another process holding the binary loaded? Measured on this machine: opening it for
// read-write ("r+") fails with EBUSY while an Electron process has it loaded and succeeds once
// that process exits. (Opening for APPEND succeeds even while it is loaded, so that cannot be
// the test.) A missing binary is not locked — the rebuild will create it. Any other failure is
// not a lock this understands, and is thrown rather than guessed at.
export function isBinaryLocked(fs: NativeFs, path: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path, "r+");
  } catch (error) {
    const code = codeOf(error);
    if (code === "EBUSY") return true;
    if (code === "ENOENT") return false;
    throw error;
  }
  fs.closeSync(fd);
  return false;
}

// What the last successful rebuild built, or null when nothing is recorded (never stamped, a
// rebuild in progress or failed, or the package reinstalled since).
export function readStamp(fs: NativeFs, path: string): NativeTarget | null {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8").trim();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  return text === "electron" || text === "node" ? text : null;
}

// Before a rebuild: drop the stamp, so one that fails half way leaves no record rather than a
// stale one — EXCEPT while the binary is in use. Then the rebuild cannot delete it (EPERM, before
// it changes anything), so what the stamp says is still true, and dropping it would make the next
// `npm run dev` refuse to hand over to the running app because an `npm test` failed meanwhile.
export function shouldClearStamp(locked: boolean): boolean {
  return !locked;
}

export type PredevDecision =
  | { action: "rebuild" }
  | { action: "skip"; message: string }
  | { action: "fail"; message: string };

export const SKIP_MESSAGE =
  "[predev] The SQLite binary is in use and was built for Electron — the app is already running. " +
  "Skipping the native rebuild; this launch will hand over to the running app.";

export function failMessage(stamp: NativeTarget | null): string {
  const built = stamp === null ? "nothing records what it was built for" : `it was last built for ${stamp}`;
  return (
    `[predev] Another program has the SQLite binary open (${BINARY_RELATIVE}), and ${built}, ` +
    "so it cannot be rebuilt for Electron and is not safe to start the app on. " +
    "Close whatever is using it (a test run, another copy of the app) and try again."
  );
}

// Free -> rebuild as before. In use AND known to be the Electron build -> that is a running copy
// of this app: skip, so the launch reaches the single-instance lock. In use and anything else ->
// fail loudly, as the rebuild always did, but saying why.
export function decidePredev(locked: boolean, stamp: NativeTarget | null): PredevDecision {
  if (!locked) return { action: "rebuild" };
  if (stamp === "electron") return { action: "skip", message: SKIP_MESSAGE };
  return { action: "fail", message: failMessage(stamp) };
}
