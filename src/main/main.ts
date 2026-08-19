import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, screen, session } from "electron";
import { WindowsShell } from "./shell/WindowsShell.ts";
import { VoiceSession } from "./shell/VoiceSession.ts";
import { createRunInstruction } from "./runInstruction.ts";
import { Planner } from "../core/planner.ts";
import { buildRegistry } from "../core/registry.ts";
import { createLLMClient } from "../core/llm/factory.ts";
import { createDatabase } from "../core/memory/db.ts";
import { SqliteMemory } from "../core/memory/SqliteMemory.ts";
import { SlackSender } from "../core/senders/SlackSender.ts";
import { WhisperCppTranscriber } from "../core/transcribers/WhisperCppTranscriber.ts";
import { ChromeGmail } from "../core/gmail/ChromeGmail.ts";
import { UnavailableGmail } from "../core/gmail/UnavailableGmail.ts";
import { InMemoryDraftStore } from "../core/draft.ts";
import type { GmailSurface, Transcriber } from "../core/types.ts";

// ONE hotkey (M8). It opens the command bar AND starts listening, so you decide whether
// to speak or type *after* the bar is up rather than before. Enter submits either way.
//
// A list, not a constant, because global shortcuts are first-come-first-served across the
// whole OS, and a hotkey that silently never fires is the worst possible failure — this
// actually happened here with Ctrl+Alt+Space (the Microsoft IME owns it). We take the
// first combo the OS grants and say which one it was. HOTKEY in .env overrides the list.
const HOTKEYS = [
  "CommandOrControl+Shift+Space",
  "CommandOrControl+Alt+Space",
  "CommandOrControl+Alt+M",
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

  // Clicking away dismisses the bar. The shell decides (and cleans up the in-flight
  // capture); main.ts just forwards the event.
  commandBar.on("blur", () => shell.handleBlur());

  // Compose the core brain. The planner drives the loop; it only knows the interfaces,
  // never electron or the concrete LLM client directly.
  //
  // The DB path is decided HERE and injected — /core never asks electron where it lives.
  const llm = createLLMClient();
  const memory = new SqliteMemory(createDatabase(join(app.getPath("userData"), "memory.db")));
  seedIfEmpty(memory);
  // Secrets are read HERE, in composition — /core never touches process.env. Never log the URL.
  const sender = new SlackSender(process.env["SLACK_WEBHOOK_URL"]);
  // M10: the Gmail tools are only on the menu when there is a Chrome to drive. A capability the
  // app cannot exercise is never offered to the model in the first place.
  const gmail = createGmail();
  const tools = buildRegistry({ gmail: gmail !== null });
  // The draft being iterated on. One per app run, in memory only — a draft is scratch state,
  // not a fact about the user, so it deliberately never reaches SQLite.
  const draft = new InMemoryDraftStore();
  // SqliteMemory is both the resolver and the action log.
  const planner = new Planner(
    llm,
    shell,
    tools,
    memory,
    memory,
    sender,
    gmail ?? new UnavailableGmail(),
    draft,
  );

  // THE planner call site. Typed text and dictated text both funnel through here, so the
  // planner cannot tell them apart and voice needs no changes anywhere in /core.
  const runInstruction = createRunInstruction(planner, shell);

  // M8: voice is only wired up when it can actually work. No transcriber means the bar
  // never opens the microphone and Enter on an empty bar does nothing — exactly as before
  // voice existed.
  const transcriber = createTranscriber();
  const voice = transcriber ? new VoiceSession(shell, transcriber) : null;

  // One hotkey: open the bar and start listening at the same moment.
  const onHotkey = (): void => {
    void (async () => {
      const typed = shell.showInput(); // resolves on Enter/Escape with whatever was typed
      void voice?.begin(); // ...and it is already listening

      const text = await typed;
      // Nothing typed means you dictated, and Enter was the "stop talking" gesture. If you
      // typed (or dismissed the bar), the session was already abandoned and answers "".
      const instruction = text.trim().length > 0 ? text : ((await voice?.finish()) ?? "");

      await runInstruction(instruction);
    })();
  };
  const hotkey = registerHotkey(shell, onHotkey);

  // Typing, or dismissing the bar, silently discards the recording. Both are "I did not
  // mean to dictate", and neither should ever produce a stray transcript.
  shell.onTypingStarted(() => void voice?.abandon());
  shell.onDismissed(() => void voice?.abandon());

  console.log(
    `[main] ready - ${hotkey ?? "(no free hotkey)"} opens the bar${voice ? " and starts listening" : " (voice off)"}`,
  );
});

// Claim the first combo the OS will actually grant. Returns null if every candidate is
// taken — the app still runs, and the log says exactly why nothing responds.
function registerHotkey(shell: WindowsShell, onTrigger: () => void): string | null {
  const configured = process.env["HOTKEY"];
  const candidates = configured ? [configured] : HOTKEYS;

  for (const combo of candidates) {
    if (shell.registerHotkey(combo, onTrigger)) {
      if (combo !== candidates[0]) {
        console.log(`[main] hotkey fell back to ${combo} - earlier choices were taken`);
      }
      return combo;
    }
  }

  console.error(
    `[main] no hotkey available - all of ${candidates.join(", ")} are already in use. ` +
      `Set HOTKEY in .env to a free combo.`,
  );
  return null;
}

// Secrets and paths are read HERE, in composition — /core never touches process.env.
// Missing config is not fatal: the app still runs typed commands, and the first voice
// attempt explains exactly what to set.
function createTranscriber(): Transcriber | null {
  const exePath = process.env["WHISPER_EXE_PATH"];
  const modelPath = process.env["WHISPER_MODEL_PATH"];
  if (!exePath || !modelPath) {
    console.log("[main] voice disabled - WHISPER_EXE_PATH / WHISPER_MODEL_PATH not set");
    return null;
  }
  return new WhisperCppTranscriber({
    exePath,
    modelPath,
    language: process.env["WHISPER_LANGUAGE"] ?? "en",
  });
}

// Same shape as createTranscriber: config is read HERE, in composition, and a missing value
// disables one capability rather than breaking the app. Chrome has to be started with
// --remote-debugging-port AND a dedicated --user-data-dir (Chrome 136+ refuses the port on the
// default profile), which is why this is opt-in rather than assumed.
function createGmail(): GmailSurface | null {
  const baseUrl = process.env["CHROME_DEBUG_URL"];
  if (!baseUrl) {
    console.log("[main] Gmail reply tools disabled - CHROME_DEBUG_URL not set");
    return null;
  }
  return new ChromeGmail({ baseUrl });
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
