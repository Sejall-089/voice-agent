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
import type { SpeechShell } from "./SpeechShell.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

// What this shell needs from the speech queue — declared here rather than importing
// SpeechSession so the dependency runs one way: the session depends on the shell (it plays
// through it), and the shell only knows this much about the session.
export interface Speaker {
  speak(text: string): void;
  stop(): void;
  isSpeaking(): boolean;
}

// How long to wait for the renderer to answer a voice request before giving up. Without
// this a crashed renderer would leave VoiceSession stuck in "transcribing" forever, and
// the hotkey dead.
const RENDERER_REPLY_TIMEOUT_MS = 15_000;

// How long a result stays on screen when the bar was never focused (the voice path shows
// it with showInactive, so the usual blur-to-hide never fires).
const AUTO_HIDE_MS = 12_000;

// Windows implementation of the OSShell contract, plus the VoiceShell contract (M7).
export class WindowsShell implements OSShell, VoiceShell, SpeechShell {
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
  // Whether the global Enter ("Return") shortcut is currently ours — DictationSession's stop
  // key (M12.1). Scoped to exactly one dictation session's recording, via armStopKey/
  // disarmStopKey below, NOT to window visibility like Escape: the window can be visible for
  // other reasons (the instruction bar, caution-tool narration) where Enter must behave
  // completely normally for whatever app has real OS focus.
  private stopKeyRegistered = false;
  // The speech queue (M14), or null on an install with no synthesizer configured. Held rather
  // than constructed here because it needs this shell to play through.
  private speech: Speaker | null = null;
  // How to take the pointing marker away (M15), or null on an install with vision off. Held as a
  // bare callback rather than the whole ScreenSurface because this is the only thing the shell
  // has any business doing to it — the shell does not capture and does not point, it only knows
  // that "never mind" should mean never mind for everything on screen at once.
  private dismissPointer: (() => void) | null = null;
  private snapshotTarget: (() => void) | null = null;
  // Whether a confirm dialog is on screen awaiting an answer (M14 §8). Set SYNCHRONOUSLY
  // before the dialog is created, so there is no instant in which it is visible and this is
  // still false — the gap a live tester would find first.
  private confirmPending = false;

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
    this.escapeRegistered = globalShortcut.register("Escape", () => {
      // Escape means "never mind" everywhere else in this app, and live use found the only way
      // to interrupt speech was the instruction hotkey — which also opens the bar and the
      // microphone, so "just be quiet" left you with a bar to dismiss afterwards. This gives
      // that gesture a key of its own without changing what the hotkey does.
      this.stopSpeaking();
      // M15: and takes the pointing marker with it. "Never mind" has to mean everything on
      // screen at once, or the gesture that dismisses the bar leaves a highlight floating over
      // another app with no obvious way to be rid of it.
      this.dismissPointer?.();
      this.hide();
    });
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

  // DictationSession's stop key (M12.1): "press Enter to finish" only means anything while a
  // dictation recording is actually live, so this is armed in DictationSession.begin() and
  // disarmed the moment it returns to idle — never left registered the rest of the time,
  // where Enter must reach whatever app has real OS focus like any other keypress.
  //
  // `() => void | Promise<void>` mirrors Tool.narrate/confirmSummary's own widening (M11) —
  // the same "let a nominally-sync slot carry async work" shape, which is what lets
  // MockShell's test double hand back an awaitable promise instead of being unawaitable.
  armStopKey(onStop: () => void | Promise<void>): void {
    if (this.stopKeyRegistered) return;
    this.stopKeyRegistered = globalShortcut.register("Return", () => {
      void onStop();
    });
    if (!this.stopKeyRegistered) {
      // Rare — Enter/Return is not a common global-shortcut target — and there is no in-app
      // fallback: the dictate hotkey itself only ever starts a recording now, so a failed
      // registration here means the ONLY way out of this recording is Escape (cancel) or the
      // 30s cap (releases the mic, still requires Enter to ever type it — so effectively
      // stuck until Enter frees up). Logged loudly for exactly that reason.
      console.error(
        "[WindowsShell] Failed to register Enter for dictation (already in use) — this " +
          "recording can only be cancelled with Esc, not finished.",
      );
    }
  }

