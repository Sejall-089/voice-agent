// `npm run dev`'s pre-step, and the stamp the native rebuilds leave behind.
//
//   node scripts/predev.mjs                   rebuild for Electron — or, if the app is already
//                                             running, skip so this launch reaches the lock
//   node scripts/predev.mjs --clear           remove the stamp before a rebuild starts (kept while
//                                             the binary is in use: that rebuild cannot replace it)
//   node scripts/predev.mjs --stamp <target>  record "electron" or "node" (after one succeeds)
//
// The decision and the lock check are in nativeTarget.mts, tested in tests/nativeTarget.test.ts.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARY_RELATIVE,
  STAMP_RELATIVE,
  decidePredev,
  isBinaryLocked,
  readStamp,
  shouldClearStamp,
} from "./nativeTarget.mts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const stampPath = join(repo, STAMP_RELATIVE);
const binaryPath = join(repo, BINARY_RELATIVE);
const [flag, value] = process.argv.slice(2);

if (flag === "--clear") {
  if (shouldClearStamp(isBinaryLocked(fs, binaryPath))) fs.rmSync(stampPath, { force: true });
} else if (flag === "--stamp") {
  if (value !== "electron" && value !== "node") {
    console.error(`[predev] --stamp takes "electron" or "node", not ${JSON.stringify(value)}`);
    process.exit(2);
  }
  fs.writeFileSync(stampPath, `${value}\n`);
} else if (flag !== undefined) {
  console.error(`[predev] unknown option ${flag}`);
  process.exit(2);
} else {
  const decision = decidePredev(isBinaryLocked(fs, binaryPath), readStamp(fs, stampPath));
  if (decision.action === "skip") {
    console.log(decision.message);
  } else if (decision.action === "fail") {
    console.error(decision.message);
    process.exit(1);
  } else {
    const rebuild = spawnSync("npm run rebuild:electron", { cwd: repo, stdio: "inherit", shell: true });
    process.exit(rebuild.status ?? 1);
  }
}
