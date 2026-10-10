// Recon: dismiss one question, give the same instruction again — does a REAL question appear?
//
//   node scripts/ask-recon/run.mjs dismissed-then-again
//
// !! SENDS REAL KEYSTROKES (Ctrl+Alt+Shift+F9, Escape) AND FLASHES A WINDOW for up to a minute.
// !! MAKES TWO REAL PLANNING CALLS on the key in .env. See run.mjs. Do not type while it runs.
//
// WHY THIS EXISTS. Reported live (M21): "a chain asks which channel I mean; while the question
// is open I pressed the instruction hotkey; the question vanished and a fresh, empty bar
// opened." The hotkey guard was the obvious suspect and was innocent — hotkey-during-question.ts
// shows a press during a real question refocuses it. What had actually happened:
//
//   1. a real question was dismissed, so the run was logged as refused, with the refusal text
//      "... teach me with: remember the bugs channel is <what it is>."
//   2. the NEXT planning call was shown that row as "the previous turn", and the model answered
//      in prose with its own "what is the bugs channel?" (5 of 5) instead of writing the plan
//   3. the planner showed that prose as an ordinary result. It LOOKS like a question; it is not
//      one — nothing is waiting on it, so the hotkey opens a fresh bar over it. Correctly.
//
// No fixture can show this: in every test the plan is the fixture. This runs the real planner,
// registry, hotkey handler, shell and renderer in a real window against the real model, with a
// throwaway memory database (never the app's own).
//
// IT RUNS NO TOOL. Both questions are dismissed with Escape, so the pre-flight refuses the plan
// before step 1: no email is read, no issue is created, nothing is posted. The connectors are
// built over UnavailableConnection, so even a bug here could not reach GitHub or Linear.
//
// WHAT IT PRINTS. For each of the two attempts, the verdict that matters:
//
//   REAL QUESTION   the shell reports a pending ask AND the renderer is showing it
//   PROSE           the model's own text arrived as a result; nothing is pending
//
// Measured 2026-10-10 (LLM_PROVIDER=openai), ONE run each — this script shows the thing happen
// on a real screen; how often the model does it is measured over repeated trials in
// tests/eval/unknownReference.eval.test.ts (0 of 5 before, 5 of 5 after):
//
//   before either fix   attempt 1: REAL QUESTION   attempt 2: PROSE   ("…I need the exact
//                                                   destination for 'the bugs channel'…")
//   after both fixes    attempt 1: REAL QUESTION   attempt 2: REAL QUESTION
//
// The fixes: the planner no longer shows that refusal row to the next planning call
// (core/chain.ts, isUnknownReferenceRefusal), and the prompt tells the model to write the plan
// with the phrase as said rather than ask about it (core/llm/prompt.ts).
import "dotenv/config";
import { app, BrowserWindow, screen } from "electron";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsShell } from "../../src/main/shell/WindowsShell.ts";
import { createOnInstructionHotkey } from "../../src/main/instructionHotkey.ts";
import { createRunInstruction } from "../../src/main/runInstruction.ts";
import { Planner } from "../../src/core/planner.ts";
import { buildRegistry } from "../../src/core/registry.ts";
import { InMemoryChainState } from "../../src/core/chainState.ts";
import { createLLMClient } from "../../src/core/llm/factory.ts";
import { createDatabase } from "../../src/core/memory/db.ts";
import { SqliteMemory } from "../../src/core/memory/SqliteMemory.ts";
import { loadConnectorTools } from "../../src/core/mcp/load.ts";
import { UnavailableConnection } from "../../src/core/mcp/SdkConnection.ts";
import { UnavailableGmail } from "../../src/core/gmail/UnavailableGmail.ts";
import type { CapturedContext } from "../../src/core/types.ts";

const REPO = process.argv[process.argv.length - 1] as string;
const INSTRUCTION = "File this email as a bug on GitHub and post it in the bugs channel";
const COMBO = "Control+Alt+Shift+F9";

