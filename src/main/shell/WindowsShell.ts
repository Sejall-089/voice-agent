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
  // What voice is doing right now. Tracked as the STATE rather than one "busy" boolean
  // because two different questions hang off it and they have different answers in the
  // "stopped" case — see the two getters below.
  private voiceState: VoiceState = "idle";
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
  // The single in-flight showInput(), if any. Held on the instance rather than captured by
  // per-call IPC listeners: listeners registered inside showInput() could only ever be
  // removed by a submit or an Escape, so any OTHER way of hiding the bar (a blur, an
  // auto-hide) stranded them. One stranded listener = one extra planner run, and therefore
  // one extra LLM call, on the next submit. Measured at 6 concurrent runs from a single
  // keystroke. With one resolver on the instance the leak cannot be expressed.
  private pendingInput: ((text: string) => void) | null = null;
  // Fired when the bar goes away without a submit (Escape, blur, auto-hide) so voice can
  // discard its recording instead of transcribing something the user walked away from.
  private onDismiss: (() => void) | null = null;
  // Whether the global Escape shortcut is currently ours. Scoped to exactly the window's
  // visible lifetime (below) — Escape is not stolen system-wide the rest of the time.
  private escapeRegistered = false;

  constructor(private readonly window: BrowserWindow) {
    // Both listeners are registered ONCE, for the app's lifetime.
    ipcMain.on("commandbar:close", () => this.hide());
    ipcMain.on("commandbar:submit", (_event, text: unknown) => {
      this.resolveInput(typeof text === "string" ? text : "");
    });

    // The capture is tied to the WINDOW being hidden, not to our own hide() having been the
    // thing that hid it. That distinction is the whole point: cleanup bound to one method
    // only holds while every path politely goes through that method, and main.ts used to
    // call window.hide() directly. Bound to the window's own events, the invariant survives
    // a direct hide(), a close, and any path nobody has written yet.
    this.window.on("hide", () => this.endCapture());
    this.window.on("closed", () => this.endCapture());

    // A renderer keydown listener for Escape only fires when the bar's own <input> has DOM
    // focus, which requires the WINDOW to have OS focus first. That's routinely false: voice
    // shows the bar via showInactive() ON PURPOSE (dictation is about the app you're already
    // in, so stealing focus would defeat the point), so during the entire time the "Esc to
    // discard" hint is on screen, no keyboard event can ever reach the renderer. Escape is
    // registered as a GLOBAL shortcut instead, bound to "show"/"hide" (not called explicitly
    // at each show()/showInactive() call site) for the same reason endCapture is bound to
    // the window's own events: it holds for every path that shows or hides the window, not
    // just the ones that happen to go through our own methods. No ordering dependency here
    // the way there is for endCapture, so the event binding alone is enough.
    this.window.on("show", () => this.registerEscape());
    this.window.on("hide", () => this.unregisterEscape());
    this.window.on("closed", () => this.unregisterEscape());
  }

  private registerEscape(): void {
    if (this.escapeRegistered) return;
    this.escapeRegistered = globalShortcut.register("Escape", () => this.hide());
    if (!this.escapeRegistered) {
      // Rare (something else already owns global Escape) — the renderer's own keydown
      // listener remains as a fallback whenever the bar happens to have focus.
      console.error(
        "[WindowsShell] Failed to register Escape (already in use) — Esc will only " +
          "close the bar while it has focus.",
      );
    }
  }

  private unregisterEscape(): void {
    if (!this.escapeRegistered) return;
    globalShortcut.unregister("Escape");
    this.escapeRegistered = false;
  }

  // Ends an in-flight capture as a DISMISSAL — no text, and voice throws its recording away.
  // Idempotent, so hide() and the window event can both call it.
  private endCapture(): void {
    if (this.pendingInput === null) return;
    // Dismiss before resolving, so the awaiting caller already sees an abandoned session.
    this.onDismiss?.();
    this.resolveInput("");
  }

  // May a BLUR hide the bar? Not while the microphone is live or whisper is running: the
  // bar is deliberately unfocused then, and hiding would take the indicator with it.
  private get pinnedAgainstBlur(): boolean {
    return this.voiceState === "recording" || this.voiceState === "transcribing";
  }

  // Is voice holding something the user has not decided about? Any non-idle state, and
  // "stopped" is the one that matters: the 90s cap has released the microphone but the
  // audio is still sitting there waiting for Enter. A TIMER must never throw that away.
  // Only a deliberate act — Escape, clicking away, typing — may discard it.
  private get hasUnsubmittedAudio(): boolean {
    return this.voiceState !== "idle";
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
    // A capture that never resolved must not outlive this one.
    this.resolveInput("");
    this.window.show();
    this.window.focus();
    this.window.webContents.send("commandbar:show");

    return new Promise<string>((resolve) => {
      this.pendingInput = resolve;
    });
  }

  // Ends the in-flight capture, if there is one. Safe to call any number of times.
  private resolveInput(text: string): void {
    const resolve = this.pendingInput;
    this.pendingInput = null;
    resolve?.(text);
  }

  // Blur, handled here rather than in main.ts so the "am I recording?" rule and the
  // dismissal bookkeeping live together.
  handleBlur(): void {
    if (this.pinnedAgainstBlur) return; // unfocused on purpose, must stay visible
    this.hide();
  }

  // main.ts routes this to VoiceSession.abandon().
  onDismissed(handler: () => void): void {
    this.onDismiss = handler;
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
    this.voiceState = "recording";
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

  // Silences the microphone. Deliberately does NOT touch bar visibility — this is called
  // from VoiceSession.abandon() on TWO different triggers that want opposite outcomes:
  // typing (onTypingStarted) must leave the bar open and focused for the rest of the
  // instruction, while a dismissal (onDismissed) wants the bar closed, but that closing
  // already happened in whatever called hide() and produced the dismissal in the first
  // place — hide() is what triggers endCapture() -> onDismiss() -> abandon() -> here, not
  // the other way around. A hide() call in here used to run unconditionally on both paths,
  // which meant typing a single character during a recording closed the whole bar instead
  // of just cancelling the capture.
  async cancelRecording(): Promise<void> {
    this.window.webContents.send("voice:cancel");
    this.voiceState = "idle";
    return Promise.resolve();
  }

  showVoiceState(state: VoiceState, detail?: string): void {
    // "Busy" means the microphone is genuinely live, or whisper is running — the two cases
    // where hiding the bar would destroy something in flight. NOT "stopped": there the mic
    // is already released and the audio is just sitting there waiting for a decision, so
    // clicking away should dismiss it like any other bar. Treating stopped as busy pinned
    // the bar on screen with a live capture and no auto-hide, which contradicted the
    // documented rule that clicking away discards everything.
    this.voiceState = state;
    this.window.webContents.send("voice:state", state, detail);
    if (state === "idle") {
      // Voice is done, but a planner result is usually seconds away — keep the bar up long
      // enough to show it rather than blinking out between the two.
      this.scheduleAutoHide();
    }
  }

  // The planner is working. Reuses the bar's existing status channel rather than adding a
  // parallel one — the indicator is a general "what is the bar doing" line, and voice was
  // simply its first user. Deliberately NOT part of VoiceState: thinking is not something
  // VoiceSession can ever be doing, and widening its state machine to carry a planner
  // concern would be a lie about the type.
  showThinking(on: boolean): void {
    if (on) this.cancelAutoHide(); // don't let the bar vanish mid-run
    this.window.webContents.send("commandbar:thinking", on);
  }

  // The user started typing instead of speaking. main.ts routes this to
  // VoiceSession.abandon(); the shell only carries the signal.
  onTypingStarted(handler: () => void): void {
    ipcMain.on("commandbar:typing", handler);
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
      // The one automatic path to hide(), and hide() discards voice's held audio. So it
      // must refuse whenever voice still has something unsubmitted — otherwise a recording
      // the user stopped at the 90s cap could vanish while they were deciding what to do
      // with it, with no action on their part. Nothing here may destroy unreviewed work.
      if (this.hasUnsubmittedAudio) return;
      if (!this.window.isFocused()) this.hide();
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
    // Explicit, so the ordering is deterministic rather than dependent on when Electron
    // emits "hide". The window event below is the backstop, not the primary path.
    this.endCapture();
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
          // Narration for `caution` tools (M10, core/risk.ts): what is about to happen inside
          // another app, said before it happens. This is the action kind the OSShell contract
          // has carried unimplemented since M0 — M10 is the first tool with something to say.
          //
          // showInactive, like showResult: a reply is drafted while the user is looking at
          // Gmail, and stealing focus to announce it would pull them out of the thing being
          // narrated. Auto-hide is cancelled because the run is still going.
          if (!this.window.isVisible()) this.window.showInactive();
          this.cancelAutoHide();
          this.window.webContents.send("commandbar:status", action.payload);
          return { ok: true };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // The gate in front of every `dangerous` action (spec.md §5 step 6b). The message it shows is
  // built by the planner from the RESOLVED arguments, so the user approves the concrete action.
  async confirm(message: string): Promise<boolean> {
    // The bar is still visible (and its Escape registration still live) at this point —
    // nothing hides it between submit and the confirm gate. The native dialog already
    // relies on Escape meaning "no" (cancelId below), so our global hook has to step aside
    // for as long as the dialog owns the keyboard, or the two would race for the same key.
    this.unregisterEscape();
    try {
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
    } finally {
      // Re-arm only if the bar is still on screen — it normally is (confirm always follows
      // a still-open bar), but don't force it back open if something else already hid it.
      if (this.window.isVisible()) this.registerEscape();
    }
  }
}

// The IPC payload crosses a process boundary, so it is validated rather than trusted.
function isAudioClip(value: unknown): value is AudioClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as { wav?: unknown; durationMs?: unknown };
  return clip.wav instanceof Uint8Array && typeof clip.durationMs === "number";
}
