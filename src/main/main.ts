import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, screen, session } from "electron";
import { WindowsShell } from "./shell/WindowsShell.ts";
import { VoiceSession } from "./shell/VoiceSession.ts";
import { Planner } from "../core/planner.ts";
import { registry } from "../core/registry.ts";
import { createLLMClient } from "../core/llm/factory.ts";
import { createDatabase } from "../core/memory/db.ts";
import { SqliteMemory } from "../core/memory/SqliteMemory.ts";
import { SlackSender } from "../core/senders/SlackSender.ts";
import {
  UnavailableTranscriber,
  WhisperCppTranscriber,
} from "../core/transcribers/WhisperCppTranscriber.ts";
import type { Transcriber } from "../core/types.ts";

// M0: global hotkey opens a command bar that echoes typed text and closes.
// Kept in one constant so the combo is trivial to change (spec.md §2).
const HOTKEY = "CommandOrControl+Shift+Space";
// M7: tap once to start dictating, tap again to stop. Distinct from HOTKEY — this one is
// a toggle, and both would fight over the same press.
//
// A list, not a constant, because global shortcuts are first-come-first-served across the
// whole OS: Ctrl+Alt+Space is taken by the Microsoft IME on some Windows installs, and a
// hotkey that silently never fires is the worst possible failure. We take the first combo
// the OS actually grants and say which one it was. VOICE_HOTKEY in .env overrides the list.
const VOICE_HOTKEYS = [
  "CommandOrControl+Alt+Space",
  "CommandOrControl+Alt+M",
  "CommandOrControl+Shift+M",
  "Alt+Shift+Space",
];

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
  // background waiting for the next hotkey press. The blur handler is wired in
  // app.whenReady() instead, because while a recording is live the bar is deliberately
  // unfocused and must NOT hide (the shell decides — see WindowsShell.shouldHideOnBlur).

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

  // Voice capture runs in the renderer, so the window needs the media permission. Grant
  // ONLY that one — everything else stays denied by default.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "media");
  });

  // The bar hides on blur, EXCEPT while a recording is live — it's unfocused on purpose
  // then, and hiding would take the recording indicator with it.
  commandBar.on("blur", () => {
    if (shell.shouldHideOnBlur()) commandBar?.hide();
  });

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

  // THE planner call site. Typed text and dictated text both funnel through here, so the
  // planner cannot tell them apart and voice needs no changes anywhere in /core.
  const runInstruction = async (instruction: string): Promise<void> => {
    if (instruction.trim().length === 0) return;
    await planner.run(instruction); // planner captures context, plans, and shows the result
  };

  shell.registerHotkey(HOTKEY, () => {
    void (async () => {
      await runInstruction(await shell.showInput());
    })();
  });

  // M7: the same instruction, spoken. VoiceSession owns the toggle state; it hands the
  // finished transcript to the exact callback above.
  const voice = new VoiceSession(shell, createTranscriber(), runInstruction);
  const voiceHotkey = registerVoiceHotkey(shell, () => void voice.toggle());
  shell.setVoiceHotkeyLabel(voiceHotkey);
  shell.onCancelRequested(() => void voice.cancel());

  console.log(
    `[main] ready - ${HOTKEY} to type, ${voiceHotkey ?? "(no free hotkey)"} to dictate`,
  );
});

// Claim the first voice combo the OS will actually grant. Returns null if every candidate
// is taken — in which case typed commands still work and the log says why voice doesn't.
function registerVoiceHotkey(shell: WindowsShell, onTrigger: () => void): string | null {
  const configured = process.env["VOICE_HOTKEY"];
  const candidates = configured ? [configured] : VOICE_HOTKEYS;

  for (const combo of candidates) {
    if (shell.registerHotkey(combo, onTrigger)) {
      if (combo !== candidates[0]) {
        console.log(`[main] voice hotkey fell back to ${combo} - earlier choices were taken`);
      }
      return combo;
    }
  }

  console.error(
    `[main] voice hotkey unavailable - all of ${candidates.join(", ")} are already in use. ` +
      `Set VOICE_HOTKEY in .env to a free combo.`,
  );
  return null;
}

// Secrets and paths are read HERE, in composition — /core never touches process.env.
// Missing config is not fatal: the app still runs typed commands, and the first voice
// attempt explains exactly what to set.
function createTranscriber(): Transcriber {
  const exePath = process.env["WHISPER_EXE_PATH"];
  const modelPath = process.env["WHISPER_MODEL_PATH"];
  if (!exePath || !modelPath) {
    console.log("[main] voice disabled - WHISPER_EXE_PATH / WHISPER_MODEL_PATH not set");
    return new UnavailableTranscriber();
  }
  return new WhisperCppTranscriber({
    exePath,
    modelPath,
    language: process.env["WHISPER_LANGUAGE"] ?? "en",
  });
}

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
