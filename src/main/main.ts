import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, screen, session } from "electron";
import { WindowsShell } from "./shell/WindowsShell.ts";
import { VoiceSession } from "./shell/VoiceSession.ts";
import { DictationSession } from "./shell/DictationSession.ts";
import { WindowsInputInjector } from "./shell/WindowsInputInjector.ts";
import { combineInstructionBusy, createOnDictateHotkey } from "./dictate.ts";
import { createRunInstruction } from "./runInstruction.ts";
import { createOnInstructionHotkey } from "./instructionHotkey.ts";
import { Planner } from "../core/planner.ts";
import { buildRegistry } from "../core/registry.ts";
import { createLLMClient } from "../core/llm/factory.ts";
import { createDatabase } from "../core/memory/db.ts";
import { SqliteMemory } from "../core/memory/SqliteMemory.ts";
import { SlackSender } from "../core/senders/SlackSender.ts";
import { WhisperCppTranscriber } from "../core/transcribers/WhisperCppTranscriber.ts";
import { PiperSynthesizer } from "../core/synthesizers/PiperSynthesizer.ts";
import { SpeechSession } from "./shell/SpeechSession.ts";
import { ChromeGmail } from "../core/gmail/ChromeGmail.ts";
import { UnavailableGmail } from "../core/gmail/UnavailableGmail.ts";
import { ChromeNotion } from "../core/notion/ChromeNotion.ts";
import { UnavailableNotion } from "../core/notion/UnavailableNotion.ts";
import { GoogleCalendar } from "../core/calendar/GoogleCalendar.ts";
import { GoogleCalendarAuth } from "../core/calendar/GoogleCalendarAuth.ts";
import { UnavailableCalendar } from "../core/calendar/UnavailableCalendar.ts";
import { WindowsScreen } from "./screen/WindowsScreen.ts";
import { AnthropicMessages } from "../core/vision/AnthropicMessages.ts";
import { AnthropicVisionLocator } from "../core/vision/AnthropicVisionLocator.ts";
import { UnavailableScreen } from "../core/vision/UnavailableScreen.ts";
import { UnavailableVisionLocator } from "../core/vision/UnavailableVisionLocator.ts";
import { InMemoryDraftStore } from "../core/draft.ts";
import type {
  CalendarSurface,
  GmailSurface,
  NotionSurface,
  Transcriber,
  VisionLocator,
} from "../core/types.ts";

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

// The SEPARATE dictation hotkey (M12) — deliberately not part of the HOTKEYS list above and
// deliberately not Space-based, so the two negotiations can never collide with each other.
// Tap to start listening, press Enter to stop and type the transcript into whatever window
// currently has focus, in ANY app — see DictationSession.ts for why this is a two-phase
// begin()/finish() flow rather than the instruction bar's own toggle shape.
//
// Ctrl+M is tried first: a genuine 2-key combo, added after live use flagged the original
// 3-4 key fallbacks as too slow to reach for repeatedly. No conflict found in Chrome, VS
// Code, Word, or Excel — the one asterisk is it sits one letter from the instruction bar's
// own Ctrl+Alt+M fallback, which is a coincidence worth noting, not a technical clash.
//
// Ctrl+Alt+V and Alt+Shift+D were both considered and deliberately excluded, not merely
// deprioritized: Ctrl+Alt+V is Excel's Paste Special, and Alt+Shift+D is Word's insert-date
// field — real, common bindings in exactly the apps dictation is most likely used in, so
// neither belongs on this list even as a last resort. Ctrl+Alt+J is the third candidate: it
// has no default binding in Word/Excel, and in Chrome/VS Code it is unused (Chrome's own
// download/console shortcuts are Ctrl+J and Ctrl+Shift+J, one modifier short of this).
const DICTATE_HOTKEYS = [
  "CommandOrControl+M",
  "CommandOrControl+Shift+Alt+D",
  "CommandOrControl+Alt+D",
  "CommandOrControl+Alt+J",
];
let commandBar: BrowserWindow | null = null;
// Held at module scope so will-quit (below) can release the persistent host process —
// app.whenReady()'s own closure ends long before the app actually quits.
let inputInjector: WindowsInputInjector | null = null;
// Same reason as inputInjector: will-quit's closure is separate from whenReady()'s, so the
// warm Piper process (post-M14 cold-start fix) needs a module-scope handle to be released.
let speechEngine: PiperSynthesizer | null = null;
// And again for the pointing overlay (M15): a transparent always-on-top window that would
// otherwise outlive the app exactly as the input host and the Piper process both once did.
let screenSurface: WindowsScreen | null = null;

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
      // The bar is hidden most of the time, and Chromium throttles timers and media in hidden
      // windows. Speech plays through this window whether or not it is on screen (M14).
      backgroundThrottling: false,
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