  disarmStopKey(): void {
    if (!this.stopKeyRegistered) return;
    globalShortcut.unregister("Return");
    this.stopKeyRegistered = false;
  }

  // Whether a typed-text capture (showInput()) is currently pending — used to widen the
  // dictation hotkey's mutual-exclusion guard (dictate.ts's combineInstructionBusy) beyond
  // "is voice recording" to "is the bar open at all", now that Enter is a trigger both flows
  // can reach for.
  isInputCapturing(): boolean {
    return this.pendingInput !== null;
  }

  // Ends an in-flight capture as a DISMISSAL — no text, and voice throws its recording away.
  // Idempotent, so hide() and the window event can both call it.
  //
  // Guards on voiceState too, not just pendingInput (M12): dictation never calls showInput()
  // — there is no typed-text capture to resolve — so pendingInput is null for the entire
  // life of a dictation session, and this must still fire so DictationSession hears about an
  // Escape/blur/direct hide and discards its recording instead of typing into whatever the
  // user walked away from.
  private endCapture(): void {
    if (this.pendingInput === null && this.voiceState === "idle") return;
    // Dismiss before resolving, so the awaiting caller already sees an abandoned session.
    this.onDismiss?.();
    // Own the busy flag here too, rather than trusting the async abandon() this triggers to
    // reset it in time: hide() below reaches endCapture() via TWO paths on a single call —
    // its own explicit invocation, and the "hide" event that same window.hide() emits a few
    // lines later. The old pendingInput-only guard was self-clearing (resolveInput() nulls
    // it), so the second path always no-op'd. voiceState is not self-clearing the same way
    // unless this method clears it directly, so without this line the second path would see
    // a still-non-idle voiceState and fire this same dismissal a second time.
    this.voiceState = "idle";
    this.resolveInput("");
  }

