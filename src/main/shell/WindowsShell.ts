import {
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  shell as electronShell,
} from "electron";
import type { CapturedContext, LocalAction, OSShell } from "./OSShell.ts";

// Windows implementation of the OSShell contract. For M0 only the three methods the
// skeleton exercises are real: registerHotkey, showInput, showResult. The rest satisfy
// the interface but throw until their milestone lands (spec.md §9).
export class WindowsShell implements OSShell {
  constructor(private readonly window: BrowserWindow) {
    // Renderer asks to close the bar (Escape) → hide it. Persistent for the app's life.
    ipcMain.on("commandbar:close", () => this.hide());
  }

  registerHotkey(combo: string, onTrigger: () => void): void {
    const ok = globalShortcut.register(combo, onTrigger);
    if (!ok) {
      console.error(`[WindowsShell] Failed to register hotkey: ${combo}`);
    }
  }

  // Show + focus the command bar and resolve with the text the renderer submits.
  // Resolves with "" if the user dismisses the bar (Escape) without submitting.
  showInput(): Promise<string> {
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
      this.window.show();
    }
    this.window.webContents.send("commandbar:echo", text);
  }

  private hide(): void {
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
