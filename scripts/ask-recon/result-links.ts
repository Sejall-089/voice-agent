// Recon: links in the result bar, on a REAL window — what is drawn, what a click does, and
// whether the bar can be made to navigate.
//
//   node scripts/ask-recon/run.mjs result-links
//
// !! FLASHES A WINDOW for about six seconds. It sends NO keystrokes through the OS (the click
// !! and the Enter are delivered straight to its own window) and it OPENS NOTHING: the one call
// !! that would reach your browser is replaced by a recorder. No API calls.
//
// WHY THIS EXISTS. tests/resultLinks.test.ts pins which URLs are links, the jsdom test pins
// what the component renders, and tests/WindowsShell.capture.test.ts pins what main does with
// what it is sent. Three things remain that only Electron itself can show (CLAUDE.md: a log
// line proves what the app decided, not what the user saw):
//
//   1. the BUILT renderer really draws the links, and a real mouse click on one — at its real
//      position on screen — reaches main as that URL and no other
//   2. Enter on a focused link does the same, once
//   3. the window REFUSES to navigate or open another window when the page itself tries —
//      `will-navigate` + `setWindowOpenHandler` are Electron behaviour, and a fake that calls
//      `preventDefault()` proves only that we called it
//
// Measured 2026-10-10: see the checks printed at the end; all held.
import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { WindowsShell } from "../../src/main/shell/WindowsShell.ts";
import type { LocalAction } from "../../src/main/shell/OSShell.ts";

const REPO = process.argv[process.argv.length - 1] as string;
const GITHUB = "https://github.com/Sejall-089/throwaway_repo/issues/3";
const LINEAR = "https://linear.app/sejal/issue/SEJ-7/login-button-does-nothing";
const RESULT = [
  "Created #3: <b>not bold</b> M20 live test",
  GITHUB,
  "SEJ-7: Login button does nothing (Todo)",
  LINEAR,
  "not links, any of these:",
  "https://github.com.evil.com/Sejall-089/x/issues/3",
  "http://github.com/Sejall-089/x/issues/3",
  "https://user@github.com/x",
  "javascript:alert(1)",
].join("\n");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

setTimeout(() => {
  console.log("\nRESULT  watchdog: gave up and exited");
  app.exit(3);
}, 40_000);

// The real shell, with the ONE call that leaves the app recorded instead of made. Everything
// before it — the IPC handler, the re-validation — is the real code.
const opened: string[] = [];
class RecordingShell extends WindowsShell {
  override executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }> {
    if (action.kind === "openUrl") {
      opened.push(action.payload);
      return Promise.resolve({ ok: true });
    }
    return super.executeAction(action);
  }
}

void app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    x: Math.round(workArea.x + (workArea.width - 640) / 2),
    y: Math.round(workArea.y + (workArea.height - 640) / 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(REPO, "out/preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const shell = new RecordingShell(win);
  const windowsBefore = BrowserWindow.getAllWindows().length;

  await win.loadFile(join(REPO, "out/renderer/index.html"));
  const home = win.webContents.getURL();
  await wait(300);

  shell.showResult(RESULT);
  await wait(500);

  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const links = await js<{ href: string; text: string; x: number; y: number }[]>(
    `[...document.querySelectorAll('.command-echo a')].map((a) => {
       const r = a.getBoundingClientRect();
       return { href: a.getAttribute('href'), text: a.textContent, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })`,
  );
  const rendered = await js<{ text: string; bold: number }>(
    `({ text: document.querySelector('.command-echo').textContent, bold: document.querySelectorAll('.command-echo b').length })`,
  );

  const checks: [string, boolean, string][] = [];
  const check = (label: string, ok: boolean, detail = ""): void => void checks.push([label, ok, detail]);

  check("exactly the two allowed URLs are drawn as links", JSON.stringify(links.map((l) => l.href)) === JSON.stringify([GITHUB, LINEAR]), JSON.stringify(links.map((l) => l.href)));
  check("each link's text is its URL", links.every((l) => l.text === l.href));
  check("the whole result is still on screen, unaltered", rendered.text === RESULT);
  check("markup in the result is text, not an element", rendered.bold === 0);

  // 1. A real mouse click, at the first link's real position.
  const first = links[0];
  if (first) {
    win.webContents.sendInputEvent({ type: "mouseDown", x: first.x, y: first.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: first.x, y: first.y, button: "left", clickCount: 1 });
  }
  await wait(400);
  check("a click on the first link asks main for that URL, once", JSON.stringify(opened) === JSON.stringify([GITHUB]), JSON.stringify(opened));
  check("the bar did not navigate on the click", win.webContents.getURL() === home);

  // 2. Keyboard: focus the second link, press Enter.
  opened.length = 0;
  const focused = await js<boolean>(
    `(() => { const a = document.querySelectorAll('.command-echo a')[1]; a.focus(); return document.activeElement === a; })()`,
  );
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await wait(400);
  check("a link can take keyboard focus", focused);
  check("Enter on the focused link asks main for that URL, once", JSON.stringify(opened) === JSON.stringify([LINEAR]), JSON.stringify(opened));
  check("the bar did not navigate on Enter", win.webContents.getURL() === home);

  // 3. A middle click on a link is the browser's "open in a new window" — not our handler.
  opened.length = 0;
  if (first) {
    win.webContents.sendInputEvent({ type: "mouseDown", x: first.x, y: first.y, button: "middle", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: first.x, y: first.y, button: "middle", clickCount: 1 });
  }
  await wait(500);
  check("a middle click opens no window and navigates nowhere", BrowserWindow.getAllWindows().length === windowsBefore && win.webContents.getURL() === home);

  // 4. The page itself tries to get out. (This is what a script injected into the bar could do.)
  const popup = await js<boolean>(`window.open('${GITHUB}') === null`);
  await wait(300);
  check("window.open is denied — even for an allowed URL", popup && BrowserWindow.getAllWindows().length === windowsBefore);

  await js<void>(`void (window.location.href = 'https://example.com/')`);
  await wait(800);
  check("setting location.href does not navigate the bar", win.webContents.getURL() === home, win.webContents.getURL());

  // 5. The bridge, called directly with URLs the renderer would never have drawn as links.
  opened.length = 0;
  await js<void>(
    `(() => { for (const u of ['https://github.com.evil.com/x', 'http://github.com/x', 'https://user@github.com/x', 'javascript:alert(1)', 'file:///C:/x', ' ${GITHUB}'])
       window.api.openResultLink(u); })()`,
  );
  await wait(400);
  check("main opens nothing for bad URLs sent through the bridge directly", opened.length === 0, JSON.stringify(opened));

  // 6. And the page reloading itself still works (the dev server's hot reload).
  const reloaded = new Promise<boolean>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  await js<void>(`void window.location.reload()`);
  check("the page can still reload itself", await reloaded);

  console.log("");
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — got ${detail}`}`);
  const all = checks.every(([, ok]) => ok);
  console.log(`\nRESULT  ${all ? "all checks held" : "SOMETHING DID NOT HOLD"}`);
  app.exit(all ? 0 : 1);
});
