// M25 reconnaissance: what a window's `blur` looks like, depending on what caused it.
//
//   npx electron scripts/blur-recon.cjs
//
// (Clear ELECTRON_RUN_AS_NODE first if your shell sets it, or this runs as plain node.)
//
// IT FLASHES WINDOWS for about five seconds: a small always-on-top window, a second window that
// takes focus from it, and a message box that closes itself. No keys are sent and the mouse is not
// moved. It does not touch the app or its hotkeys, so the app can stay running.
//
// WHY THIS EXISTS. M25 makes an outside click on a thinking bar detach its job — but a blur is
// also what the bar gets when the app hides it itself (Escape, the auto-hide) and when a confirm
// dialog opens on top of it, and neither of those may detach anything. `WindowsShell.handleBlur`
// tells them apart by whether the window is still VISIBLE when the blur arrives, plus a flag set
// around its own hide(). Whether that works depends on things only Windows and Electron decide:
//
//   1. hide() on a focused window: is there a blur at all — during the hide() call or after it —
//      and is isVisible() already false when it arrives?
//   2. another window taking focus (the outside click): blur, with isVisible() still true?
//   3. a message box parented to the window: does the parent blur, and is it visible then?
//
// The fake window in tests/outsideClick.test.ts copies what this measures; re-run it before
// trusting those tests on a new Electron.

const { app, BrowserWindow, dialog } = require("electron");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const lines = [];
  const bar = new BrowserWindow({ width: 420, height: 160, show: false, alwaysOnTop: true, title: "blur-recon bar" });
  await bar.loadURL("data:text/html,<h3>blur-recon: the bar</h3>");
  let phase = "";
  let insideHide = false;
  bar.on("blur", () => {
    lines.push(`  [${phase}] blur — ${insideHide ? "DURING hide()" : "outside any hide() call"}; isVisible()=${bar.isVisible()}`);
  });
  const focusBar = async () => {
    bar.show();
    bar.focus();
    await sleep(500);
    lines.push(`  (bar shown and focused: isFocused()=${bar.isFocused()})`);
  };

  // 1. The app hides its own focused window.
  phase = "1 own hide";
  await focusBar();
  insideHide = true;
  bar.hide();
  insideHide = false;
  lines.push(`  [${phase}] hide() returned; isVisible()=${bar.isVisible()}`);
  await sleep(600);

  // 2. Another window takes focus — what an outside click does.
  phase = "2 other window";
  await focusBar();
  const other = new BrowserWindow({ width: 320, height: 140, show: false, title: "blur-recon other" });
  await other.loadURL("data:text/html,<h3>blur-recon: another window</h3>");
  other.show();
  other.focus();
  await sleep(600);
  lines.push(`  [${phase}] other focused=${other.isFocused()}, bar visible=${bar.isVisible()}`);
  other.destroy();
  await sleep(300);

  // 3. A message box parented to the bar (how a confirm opens when the bar is not hidden first).
  phase = "3 dialog on bar";
  await focusBar();
  const abort = new AbortController();
  const box = dialog.showMessageBox(bar, { message: "blur-recon", buttons: ["OK"], signal: abort.signal });
  await sleep(800);
  abort.abort();
  await box.catch(() => undefined);
  await sleep(300);

  console.log(`blur-recon (Electron ${process.versions.electron}, ${process.platform}):\n${lines.join("\n")}`);
  bar.destroy();
  app.quit();
});