const t0 = Date.now();
const log = (line: string): void => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${line}`);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// THE CONTEXT IS FIXED, AND EMPTY. The real shell's getContext() reads the clipboard, and the
// first run of this script therefore sent 1,737 characters of whatever had last been copied to
// the model — which is both nobody's business and an unrecorded variable: with that clipboard
// the model planned on attempt 2, and with an empty one it answers in prose (5 of 5 in the
// eval). A recon must hold fixed whatever it is not measuring (CLAUDE.md, "an eval must see
// what the app sees" — and must SAY what it showed).
class ReconShell extends WindowsShell {
  override getContext(): Promise<CapturedContext> {
    return Promise.resolve({ selectedText: null, activeApp: null, activeWindowTitle: null });
  }
}

// The planner is told an email is open, as it was in the live run. Nothing ever reads it.
class GmailWithAnEmailOpen extends UnavailableGmail {
  override hasOpenEmail(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// A window that will not go away is the worst thing this script can leave behind, so it cannot:
// whatever happens below — a hang, a throw, a model that never answers — it exits.
const WATCHDOG_MS = 170_000;
setTimeout(() => {
  console.log("\nRESULT  watchdog: gave up and exited");
  app.exit(3);
}, WATCHDOG_MS);
process.on("unhandledRejection", (reason) => {
  console.log(`\nRESULT  failed: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  app.exit(4);
});

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

  const shell = new ReconShell(win);
  win.on("blur", () => shell.handleBlur());

  // A throwaway database in the temp folder: the real engine, none of the user's facts.
  const scratch = mkdtempSync(join(tmpdir(), "ask-recon-"));
  const db = createDatabase(join(scratch, "memory.db"));
  const memory = new SqliteMemory(db);

  const connectors = loadConnectorTools({
    configText: readFileSync(join(REPO, "connectors.json"), "utf8"),
    readKey: (keyName) => process.env[keyName],
    connect: (def) => new UnavailableConnection(def.label),
  }).tools;

  const chain = new InMemoryChainState();
  const planner = new Planner(
    createLLMClient(),
    shell,
    buildRegistry({ gmail: true, connectors }),
    memory,
    memory,
    undefined, // sender — unavailable; nothing is ever sent
    new GmailWithAnEmailOpen(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    chain,
  );

  const onHotkey = createOnInstructionHotkey({
    shell,
    dictation: null,
    voice: null,
    speech: null,
    chain,
    runInstruction: createRunInstruction(planner, shell),
  });
  log(`registered ${COMBO}: ${shell.registerHotkey(COMBO, onHotkey)}`);

  await win.loadFile(join(REPO, "out/renderer/index.html"));
  await wait(300);

  const press = (keys: string): void => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`,
    ]);
  };
  const enter = (): void => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  };
  interface Screen {
    question: string | null;
    echo: string | null;
    placeholder: string | null;
  }
  // What is actually rendered — the DOM, not a log of what main decided to send.
  const onScreen = async (): Promise<Screen> =>
    JSON.parse(
      (await win.webContents.executeJavaScript(
        `JSON.stringify({ question: document.querySelector('.command-question')?.textContent ?? null,
           echo: document.querySelector('.command-echo')?.textContent ?? null,
           placeholder: document.querySelector('.command-input')?.placeholder ?? null })`,
      )) as string,
    ) as Screen;

  // One attempt: press the hotkey, type the instruction, Enter, and wait for the model.
  const attempt = async (n: number): Promise<"REAL QUESTION" | "PROSE" | "NEITHER"> => {
    log(`--- attempt ${n}: hotkey, type the instruction, Enter ---`);
    press("^%+{F9}");
    for (let i = 0; i < 40 && !shell.isInputCapturing(); i++) await wait(100);
    if (!shell.isInputCapturing()) {
      log("the bar never opened");
      return "NEITHER";
    }
    await win.webContents.insertText(INSTRUCTION);
    await wait(200);
    enter();

    for (let i = 0; i < 600; i++) {
      await wait(100);
      const now = await onScreen();
      if (shell.isAskPending() && now.question !== null) {
        log(`shell: ask pending. rendered question: ${JSON.stringify(now.question)}`);
        log(`rendered placeholder: ${JSON.stringify(now.placeholder)}`);
        return "REAL QUESTION";
      }
      if (now.echo !== null) {
        log(`shell: ask pending = ${shell.isAskPending()}. rendered RESULT: ${JSON.stringify(now.echo)}`);
        return "PROSE";
      }
    }
    log("timed out waiting for the model");
    return "NEITHER";
  };

  const first = await attempt(1);
  log(`attempt 1 verdict: ${first}`);

  if (first === "REAL QUESTION") {
    log("--- dismissing the question with a real Escape ---");
    press("{ESC}");
    for (let i = 0; i < 50 && shell.isAskPending(); i++) await wait(100);
    await wait(800); // let the refusal be logged and shown
    log(`after Escape: ask pending = ${shell.isAskPending()}; last log row = ${memory.getLast()?.status}`);
  }

  const second = await attempt(2);
  log(`attempt 2 verdict: ${second}`);
  if (second === "REAL QUESTION") {
    press("{ESC}");
    for (let i = 0; i < 50 && shell.isAskPending(); i++) await wait(100);
  }

  console.log(`\nRESULT  attempt 1: ${first}   attempt 2: ${second}`);
  await wait(300);
  db.close(); // or Windows will not let the file go
  rmSync(scratch, { recursive: true, force: true });
  app.exit(0);
});
