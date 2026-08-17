import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { WindowsShell } from "./shell/WindowsShell.ts";
import { Planner } from "../core/planner.ts";
import { registry } from "../core/registry.ts";
import { createLLMClient } from "../core/llm/factory.ts";
import { createDatabase } from "../core/memory/db.ts";
import { SqliteMemory } from "../core/memory/SqliteMemory.ts";
import { SlackSender } from "../core/senders/SlackSender.ts";

// M0: global hotkey opens a command bar that echoes typed text and closes.
// Kept in one constant so the combo is trivial to change (spec.md §2).
const HOTKEY = "CommandOrControl+Shift+Space";

let commandBar: BrowserWindow | null = null;

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 640;

function createCommandBar(): BrowserWindow {
  // Center explicitly — Electron's default placement for a frameless window isn't
  // reliably centered on Windows, so it can end up hugging the top of the screen.
  // Use workArea (not workAreaSize): it carries the display's x/y origin, which matters
  // on multi-monitor setups where the primary display doesn't start at (0, 0).
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
  const y = Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Hide instead of destroy when it loses focus, so the app keeps living in the
  // background waiting for the next hotkey press.
  win.on("blur", () => win.hide());

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  commandBar = createCommandBar();
  const shell = new WindowsShell(commandBar);

  // Compose the core brain. The planner drives the loop; it only knows the interfaces,
  // never electron or the concrete LLM client directly.
  //
  // The DB path is decided HERE and injected — /core never asks electron where it lives.
  const llm = createLLMClient();
  const memory = new SqliteMemory(createDatabase(join(app.getPath("userData"), "memory.db")));
  seedIfEmpty(memory);
  // Secrets are read HERE, in composition — /core never touches process.env. Never log the URL.
  const sender = new SlackSender(process.env["SLACK_WEBHOOK_URL"]);
  // SqliteMemory is both the resolver and the action log.
  const planner = new Planner(llm, shell, registry, memory, memory, sender);

  shell.registerHotkey(HOTKEY, () => {
    void (async () => {
      const instruction = await shell.showInput();
      if (instruction.trim().length === 0) return;
      await planner.run(instruction); // planner captures context, plans, and shows the result
    })();
  });

  console.log(`[main] ready — press ${HOTKEY} to open the command bar`);
});

// A couple of starter facts so a live "open my dashboard" / "rewrite in my tone" can be
// eyeballed before `remember` (M4) exists. Only runs on a fresh DB; real facts will normally
// arrive via the remember tool.
function seedIfEmpty(memory: SqliteMemory): void {
  if (memory.query("").length > 0) return;
  memory.write("tone", "concise, warm, and direct", { confidence: 0.9, source: "seed" });
  memory.write("target:dashboard", "https://github.com/dashboard", {
    confidence: 0.9,
    source: "seed",
  });
  console.log("[main] seeded starter facts (tone, target:dashboard)");
}

// Headless-style app: no dock/taskbar window, so don't quit when windows close.
app.on("window-all-closed", () => {
  // Intentionally empty: the app lives in the background for the global hotkey.
});

// Release the global hotkey so nothing lingers after the app exits.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
