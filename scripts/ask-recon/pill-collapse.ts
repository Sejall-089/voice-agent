// The status pill in a REAL window, driven by the app's REAL pill controller, pill window,
// job manager and instruction-hotkey handler: does the list always start collapsed, does it
// close when it should, and is a long failure message drawn whole?
//
//   npm run build
//   node scripts/ask-recon/run.mjs pill-collapse [png dir]
//
// !! IT MOVES THE REAL MOUSE POINTER AND CLICKS, on a small window it shows at the bottom
// !! right of the screen, for about 45 seconds. Do not touch the mouse while it runs. It sends
// !! no keystrokes, makes no API calls, and approves nothing: no tool exists in it to run.
//
// WHY THIS EXISTS. Found live: after one click on the pill the job list stayed open for that
// instruction and every later one. tests/pill.collapse.test.ts pins the rule on the reducer,
// the controller and the hotkey wiring — against a FAKE window. What a fake cannot say:
//   - that a real click on the real page reaches main as "expand", and a hotkey press then
//     puts a collapsed pill on screen;
//   - that `mouseleave` arrives from a window that cannot take focus, and the list closes
//     about ten seconds later, and that coming back cancels it;
//   - that a long failure message is drawn WHOLE — wrapped, not clipped mid-word, with no
//     scrollbar for one job — and that the window grows to fit it without its bottom-right
//     corner moving.
//
// "The hotkey" here is the app's own `createOnInstructionHotkey` handler, called directly,
// with main.ts's own `startingSomethingElse` as its detach hook — the real wiring, minus the
// OS delivering the key (scripts/ask-recon/hotkey-during-question covers that delivery).
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobManager } from "../../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../../src/core/jobs/JobStore.ts";
import { PILL_COLLAPSED, PILL_MARGIN } from "../../src/core/jobs/pill.ts";
import { InMemorySettings } from "../../src/core/settings.ts";
import { createOnInstructionHotkey } from "../../src/main/instructionHotkey.ts";
import { createStartingSomethingElse } from "../../src/main/jobs/startingSomethingElse.ts";
import { PillController } from "../../src/main/pill/PillController.ts";
import { PillWindow } from "../../src/main/pill/PillWindow.ts";

const args = process.argv.slice(2);
const repo = args[args.length - 1] ?? process.cwd();
const pngDir = args.length > 1 && args[0] !== undefined ? resolve(args[0]) : null;
// Where the built page and preload are: out/, or BUILD_DIR (see run.mjs).
const buildDir = process.env["BUILD_DIR"] ?? join(repo, "out");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => console.log(`[recon] ${line}`);

// One real left click at (X, Y), or just a move there. PowerShell is not DPI-aware, so these
// are DIP — measured by scripts/pill-click-recon.cjs on this machine.
const MOUSE = String.raw`
param([int]$X, [int]$Y, [int]$Click)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][M]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 150
if ($Click -eq 1) {
  [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 150
}
`;
const scratch = mkdtempSync(join(tmpdir(), "va-pillcollapse-"));
writeFileSync(join(scratch, "mouse.ps1"), MOUSE);
const mouse = (x: number, y: number, click: boolean): void => {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scratch, "mouse.ps1"), String(Math.round(x)), String(Math.round(y)), click ? "1" : "0"],
    { encoding: "utf8" },
  );
};

// A failure message of the kind the live run clipped: a stopped two-step chain.
const LONG_FAILURE =
  "Could not confirm the message to #fun. It may have been sent. Check Slack before trying " +
  "again. I'd already done step 1 of 2 (create the GitHub issue \"Body format\"), but step 2 " +
  "didn't finish.";

