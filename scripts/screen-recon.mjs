// M15 task 1a — reconnaissance against the REAL Windows capture path, before any of it is
// designed around.
//
// WHY THIS EXISTS. M10 hand-authored a jsdom fixture from an assumption about Gmail's markup
// (`role="button"`; it was `role="link"`), every test passed, and only a live page ever said so.
// M11 wrote scripts/notion-recon.mjs so its fixture would be TRANSCRIBED instead; M14 wrote
// scripts/tts-recon.mjs for the same reason and found the engine was mangling UTF-8. This is
// that move for screen capture, and it matters more here than in either of those, because the
// whole milestone rests on a coordinate being right: an image-pixel → screen-DIP mapping written
// from an assumption about DPI is a marker that lands confidently in the wrong place.
//
// THIS SCRIPT MUST RUN UNDER ELECTRON, not node:
//
//     npx electron scripts/screen-recon.mjs
//
// `desktopCapturer` is an electron API and does not exist under plain node. If the sandbox has
// set ELECTRON_RUN_AS_NODE=1, electron boots as node and this file bails with instructions
// rather than failing obscurely.
//
// The open questions this answers, in the order they matter:
//   Q1  Does `desktopCapturer.getSources` hand back a display at its full native pixel
//       resolution, and does `source.display_id` map onto `screen.getAllDisplays()[].id`?
//       Everything downstream indexes on that join.
//   Q2  What does one capture COST — milliseconds, and bytes as PNG and as JPEG?
//   Q3  *The load-bearing one.* Does `setContentProtection(true)` exclude one of our OWN windows
//       from our OWN capture? The plan's lazy-capture design (screenshot taken inside the
//       handler, while the command bar is on screen) is only viable if it does. Measured by
//       painting a window solid magenta and COUNTING magenta pixels in the captured frame —
//       "it looked fine" is not an answer. Also: does a just-set protection take effect on the
//       very next capture, or is there a frame of lag? That decides permanent vs. toggled.
//   Q4  Multi-monitor: one source per display, and which source is which display?
//   Q5  DPI. On a scaled display, what is `display.bounds` (DIP) versus the captured image size
//       (px)? This is the exact arithmetic core/vision/geometry.ts has to implement, and it gets
//       TRANSCRIBED from here rather than derived from what scaleFactor ought to mean.
//   Q6  `nativeImage.resize()` — what it costs, and whether the output size is actually the one
//       requested (the downscale is what fixes the model's pixel space, so an off-by-a-row here
//       is an off-by-a-row in every coordinate).
//   Q7  Manual: what happens with a UAC prompt or the lock screen up. Not automatable — see the
//       note printed at the end.
//   Q8  Is `getDisplayNearestPoint(getCursorScreenPoint())` a sane "the display the user is
//       looking at" selector?
//
// Flags:
//   --out <dir>   where the captured PNGs land (default: <tmp>/screen-recon)
//   --keep        do not delete the captured PNGs on the way out (default: they are deleted;
//                 these are pictures of your screen, and this milestone's whole privacy claim
//                 is that they do not linger)

import * as electronNS from "electron";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = electronNS.default ?? electronNS;
const { app, BrowserWindow, desktopCapturer, screen } = electron;

