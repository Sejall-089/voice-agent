// M16.8 — the real host against real windows.
//
// Everything from M16.2 to M16.7 was proven against fakes built from an EARLIER recon session's
// dumps. This script is the first thing that runs the actual `WindowsElements` host process and
// compares what it reports against what those fixtures assumed. M14's Piper `--output-dir`
// discovery is the precedent: a design built correctly against documentation can still be wrong
// about how the real thing behaves once you run it.
//
// It answers four questions, in the order they can invalidate work:
//   B1  What do probe() and enumerate() cost THROUGH THE HOST? Recon measured raw UIA at
//       46-80ms and 200-850ms, but that was ad-hoc PowerShell with no process boundary. If the
//       host adds meaningful overhead, the settle budget (350/700/1500ms) is mis-calibrated.
//   B2  Do the three regression targets still exist at the rects the fixtures were built from?
//   B3  Do the live triggers fire where the fakes said — window class read on probe, chrome-only
//       detected on enumerate?
//   B4  What does the host's own startup cost, and does it stay warm?
//
//   npx vite-node scripts/uia-host-bench.ts --match "Notepad"
import { WindowsElements } from "../src/main/uia/WindowsElements.ts";
import { buildCandidates, isChromeOnly } from "../src/core/screen/elements.ts";
import { classify, isLazyShell } from "../src/core/screen/settle.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]!;
};
const MATCH = flag("--match", "");
const HWND = Number(flag("--hwnd", "0"));

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const value = await fn();
  console.log(`    ${label.padEnd(34)} ${(performance.now() - t0).toFixed(0)}ms`);
  return value;
};

// The host takes an HWND; 0 means "the foreground window". This bench drives it by foreground,
// which is what M16.9 will replace with the hotkey-time snapshot.
// Addressed by HWND rather than by foreground, so a background window can be measured without
// stealing focus from the terminal — UIA reads background windows fine (recon enumerated a
// MINIMIZED Notepad). 0 falls back to whatever is in front.
const host = new WindowsElements({ target: () => HWND });

console.log("B4  host startup (first call pays Add-Type + two UIAutomation assemblies)");
const first = await ms("first probe (cold host)", () => host.probe());
console.log(`    -> count=${first.count} class=${first.windowClass}`);

console.log("");
console.log("B1  steady-state cost through the host process");
for (let i = 0; i < 4; i += 1) {
  await ms(`probe #${i + 2} (warm)`, () => host.probe());
}
const window = await ms("enumerate (warm)", () => host.enumerate());
await ms("enumerate again (warm)", () => host.enumerate());

console.log("");
console.log("B3  what the live triggers see");
const candidates = buildCandidates(window);
console.log(`    windowTitle   ${JSON.stringify(window.windowTitle)}`);
console.log(`    windowClass   ${window.windowClass}   (trigger A fires: ${isLazyShell(window.windowClass)})`);
console.log(`    windowRect    ${JSON.stringify(window.windowRect)}`);
console.log(`    raw elements  ${window.elements.length}`);
console.log(`    candidates    ${candidates.length}`);
console.log(`    thinness      ${classify(candidates)}   (chromeOnly: ${isChromeOnly(candidates)})`);

if (MATCH) {
  console.log("");
  console.log(`B2  regression targets matching /${MATCH}/`);
  const hits = candidates.filter((c) => new RegExp(MATCH, "i").test(c.name));
  if (hits.length === 0) console.log("    *** NONE FOUND ***");
  for (const c of hits) {
    console.log(
      `    #${String(c.number).padStart(3)} ${c.controlType.padEnd(12)} ` +
        `rect=${c.rect.x},${c.rect.y} ${c.rect.width}x${c.rect.height}  pos=${c.position}  ` +
        `name=${JSON.stringify(c.name)}`,
    );
  }
}

console.log("");
console.log("    first 12 candidates:");
for (const c of candidates.slice(0, 12)) {
  console.log(
    `      #${String(c.number).padStart(3)} ${c.controlType.padEnd(12)} ` +
      `${String(c.rect.x).padStart(5)},${String(c.rect.y).padStart(5)} ` +
      `${c.rect.width}x${c.rect.height}  ${JSON.stringify(c.name).slice(0, 46)}`,
  );
}

host.dispose();
