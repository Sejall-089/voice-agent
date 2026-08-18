import {
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  shell as electronShell,
} from "electron";
import type { AudioClip } from "../../core/types.ts";
import type { CapturedContext, LocalAction, OSShell } from "./OSShell.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

// How long to wait for the renderer to answer a voice request before giving up. Without
// this a crashed renderer would leave VoiceSession stuck in "transcribing" forever, and
// the hotkey dead.
const RENDERER_REPLY_TIMEOUT_MS = 15_000;

// How long a result stays on screen when the bar was never focused (the voice path shows
// it with showInactive, so the usual blur-to-hide never fires).
const AUTO_HIDE_MS = 12_000;

// Windows implementation of the OSShell contract, plus the VoiceShell contract (M7).
export class WindowsShell implements OSShell, VoiceShell {
  // Set while a recording/transcription is in flight: the bar must stay on screen even
  // though it isn't focused, or the recording indicator vanishes the instant it appears.
  private voiceBusy = false;
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly window: BrowserWindow) {
    // Renderer asks to close the bar (Escape) → hide it. Persistent for the app's life.
    ipcMain.on("commandbar:close", () => this.hide());
    // The bar hides on blur. While voice is live it is deliberately unfocused, so that
    // handler has to be suppressed — main.ts registers blur AFTER us, so we expose the
    // decision as a method instead of racing it.
  }

  // main.ts asks this before acting on a blur.
  shouldHideOnBlur(): boolean {
    return !this.voiceBusy;
  }

  registerHotkey(combo: string, onTrigger: () => void): boolean {
    const ok = globalShortcut.register(combo, onTrigger);
    if (!ok) {
      console.error(`[WindowsShell] Failed to register hotkey: ${combo} (already in use)`);
    }
    return ok;
  }

  // Show + focus the command bar and resolve with the text the renderer submits.
  // Resolves with "" if the user dismisses the bar (Escape) without submitting.
  showInput(): Promise<string> {
    this.cancelAutoHide();
    this.window.show();
    this.window.focus();
    this.window.webContents.send("commandbar:show");

    return new Promise<string>((resolve) => {
      const cleanup = (): void => {
        ipcMain.removeListener("commandbar:submit", onSubmit);
        ipcMain.removeListener("commandbar:close", onClose);
      };
      const onSubmit = (_event: Electron.IpcMainEvent, text: unknown): void => {
        cleanup();
        resolve(typeof text === "string" ? text : "");
      };
      const onClose = (): void => {
        cleanup();
        resolve("");
      };
      ipcMain.on("commandbar:submit", onSubmit);
      ipcMain.on("commandbar:close", onClose);
    });
  }

  showResult(text: string): void {
    // A modal confirm dialog blurs the bar, and the blur handler hides it. Re-show it, or the
    // result of the action the user just approved would land in an invisible window.
    if (!this.window.isVisible()) {
      // showInactive, not show: a voice result must not yank focus out of whatever the user
      // is actually working in. A typed run already owns focus, so nothing changes there.
      this.window.showInactive();
    }
    this.window.webContents.send("commandbar:echo", text);
    // A never-focused bar (the voice path) gets no blur, so it would sit there forever.
    if (!this.window.isFocused()) {
      this.scheduleAutoHide();
    }
  }

  // --- VoiceShell (M7) ---

  async startRecording(): Promise<void> {
    this.cancelAutoHide();
    this.voiceBusy = true;
    // showInactive: dictation is about the app you are already in. Stealing focus to show a
    // recording dot would defeat the point of a global hotkey.
    this.window.showInactive();

    const started = this.awaitRenderer<null>("voice:started", (_clip, error) => {
      if (error) throw new Error(error);
      return null;
    });
    this.window.webContents.send("voice:start");
    await started;
  }

  async stopRecording(): Promise<AudioClip> {
    const audio = this.awaitRenderer<AudioClip>("voice:audio", (clip, error) => {
      if (error) throw new Error(error);
      if (!isAudioClip(clip)) throw new Error("The recorder returned no audio.");
      return clip;
    });
    this.window.webContents.send("voice:stop");
    return audio;
  }

  async cancelRecording(): Promise<void> {
    this.window.webContents.send("voice:cancel");
    this.voiceBusy = false;
    this.hide();
    return Promise.resolve();
  }

  showVoiceState(state: VoiceState, detail?: string): void {
    this.voiceBusy = state !== "idle";
    this.window.webContents.send("voice:state", state, detail);
    if (state === "idle") {
      // Voice is done, but a planner result is usually seconds away — keep the bar up long
      // enough to show it rather than blinking out between the two.
      this.scheduleAutoHide();
    }
  }

  // The renderer asked to discard the recording (Escape). main.ts routes this to
  // VoiceSession.cancel(); the shell only carries the signal.
  onCancelRequested(handler: () => void): void {
    ipcMain.on("voice:cancelled", handler);
  }

  // Tell the bar which combo actually got registered, so the "…to stop" hint on the
  // recording indicator names the real key rather than the one we hoped for.
  setVoiceHotkeyLabel(combo: string | null): void {
    const send = (): void => this.window.webContents.send("voice:hotkey", combo);
    // The renderer may not have loaded yet at startup, so send on both events.
    this.window.webContents.on("did-finish-load", send);
    if (!this.window.webContents.isLoading()) send();
  }

  // One-shot request/response over IPC, with a timeout so a dead renderer can't hang the
  // voice state machine. `parse` turns the raw reply into the value (or throws).
  private awaitRenderer<T>(
    channel: string,
    parse: (payload: unknown, error?: string) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener(channel, onReply);
        reject(new Error("The recorder didn't respond."));
      }, RENDERER_REPLY_TIMEOUT_MS);

      const onReply = (_event: Electron.IpcMainEvent, payload: unknown, error?: string): void => {
        clearTimeout(timer);
        ipcMain.removeListener(channel, onReply);
        try {
          resolve(parse(payload, error));
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error(String(failure)));
        }
      };
      ipcMain.once(channel, onReply);
    });
  }

  private scheduleAutoHide(): void {
    this.cancelAutoHide();
    this.autoHideTimer = setTimeout(() => {
      this.autoHideTimer = null;
      if (!this.voiceBusy && !this.window.isFocused()) this.hide();
    }, AUTO_HIDE_MS);
  }

  private cancelAutoHide(): void {
    if (this.autoHideTimer !== null) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  private hide(): void {
    this.cancelAutoHide();
    this.window.webContents.send("commandbar:reset");
    this.window.hide();
  }

  // v0 context capture (spec.md §4): the current clipboard is the "selected text".
  // Workflow is select → copy (Ctrl+C) → hotkey. active-win is deferred (spec §3 optional).
  getContext(): Promise<CapturedContext> {
    const selectedText = clipboard.readText() || null;
    return Promise.resolve({ selectedText, activeApp: null, activeWindowTitle: null });
  }

  // The local side effects a tool handler can ask for (spec.md §4). Returns { ok: false }
  // rather than throwing, per the OSShell contract.
  async executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (action.kind) {
        case "openUrl": {
          // The payload originates from LLM output — only ever hand http(s) to the OS.
          const url = new URL(action.payload);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return { ok: false, error: `Refusing to open a non-web URL: ${url.protocol}` };
          }
          await electronShell.openExternal(url.toString());
          return { ok: true };
        }
        case "copyToClipboard": {
          clipboard.writeText(action.payload);
          return { ok: true };
        }
        case "notify": {
          // No tool emits this yet; wire it up when one does.
          return { ok: false, error: "notify is not implemented yet" };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // The gate in front of every irreversible action (spec.md §5 step 6). The message it shows is
  // built by the planner from the RESOLVED arguments, so the user approves the concrete action.
  async confirm(message: string): Promise<boolean> {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Send", "Cancel"],
      defaultId: 1, // Cancel — a stray Enter must never fire a destructive action
      cancelId: 1, // Esc / closing the dialog means "no"
      noLink: true,
      title: "Confirm action",
      message,
    });
    return response === 0;
  }
}

// The IPC payload crosses a process boundary, so it is validated rather than trusted.
function isAudioClip(value: unknown): value is AudioClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as { wav?: unknown; durationMs?: unknown };
  return clip.wav instanceof Uint8Array && typeof clip.durationMs === "number";
}