if (typeof app?.whenReady !== "function") {
  console.error(
    "This script must run under electron, not node.\n" +
      "  npx electron scripts/screen-recon.mjs\n\n" +
      "If you ARE running it that way and still see this, ELECTRON_RUN_AS_NODE is set in the\n" +
      "environment and electron booted as plain node. Clear it first:\n" +
      "  PowerShell:  $env:ELECTRON_RUN_AS_NODE=''\n" +
      "  bash:        unset ELECTRON_RUN_AS_NODE",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const OUT_DIR = flag("--out", join(tmpdir(), "screen-recon"));
const KEEP = has("--keep");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function heading(text) {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

// One capture of every screen at the requested thumbnail size. `thumbnailSize` applies to ALL
// sources in the call, which is itself worth knowing: asking for one display at native size
// means every other display is rendered at that size too.
async function grab(thumbnailSize) {
  const started = Date.now();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  return { sources, elapsedMs: Date.now() - started };
}

// Count how many pixels inside a screen-DIP rectangle came back magenta.
//
// The point of counting rather than eyeballing: "the window is excluded from capture" and "the
// window happened to be behind something" look identical in a screenshot, and only one of them
// is the property we are about to build on. `image` is one display's frame; `display` is that
// display's bounds in DIP; `rect` is in DIP, in SCREEN coordinates.
function countMagenta(image, display, rect) {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA, 4 bytes per pixel, row-major
  // DIP → image pixels. Derived from the IMAGE we actually got rather than from scaleFactor,
  // because whether those agree is precisely Q5.
  const sx = size.width / display.width;
  const sy = size.height / display.height;

  const left = Math.max(0, Math.round((rect.x - display.x) * sx));
  const top = Math.max(0, Math.round((rect.y - display.y) * sy));
  const right = Math.min(size.width, Math.round((rect.x - display.x + rect.width) * sx));
  const bottom = Math.min(size.height, Math.round((rect.y - display.y + rect.height) * sy));

  let inRect = 0;
  let anywhere = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const i = (y * size.width + x) * 4;
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      if (r > 200 && b > 200 && g < 60) {
        anywhere += 1;
        if (x >= left && x < right && y >= top && y < bottom) inRect += 1;
      }
    }
  }
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return { inRect, anywhere, area, pct: area === 0 ? 0 : (inRect / area) * 100 };
}

function sourceFor(sources, display) {
  return (
    sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0] ?? null
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  const save = (name, buffer) => {
    const path = join(OUT_DIR, name);
    writeFileSync(path, buffer);
    written.push(path);
    return path;
  };

  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // --- Q1 / Q4 / Q5: what electron thinks the displays are ---------------------------------

  heading("Q1/Q4/Q5 — displays as electron sees them");
  for (const d of displays) {
    console.log(
      [
        `id=${d.id}${d.id === primary.id ? " (primary)" : ""}`,
        `bounds=${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height} (DIP)`,
        `size=${d.size.width}x${d.size.height}`,
        `workArea=${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height}`,
        `scaleFactor=${d.scaleFactor}`,
        `rotation=${d.rotation}`,
        `internal=${d.internal}`,
      ].join("\n    "),
    );
    console.log(
      `    implied native px = ${Math.round(d.bounds.width * d.scaleFactor)}x${Math.round(
        d.bounds.height * d.scaleFactor,
      )}`,
    );
  }

  // Ask for the primary display at its implied NATIVE pixel size.
  const nativeSize = {
    width: Math.round(primary.bounds.width * primary.scaleFactor),
    height: Math.round(primary.bounds.height * primary.scaleFactor),
  };
  heading(`Q1/Q2 — getSources at implied native size ${nativeSize.width}x${nativeSize.height}`);
  const nativeGrab = await grab(nativeSize);
  console.log(`getSources took ${nativeGrab.elapsedMs} ms for ${nativeGrab.sources.length} source(s)`);
  for (const s of nativeGrab.sources) {
    const size = s.thumbnail.getSize();
    console.log(
      `  id=${s.id}  display_id=${s.display_id || "(empty)"}  name=${JSON.stringify(s.name)}\n` +
        `    thumbnail=${size.width}x${size.height}  empty=${s.thumbnail.isEmpty()}`,
    );
  }
  console.log(
    "\n  ^ Q1 answer: does display_id above match one of the display ids in the first block?\n" +
      "    If display_id is EMPTY, the join has to be done by index/name instead and the\n" +
      "    multi-monitor story changes.",
  );

  const primarySource = sourceFor(nativeGrab.sources, primary);
  if (primarySource === null) {
    console.error("No screen source came back at all — nothing further can be measured.");
    app.quit();
    return;
  }

  const full = primarySource.thumbnail;
  const fullSize = full.getSize();
  const png = full.toPNG();
  const jpeg = full.toJPEG(80);
  console.log(
    `\n  Q2: primary frame ${fullSize.width}x${fullSize.height}  ` +
      `PNG ${kb(png.length)}  JPEG(q80) ${kb(jpeg.length)}`,
  );
  console.log(
    `  Q5: requested ${nativeSize.width}x${nativeSize.height}, got ${fullSize.width}x${fullSize.height} — ` +
      (fullSize.width === nativeSize.width && fullSize.height === nativeSize.height
        ? "EXACT"
        : "DIFFERENT (this is the number geometry.ts must trust, not scaleFactor)"),
  );
  save("q2-full.png", png);

  // The same call again, asking in DIP instead of native pixels — does electron scale, or is
  // thumbnailSize a hard ceiling with aspect preserved?
  const dipGrab = await grab({ width: primary.bounds.width, height: primary.bounds.height });
  const dipSource = sourceFor(dipGrab.sources, primary);
  if (dipSource) {
    const s = dipSource.thumbnail.getSize();
    console.log(
      `  Q5: asking in DIP (${primary.bounds.width}x${primary.bounds.height}) returned ${s.width}x${s.height} ` +
        `in ${dipGrab.elapsedMs} ms`,
    );
  }

  // --- Q6: downscaling to a pixel space we control -----------------------------------------

  heading("Q6 — nativeImage.resize() to a long edge of 1568");
  const longEdge = fullSize.width >= fullSize.height ? "width" : "height";
  const t0 = Date.now();
  const small = full.resize({ [longEdge]: 1568, quality: "best" });
  const resizeMs = Date.now() - t0;
  const smallSize = small.getSize();
  const smallPng = small.toPNG();
  const smallJpeg = small.toJPEG(80);
  console.log(
    `  resize(${longEdge}=1568) took ${resizeMs} ms → ${smallSize.width}x${smallSize.height}\n` +
      `  PNG ${kb(smallPng.length)}  JPEG(q80) ${kb(smallJpeg.length)}`,
  );
  console.log(
    `  aspect preserved? source ${(fullSize.width / fullSize.height).toFixed(4)} vs ` +
      `resized ${(smallSize.width / smallSize.height).toFixed(4)}`,
  );
  console.log(
    `  image-px → DIP factor the tool will use: x ${(primary.bounds.width / smallSize.width).toFixed(5)}, ` +
      `y ${(primary.bounds.height / smallSize.height).toFixed(5)}`,
  );
  save("q6-downscaled.png", smallPng);

  // --- Q3: does content protection hide one of OUR windows from OUR capture? ---------------

  heading("Q3 — setContentProtection() vs. our own desktopCapturer call");

  const probeRect = {
    x: primary.bounds.x + 140,
    y: primary.bounds.y + 140,
    width: 420,
    height: 300,
  };
  const probe = new BrowserWindow({
    ...probeRect,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#FF00FF",
  });
  probe.setAlwaysOnTop(true, "screen-saver");
  await probe.loadURL(
    "data:text/html,<body style='margin:0;height:100vh;background:%23FF00FF'></body>",
  );
  probe.showInactive();
  await sleep(900); // let the compositor actually paint it

  const measure = async (label) => {
    const { sources } = await grab(nativeSize);
    const source = sourceFor(sources, primary);
    const counted = countMagenta(source.thumbnail, primary.bounds, probeRect);
    console.log(
      `  ${label.padEnd(34)} magenta in probe rect: ${counted.inRect}/${counted.area} ` +
        `(${counted.pct.toFixed(1)}%)   anywhere on screen: ${counted.anywhere}`,
    );
    return { counted, image: source.thumbnail };
  };

  const before = await measure("unprotected");
  save("q3-a-unprotected.png", before.image.toPNG());

  probe.setContentProtection(true);
  const immediately = await measure("protected, captured immediately");
  save("q3-b-protected-immediate.png", immediately.image.toPNG());

  await sleep(600);
  const settled = await measure("protected, after 600ms");
  save("q3-c-protected-settled.png", settled.image.toPNG());

  probe.setContentProtection(false);
  await sleep(600);
  const after = await measure("protection turned back off");

  console.log("\n  READ THIS AS:");
  console.log(
    "    unprotected should be a high percentage (the window is visible and captured).\n" +
      "    protected should be ~0. If it is, lazy capture works and the command bar can stay\n" +
      "    on screen while we photograph what is behind it.\n" +
      "    If 'immediately' is high but 'after 600ms' is ~0, protection is real but LAGS — set\n" +
      "    it permanently at window creation rather than toggling it around each capture.\n" +
      "    If protected is still high, Q3 has FAILED: fall back to the plan's contingency\n" +
      "    (capture at hotkey-press time, before the bar is shown).",
  );
  const verdict =
    before.counted.pct > 50 && settled.counted.pct < 1
      ? immediately.counted.pct < 1
        ? "PASS — protection works and takes effect immediately"
        : "PASS WITH LAG — protection works but needs a beat; set it permanently"
      : before.counted.pct <= 50
        ? "INCONCLUSIVE — the probe window was not captured even unprotected (was it covered?)"
        : "FAIL — protected windows still appear in our own capture";
  console.log(`\n  Q3 VERDICT: ${verdict}`);
  console.log(`  (turning it back off restored ${after.counted.pct.toFixed(1)}% — sanity check)`);

  probe.destroy();

  // --- Q8: which display is the user looking at? -------------------------------------------

  heading("Q8 — picking the display");
  const cursor = screen.getCursorScreenPoint();
  const nearest = screen.getDisplayNearestPoint(cursor);
  console.log(`  cursor at ${cursor.x},${cursor.y} (DIP)`);
  console.log(`  getDisplayNearestPoint → id=${nearest.id}${nearest.id === primary.id ? " (primary)" : ""}`);
  console.log(
    "  With one display this is trivially right. With two, move the mouse to the second\n" +
      "  monitor and re-run: the id must change, or the selector is wrong.",
  );

  // --- Q7: not automatable -----------------------------------------------------------------

  heading("Q7 — manual, not automated");
  console.log(
    "  Run this again with a UAC prompt on screen, and again from a locked session, and note\n" +
      "  what getSources does: throws, returns an empty thumbnail, or returns the desktop\n" +
      "  without the secure surface. Whatever it does is what WindowsScreen has to classify\n" +
      "  into a sentence a person can act on — no failure reason gets invented from a guess.",
  );

  // --- files ------------------------------------------------------------------------------

  heading("captured frames");
  if (KEEP) {
    console.log(`  kept in ${OUT_DIR}:`);
    for (const p of written) console.log(`    ${p}`);
    console.log(
      "\n  These are pictures of your screen. Look at them, then delete them — the milestone's\n" +
        "  privacy claim is that nothing lingers, and that starts with the recon.",
    );
  } else {
    for (const p of written) rmSync(p, { force: true });
    console.log(
      `  ${written.length} frame(s) written and deleted again (pass --keep to eyeball them).\n` +
        "  Deleting is the default on purpose: these are pictures of your screen.",
    );
  }

  app.quit();
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error("\nrecon failed:", error);
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  // Intentionally empty — the probe window closing must not end the run.
});
