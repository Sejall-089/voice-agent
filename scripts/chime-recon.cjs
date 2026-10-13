// M23 reconnaissance: does a sound play from the command bar's window while it is HIDDEN?
//
//   npx electron scripts/chime-recon.cjs
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT PLAYS THE CHIME OUT LOUD, three times, about five seconds in all. Nothing is shown.
//
// WHY THIS EXISTS. The needs-you chime is played by the bar's renderer, on its own `Audio`
// element — and at the moment a job starts waiting, the bar is almost always hidden. Speech
// already plays from that hidden window (M14), which is evidence but not proof for a second
// element: whether an `Audio` created in a window that has NEVER been shown, with no user
// gesture, actually starts, runs to its end and reports `ended` is something Chromium decides.
// A fixture written from the assumption would pass every test.
//
// It builds a window with main.ts's options that matter to audio (never shown,
// backgroundThrottling off) under the same autoplay switch, and asks three things:
//
//   1. does `play()` resolve, and does `ended` fire, in a window that was never shown?
//   2. does a SECOND element play while a first is still playing (the chime beside speech)?
//      Neither may cut the other off — that is the reason the chime has its own element.
//   3. does `pause()` on one leave the other playing? (barge-in stops speech, not a chime
//      already half over — and the reverse.)
//
// WHAT IT CANNOT SHOW: that sound came out of the speaker. `ended` and an advancing
// `currentTime` say Chromium's pipeline ran; only a person can say they heard it.
//
// What it measured on 2026-10-13 (this machine, Electron 33): see the M23 entry in spec.md §9.

const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// main.ts sets this at startup for the same reason: nothing here is triggered by a click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const wav = readFileSync(join(__dirname, "../src/renderer/assets/needs-you.wav"));
const dataUrl = `data:audio/wav;base64,${wav.toString("base64")}`;

// Runs in the page. Plays `url` on a fresh element and reports what happened to it.
const PLAY = `
  window.playOne = (url, label) => new Promise((resolve) => {
    const audio = new Audio(url);
    const started = performance.now();
    const report = (how) => resolve({
      label, how,
      ms: Math.round(performance.now() - started),
      currentTime: Number(audio.currentTime.toFixed(3)),
      duration: Number((audio.duration || 0).toFixed(3)),
    });
    audio.onended = () => report("ended");
    audio.onerror = () => report("error");
    audio.play().then(() => { window.live = window.live || {}; window.live[label] = audio; },
                      (error) => report("play() rejected: " + error.message));
    setTimeout(() => report("TIMED OUT (never ended)"), 4000);
  });
  true; // the script's value crosses IPC, and a function cannot
`;

app.whenReady().then(async () => {
  const bar = new BrowserWindow({
    width: 640,
    height: 640,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await bar.loadURL("data:text/html,<body>hidden bar</body>");
  await bar.webContents.executeJavaScript(PLAY);
  const run = (js) => bar.webContents.executeJavaScript(js);
  const url = JSON.stringify(dataUrl);

  console.log(`[recon] window visible: ${bar.isVisible()} (must be false throughout)`);

  const one = await run(`window.playOne(${url}, "alone")`);
  console.log(`[recon] 1. one element, never-shown window:   ${JSON.stringify(one)}`);

  const two = await run(
    `Promise.all([window.playOne(${url}, "first"), new Promise(r => setTimeout(r, 120)).then(() => window.playOne(${url}, "second"))])`,
  );
  console.log(`[recon] 2. two elements overlapping:           ${JSON.stringify(two)}`);

  const three = await run(`
    (async () => {
      const a = window.playOne(${url}, "paused-one");
      const b = window.playOne(${url}, "other");
      await new Promise(r => setTimeout(r, 100));
      window.live["paused-one"].pause();
      const other = await b;
      const pausedAt = Number(window.live["paused-one"].currentTime.toFixed(3));
      return { other, pausedOneStoppedAt: pausedAt };
    })()
  `);
  console.log(`[recon] 3. pause one, the other keeps going:   ${JSON.stringify(three)}`);

  console.log(`[recon] window visible at the end: ${bar.isVisible()}`);
  app.exit(0);
});
