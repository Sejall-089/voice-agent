import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BINARY_RELATIVE,
  SKIP_MESSAGE,
  STAMP_RELATIVE,
  decidePredev,
  isBinaryLocked,
  readStamp,
  shouldClearStamp,
  type NativeFs,
} from "../scripts/nativeTarget.mts";

// `npm run dev`'s pre-step (live finding after M23): a second launch while the app was running
// died in the forced SQLite rebuild and never reached the single-instance lock. The rebuild is now
// skipped only when the binary is in use AND recorded as the Electron build.
//
// The fake filesystem follows what was MEASURED on Windows, not what the code expects: opening
// the binary "r+" while an Electron process has it loaded throws a Node error with code EBUSY;
// a missing file throws ENOENT. Node throws an `Error` carrying `code` — so does this fake.
// What this cannot show: that a real second launch then reaches the lock and the running app
// says so. That is scripts/second-launch-recon.mjs.

const BINARY = `C:/repo/${BINARY_RELATIVE}`;
const STAMP = `C:/repo/${STAMP_RELATIVE}`;

function nodeError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: operation failed, open '${path}'`), { code, errno: -1, syscall: "open", path });
}

function fakeFs(files: Record<string, string>, held: string[] = [], other: Record<string, string> = {}) {
  const opened: number[] = [];
  const closed: number[] = [];
  const fs: NativeFs = {
    openSync(path, flags) {
      if (other[path] !== undefined) throw nodeError(other[path], path);
      if (!(path in files)) throw nodeError("ENOENT", path);
      if (held.includes(path) && flags === "r+") throw nodeError("EBUSY", path);
      const fd = 100 + opened.length;
      opened.push(fd);
      return fd;
    },
    closeSync(fd) {
      closed.push(fd);
    },
    readFileSync(path) {
      const content = files[path];
      if (content === undefined) throw nodeError("ENOENT", path);
      return content;
    },
  };
  return { fs, opened, closed };
}

// The whole pre-step as predev.mjs runs it, against a fake disk.
const decideOn = (fs: NativeFs) => decidePredev(isBinaryLocked(fs, BINARY), readStamp(fs, STAMP));

describe("npm run dev's pre-step: rebuild, skip, or fail", () => {
  it("NOT LOCKED -> rebuild, whatever the stamp says", () => {
    for (const stamp of ["electron\n", "node\n", undefined]) {
      const files: Record<string, string> = { [BINARY]: "<binary>" };
      if (stamp !== undefined) files[STAMP] = stamp;
      expect(decideOn(fakeFs(files).fs)).toEqual({ action: "rebuild" });
    }
  });

  it("LOCKED + stamp 'electron' -> skip (the app is already running), with the skip message", () => {
    const { fs } = fakeFs({ [BINARY]: "<binary>", [STAMP]: "electron\n" }, [BINARY]);
    expect(decideOn(fs)).toEqual({ action: "skip", message: SKIP_MESSAGE });
  });

  it("LOCKED + stamp 'node' -> fail, saying someone else has it open and to close it", () => {
    const { fs } = fakeFs({ [BINARY]: "<binary>", [STAMP]: "node\n" }, [BINARY]);
    const decision = decideOn(fs);
    expect(decision.action).toBe("fail");
    expect(decision.action === "fail" && decision.message).toMatch(/another program has the sqlite binary open/i);
    expect(decision.action === "fail" && decision.message).toContain("last built for node");
    expect(decision.action === "fail" && decision.message).toMatch(/close whatever is using it/i);
  });

  it("LOCKED + NO stamp -> fail (nothing says it is the Electron build)", () => {
    const { fs } = fakeFs({ [BINARY]: "<binary>" }, [BINARY]);
    const decision = decideOn(fs);
    expect(decision.action).toBe("fail");
    expect(decision.action === "fail" && decision.message).toContain("nothing records what it was built for");
  });

  it("LOCKED + an unreadable stamp -> fail, the same as none", () => {
    const { fs } = fakeFs({ [BINARY]: "<binary>", [STAMP]: "electron-ish" }, [BINARY]);
    expect(decideOn(fs).action).toBe("fail");
  });
});

describe("the lock check", () => {
  it("a free binary is not locked, and the handle it opened is closed again", () => {
    const disk = fakeFs({ [BINARY]: "<binary>" });
    expect(isBinaryLocked(disk.fs, BINARY)).toBe(false);
    expect(disk.closed).toEqual(disk.opened);
    expect(disk.opened).toHaveLength(1);
  });

  it("EBUSY on a read-write open is a lock", () => {
    expect(isBinaryLocked(fakeFs({ [BINARY]: "<binary>" }, [BINARY]).fs, BINARY)).toBe(true);
  });

  it("a missing binary is not locked (the rebuild creates it)", () => {
    expect(isBinaryLocked(fakeFs({}).fs, BINARY)).toBe(false);
  });

  it("any OTHER failure is thrown, not guessed to be a lock", () => {
    const { fs } = fakeFs({ [BINARY]: "<binary>" }, [], { [BINARY]: "EACCES" });
    expect(() => isBinaryLocked(fs, BINARY)).toThrow(/EACCES/);
  });
});

describe("the stamp", () => {
  it("reads 'electron' and 'node' with or without a trailing newline", () => {
    expect(readStamp(fakeFs({ [STAMP]: "electron\n" }).fs, STAMP)).toBe("electron");
    expect(readStamp(fakeFs({ [STAMP]: "node" }).fs, STAMP)).toBe("node");
  });

  it("missing or anything else is 'not recorded'", () => {
    expect(readStamp(fakeFs({}).fs, STAMP)).toBeNull();
    expect(readStamp(fakeFs({ [STAMP]: "" }).fs, STAMP)).toBeNull();
  });

  it("is cleared before a rebuild — but KEPT while the binary is in use, since that rebuild cannot replace it", () => {
    expect(shouldClearStamp(false)).toBe(true);
    expect(shouldClearStamp(true)).toBe(false);
  });

  it("lives inside the package, so reinstalling better-sqlite3 removes it with the binary", () => {
    expect(STAMP_RELATIVE.startsWith("node_modules/better-sqlite3/")).toBe(true);
  });
});

describe("package.json: every rebuild clears the stamp first and writes it only after succeeding", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  const steps = (name: string): string[] => (scripts[name] ?? "").split("&&").map((step) => step.trim());

  it("rebuild:node — clear, npm rebuild, stamp node", () => {
    expect(steps("rebuild:node")).toEqual([
      "node scripts/predev.mjs --clear",
      "npm rebuild better-sqlite3",
      "node scripts/predev.mjs --stamp node",
    ]);
  });

  it("rebuild:electron — clear, forced electron-rebuild, stamp electron", () => {
    expect(steps("rebuild:electron")).toEqual([
      "node scripts/predev.mjs --clear",
      "electron-rebuild -f -w better-sqlite3",
      "node scripts/predev.mjs --stamp electron",
    ]);
  });

  it("pretest and preeval go through rebuild:node; predev through the script that may skip", () => {
    expect(scripts["pretest"]).toBe("npm run rebuild:node");
    expect(scripts["preeval"]).toBe("npm run rebuild:node");
    expect(scripts["predev"]).toBe("node scripts/predev.mjs");
  });
});
