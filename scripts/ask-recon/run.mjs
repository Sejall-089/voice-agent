// Runner for the ask recon scripts in this folder.
//
//   node scripts/ask-recon/run.mjs hotkey-during-question [typed|dictated]
//   node scripts/ask-recon/run.mjs dismissed-then-again
//
// !! THESE SEND REAL KEYSTROKES TO YOUR DESKTOP AND FLASH WINDOWS. !!
//
// Each script opens a real 640x640 always-on-top Electron window in the middle of the screen for
// several seconds and presses keys through the OS with SendKeys: Ctrl+Alt+Shift+F9 (a combo
// registered only by the script) and, in some, Escape. Whatever has focus when a key lands
// receives it — so do not type while one runs, and close anything where a stray Escape would
// cost you something. They register their own hotkey and never touch the app's; the app can
// stay running.
//
// `dismissed-then-again` additionally makes two real planning calls on the API key in .env. It
// executes no tool: both questions are dismissed, so no email is read and nothing is created.
//
// WHY A RUNNER. The scripts are TypeScript that import the app's real WindowsShell and hotkey
// handler, and they have to run inside Electron's MAIN process (a real BrowserWindow, real
// global shortcuts). So each is bundled with esbuild into out/ask-recon/ — inside the repo, so
// `electron` and `better-sqlite3` resolve — and launched with ELECTRON_RUN_AS_NODE cleared,
// which some shells set and which would otherwise run it as plain node.
//
// PREREQUISITES: `npm run build` once (the scripts load out/preload and out/renderer), and
// better-sqlite3 built for Electron (`npm run rebuild:electron`, which `npm run dev` does).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [name, ...args] = process.argv.slice(2);

const entry = join(here, `${name}.ts`);
if (!name || !existsSync(entry)) {
  console.error("usage: node scripts/ask-recon/run.mjs <hotkey-during-question|dismissed-then-again> [args]");
  process.exit(2);
}
for (const built of ["out/preload/preload.js", "out/renderer/index.html"]) {
  if (!existsSync(join(repo, built))) {
    console.error(`missing ${built} - run \`npm run build\` first`);
    process.exit(2);
  }
}

const outfile = join(repo, "out", "ask-recon", `${name}.cjs`);
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "better-sqlite3"],
  logLevel: "warning",
});

const electron = createRequire(import.meta.url)("electron"); // the path to electron.exe
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [outfile, ...args, repo], { cwd: repo, env, stdio: "inherit" });
process.exit(result.status ?? 1);