// Chromium refuses to play audio that no user gesture asked for. Every utterance this app
// produces is triggered by a hotkey or by the planner finishing, never by a click inside the
// window, so without this the very first thing the app tries to say fails silently.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  commandBar = createCommandBar();

  // M15. The bar is a 640x640 always-on-top window in the middle of the screen, and `pointAt`
  // photographs the screen while it is open — so without this the app would hand the vision
  // model a picture of its own UI sitting on top of whatever the user was asking about.
  //
  // WDA_EXCLUDEFROMCAPTURE via Electron: the window stays visible to the person and vanishes
  // from capture APIs, including our own. scripts/screen-recon.mjs Q3 measured it at 98.4% of a
  // probe window captured unprotected and 0.0% protected, taking effect on the very next frame.
  // Set permanently rather than toggled around each capture, because a permanent setting has no
  // window in which it can be observed in the wrong state.
  commandBar.setContentProtection(true);

  const shell = new WindowsShell(commandBar);

  // Voice capture runs in the renderer, so the window needs the media permission. Grant
  // ONLY that one — everything else stays denied by default.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) => {
      callback(permission === "media");
    },
  );

  // Clicking away dismisses the bar. The shell decides (and cleans up the in-flight
  // capture); main.ts just forwards the event.
  commandBar.on("blur", () => shell.handleBlur());

  // Compose the core brain. The planner drives the loop; it only knows the interfaces,
  // never electron or the concrete LLM client directly.
  //
  // The DB path is decided HERE and injected — /core never asks electron where it lives.
  const llm = createLLMClient();
  const memory = new SqliteMemory(
    createDatabase(join(app.getPath("userData"), "memory.db")),
  );
  seedIfEmpty(memory);
  // Secrets are read HERE, in composition — /core never touches process.env. Never log the URL.
  const sender = new SlackSender(process.env["SLACK_WEBHOOK_URL"]);
  // M10/M11: browser-backed tools are only on the menu when there is a Chrome to drive. A
  // capability the app cannot exercise is never offered to the model in the first place. Both
  // currently gate on the same CHROME_DEBUG_URL — one debug Chrome, two app surfaces in it.
  const gmail = createGmail();
  const notion = createNotion();
  // M13: same idea, a different gate — not a browser to drive but a connected Google account.
  // The check is synchronous and offline (is there a refresh token?), so nothing on the network
  // decides what the model is offered.
  const calendar = createCalendar();
  // M14: same gate shape again — a capability the app cannot exercise is never offered.
  const synthesizer = createSynthesizer();
  speechEngine = synthesizer;
  // M15: the only gate here that is an explicit OPT-IN rather than inferred from config that
  // exists anyway. Every other capability above answers "is there a thing to talk to?" from
  // something set for no other purpose — a debug Chrome, a refresh token, a piper binary. This
  // one cannot: ANTHROPIC_API_KEY is very likely already present for the planner, and its
  // presence must never be read as permission to send a picture of the user's screen anywhere.
  const vision = createVisionLocator();
  // Built only when vision is on, so an install that never opted in has no capture machinery at
  // all — "no screenshot is taken" is a property of the object graph, not of a branch somewhere.
  const screenSurfaceOrNull = vision ? new WindowsScreen() : null;
  screenSurface = screenSurfaceOrNull;
  if (screenSurfaceOrNull) shell.attachPointer(() => screenSurfaceOrNull.clearPointer());
  const tools = buildRegistry({
    gmail: gmail !== null,
    notion: notion !== null,
    calendar: calendar !== null,
    speech: synthesizer !== null,
    // Both halves, or neither. Pointing needs something to capture with AND something to ask.
    vision: vision !== null && screenSurfaceOrNull !== null,
  });
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
    notion ?? new UnavailableNotion(),
    calendar ?? new UnavailableCalendar(),
    undefined, // speech store — the planner's own scratch state, no composition needed
    screenSurfaceOrNull ?? new UnavailableScreen(),
    vision ?? new UnavailableVisionLocator(),
  );

  // The speech queue, wired both ways: the session plays THROUGH the shell, and the shell
  // hands it whatever the planner asks to have said. A failure to speak is narrated on screen
  // rather than logged and forgotten — a speaker that quietly stopped working looks exactly
  // like one that had nothing to say.
  const speech = synthesizer
    ? new SpeechSession(shell, synthesizer, {
        onFailure: (message) => shell.narrate(message),
      })
    : null;
  if (speech) shell.attachSpeech(speech);

  // THE planner call site. Typed text and dictated text both funnel through here, so the
  // planner cannot tell them apart and voice needs no changes anywhere in /core.
  const runInstruction = createRunInstruction(planner, shell);

  // M8: voice is only wired up when it can actually work. No transcriber means the bar
  // never opens the microphone and Enter on an empty bar does nothing — exactly as before
  // voice existed.
  const transcriber = createTranscriber();
  const voice = transcriber ? new VoiceSession(shell, transcriber) : null;

  // M12: dictation needs the same transcriber voice does — no whisper, no dictation either,
  // same "off is a real state" rule as M7/M8. The injector is only constructed alongside it,
  // so a voice-off install never spawns the PowerShell input host at all.
  const injector = transcriber ? new WindowsInputInjector() : null;
  inputInjector = injector;
  const dictation =
    transcriber && injector
      ? new DictationSession(shell, transcriber, injector)
      : null;

  // One hotkey: open the bar and start listening at the same moment. The handler lives in
  // instructionHotkey.ts rather than here, so its guards are testable without booting electron
  // — which is exactly what the missing M14 §8 guard needed and did not have.
  const onHotkey = createOnInstructionHotkey({
    shell,
    dictation,
    voice,
    speech,
    runInstruction,
  });
  const hotkey = registerHotkey(shell, onHotkey);

  // The dictation hotkey: only registered when dictation can actually work (transcriber +
  // injector both present), mirroring the instruction hotkey's own construction above.
  //
  // combineInstructionBusy (M12.1), not `voice` directly: since Enter now stops dictation
  // globally, the dictation hotkey must stay blocked for the bar's whole open lifetime — not
  // just while voice happens to still be recording — or the bar's own Enter-to-submit and
  // dictation's Enter-to-finish could both fire from one keypress.
  const onDictate = dictation
    ? createOnDictateHotkey(dictation, combineInstructionBusy(voice, shell))
    : null;
  const dictateHotkey = onDictate
    ? registerDictateHotkey(shell, () => {
        // Same reason as the instruction hotkey: dictation types into another app, and the
        // app talking over it is noise on top of a microphone the two already share.
        speech?.stop();
        // And a leftover marker is noise on top of the window about to be typed into (M15).
        shell.clearPointer();
        onDictate();
      })
    : null;

  // Typing, or dismissing the bar, silently discards the recording. Both are "I did not
  // mean to dictate", and neither should ever produce a stray transcript. Both sessions'
  // abandon() no-op when idle, so it is safe to call both unconditionally — exactly one of
  // them can ever be non-idle at a time (mutual exclusion above / in dictate.ts).
  shell.onTypingStarted(() => void voice?.abandon());
  shell.onDismissed(() => {
    void voice?.abandon();
    void dictation?.abandon();
  });

  console.log(
    `[main] ready - ${hotkey ?? "(no free hotkey)"} opens the bar${voice ? " and starts listening" : " (voice off)"}`,
  );
  console.log(
    dictation
      ? `[main] dictation ready - ${dictateHotkey ?? "(no free hotkey)"} types into the focused window`
      : "[main] dictation disabled - voice is off (WHISPER_EXE_PATH / WHISPER_MODEL_PATH not set)",
  );
  // Said out loud at startup, every run, on purpose. This is the one capability that can send a
  // picture of the user's screen off the machine, and an install where it is quietly on is
  // exactly the situation the explicit opt-in exists to prevent.
  console.log(
    vision
      ? "[main] vision guidance ON - 'where is X' captures the screen and sends it to Anthropic"
      : "[main] vision guidance off - VISION_ENABLED not set (no screen is ever captured)",
  );
});