void app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const anchor = { right: workArea.x + workArea.width - PILL_MARGIN, bottom: workArea.y + workArea.height - PILL_MARGIN };
  const manager = new JobManager({ store: new InMemoryJobStore() });

  // main.ts's own construction of the pill, over the built page and preload.
  const pill = new PillWindow<BrowserWindow>({
    create: (options) =>
      new BrowserWindow({
        ...options,
        ...PILL_COLLAPSED,
        webPreferences: { preload: join(buildDir, "preload/pill.js"), contextIsolation: true, nodeIntegration: false },
      }),
    load: (win) => win.loadFile(join(buildDir, "renderer/pill.html")),
    workArea: () => screen.getPrimaryDisplay().workArea,
  });
  const controller = new PillController({
    manager,
    settings: new InMemorySettings(),
    surface: pill,
    playChime: () => undefined, // silent: this script is about what is drawn
    isBusy: () => false,
    pointerOver: () => {
      const win = pill.window();
      if (win === null || !win.isVisible()) return null;
      const point = screen.getCursorScreenPoint();
      const b = win.getBounds();
      return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    },
  });
  const fromPill = (event: Electron.IpcMainEvent): boolean => event.sender === pill.window()?.webContents;
  const received: string[] = [];
  ipcMain.on("pill:action", (event, id: unknown, action: unknown) => { if (fromPill(event)) controller.onAction(id, action); });
  ipcMain.on("pill:expand", (event, expanded: unknown) => { received.push(`expand(${String(expanded)})`); if (fromPill(event)) controller.onExpand(expanded); });
  ipcMain.on("pill:mute", (event, muted: unknown) => { if (fromPill(event)) controller.onMute(muted); });
  ipcMain.on("pill:hover", (event, inside: unknown) => { received.push(`hover(${String(inside)})`); if (fromPill(event)) controller.onHover(inside); });
  ipcMain.on("pill:height", (event, height: unknown) => { received.push(`height(${String(height)})`); if (fromPill(event)) controller.onContentHeight(height); });
  const timer = setInterval(() => controller.tick(), 1_000);

  // The real hotkey handler, wired as main.ts wires it.
  const shown: string[] = [];
  const onHotkey = createOnInstructionHotkey({
    shell: {
      isConfirmPending: () => false,
      isAskPending: () => false,
      focusAsk: () => undefined,
      narrate: () => undefined,
      showInput: () => { shown.push("bar opened"); return new Promise<string>(() => undefined); },
      clearPointer: () => undefined,
      snapshotPointTarget: () => Promise.resolve(),
    },
    dictation: null,
    voice: null,
    speech: null,
    chain: { isRunning: () => manager.attachedBlocks() },
    detach: createStartingSomethingElse({ jobs: manager, pill: () => controller }),
    runInstruction: () => Promise.resolve(),
  });

  const win = (): BrowserWindow => {
    const w = pill.window();
    if (w === null) throw new Error("no pill window");
    return w;
  };
  const dom = <T>(js: string): Promise<T> => win().webContents.executeJavaScript(js) as Promise<T>;
  const state = async (): Promise<string> => {
    const b = win().getBounds();
    const listOpen = await dom<boolean>("document.querySelector('.list') !== null");
    return (
      `expanded=${String(controller.view().expanded)} drawnList=${String(listOpen)} ` +
      `size=${b.width}x${b.height} cornerOffBy=(${b.x + b.width - anchor.right},${b.y + b.height - anchor.bottom}) ` +
      `focused=${String(win().isFocused())}`
    );
  };
  const shot = async (name: string): Promise<void> => {
    if (pngDir === null) return;
    writeFileSync(join(pngDir, `${name}.png`), (await win().webContents.capturePage()).toPNG());
  };
  const centreOf = async (selector: string): Promise<{ x: number; y: number }> => {
    const r = await dom<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    const b = win().getBounds();
    return { x: b.x + r.x, y: b.y + r.y };
  };
  const clickPill = async (): Promise<void> => {
    const at = await centreOf(".summary");
    mouse(at.x, at.y, true);
    await sleep(700);
  };
  const away = (): void => mouse(workArea.x + 200, workArea.y + 200, false);

  // --- One background job that failed with a long message. ---
  const failed = manager.submit("create an issue on github for body format and send these notes to fun channel");
  manager.detachAttached();
  manager.finish(failed, "failed", LONG_FAILURE);
  await sleep(1_500);
  log(`1. a job failed, nobody clicked:        ${await state()}`);
  await shot("collapse-1-collapsed");

  // --- A real click opens it. ---
  await clickPill();
  await sleep(600);
  log(`2. after a real click on the pill:       ${await state()}`);
  const drawn = await dom<{ text: string; clipped: boolean; listScrolls: boolean; sideways: boolean }>(`(() => {
    const d = document.querySelector('.row .detail'); const l = document.querySelector('.list');
    return { text: d.textContent, clipped: d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1,
             listScrolls: l.scrollHeight > l.clientHeight + 1, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  log(`   the long message is drawn WHOLE:      ${String(drawn.text === LONG_FAILURE)} (${drawn.text.length} chars)  clipped=${String(drawn.clipped)}  listNeedsScrollbar=${String(drawn.listScrolls)}  sideways=${String(drawn.sideways)}`);
  // Every line the browser laid the message out in ends at a space or at the end: no word is
  // broken across lines.
  const brokenWords = await dom<string[]>(`(() => {
    const node = document.querySelector('.row .detail').firstChild; const text = node.textContent; const range = document.createRange();
    const broken = []; let lastTop = null;
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const top = Math.round(range.getBoundingClientRect().top);
      if (lastTop !== null && top !== lastTop && text[i - 1] !== ' ' && text[i] !== ' ') broken.push(text.slice(Math.max(0, i - 6), i + 6));
      lastTop = top;
    }
    return broken;
  })()`);
  log(`   words broken across a line:           ${brokenWords.length === 0 ? "none" : JSON.stringify(brokenWords)}`);
  await shot("collapse-2-expanded-long-message");

  // --- The hotkey closes it. ---
  onHotkey();
  await sleep(700);
  log(`3. after the hotkey handler ran:         ${await state()}  (${shown.join(", ") || "bar NOT opened"})`);
  await shot("collapse-3-after-hotkey");

  // --- A job that starts waiting does not open it. ---
  const waiting = manager.submit("send these notes to fun channel");
  const gate = manager.gateFor(waiting);
  await gate.admit({ tools: ["sendMessage"], statusOnly: false });
  manager.detachAttached();
  await gate.enterStep({ tool: "sendMessage", index: 1, total: 1, foregroundOnly: false });
  void gate.beforeConfirm();
  await sleep(900);
  log(`4. a job started waiting (needs-you):    ${await state()}  label=${JSON.stringify(controller.view().label)}`);

  // --- The idle timer: off the list for ten seconds; coming back cancels it. ---
  received.length = 0;
  await clickPill();
  log(`5. opened again by a click:              ${await state()}`);
  away();
  await sleep(5_000);
  log(`   5 s after the pointer left:           ${await state()}`);
  const back = await centreOf(".heading");
  mouse(back.x, back.y, false);
  await sleep(8_000);
  log(`   pointer came back, 8 s more (13 s):   ${await state()}`);
  away();
  await sleep(12_500);
  log(`   pointer left again, 12.5 s later:     ${await state()}`);
  log(`   from the page: ${received.filter((r) => r.startsWith("hover")).join(" ")}`);
  await shot("collapse-5-after-idle");

  // --- A row's button closes it. ---
  await clickPill();
  const dismiss = await centreOf(".action-dismiss");
  mouse(dismiss.x, dismiss.y, true);
  await sleep(700);
  log(`6. after a real click on "Dismiss":      ${await state()}  label=${JSON.stringify(controller.view().label)}`);

  clearInterval(timer);
  away();
  rmSync(scratch, { recursive: true, force: true });
  pill.dispose();
  app.exit(0);
});
