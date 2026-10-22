// M27: "Dismiss all" on the REAL pill page, in a real window — is it drawn in the same row as
// the chime toggle, can it be SEEN and CLICKED with the list at its top and scrolled to its
// bottom (four rows pass the panel's height ceiling, so the list scrolls), and does pressing it
// reach main as `pill:dismiss-all` with no arguments? Ends with one PASS or FAIL line.
//
// History: first written for a foot under the last row, where it found the button scrolled out
// of reach; the foot was made sticky. Then the button moved beside the chime toggle, whose row
// it found scrolled out of reach after 21 px; that row is now sticky instead.
//
//   npm run build            (or: npx electron-vite build --outDir <dir>, and pass <dir>)
//   npx electron scripts/pill-dismiss-all-recon.cjs [build dir, default "out"] [png dir]
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT SHOWS A SMALL WINDOW AT THE BOTTOM RIGHT for a few seconds. It does NOT move the pointer or
// type: the button is pressed with a DOM click(), which proves the page -> preload -> main wiring
// and nothing about a physical click on a window that cannot take focus. That part was measured
// for row buttons by scripts/pill-render-recon.cjs (M23) and is left to the live checklist.
//
// It plays main's part of the height round trip (pill:height -> resize), as main.ts does.

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

const VIEW = {
  mode: "running",
  label: "1 running · 1 didn't finish · 2 done",
  pulse: false,
  expanded: true,
  muted: false,
  notice: null,
  dismissAll: true,
  items: [
    { id: "job-failed", title: "file this bug in Linear", state: "failed", detail: "Linear said no.", actions: ["dismiss"] },
    { id: "job-running", title: "summarize these notes", state: "running", detail: "Running — summarize", actions: ["cancel"] },
    { id: "job-done-1", title: "summarize the thread", state: "done", detail: "A short summary of the thread.", actions: ["dismiss"] },
    { id: "job-done-2", title: "what's on today", state: "done", detail: "Two meetings: 10:00 and 15:30.", actions: ["dismiss"] },
    // Six rows, so the list is sure to pass the 440 px ceiling and scroll: four came to exactly
    // 440 once the button left the foot, and a list that does not scroll proves nothing here.
    { id: "job-done-3", title: "recall the wifi password", state: "done", detail: "It's on the fridge.", actions: ["dismiss"] },
    { id: "job-expired", title: "post the notes to #fun", state: "expired", detail: "Expired — nobody answered, so it was not run.", actions: ["dismiss"] },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const preload = join(buildDir, "preload", "pill.js");
  const page = join(buildDir, "renderer", "pill.html");
  if (!existsSync(preload) || !existsSync(page)) {
    console.log(`[recon] no build at ${buildDir} (need preload/pill.js and renderer/pill.html) - run npm run build`);
    app.exit(1);
    return;
  }

  const received = [];
  let height = null;
  ipcMain.on("pill:dismiss-all", (_e, ...args) => received.push(`dismiss-all(${args.length} args)`));
  ipcMain.on("pill:action", (_e, id, action) => received.push(`action(${id}, ${action})`));
  ipcMain.on("pill:height", (_e, h) => (height = h));

  const { workArea } = screen.getPrimaryDisplay();
  const place = (win, width, h) =>
    win.setBounds({ x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - h - 16, width, height: h });

  const win = new BrowserWindow({
    ...PILL_WINDOW_OPTIONS,
    width: 348,
    height: 440,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  win.setContentProtection(true);
  await win.loadFile(page);
  const dom = (js) => win.webContents.executeJavaScript(js);

  place(win, 348, 440);
  win.webContents.send("pill:view", VIEW);
  win.showInactive();
  for (let waited = 0; height === null && waited < 2_000; waited += 50) await sleep(50);
  console.log(`[recon] page measured the open list at ${height} px`);
  if (height !== null) {
    place(win, 348, Math.min(440, height));
    win.webContents.send("pill:view", { ...VIEW, contentHeight: height });
    await sleep(400);
  }

  // Can each button be SEEN and CLICKED where it is? Visible means inside the list's own box,
  // which clips what it scrolls, not merely inside the window: a button scrolled out of the list
  // is still "in" the window. Clickable means a click at its centre is delivered to it, not to
  // a row scrolled over it. Asked at the top of the list and again scrolled to the bottom.
  const reach = (selector) =>
    dom(`(() => {
      const list = document.querySelector('.list'), button = document.querySelector(${JSON.stringify(selector)});
      if (button === null) return { present: false, visible: false, hit: false };
      const b = button.getBoundingClientRect(), l = list.getBoundingClientRect();
      const visible = b.top >= l.top && b.bottom <= l.bottom && b.left >= l.left && b.right <= l.right;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === button;
      return { present: true, visible, hit };
    })()`);
  const scrollTo = (where) =>
    dom(`(() => { const l = document.querySelector('.list'); l.scrollTop = ${where === "bottom" ? "l.scrollHeight" : "0"}; return l.scrollTop; })()`);

  const layout = await dom(`(() => {
    const list = document.querySelector('.list'), button = document.querySelector('.dismiss-all'), mute = document.querySelector('.mute');
    return {
      sameRowAsChime: button !== null && mute !== null && button.closest('.header') !== null && button.closest('.header') === mute.closest('.header'),
      listScrolls: list.scrollHeight > list.clientHeight,
      buttons: [...document.querySelectorAll('button')].map((n) => n.textContent),
    };
  })()`);
  console.log(`[recon] window ${JSON.stringify(win.getBounds())}  list scrolls: ${layout.listScrolls}`);
  console.log(`[recon] "Dismiss all" in the same row as the chime toggle: ${layout.sameRowAsChime}`);
  console.log(`[recon] every button drawn: ${JSON.stringify(layout.buttons)}`);
  let reachable = layout.listScrolls;
  for (const where of ["top", "bottom"]) {
    const scrolled = await scrollTo(where);
    await sleep(150);
    for (const selector of [".mute", ".dismiss-all"]) {
      const r = await reach(selector);
      if (selector === ".dismiss-all") reachable = reachable && r.present && r.visible && r.hit;
      console.log(`[recon] scrolled to the ${where} (scrollTop ${scrolled}): ${selector} visible=${r.visible} click-at-centre-hits-it=${r.hit}`);
    }
    if (pngDir !== null) writeFileSync(join(pngDir, `pill-dismiss-all-${where}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log(`[recon] ${reachable ? "PASS" : "FAIL"}: "Dismiss all" visible and clickable with the list at its top AND scrolled to its bottom${layout.listScrolls ? "" : " (the list did not scroll, so this proves nothing)"}`);

  await dom(`document.querySelector('.dismiss-all').click()`);
  await sleep(300);
  console.log(`[recon] after pressing it, main received: ${JSON.stringify(received)}`);

  // Not offered: no button.
  win.webContents.send("pill:view", { ...VIEW, dismissAll: undefined });
  await sleep(300);
  console.log(`[recon] view without dismissAll: button present = ${await dom("document.querySelector('.dismiss-all') !== null")}`);
  app.exit(0);
});