// Claim the first combo the OS will actually grant. Returns null if every candidate is
// taken — the app still runs, and the log says exactly why nothing responds.
function registerHotkey(
  shell: WindowsShell,
  onTrigger: () => void,
): string | null {
  const configured = process.env["HOTKEY"];
  const candidates = configured ? [configured] : HOTKEYS;

  for (const combo of candidates) {
    if (shell.registerHotkey(combo, onTrigger)) {
      if (combo !== candidates[0]) {
        console.log(
          `[main] hotkey fell back to ${combo} - earlier choices were taken`,
        );
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

// Same shape as registerHotkey, for the SEPARATE dictation combo (M12) — a distinct
// candidate list and env override (DICTATE_HOTKEY) so the two negotiations can never
// collide with each other on the OS.
function registerDictateHotkey(
  shell: WindowsShell,
  onTrigger: () => void,
): string | null {
  const configured = process.env["DICTATE_HOTKEY"];
  const candidates = configured ? [configured] : DICTATE_HOTKEYS;

  for (const combo of candidates) {
    if (shell.registerHotkey(combo, onTrigger)) {
      if (combo !== candidates[0]) {
        console.log(
          `[main] dictation hotkey fell back to ${combo} - earlier choices were taken`,
        );
      }
      return combo;
    }
  }

  console.error(
    `[main] no dictation hotkey available - all of ${candidates.join(", ")} are already in ` +
      `use. Set DICTATE_HOTKEY in .env to a free combo.`,
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
    console.log(
      "[main] voice disabled - WHISPER_EXE_PATH / WHISPER_MODEL_PATH not set",
    );
    return null;
  }
  return new WhisperCppTranscriber({
    exePath,
    modelPath,
    language: process.env["WHISPER_LANGUAGE"] ?? "en",
  });
}

// M14. Same shape and the same rule as createTranscriber above: paths are read HERE, and a
// missing one disables one capability rather than breaking the app. Unset means the app simply
// does not speak — no session is built, the `elaborate` tool is never offered, and every
// `speak` action the planner emits is accepted and discarded.
function createSynthesizer(): PiperSynthesizer | null {
  const exePath = process.env["PIPER_EXE_PATH"];
  const modelPath = process.env["PIPER_MODEL_PATH"];
  if (!exePath || !modelPath) {
    console.log(
      "[main] voice output disabled - PIPER_EXE_PATH / PIPER_MODEL_PATH not set",
    );
    return null;
  }
  const dataDir = process.env["PIPER_DATA_DIR"];
  return new PiperSynthesizer({
    exePath,
    modelPath,
    ...(dataDir ? { dataDir } : {}),
    // The archived v1.2.0 build spells the flags differently from the maintained one. Recon's
    // `--help` dump says which this install takes.
    legacyFlags: process.env["PIPER_LEGACY_FLAGS"] === "1",
  });
}

// M15. Config is read HERE like every other capability, but the GATE is a different shape, and
// deliberately so.
//
// Every other one asks "is there a thing to talk to?" and answers itself from config that exists
// for no other purpose — a debug Chrome URL, a Google refresh token, a piper binary path. Vision
// cannot be gated that way: the credential it would key off, ANTHROPIC_API_KEY, is very likely
// already set because the planner is using it, and reading its presence as permission to
// photograph the user's screen would turn "I configured an LLM" into "I consented to screen
// capture". Those are not the same decision, so this one needs a flag of its own.
//
// Unset means the tool is never on the menu, no WindowsScreen is constructed, and no screen is
// ever captured — the same "off is a real state" rule as voice and speech, on the capability
// where it matters most.
function createVisionLocator(): VisionLocator | null {
  if (process.env["VISION_ENABLED"] !== "1") return null;

  // Enabled but unusable is worth saying out loud at startup rather than discovering at the
  // first "where's the send button?" — the app would otherwise offer a tool that can only refuse.
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "[main] VISION_ENABLED=1 but ANTHROPIC_API_KEY is not set - vision guidance stays off. " +
        "The vision call is Anthropic-only (spec §3), independently of LLM_PROVIDER.",
    );
    return null;
  }

  // The key is read inside AnthropicMessages, from the environment, and never logged (spec §10).
  const model = process.env["VISION_MODEL"];
  return new AnthropicVisionLocator({
    api: new AnthropicMessages(),
    ...(model ? { model } : {}),
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

// Same CHROME_DEBUG_URL as Gmail (M11): one debug Chrome, a second app surface in it.
function createNotion(): NotionSurface | null {
  const baseUrl = process.env["CHROME_DEBUG_URL"];
  if (!baseUrl) {
    console.log("[main] Notion tools disabled - CHROME_DEBUG_URL not set");
    return null;
  }
  return new ChromeNotion({ baseUrl });
}

// M13. All three are read HERE, in composition — /core never touches process.env, and the
// refresh token is a secret that is never logged (spec §10). Missing credentials disable one
// capability rather than breaking the app: the tools are simply not on the menu.
function createCalendar(): CalendarSurface | null {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  const refreshToken = process.env["GOOGLE_REFRESH_TOKEN"];

  if (!clientId || !clientSecret || !refreshToken) {
    console.log(
      "[main] Calendar tools disabled - run `npm run calendar:connect` and set " +
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN",
    );
    return null;
  }

  return new GoogleCalendar({
    auth: new GoogleCalendarAuth({ clientId, clientSecret, refreshToken }),
  });
}

// A couple of starter facts so a live "open my dashboard" / "rewrite in my tone" can be
// eyeballed before `remember` (M4) exists. Only runs on a fresh DB; real facts will normally
// arrive via the remember tool.
function seedIfEmpty(memory: SqliteMemory): void {
  if (memory.query("").length > 0) return;
  memory.write("tone", "concise, warm, and direct", {
    confidence: 0.9,
    source: "seed",
  });
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
  // Release the persistent PowerShell input host (M12), or it outlives the app.
  inputInjector?.dispose();
  // Release the warm Piper process (post-M14 cold-start fix), or the ONNX model host outlives
  // the app the same way the input host would.
  speechEngine?.dispose();
  // And the pointing overlay (M15) — a transparent always-on-top window is the most obnoxious
  // possible thing to leave behind, because there is nothing visible to close it with.
  screenSurface?.dispose();
});
