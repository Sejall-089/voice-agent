// The command bar's text box in a REAL window: does a long instruction wrap, grow to about
// four lines, then scroll vertically — and never sideways?
//
//   npm run build
//   npx electron scripts/bar-wrap-recon.cjs [build dir, default "out"] [png dir]
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT SHOWS THE COMMAND BAR for a few seconds and types into it. The text goes in through
// Chromium's own input pipeline (`webContents.insertText`, which is what a keyboard or a paste
// produces) — no global keystrokes are sent and the mouse is not touched. Nothing is submitted
// to anything: main is a recorder here.
//
// WHY THIS EXISTS. The box was a single-line <input>; a long instruction scrolled sideways out
// of view and the user could not read back what they had asked for. It is a textarea now, and
// src/renderer/CommandBar.test.tsx checks what it holds and what Enter does — in jsdom, which
// does no layout: every height there is 0. Whether text WRAPS is a fact about a rendered
// window, so it is measured in one (CLAUDE.md).
//
// It uses the built output (the real index.html, bundle, stylesheet and preload) in a window
// with main.ts's command-bar options. With a png dir it saves a screenshot of each state.

const { app, BrowserWindow, ipcMain } = require("electron");
const { existsSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const buildDir = resolve(process.argv[2] ?? "out");
const pngDir = process.argv[3] ? resolve(process.argv[3]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE = "create an issue on github for body format and send these notes to fun channel";
const VERY_LONG = Array(9).fill(LIVE).join(" and then ");
const UNBROKEN = "https://example.com/" + "averyveryverylongpathsegmentwithnospaces".repeat(8);

app.whenReady().then(async () => {
  const preload = join(buildDir, "preload", "preload.js");
  const page = join(buildDir, "renderer", "index.html");
  if (!existsSync(preload) || !existsSync(page)) {
    console.log(`[recon] no build at ${buildDir} - run npm run build`);
    app.exit(1);
    return;
  }
  const submitted = [];
  ipcMain.on("commandbar:submit", (_e, text) => submitted.push(text));
  ipcMain.on("commandbar:typing", () => undefined);
  ipcMain.on("commandbar:close", () => undefined);

  // main.ts's createCommandBar(), where it matters to layout.
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(page);
  win.show();
  win.focus();
  win.webContents.send("commandbar:show");
  await sleep(500);

  const dom = (js) => win.webContents.executeJavaScript(js);
  const measure = () =>
    dom(`(() => {
      const box = document.querySelector('.command-input');
      const style = getComputedStyle(box);
      const line = parseFloat(style.lineHeight);
      return {
        tag: box.tagName,
        chars: box.value.length,
        hasNewline: /[\\r\\n]/.test(box.value),
        lines: Math.round(box.clientHeight / line * 10) / 10,
        contentLines: Math.round(box.scrollHeight / line * 10) / 10,
        scrollsSideways: box.scrollWidth > box.clientWidth,
        scrollsVertically: box.scrollHeight > box.clientHeight,
        pageOverflowsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
  const shot = async (name) => {
    if (pngDir === null) return;
    writeFileSync(join(pngDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const clear = async () => {
    win.webContents.send("commandbar:show"); // main's own "reset and focus"
    await sleep(250);
  };
  const type = async (text) => {
    await dom("document.querySelector('.command-input').focus()");
    await win.webContents.insertText(text);
    await sleep(350);
  };

  console.log(`[recon] empty:                 ${JSON.stringify(await measure())}`);
  await shot("bar-empty");

  await type("summarize this");
  console.log(`[recon] short instruction:     ${JSON.stringify(await measure())}`);

  await clear();
  await type(LIVE);
  console.log(`[recon] the live instruction:  ${JSON.stringify(await measure())}`);
  await shot("bar-live-instruction");

  await clear();
  await type(VERY_LONG);
  console.log(`[recon] very long (${VERY_LONG.length} chars): ${JSON.stringify(await measure())}`);
  await shot("bar-very-long");

  await clear();
  await type(UNBROKEN);
  console.log(`[recon] one unbroken ${UNBROKEN.length}-char word: ${JSON.stringify(await measure())}`);
  await shot("bar-unbroken");

  await clear();
  await type("line one\nline two\r\nline three");
  console.log(`[recon] pasted with newlines:  ${JSON.stringify(await measure())}  value=${JSON.stringify(await dom("document.querySelector('.command-input').value"))}`);

  // A real Enter and a real Shift+Enter, through Chromium's key pipeline.
  const key = (modifiers) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers });
  };
  key(["shift"]);
  await sleep(250);
  console.log(`[recon] Shift+Enter:           submitted=${JSON.stringify(submitted)}  value=${JSON.stringify(await dom("document.querySelector('.command-input').value"))}`);
  key([]);
  await sleep(250);
  console.log(`[recon] Enter:                 submitted=${JSON.stringify(submitted)}`);

  await clear();
  console.log(`[recon] after reset:           ${JSON.stringify(await measure())}`);
  app.exit(0);
});