  // May a BLUR hide the bar? Not while the microphone is live, whisper is running, or
  // dictation is inserting text: the bar is deliberately unfocused in all three cases, and
  // hiding would take the indicator with it.
  private get pinnedAgainstBlur(): boolean {
    return (
      this.voiceState === "recording" ||
      this.voiceState === "transcribing" ||
      this.voiceState === "inserting"
    );
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

  // Says what is about to happen (or just happened) BEFORE/without stealing focus. Original
  // use was `caution`-tool narration (M10, via executeAction's "notify"); M12's
  // DictationSession reuses it verbatim — same channel, same reasoning — to name the window
  // it is about to type into ("Dictating into — Untitled - Notepad") rather than adding a
  // parallel status surface for a second narration source.
  narrate(text: string): void {
    if (!this.window.isVisible()) this.window.showInactive();
    this.cancelAutoHide();
    this.window.webContents.send("commandbar:status", text);
  }

  // --- SpeechShell (M14) ---

  // The queue, once main.ts has built one. Set after construction because the session needs
  // THIS shell to play through — the same shape as onDismissed/onTypingStarted.
  attachSpeech(session: Speaker): void {
    this.speech = session;
  }

  // --- The pointing marker (M15) ---

  // How to take the marker down, once main.ts has built something that can put one up. Set after
  // construction for the same reason attachSpeech is: the shell is a dependency of the thing it
  // is being handed, not the other way round.
  attachPointer(dismiss: () => void): void {
    this.dismissPointer = dismiss;
  }

  // M16.9. Same shape as attachPointer: the shell is handed the thing to call, and never learns
  // what a UIA host is.
  attachTargetSnapshot(snapshot: () => void): void {
    this.snapshotTarget = snapshot;
  }

  // Called by the instruction hotkey BEFORE showInput() steals focus.
  snapshotPointTarget(): void {
    this.snapshotTarget?.();
  }

  // Called by the hotkey handlers before a new instruction starts, so a marker never outlives
  // the question it answered.
  clearPointer(): void {
    this.dismissPointer?.();
  }

  isSpeaking(): boolean {
    return this.speech?.isSpeaking() ?? false;
  }

  // Everything about to be said is dropped, and what is playing is cut off. Called on either
  // hotkey (main.ts) and, structurally, whenever the microphone opens (below).
  stopSpeaking(): void {
    this.speech?.stop() ?? this.stopPlayback();
  }

  play(wav: Uint8Array): Promise<void> {
    // Resolve on the renderer's report, whatever it says. A rejection here would strand the
    // whole queue behind one bad utterance, so a failure resolves and is reported instead.
    const finished = this.awaitRenderer<null>("speech:ended", (_payload, error) => {
      if (error) console.error(`[WindowsShell] playback: ${error}`);
      return null;
    }).catch((error: unknown) => {
      // A renderer that never answered — a crash, or a window destroyed mid-utterance. The
      // queue must keep moving.
      console.error(`[WindowsShell] playback did not report back: ${messageOf(error)}`);
      return null;
    });

    this.window.webContents.send("speech:play", wav);
    return finished.then(() => undefined);
  }

  stopPlayback(): void {
    // Fire-and-forget: the renderer's own play() promise resolves when it is cut off, and that
    // is what reports the end, so there is nothing to wait for here.
    if (!this.window.isDestroyed()) this.window.webContents.send("speech:stop");
  }

  // --- VoiceShell (M7) ---

  async startRecording(): Promise<void> {
    // THE invariant, enforced at the one chokepoint every path to the microphone passes
    // through rather than at each hotkey — M8's lesson about binding cleanup to the event and
    // not to one code path. Not a UX preference: the instruction hotkey opens the bar AND the
    // microphone in the same moment (spec §4a), so an app still speaking would be transcribed
    // by whisper into the user's own instruction. MockShell mirrors this exactly.
    this.stopSpeaking();

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
        case "speak": {
          // M14. Handed to the queue, which never blocks: `speak` returns once the utterance is
          // queued, not once it has been heard, so a `caution` tool announces itself and then
          // acts rather than waiting two seconds in between.
          //
          // With no synthesizer configured there is no session, and this is accepted and
          // discarded. "The app cannot speak" is a real, supported state — the same one every
          // install is in when PIPER_EXE_PATH is unset — and a planner run must not fail
          // because the machine is silent, exactly as it does not fail with no microphone.
          this.speech?.speak(action.payload);
          return { ok: true };
        }
        case "notify": {
          // Narration for `caution` tools (M10, core/risk.ts): what is about to happen inside
          // another app, said before it happens. This is the action kind the OSShell contract
          // has carried unimplemented since M0 — M10 is the first tool with something to say.
          this.narrate(action.payload);
          return { ok: true };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // The gate in front of every `dangerous` action (spec.md §5 step 6b). The message it shows is
  // built by the planner from the RESOLVED arguments, so the user approves the concrete action.
  // Is a `dangerous` action sitting on screen waiting for a yes or no? (M14 §8.)
  //
  // The hotkeys read this. Without it, pressing the instruction hotkey mid-dialog starts a
  // SECOND concurrent planner run while the first is still parked at the confirm gate — and
  // `showInput()` calls `window.focus()`, which takes focus off the dialog, and `window.show()`
  // re-registers the global Escape that `confirm()` deliberately released so the dialog's own
  // cancel would work. Found in live testing, exactly as predicted, because the guard that was
  // designed to prevent it never got built.
  isConfirmPending(): boolean {
    return this.confirmPending;
  }

  async confirm(message: string): Promise<boolean> {
    // Set before anything awaits, so "the dialog is up" and "the guard knows" can never be
    // observed in different states.
    this.confirmPending = true;

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
      // In the finally, not after the await: a dialog that THREW must not leave the hotkeys
      // blocked forever with nothing on screen to answer.
      this.confirmPending = false;
      // The question has been answered, so anything still queued about it is describing a
      // decision the user has already made. Live use heard the app refer to a dialog cancelled
      // five seconds earlier, because a ~5s synthesis had the summary still waiting behind it.
      // Safe to do here and not a moment later: the handler's own result is spoken AFTER this
      // returns, so nothing that matters is dropped.
      this.stopSpeaking();
      // Re-arm only if the bar is still on screen — it normally is (confirm always follows
      // a still-open bar), but don't force it back open if something else already hid it.
      if (this.window.isVisible()) this.registerEscape();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The IPC payload crosses a process boundary, so it is validated rather than trusted.
function isAudioClip(value: unknown): value is AudioClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as { wav?: unknown; durationMs?: unknown };
  return clip.wav instanceof Uint8Array && typeof clip.durationMs === "number";
}
