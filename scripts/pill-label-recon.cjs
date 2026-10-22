// M27: the REAL pill page measuring its own label, in a real window — does the label it ends up
// showing fit, whole, in the width it was given?
//
//   npm run build
//   npx electron scripts/pill-label-recon.cjs [build dir, default "out"] [png dir]
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT SHOWS A SMALL WINDOW AT THE BOTTOM RIGHT for a few seconds. It does NOT move the pointer,
// click or type. Nothing is sent anywhere: main is a recorder here.
//
// WHY THIS EXISTS. tests/pill.label.test.ts proves the rule (the longest form whose measured
// width is within the cap) and render.test.ts proves the page measures each form — against
// widths jsdom was HANDED, because jsdom does no layout. Neither can say whether the real page,
// with the real font, in a frameless transparent window, measures widths that make the chosen
// label fit without an ellipsis, or what those widths are. Only Chromium can.
//
// It plays main's part of the round trip: send a view with `labelOptions`, take the page's
// `pill:label-widths` report, choose as core/jobs/pill.ts does (copied below — keep in step:
// PILL_COLLAPSED.width 232, PILL_LABEL_MAX_WIDTH 348), size the window and send the view again.
// Then it reads the DOM: is the label cut (scrollWidth > clientWidth)? Is the pill as wide as
// the window?

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { existsSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const buildDir = resolve(process.argv[2] ?? "out");
const pngDir = process.argv[3] ? resolve(process.argv[3]) : null;

// src/main/pill/PillWindow.ts — PILL_WINDOW_OPTIONS, verbatim.
const PILL_WINDOW_OPTIONS = {
  show: false,
  frame: false,
  transparent: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,
  skipTaskbar: true,
  hasShadow: false,
  alwaysOnTop: true,
};

// core/jobs/pill.ts — pickLabel, copied.
const MIN_WIDTH = 232;
const MAX_WIDTH = 348;
const pick = (widths) => {
  const fits = widths.findIndex((width) => width <= MAX_WIDTH);
  const index = fits === -1 ? widths.length - 1 : fits;
  return { index, width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, widths[index])) };
};

// The forms core builds, for each case (labelOptions in core/jobs/pill.ts).
const CASES = [
  { name: "one group", options: ["1 running"] },
  { name: "the live finding", options: ["1 running · 2 done", "1 running · +2 more"] },
  {
    name: "three groups",
    options: ["1 didn't finish · 1 running · 2 done", "1 didn't finish · 1 running · +2 more", "1 didn't finish · +3 more"],
  },
  {
    name: "all four",
    options: [
      "1 needs you · 2 didn't finish · 3 running · 1 done",
      "1 needs you · 2 didn't finish · 3 running · +1 more",
      "1 needs you · 2 didn't finish · +4 more",
      "1 needs you · +6 more",
    ],
  },
  {
    name: "all four, big counts",
    options: [
      "12 need you · 10 didn't finish · 11 running · 14 done",
      "12 need you · 10 didn't finish · 11 running · +14 more",
      "12 need you · 10 didn't finish · +25 more",
      "12 need you · +35 more",
    ],
  },
  {
    // Past the cap on purpose, so the "+N more" form is drawn at least once.
    name: "past the cap",
    options: [
      "123 need you · 456 didn't finish · 789 running · 100 done",
      "123 need you · 456 didn't finish · 789 running · +100 more",
      "123 need you · 456 didn't finish · +889 more",
      "123 need you · +1345 more",
    ],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const preload = join(buildDir, "preload", "pill.js");
  const page = join(buildDir, "renderer", "pill.html");
  if (!existsSync(preload) || !existsSync(page)) {
    console.log(`[recon] no build at ${buildDir} (need preload/pill.js and renderer/pill.html) - run npm run build`);
    app.exit(1);
    return;
  }

  let report = null;
  ipcMain.on("pill:label-widths", (_e, labels, widths) => (report = { labels, widths }));

  const { workArea } = screen.getPrimaryDisplay();
  const place = (win, width, height) =>
    win.setBounds({ x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16, width, height });

  const win = new BrowserWindow({
    ...PILL_WINDOW_OPTIONS,
    width: MIN_WIDTH,
    height: 44,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  win.setContentProtection(true);
  await win.loadFile(page);
  const dom = (js) => win.webContents.executeJavaScript(js);

  for (const c of CASES) {
    report = null;
    const view = { mode: "running", label: c.options[0], labelOptions: c.options, pulse: false, expanded: false, muted: false, items: [] };
    place(win, MIN_WIDTH, 44);
    win.webContents.send("pill:view", view);
    win.showInactive();
    for (let waited = 0; report === null && waited < 2_000; waited += 50) await sleep(50);
    if (report === null) {
      console.log(`[recon] ${c.name}: NO REPORT from the page within 2 s`);
      continue;
    }
    const sameLabels = JSON.stringify(report.labels) === JSON.stringify(c.options);
    const chosen = pick(report.widths);
    place(win, chosen.width, 44);
    win.webContents.send("pill:view", { ...view, label: c.options[chosen.index], labelWidths: report.widths, width: chosen.width });
    await sleep(300);
    const read = await dom(`(() => {
      const s = document.querySelector('.summary'), l = document.querySelector('.summary .label');
      return { text: l.textContent, cut: l.scrollWidth > l.clientWidth, summary: Math.round(s.getBoundingClientRect().width),
               page: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    console.log(
      `[recon] ${c.name}: widths=${JSON.stringify(report.widths)} labelsEcho=${sameLabels} -> shows ${JSON.stringify(read.text)} ` +
        `at ${chosen.width}px; window=${win.getBounds().width} summary=${read.summary} page=${read.page} cut=${read.cut} overflow=${read.overflow}`,
    );
    if (pngDir !== null) {
      const image = await win.webContents.capturePage();
      writeFileSync(join(pngDir, `pill-label-${c.name.replace(/\W+/g, "-")}.png`), image.toPNG());
    }
  }
  app.exit(0);
});
