# spec.md — Voice-Action Agent (v0)

> Persistent decisions for this project. Claude Code should treat this file as the
> source of truth for scope, stack, and architecture. When something here conflicts
> with an ad-hoc chat instruction, ask before diverging.

---

## 1. What we are building

A desktop assistant that turns a short instruction (typed in v0) plus on-screen
context plus a personal memory store into **one concrete action**.

It is the interface + action layer on top of a personal memory engine. The memory
engine is the differentiator; this app makes it usable and visible.

**v0 is deliberately small.** Every task is single-step: one instruction → one plan
→ one action → one result (with a confirm step for irreversible actions). No
multi-step autonomous loops, no voice, no GUI computer-use. Those are later versions.

### The core translation
Fuzzy human sentence  →  exact function call.
`"send these to the team"`  →  `sendMessage(channel: "#design-team", text: "...")`

---

## 2. Non-negotiable scope guardrails

**In scope for v0:**
- Global hotkey opens a command bar (text input) anywhere in the OS.
- Capture context at trigger time (clipboard text + active window title).
- A planner that uses the LLM's tool-calling to pick ONE tool from a fixed registry.
- A memory engine (local SQLite) with read, write, versioning, and confidence.
- Six tools covering seven demo tasks (see §6).
- One external action via Slack incoming webhook.
- Confirmation step before any irreversible action.
- An action log that also records "no tool matched" misses.

**Added after v0 (M7):**
- Voice input: a second global hotkey dictates the instruction instead of typing it.
  Local transcription only (whisper.cpp) — no cloud STT. See §4a and §9's M7.

**Added after v0 (M10):**
- Instruction-driven email reply, scoped to **Gmail in Chrome and nothing else**: read the
  open message, draft a reply in the stored tone, put it in the reply box, tweak it by
  voice, and send only through an explicit confirm. See §6a and §9's M10.

**Added after v0 (M11):**
- Instruction-driven page writing, scoped to **Notion in Chrome, one open page, append
  only**: read the page, write new content in the stored tone, add it to the end. No
  search, no navigation, no editing or removing existing content, no revision tool. See
  §6b and §9's M11.

**Added after v0 (M12):**
- System-wide dictation: a THIRD, separate hotkey (not the M8 instruction hotkey) that
  types the raw transcript at the OS caret of whatever window currently has focus, in ANY
  app. Never reaches the planner — no tool selection, no risk tier, no confirm gate; it is
  the "insert text at cursor" primitive the Gmail/Notion CDP work always implied but never
  generalized past one browser tab. See §4c and §9's M12.

**Added after v0 (M14, in progress):**
- Voice output: the app SPEAKS its narration, confirms, and results instead of only showing
  them. Local synthesis only (Piper), behind a `SpeechSynthesizer` interface so a cloud voice
  is a later swap rather than a rewrite. The screen keeps exactly the text it shows today and
  the spoken line is DERIVED from it (`src/core/speech.ts`) — see §4d for why one unified
  string was rejected. Voice-ANSWERING of confirm dialogs is deliberately NOT part of this:
  putting speech recognition on the one gate that must never be bypassed needs its own
  fail-closed design, and gets its own milestone if it is ever built.

**Explicitly OUT of scope for v0 (do not build, do not scaffold):**
- ~~Voice / speech-to-text.~~ **Moved into scope in M7**, after v0 was complete and
  live-verified. It was out of v0 deliberately — voice is a second way to produce the
  instruction string, and it was only worth building once the string reliably produced
  the right action. It changes nothing downstream: the planner, registry, tools, and
  memory are untouched by M7.
- ~~GUI computer-use / screenshot-driven automation.~~ **Narrowly, and only half of this,
  moved into scope in M10, then M11.** The half that moved in is DOM/accessibility-based
  control of specific apps in Chrome (Gmail, then Notion), where every control is resolved
  structurally — by role and accessible name for Gmail, by `data-block-id` and document
  order for Notion, whichever identity the app's own DOM actually exposes (M11 found Notion
  exposes no roles at all on body content — see §6b). The half that did NOT move in — and is
  still explicitly out — is screenshot/vision-driven clicking anywhere on screen. The
  distinction is the whole point: reading a page's real structure is checkable and
  refusable; guessing from pixels is not. See §6a, §6b.
- macOS or Linux shells (architect for them via the interface, implement Windows only).
- More than one external connector.
- Multi-step / autonomous agent loops.
- Any UI beyond the command bar and a result popup.
- Auth systems, accounts, cloud sync.

If a task seems to require anything in the OUT list, stop and flag it.

---

## 3. Tech stack (decided — do not substitute without asking)

| Concern            | Choice                                   | Notes |
|--------------------|------------------------------------------|-------|
| Desktop shell      | **Electron** (main process, Node + TS)   | Global hotkey, tray, windows. |
| UI (renderer)      | **React + Vite + TypeScript**            | Command bar + result popup only. |
| Language           | **TypeScript** everywhere                | Strict mode on. |
| Memory store       | **better-sqlite3** (local file)          | Synchronous, embedded, zero-config. |
| Planner LLM        | **Selectable via `LLM_PROVIDER`**        | `anthropic` → `@anthropic-ai/sdk`, `claude-sonnet-4-6`. `openai` → `openai`, `gpt-5`. Tool-calling either way; see `src/core/llm/factory.ts`. |
| External action    | **Slack Incoming Webhook** (via `fetch`) | The only connector in v0. |
| Active window      | `active-win` (optional)                  | If it complicates the build, skip; context still works from clipboard. |
| Speech to text (M7)| **whisper.cpp**, local, via a spawned `whisper-cli.exe` | No cloud STT, no API key, no new npm dependency. Audio is captured in the renderer (Web Audio → 16 kHz mono WAV); `src/core/transcribers/`. |
| Browser control (M10, extended M11)| **Chrome DevTools Protocol** over `ws`, hand-rolled (`core/browser/`) | One `CdpClient` (app-agnostic) attaches to a Chrome the user starts with `--remote-debugging-port` + a dedicated `--user-data-dir` (Chrome 136+ refuses the port on the default profile); `ChromeGmail` and `ChromeNotion` are the per-app layers on top. `ws` is pure JS — no second native rebuild. Not puppeteer: the element-resolution logic is the safety-critical part and stays in our own tested code. M11 added real CDP-level input (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) alongside the `Input.insertText` M10 already used — Notion's editor ignores JS-dispatched `.click()`/`.focus()`/`execCommand()` (they report success but save nothing); only genuine device-level input registers. |
| System-wide input (M12) | **`SendInput` + `KEYEVENTF_UNICODE`**, hand-rolled over a persistent PowerShell host process (`src/main/shell/WindowsInputInjector.ts`) | The one Windows primitive with a real success signal: it returns the count of keystrokes the OS actually accepted, so a short write (most often UIPI blocking an unelevated process from typing into an elevated window) is a thrown error, never a silently-swallowed partial type — the same discipline M11 learned the hard way when `execCommand()` reported success and saved nothing. UI Automation's `ValuePattern.SetValue` was considered and rejected: it has no insert-at-caret operation, only whole-value replacement, which is destructive exactly where dictation must not be. Clipboard + `Ctrl+V` was rejected too — `getContext()` already uses the clipboard as this app's own context-capture channel (§4), and routing dictation through it would race that. PowerShell (`Add-Type` compiling one P/Invoke declaration, once, at construction) rather than a native node module — same reasoning as whisper.cpp's spawned binary: this repo already rebuilds `better-sqlite3` twice per install, and a second native addon would double that fragility. |
| Text to speech (M14)| **Piper**, local, via a spawned `piper.exe` | No cloud TTS, no API key, no new npm dependency — the same shape and the same reasoning as whisper.cpp above, and local for the same reason voice INPUT is. Behind `SpeechSynthesizer` (`core/types.ts`, beside `Transcriber`), so an ElevenLabs implementation is a later swap that touches nothing else. Rejected: SAPI / Chromium's `speechSynthesis` (zero install and trivial to stop mid-word, but the built-in Windows voices are the robotic ones — kept as the named fallback if Piper's setup friction proves worse than it looks), and Kokoro via `onnxruntime-node` (better still, but a second native addon, which this repo has now refused twice for the same reason). The maintained build is `OHF-Voice/piper1-gpl` (`pip install piper-tts`); the archived `rhasspy/piper` v1.2.0 zip is the no-Python option. The wrapper spawns a path from `.env`, so which one is installed is a README decision, not an architecture one. The voice model is downloaded ONCE, ahead of time — a "nothing leaves the machine" feature must not make a network call on its first utterance. |
| Config / secrets   | `.env` (dotenv), never committed         | `LLM_PROVIDER`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (whichever matches), `SLACK_WEBHOOK_URL`, and (M7, optional) `WHISPER_EXE_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE`, and (M10/M11, optional) `CHROME_DEBUG_URL` — one debug Chrome, both Gmail and Notion tools gate on it, and (M12, optional) `DICTATE_HOTKEY` — dictation itself needs no new secret, only the whisper config it already shares with voice, and (M14, optional) `PIPER_EXE_PATH`, `PIPER_MODEL_PATH` — unset means the app simply does not speak, the same way unset whisper paths mean it does not listen. |

Target OS for v0: **Windows**. Everything OS-specific lives behind the `OSShell`
interface (§4) so a Mac/Linux shell can be added later without touching the core.

Recommended repo layout:
```
/src
  /main            Electron main process
    main.ts        app lifecycle, tray, wiring
    shell/
      OSShell.ts   the interface (§4)
      WindowsShell.ts
      MockShell.ts head­less shell for tests/dev
  /core            OS-agnostic brain (no electron imports here)
    planner.ts     the loop (§5)
    registry.ts    tool definitions (§6)
    tools/         one file per tool handler
    memory/
      db.ts        better-sqlite3 setup + migrations
      memory.ts    read / write / resolve / version (§7)
    llm/           anthropic.ts + openai.ts clients, shared prompt.ts, factory.ts (LLM_PROVIDER)
    types.ts       shared types
  /renderer        React + Vite UI
    CommandBar.tsx
    ResultPopup.tsx
    ConfirmDialog.tsx
/tests             vitest specs, run against MockShell
spec.md
ARCHITECTURE.md
CLAUDE.md
```

---

## 3b. The "Thinking…" indicator

A planner run is 6–13 s, nearly all of it waiting on the model, and the bar used to show
nothing at all during it — a wait indistinguishable from a hang. `shell.showThinking(on)`
drives the same status line voice already used (`commandbar:thinking`), shown for typed and
dictated instructions alike since both funnel through one call site.

It is **perception only** — nothing runs faster. The model-side levers (lower reasoning
effort, a smaller model for `chooseTool`) are deliberately untouched, because they trade
against tool-choice accuracy and that needs an eval run rather than a guess.

`createRunInstruction()` (`src/main/runInstruction.ts`) exists so that call site is a named,
testable thing rather than a closure inside `app.whenReady()` — importing `main.ts` would
boot electron. The indicator is turned off in a `finally`, so no path out of a planner run
can leave the bar claiming to think forever.

---

## 3a. Token budget and the truncated-response outcome (M9)

`chooseTool` asks for **4096** tokens on both providers, not 1024. On a reasoning model the
reasoning tokens are spent from the *same* allowance the tool call must fit inside, so a
long reasoning pass could consume the whole budget and return no tool call. A cap the model
does not reach costs nothing, so the headroom is close to free.

Headroom alone is not a guarantee, so truncation is now its own outcome rather than an
absence. `ToolChoice` has a third variant:

```ts
| { kind: "incomplete"; reason: string }   // hit the ceiling before deciding anything
```

- `openai.ts` returns it on `finish_reason === "length"` with no tool call (and names the
  reasoning-token count when the API reports it).
- `anthropic.ts` returns it on `stop_reason === "max_tokens"` with no `tool_use` block.

**Why it is not just `{ kind: "none" }`:** "I decline" and "I ran out of room" are different
facts. Collapsing them told the user *"I don't have a tool for that"* — false, and it sends
them looking for a missing capability that was never the problem.

The planner's `refuseIncomplete()` shows the honest message and logs the row with
**`status: "no_tool"`**, but deliberately *not* through `logMiss()`: §8 defines the miss list
as a ranked backlog of tools worth building, and a token-budget failure is not a missing
tool. Same status, same table, reason recorded in `result`, backlog uncorrupted.

Note `complete()` (used inside handlers) can still truncate a long summary. That is visible
to the user as short output rather than silent, so it is left alone for now.

---

## 4. The OSShell interface (the portability contract)

The core NEVER calls OS APIs directly. It only calls these six methods. Porting to
another OS later means implementing this interface again — nothing else changes.

```ts
export interface CapturedContext {
  selectedText: string | null;    // v0: current clipboard contents
  activeApp: string | null;       // optional (active-win); may be null
  activeWindowTitle: string | null;
}

export type LocalAction =
  | { kind: "openUrl"; payload: string }
  | { kind: "copyToClipboard"; payload: string }
  | { kind: "notify"; payload: string };

export interface OSShell {
  registerHotkey(combo: string, onTrigger: () => void): boolean;  // false = combo taken
  getContext(): Promise<CapturedContext>;
  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }>;
  showInput(): Promise<string>;                 // opens command bar, resolves with typed text
  showResult(text: string): void;               // result popup
  confirm(message: string): Promise<boolean>;   // yes/no dialog for irreversible actions
}
```

**Build a `MockShell` first.** It returns canned context, logs actions instead of
running them, and lets the entire core + memory + tests run headless with no
Electron. Wire the real `WindowsShell` last.

v0 selection capture is intentionally simple: `getContext()` reads the current
system clipboard as `selectedText`. The user workflow is "select → copy (Ctrl+C) →
hotkey". Simulated-copy (injecting Ctrl+C) is a later refinement, not v0.

---

## 4a. Voice input (M7) — a parallel contract, not a change to OSShell

`OSShell` above is the contract **`/core` depends on**, and the core brain has no
business knowing a microphone exists. Voice is main-process wiring, so it gets its own
interface next door in `src/main/shell/VoiceShell.ts`. `WindowsShell` implements both;
`MockShell` implements both; a future Mac shell would implement both.

```ts
export type VoiceState = "idle" | "recording" | "transcribing";

export interface VoiceShell {
  startRecording(): Promise<void>;
  stopRecording(): Promise<AudioClip>;   // resolves with 16 kHz mono WAV bytes
  cancelRecording(): Promise<void>;      // discard — no transcript, no action
  showVoiceState(state: VoiceState, detail?: string): void;
  showResult(text: string): void;        // already on OSShell
}

// core/types.ts, beside LLMClient and MessageSender
export interface Transcriber {
  transcribe(clip: AudioClip): Promise<string>;
}
```

**One hotkey, negotiated (M8).** `registerHotkey()` returns a boolean (the OS can refuse a
combo another app owns), and `main.ts` claims the first free combo from an ordered list —
`Ctrl+Shift+Space`, then `Ctrl+Alt+Space`, `Ctrl+Alt+M`, `Alt+Shift+Space` — logging which
one won. `HOTKEY` in `.env` overrides the list. This is not speculative: `Ctrl+Alt+Space`
was already taken on the first machine this ran on, and a hotkey that silently never fires
is indistinguishable from a broken app.

M7 shipped *two* hotkeys — one to type, one to dictate — which forced the choice before the
bar was even open. **M8 collapsed them into one:** the hotkey opens the bar *and* starts
listening, and `Enter` submits either way.

| You do | What happens |
|---|---|
| Speak, then `Enter` | Recording stops, transcribes, submits the transcript |
| Start typing | Recording is **silently cancelled** — no message, no stray transcript |
| Type, then `Enter` | Submits the typed text |
| `Esc`, or click away | Recording discarded, bar closed, nothing runs |
| Wait 90 s | Mic released, audio held; `Enter` still submits it |

**The state machine (`src/main/shell/VoiceSession.ts`).** No longer a toggle — a capture
session tied to the bar being open. The bar's own `Enter`/`Esc` drive it:

```
idle ──begin()──► recording ──finish()──► transcribing ──► idle (returns the transcript)
                      │  └───90s cap───► stopped ──finish()──► transcribing
                      └──abandon()──► idle (silent)
```

| State | `begin()` | `finish()` | `abandon()` |
|---|---|---|---|
| `idle` | → `recording` | `""` | no-op |
| `recording` | no-op | stop → transcribe → transcript | discard, → `idle` |
| `stopped` (cap hit, audio held) | no-op | transcribe the held audio | discard, → `idle` |
| `transcribing` | no-op | `""` — never starts a second run | → `idle` |

- **The 90 s cap releases the microphone but does not transcribe.** Holding the mic open is
  the actual harm; whisper work on audio you may never submit is waste. Nothing fires on its
  own — under M7's invisible bar an auto-submit was defensible, but the bar is now open and
  focused in front of you.
- **A capped recording never expires.** `hide()` is what discards voice's held audio, and the
  12 s auto-hide timer is the only path to `hide()` that no human triggered. It now refuses
  to fire while voice holds anything unsubmitted, so a recording stopped at the cap survives
  until *you* act on it — Enter runs it, Escape or clicking away discards it, and nothing
  else may. Two questions hang off the voice state and they differ exactly here, so the shell
  tracks the state rather than one boolean: blur-hide is suppressed only while the mic is
  live or whisper is running, while the automatic timer is suppressed for any non-idle
  state — including `stopped`.
- **`abandon()` is silent.** Typing is not an error; a "didn't catch that" there would be
  noise. Asserted directly in the suite.
- **Every failure returns to `idle`** — blocked mic, whisper crash, blank transcript,
  sub-300 ms clip. No path leaves the hotkey dead.
- The state flips to `recording` **before** awaiting the microphone, so a keystroke during
  mic warm-up can still abandon the session.

**Voice off is a real state.** With `WHISPER_EXE_PATH`/`WHISPER_MODEL_PATH` unset,
`createTranscriber()` returns `null`, no `VoiceSession` is built, the bar never opens the
microphone, and `Enter` on an empty bar does nothing — exactly as before voice existed.

**The one rule this milestone must not break:** voice produces a *string*, nothing more.
`VoiceSession` never calls the planner. `main.ts` *pulls* a transcript from
`finish()` and feeds it to the same `runInstruction` the typed path uses, so there is
exactly one planner call site and `/core` is unchanged by M7/M8. Dictated instructions pass the same
registry check, the same resolution, and the same confirm gate; the planner cannot tell
where the string came from.

---

## 4c. System-wide dictation (M12) — never reaches the planner

Everything in §4a exists to produce an *instruction string* for the planner. M12 is a
different, simpler primitive: hold nothing, tap the dictation hotkey to start listening, press
**Enter** to stop and type the raw transcript at the OS caret of whatever window currently has
focus — in ANY app, not just this one. There is no tool selection, no risk tier, no confirm
gate, because there is no planner call at all. It is the "insert text at cursor" primitive the
Gmail/Notion CDP work always implied but never generalized past one browser tab.

**A separate hotkey, not the M8 instruction hotkey, disambiguated by which key combo is
pressed rather than by hold-vs-tap.** Hold-vs-tap needs a system-wide low-level keyboard hook
to detect key-up (`globalShortcut` only fires on press), which is a much bigger primitive to
buy a distinction this app doesn't otherwise need. The stronger reason is semantic: the two
modes want *opposite* focus behaviour. `showInput()` calls `window.focus()` on purpose — the
instruction bar is a conversation with the agent. Dictation must never focus the bar — it is
a conversation with whatever app you're already in — so a misfire has asymmetric cost: an
instruction misfire wastes a planner run; a dictation misfire types characters into someone's
live document with no undo.

```
DICTATE_HOTKEYS = [Ctrl+M, Ctrl+Shift+Alt+D, Ctrl+Alt+D, Ctrl+Alt+J]   (DICTATE_HOTKEY in .env overrides)
```
Negotiated exactly like the instruction hotkey list (§4a, §9's M8) — first free combo wins,
logged. Deliberately NOT Space-based, so the two negotiations can never collide with each
other on the OS. `Ctrl+Alt+V` (Excel's Paste Special) and `Alt+Shift+D` (Word's insert-date
field) were considered and excluded outright, not merely deprioritized — both are real,
common bindings in exactly the apps dictation is most likely used in. `Ctrl+Alt+J` is the
last-resort candidate: no default binding in Word/Excel, and unused in Chrome/VS Code
(Chrome's own download/console shortcuts are `Ctrl+J`/`Ctrl+Shift+J`, one modifier short of
this). `Ctrl+M` was promoted to first choice in M12.2 (§9), a genuine 2-key combo added after
live use flagged the 3-4 key fallbacks as too slow to reach for repeatedly — no conflict found
in Chrome, VS Code, Word, or Excel; it happens to sit one letter from the instruction bar's
own `Ctrl+Alt+M` fallback (§4a, §9's M8), which is a coincidence worth noting, not a
technical clash (the two hotkey lists are negotiated independently and can never collide).

**The gesture is `begin()`/`finish()`, matching `VoiceSession` exactly — Enter stops it, not
the same hotkey.** M12 originally shipped a same-hotkey TOGGLE, rejecting the instruction
bar's Enter-driven shape for one reason: the dictation window is shown via `showInactive()`
and never takes OS focus, so a renderer `<input>` keydown listener for Enter would never fire
— there was nothing to hook it to. **M12.1 revised this** after live use showed people
reflexively reach for Enter, the way the instruction bar's own M8 flow already works — the
objection dissolves once Enter is registered as a **global** shortcut instead
(`WindowsShell.armStopKey`/`disarmStopKey`), exactly the precedent `WindowsShell` already set
for Escape, which has the identical focus problem. So `DictationSession`
(`src/main/shell/DictationSession.ts`) is now the SAME shape as `VoiceSession`:

```
idle ──begin()──► recording ──finish()──► transcribing ──► inserting ──► idle
         │              └──cap (DEFAULT_MAX_RECORDING_MS = 90s)──► stopped ──finish()──►┘
         └──abandon()──► idle (silent, mirrors VoiceSession)
```

`begin()` is a no-op unless idle — once a recording has started, the ONLY way to stop it is
Enter, not a repeat press of the dictate hotkey. `finish()` fires on the global Enter press
(armed in `begin()`, disarmed the moment the session returns to `idle` — a single centralized
disarm inside the private `enter()` transition helper, since every exit path funnels through
`enter("idle", …)` regardless of whether it was success, failure, or `abandon()`).

**The tradeoff this brings, stated plainly: for as long as a recording is live ("recording" or
"stopped"), Enter is captured GLOBALLY** — it stops dictation and types the transcript
instead of reaching whatever app has focus for its normal purpose (submitting a form, a
newline). That is inherent to "Enter finishes it, no matter what has focus" and is the whole
point; it ends the moment the session returns to idle. If the global registration itself
fails (rare — Enter/Return is not a common global-shortcut target), it is logged loudly and
there is no in-app fallback: that recording can only be cancelled with Escape, not finished,
until whatever is holding the key releases it.

The cap is a SAFETY CEILING for a forgotten Enter, not a typical session length — dictation's
normal ending is pressing Enter, and a dictation take runs silently in the background with
nothing on screen to prompt you back to it, unlike the instruction bar's 90s cap which sits
behind a visible, focused bar the whole time. `DEFAULT_MAX_RECORDING_MS` was raised from 30s
to **90s** in M12.2 (§9) after live use showed 30s cutting off genuinely longer dictated
thoughts mid-sentence with no warning — it now matches the instruction bar's own cap length.
A `WARNING_BEFORE_CAP_MS` (10s) narration fires before the cap itself, so a long dictation is
never cut off blind. Both are named, tunable constants (same convention as `ChromeNotion`'s
`FOCUS_SETTLE_MS`/`KEY_SETTLE_MS`) — the cap-reached narration derives its wording from
`maxRecordingMs` rather than a literal, precisely so raising this constant again later can't
silently leave the message announcing the wrong duration.

Shares WindowsShell's existing `voiceState` field and `showVoiceState`/`hasUnsubmittedAudio`/
`pinnedAgainstBlur` plumbing with `VoiceSession` rather than adding a second parallel "busy"
concept — the two machines are mutually exclusive at runtime (they share the one `MicRecorder`
in the renderer), so one field safely serves both. `"inserting"` was added to `VoiceState` for
this reason.

**Mutual exclusion (`src/main/dictate.ts`), widened in M12.1.** Dictation and the instruction
bar's own voice capture share one microphone and, while dictation runs, the same
`BrowserWindow` (shown via `showInactive()` so it never steals focus). If the instruction
hotkey fired mid-dictation, `shell.showInput()`'s `window.focus()` would yank focus away from
whatever the user is dictating into — exactly the failure this feature exists to avoid. Each
hotkey's handler checks the other session's state before doing anything; both sessions'
`abandon()` are no-ops when already idle, so `shell.onDismissed()` can call both
unconditionally.

Originally the dictation hotkey was blocked only while the instruction bar's *voice*
sub-capture was recording (`voice.getState() !== "idle"`). Under the same-hotkey-stops design
this was harmless — dictation never touched Enter, so it never collided with the bar's own
Enter-to-submit. Once Enter became a shared global trigger (M12.1), this became a real gap: the
bar can be open and being typed into (`showInput()` pending) with voice already abandoned via
`commandbar:typing`, and in that state the old guard would have let the dictation hotkey start
a recording anyway — one later Enter press could then both submit the bar's typed text *and*
finish dictation. `combineInstructionBusy(voice, shell)` closes it: the dictation hotkey is
blocked for the bar's *entire* open lifetime (`WindowsShell.isInputCapturing()`, a trivial
`pendingInput !== null` read), not just the portion where voice happens to still be recording.

**Insertion mechanism: `SendInput` + `KEYEVENTF_UNICODE`, not UI Automation, not clipboard,
not `SendKeys`.** See the tech-stack table (§3) for the full reasoning; the short version is
that `SendInput` is the only one of the three with a real, un-swallowable success signal (a
short write throws), UIA's `ValuePattern.SetValue` has no insert-at-caret operation (only
whole-value replacement — destructive exactly where dictation must not be), and clipboard+
`Ctrl+V` would race `getContext()`'s own use of the clipboard as this app's context-capture
channel (§4). Text is chunked (`CHUNK_SIZE_CHARS`/`CHUNK_DELAY_MS`, named and tunable) into
small `SendInput` bursts rather than one giant call — apps doing per-keystroke work
(autocomplete, an IDE's own input handling) have been observed to drop or reorder events
under a single large burst. **Revised in M12.2 (§9)** after live testing surfaced genuine
OS-level character repetition ("mmmmmm", "IIIIIIII") on longer dictations at the original
25-chars/8ms pacing — not an app rendering issue. `KEYEVENTF_UNICODE` events carry no real
virtual-key code (`wVk = 0`), and a fast enough stream of them was tripping Windows' own
key-repeat handling. `CHUNK_SIZE_CHARS`/`CHUNK_DELAY_MS` are now `1`/`40ms` — one character
per `SendInput` call, confirmed to fix a previously-corrupted long sentence — at the direct
cost of a longer dictation now visibly taking longer to type out.

**Focus is checked twice: at trigger time, and again immediately before typing.** The
foreground window (handle + title) is captured when recording begins — before anything is
narrated, so the user knows where text will land *before* speaking, not after. If focus
changed by the time transcription finishes (the whole capture takes real, unpredictable time),
`DictationSession` refuses to type at all rather than guess it is still safe — the transcript
is surfaced in the refusal message so nothing said is lost, but nothing is typed into a window
the user has since moved on from. The same refusal applies if the starting focus could not be
captured in the first place (no target to compare against is treated as "unsafe", never as
"assume it's fine").

**Raw transcript only, no cleanup pass.** `WhisperCppTranscriber`'s existing
`cleanTranscript()` (stripping `[BLANK_AUDIO]`/`(silence)` tokens, collapsing whitespace) is
the only processing the text gets — dictation reuses it for free, since it lives in the
transcriber both paths already share. A rewrite pass was considered and rejected for v1: it
would add a full model round trip to the one feature whose entire value is speak-then-it-
appears-immediately latency (§3b: a planner run alone is 6-13s); it has no draft/confirm step
to review the result against, unlike every other generated-text path in this app; and a raw
transcript is falsifiable against what was actually said, while a cleaned one is not. The seam
is left, not built: a `TextTransform = (text: string) => Promise<string>` (identity by
default) would let a later milestone add an opt-in cleanup pass, reusing `composeShared.ts`'s
primitives, without restructuring anything here.

**No new risk tier.** `Risk` (core/risk.ts) is metadata on a *registry entry*, read by the
planner after the model has already chosen a tool. Dictation has no registry entry and no
model choice for a gate to constrain — there is nothing to gate. The discipline `caution`
encodes is met without the plumbing: narrate before acting (the captured window title, shown
before recording even starts), say what happened after (the typed transcript stays visible),
and refuse rather than guess (an unreadable focus, a focus change, or a short/blocked
`SendInput` write all refuse outright, never silently partial).

**Dictation never presses Enter, and never will in v1.** The transcript is a single string,
typed exactly as transcribed — no keypress is synthesized around it, so dictation can never
accidentally submit a form or send a message on its own.

---

## 5. The planner loop (core/planner.ts)

Given the user's instruction and captured context, run exactly this sequence:

1. **Assemble request** — build the LLM call: the instruction + context + the tool
   schemas from the registry (§6), plus one turn of state: the single most recently
   logged action (`ActionLog.getLast()`), scoped strictly to resolving a correction or
   pronoun in the CURRENT instruction ("no, I meant..."). This is not conversation
   history — it's one bounded fact, and it's still exactly one tool call per
   instruction; the planner never chains actions on its own. **The current local time**
   goes in too (M13) — see "The clock in the prompt" below.
2. **LLM picks a tool** — call the configured provider (§3, `LLM_PROVIDER`) with
   tool-calling. Expect a `tool_call`:
   `{ name, input }`. The model may also decline (return only text).
3. **Guard: registry check** — if `name` is not in the registry (hallucinated tool)
   OR the model declined, DO NOT act. Fall to graceful refusal (§8) and log a miss.
4. **Resolve arguments** — for each argument that looks like a vague reference
   (e.g. "the team", "my dashboard", "the usual tone"), call `memory.resolve()`
   (§7) to replace it with a concrete value. If a required reference can't be
   resolved, ask the user (via showInput) or refuse gracefully.
5. **Validate** — all required args present and concrete?
5b. **Resolve the tier** — what does *this* call cost (§6)? Usually the constant the tool
   declares; for a tool with a `RiskPolicy` it is worked out from the resolved arguments,
   and may read the world to do it. Resolved **once** and reused by both gates below —
   asking twice would let the two answers disagree, which is a hole in the gate rather
   than a slow path.
6. **Gate on the tier** — two steps, both driven by the tier alone (M10):
   - **6a. Narrate** — a `caution` tool announces what it is about to do, via
     `executeAction({ kind: "notify" })`, *before* the handler runs. It is not asked,
     because it is routine; it is announced, because there is no undo.
   - **6b. Confirm** — a `dangerous` tool must pass `shell.confirm(summary)`. Abort on
     "no". The summary may read the world first (see `confirmSummary`, §6), so the user
     approves the concrete action rather than the model's description of it.
7. **Execute** — run the tool's handler. Handlers may call the LLM, memory, or the
   shell.
8. **Record** — write an `action_log` row (instruction, tool, args, result,
   status). Show the result via `shell.showResult()`.

Key rule: **the LLM proposes, the planner disposes.** Nothing `dangerous` runs
without the registry check + validation + confirm gate. This separation is the most
important design decision in the app.

### The clock in the prompt (added in M13)

Through M12 the prompt carried **no current date or time at all**, and nothing missed it:
every tool operated on text the user had already selected or on a page already open, so
the model never had to know what day it was. Calendar breaks that. A calendar tool takes an
exact instant, and the thing that turns "tomorrow at 3" into one is the **model**, at the
planning layer — which it cannot do if it does not know what today is.

So `renderRequest` (`core/llm/prompt.ts`) now opens with a standing fact:

```
Current time: 2026-08-23T15:18:29+05:30 (Sunday, Asia/Kolkata)
```

The **offset** is the load-bearing part. Without it "15:00" is not a point in time, and a
zone name alone would leave the model doing timezone arithmetic in its head. The weekday is
there for "next Tuesday".

This is the user's **local** zone — what they mean when they say "3pm". It is not
necessarily the calendar's own zone, which is read from the calendar itself and used for
*display* (§6c, `CalendarSurface.calendarTimeZone`). They are usually the same and must not
be assumed to be.

`now` and `zone` are **defaulted arguments**, following `DraftStore.get(now = Date.now())`:
production passes nothing and gets the real clock; tests pass a fixed instant and get a
deterministic prompt. `/core` still reads no globals it hasn't been handed.

---

## 6. Tool registry (core/registry.ts) — seven demo tasks, six tools (+3 in M10, +1 in M11, +3 in M13)

Each tool = `{ name, description, inputSchema, irreversible, handler }`. The
`description` and `inputSchema` are what the LLM sees (they double as the prompt).

| Tool          | Task(s) it serves                    | Reads memory? | Irreversible | Handler does |
|---------------|--------------------------------------|---------------|--------------|--------------|
| `summarize`   | 1. Summarize selection               | no            | safe         | LLM summarizes `context.selectedText`; showResult |
| `rewrite`     | 2. Rewrite selection in my tone      | yes (tone)    | reversible   | LLM rewrites using stored tone; copyToClipboard |
| `openTarget`  | 3. Open a named target               | yes (targets) | reversible   | resolve name→URL, `openUrl` |
| `remember`    | 4. Remember X · 6. Correction sticks | writes        | reversible   | `memory.write()` (versions old fact on conflict) |
| `sendMessage` | 5. Format notes and send             | yes (channel) | **dangerous**| LLM formats notes → Slack webhook POST |
| `recall`      | 7. What do you remember about…       | reads         | safe         | `memory.query()` → showResult with metadata |
| `draftReply`  | 8. Reply to the open Gmail email      | yes (tone)    | caution      | read open email → compose → open reply box → insert draft |
| `reviseDraft` | 9. Tweak that reply                   | yes (tone)    | caution      | re-compose from the LIVE box text → replace it |
| `sendReply`   | 10. Send it                           | no            | **dangerous**| confirm (recipient + whole draft) → click Gmail's Send |
| `addToPage`   | 11. Add a note to the open Notion page | yes (tone)   | caution      | read open page → compose → real-CDP click + type at the end |
| `readSchedule`| 12. What's on my calendar             | no            | safe         | list a time window → format as text |
| `createEvent` | 13. Put something on the calendar     | no            | caution / **dangerous** | create it; `dangerous` when anyone is invited |
| `moveEvent`   | 14. Move something                    | no            | caution / **dangerous** | find it (default-deny) → move; `dangerous` when it has guests |

The `Irreversible` column above is the M10 `risk` tier — see the `risk` subsection below. The first six tools kept
their exact behaviour through that migration: only `sendMessage` and `sendReply` confirm.

`addToPage` is ONE tool, not three like Gmail's reply flow — Notion has no staging area and no
irreversible send, so there is nothing to split a draft/revise/send cycle across. See §6b.

Task 6 ("correction sticks") is not a separate tool — it's the `remember` tool
updating an existing fact, which must (a) mark the old fact version inactive,
(b) insert a new version, and (c) change future `resolve()` results. This behavior
is the flagship demo; make it real, not cosmetic.

### `resolvesReferences` (added in M4)

A tool may also declare `resolvesReferences: false` (default: `true`). The planner runs a
tool's arguments through `memory.resolveArgs()` at step 4 of §5 — correct for tools whose
args are *references* to look up ("my dashboard"), but wrong for memory-**writing** tools
whose args are *literals to store*. Without this flag, a `remember` call carrying
`subject: "the team"` would have that subject silently resolved into the current fact's
value before the handler ran. Like `irreversible`, the planner reads this property
generically — it never knows which tool it is running.

### `risk` (added in M10 — replaced `irreversible`)

Until M10 a tool answered one question: *is this irreversible?* A boolean was enough, because
everything the app could do was either a local, undoable transform or the one Slack POST.
Acting inside another app's GUI breaks that. Most GUI actions have no undo at all — you cannot
un-open a reply box or un-type into a field — so "reversible?" stops being the useful question.
Four tiers (`core/risk.ts`, adapted from clacky's `permission.py`) replace it:

| Tier | Means | Planner does |
|------|-------|--------------|
| `safe` | read-only | run |
| `reversible` | mutates, but recoverable (clipboard, a tab, a versioned fact) | run |
| `caution` | irreversible but routine and low-stakes | run, but **narrate first** |
| `dangerous` | irreversible **and** high-stakes | **confirm first**, no exceptions |

Two things make this more than a rename:

- **Narration stands in for the undo that doesn't exist.** A `caution` tool announces itself
  through the `notify` action (§4) *before* the handler runs. That action kind had sat in the
  `OSShell` contract unimplemented since M0; M10 is the first tool with something to say, so
  narration needed no change to the portability contract. M11 widened `narrate` from
  `(args) => string` to `(args, deps) => string | Promise<string>` — the same evolution
  `confirmSummary` underwent in M10, and for the identical reason: naming the actual page a
  note is about to land in means reading the world first. Same rule as `confirmSummary`: SAFE
  work only, and if it throws, the planner refuses and nothing runs.
- **Default-deny on unidentified targets.** clacky's sharpest idea: a click whose target cannot
  be identified is treated as dangerous. Here that lives one level down, in `gmailScript.ts` —
  a control that matches zero elements *or more than one* is never clicked at all. If we cannot
  say which button this is, we do not press it.

### Argument-dependent tiers (added in M13)

Through M12 a tier was a property of the **tool**: `sendReply` was `dangerous` whether the
reply was one line or ten, because sending is sending. Calendar breaks that, for a specific
structural reason worth stating rather than assuming.

Gmail could gate on `sendReply` alone because drafting and sending are **separate moments** —
so `draftReply`/`reviseDraft` stayed `caution` and only the send needed a confirm. A calendar
event has no equivalent later step: attendees are emailed the instant it is **created or
moved**. There is no "send" left to gate. So the same tool is routine when the event is yours
alone and high-stakes when it puts a meeting invite in someone else's inbox, and the only
thing separating the two is the **arguments of that particular call**.

A tool's `risk` may therefore be either a plain tier (still the common case — every tool
built before M13 is untouched) or a `RiskPolicy`:

```ts
interface RiskPolicy<Args, Deps> {
  readonly tiers: readonly Risk[];              // every tier this could ever return
  resolve(args: Args, deps: Deps): Risk | Promise<Risk>;
}
```

Three things make this safe rather than a loophole:

- **`tiers` is declared up front.** Registry-wide invariants are statements about the whole
  menu — "anything that *can* be dangerous has a `confirmSummary`" — and they have to be
  answerable **without calling anything**. Discovering tiers at runtime would make them
  uncheckable. `tests/risk.test.ts` reads `declaredTiers()` for exactly this reason, and
  `createEvent`/`moveEvent` are the first tools that need **both** `narrate` *and*
  `confirmSummary`, because either tier is reachable.
- **Escalate, never de-escalate.** If `resolve` throws — calendar unreachable, token expired,
  event vanished — or returns a tier it never declared, the planner takes the **worst** tier
  declared. A classifier that fails must not be able to talk the planner *out* of a gate: the
  failure mode of "we could not tell" has to be "ask", not "go ahead". In practice the
  escalation lands on `dangerous`, `confirmSummary` then fails on the same broken read, and
  the planner refuses outright — fail-closed at both steps.
- **`resolve` may do SAFE work only.** It runs *before* any gate has fired, so it must never
  change the world it is classifying — the same rule `confirmSummary` got in M10 and
  `narrate` got in M11, widened for the same reason: `moveEvent` has to look up whether the
  event it would move has guests, and that fact lives in the calendar, not in the arguments.

### `confirmSummary` (added in M5, widened in M10)

An irreversible tool should also define `confirmSummary(args): string`. The planner calls it
with the **resolved** arguments (step 4 runs before step 6), so the confirm dialog always
describes the *concrete* action — "Send to #design-team?" — and never the vague phrasing the
user typed ("send to the team"). Showing the unresolved version would be a trust bug: the
user must approve what will actually happen. Tools without it fall back to a generic
`Run <tool>?`.

M10 widened it to `(args, deps) => string | Promise<string>`. A GUI action's concrete facts —
who this reply would actually reach, what is sitting in the box right now — live in the app
being acted on, not in the arguments the model proposed, so a dialog that could not read them
would be describing a guess. It may do **SAFE work only**: it runs before the user has agreed
to anything. If it throws, the planner never opens the dialog and nothing runs — "we cannot say
what would happen" is itself a refusal.

---

## 6a. The Gmail reply flow (M10)

Scoped to **Gmail in Chrome**, deliberately and only. Two halves, split because they age
differently: the writing half (`core/compose.ts`) is app-agnostic — content + a free-form
instruction + the stored tone → new text, the generalization of `rewrite` — and the finding
half (`core/gmail/`) is not, and needs real per-app verification.

- **How it reaches the page.** A hand-rolled CDP client (`CdpClient.ts`) attaches to a tab in
  a Chrome the user started with remote debugging. `gmailScript.ts` is injected with
  `Function.prototype.toString()`, which is why it imports nothing and takes its `document` as
  a parameter — the same constraint that lets the identical function run under jsdom in tests.
- **How it picks a tab.** Of the `mail.google.com` tabs, exactly one must satisfy the operation
  (a message open, or a reply box open). Zero or several is a refusal: with two tabs mid-reply
  there is no honest way to know which draft was meant.
- **Iterative tweaks.** `core/draft.ts` holds one draft with a 15-minute TTL. It is deliberately
  NOT in the memory engine: memory holds versioned facts about the user that should outlive the
  session, and a draft is scratch state that should evaporate. A revision reads the **live**
  compose box first and only falls back to the stored copy, so a hand-edit the user made is
  never silently thrown away.
- **Sending.** Only through `sendReply`, which is `dangerous`, whose dialog shows the real
  recipients and the **whole** draft rather than a preview. Typed or dictated makes no
  difference: both converge on one planner call site (§4a) and the gate reads the tool's tier.

**Out of scope for M10, and not scaffolded:** any app other than Gmail-in-Chrome; any
screenshot/vision-based clicking; composing a new email with none open; auto-selecting screen
content; the Gmail API; multi-step autonomous loops. **Known limits:** Gmail's English UI only
(the labels are matched literally, and a localised UI refuses rather than misfires), and one
reply at a time.

---

## 6b. The Notion page-writing flow (M11)

Scoped to **Notion in Chrome, one open page, append only**. Built to answer a question M10
left open: was the compose.ts/gmail split a real architectural seam, or just a description of
Gmail? A second, structurally different app (a block editor with no send action, no staging
area, autosave) was the test.

**What generalized, and what did not.**

- `core/composeShared.ts` — genuinely app-neutral: sounding like the user, the standing rule
  against inventing content, the guard against writing emptiness. Both `compose.ts` (replies)
  and `composeNote.ts` (notes) import it.
- The reply/note SHAPE did **not** generalize. `compose.ts`'s rules mandate a greeting and
  sign-off and forbid a subject line — a note has none of that furniture, because it was never
  addressed to anyone. Broadening one function to cover both would have meant one prompt
  branching on which app it's for, exactly the coupling the M10 split existed to avoid.
- `core/draft.ts` did **not** generalize, and stays Gmail-only. It exists because Gmail owns a
  staging area with a lifetime (a compose box that sits open between turns). Notion has no
  staging area, so there is nothing to stage. A parallel `NoteStore` would have one writer, no
  reader, and nothing to hold.
- The **tool shape** did not generalize either: one tool (`addToPage`, `caution`), not three.
  Gmail has three world-states (nothing → private draft → sent); Notion has two (nothing →
  written and autosaved). There is no revision tool: editing what was just written means
  deleting real content from a live document with no staging area, a materially higher-risk
  operation this milestone deliberately did not add. A follow-up like "make that note shorter"
  correctly logs as a miss.
- **The safety RULE generalized; its instantiation did not.** M10's rule was never literally
  "role + accessible name" — that was Gmail's instantiation of "resolve the target
  structurally, refuse on zero or ambiguous matches." Live inspection found Notion's body
  content carries **no ARIA roles at all** (only the page title does), so `notionScript.ts`
  identifies the append target by `data-block-id` and document order instead — "the last block
  on the page" is not a guess among several candidates the way picking one of several
  role-matched elements would be; it is the one unambiguous meaning of "the end of the page."

**How it reaches the page — and the one genuine mechanism difference from Gmail.** Gmail's
compose box is an ordinary browser-native `contenteditable`, and JS-dispatched calls
(`el.focus()`, `document.execCommand()`) work on it correctly — that is `gmailScript.ts`'s
entire mechanism. Live testing found Notion's editor does **not** respond to those calls: they
report success but save nothing, repeated across several distinct approaches (direct click,
focus + Selection/Range + `execCommand`, focusing the shared editor root). What does work,
confirmed live and now the shipped mechanism, is real CDP-level input — `Input.dispatchMouseEvent`
and `Input.dispatchKeyEvent` (both added to `core/browser/CdpClient.ts` in M11, alongside the
`Input.insertText` M10 already used) — the same signal a physical mouse and keyboard produce.
Consequently `notionScript.ts` only **finds and reads** (jsdom-testable, like `gmailScript.ts`);
`ChromeNotion.ts` does the clicking, keying, and typing, informed by what the script locates.
A single multi-line `insertText` blob also turned out to silently drop everything after the
first `\n` — Notion needs one real Enter keypress between lines, not an embedded newline.

- **How it picks a tab.** Lifted into `core/browser/tabs.ts`'s generic `pickTab()` — the same
  zero/many refusal rule Gmail uses, reused rather than duplicated. One refinement: nearly
  every open Notion tab satisfies "has an editable page" (unlike Gmail, where "a message is
  open" is a much narrower condition), so the flat rule alone would refuse constantly with two
  Notion tabs open. `pickTab`'s `narrow` step breaks the tie by `document.visibilityState`,
  preferring the foreground tab, and only falls through to a real refusal if that still leaves
  zero or several.
- **Verification, not trust.** Because Notion can report a successful DOM operation that saved
  nothing, `appendToPage` re-reads the page after typing and refuses to claim success unless
  the appended text is actually present in the read-back body.

**Out of scope for M11, and not scaffolded:** page search or navigation; multi-page operations;
sharing or publishing; databases and database rows; editing or removing existing content; the
Notion API; any vision-based fallback; the Notion desktop app (Chrome tab only — the debug
Chrome setup Gmail already uses is what M11 was built against; the desktop app is a different,
unverified transport). **Known limits:** one page at a time, and the CDP-level input path
appears to require the tab be the genuine foreground tab in its Chrome window (unverified
*why* — plausibly Chrome deprioritizing hit-testing for a backgrounded tab's compositor), so
`ChromeNotion` calls `Page.bringToFront` before acting, unlike Gmail's tools.

---

## 6c. The calendar flow (M13)

Google Calendar, via its **API** — not the DOM, not CDP, not a browser at all.

That is a reversal of M10 and M11, and the reason is specific rather than a change of taste.
Gmail and Notion were driven through a browser because the *point* was a live, editable draft
the user could read and tweak before it went anywhere: a reply box with words in it. A calendar
event is structured data — a title, a start, an end, a guest list. There is nothing to tweak in
place, so a DOM buys nothing and costs a dependency on Google's markup surviving a reskin. This
is much closer to how `sendMessage` already works than to how `draftReply` does.

**Three tools:**

| Tool | Task | Tier | Handler does |
|------|------|------|--------------|
| `readSchedule` | 12. What's on | `safe` | list a window → format |
| `createEvent` | 13. Put it on the calendar | `caution` / **`dangerous`** | create; guests are emailed at once |
| `moveEvent` | 14. Move it | `caution` / **`dangerous`** | look up → move; guests are emailed at once |

**Why the tier is argument-dependent** — the design decision this milestone turned on. Gmail
could gate `sendReply` alone because drafting and sending are separate moments. A calendar event
has no equivalent later step: attendees are emailed the instant it is created or moved, so there
is no "send" left to gate. The tier therefore has to come from the *arguments of that call*, not
from which tool was picked. See "Argument-dependent tiers" under §6 for the mechanism.

`createEvent` reads its guest list straight from its own arguments. `moveEvent` has to **look one
up** — "push the review to 4" says nothing about who is on it — which is why `RiskPolicy.resolve`
receives `deps` at all.

**What holds it together:**

- **Default-deny on which event.** `moveEvent` matching zero events, or more than one, refuses
  and names the candidates. The same rule `gmailScript.ts` applies to buttons, one level up:
  if we cannot say *which* one, we do not touch any of them.
- **The search term is the event's NAME, not the sentence it was said in.** Google's `q=` ANDs
  its terms, so every extra word is another thing the event must contain — "the test one
  meeting" finds nothing when the event is called "test one". Two defences, because the tool
  description alone is not one: the description asks the model for the name with filler left
  out, and `resolveTargetEvent` searches the **exact phrasing first**, retrying without filler
  words only when that found nothing. The order is the design — an event genuinely called
  "Team meeting" matches on the first attempt and never reaches the loosening, so a word like
  "meeting" is only ever stripped at the point where the alternative is refusing outright.
  Since `q=` ANDs, dropping terms can only find *more*, never something different, which is
  why the filler list does not have to be perfect. It never searches for an empty term.
- **Two events it declines to move.** A **recurring** instance (instance-or-series is a real
  choice with a real wrong answer — Google's own UI asks) and an **all-day** event. Both refuse
  by name rather than guessing.
- **All-day is read but never written.** `readSchedule` shows all-day events, `createEvent`
  declines to make one, and `moveEvent` declines to move one. A bare `2026-08-26` parses as a
  real moment, so without an explicit refusal "block out Thursday" would quietly become a
  midnight-to-midnight timed event — a plausible-looking wrong answer, the worst kind.
- **A guest with no address stops the call.** Dropping an unusable entry would take the
  attendee count to zero, downgrade the tier from `dangerous` to `caution`, and skip the
  confirm gate — the unsendable entry is the whole reason to stop.
- **A time-of-check/time-of-use guard.** `moveEvent`'s tier is decided by reading a guest list;
  someone can add a guest between that read and the act. The handler re-reads and refuses if
  the event has guests while the call resolved to `caution` — otherwise a call nobody was asked
  to confirm would email a person nobody mentioned. This is what `ToolDeps.tier` exists for.
- **The scope is `calendar.events`, and that constrains which endpoints exist.** Least privilege
  costs something specific here, learned on the first live run: `GET /calendars/primary` is the
  **Calendars** resource, which that scope does not grant, so reading the calendar's timezone
  from it returned `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. The timezone is taken from the
  **events listing's own envelope** instead — every `events.list` response carries it — which
  needs no extra scope, no reconnect, and usually no extra request, since `readSchedule` and
  `moveEvent` both list before they need it.
- **A 403 is not one thing.** Google returns it for a missing scope, for an API nobody enabled,
  and for a rate limit — three problems, three different fixes, and only one of them resembles
  "your access was revoked". They are classified from the error envelope's `reason`.
- **Google's quirks stop at one file.** `googleCalendarMap.ts` is M13's `gmailScript.ts`: pure,
  exhaustively tested, and the only place that knows Google includes the **organizer** in
  `attendees` (left alone, every solo event looks like it has a guest and *everything* gets
  gated), that an all-day `end.date` is **exclusive**, and that `date` and `dateTime` are
  different fields.

**Out of scope for M13, and not scaffolded:** recurring events (beyond refusing to move one);
choosing a calendar (primary only); free/busy lookup across other people's calendars; natural-
language date parsing below the planning layer (the model resolves "tomorrow at 3" from the
clock in the prompt — see §5); creating all-day events; deleting events; responding to
invitations.

---

## 7. Memory engine (core/memory/)

Local SQLite via better-sqlite3. This is the v0 stand-in for / seed of the personal
OS. Keep the API small and clean so it can later point at Postgres/Neon.

### Schema
```sql
CREATE TABLE facts (
  id          INTEGER PRIMARY KEY,
  subject     TEXT NOT NULL,        -- e.g. "team", "tone", "target:upwork"
  value       TEXT NOT NULL,        -- e.g. "#design-team", "concise and warm"
  confidence  REAL NOT NULL DEFAULT 0.8,
  source      TEXT,                 -- e.g. "user:2026-07-13"
  version     INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,  -- 0 when superseded
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE action_log (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  instruction TEXT NOT NULL,
  tool        TEXT,                 -- null when no tool matched
  arguments   TEXT,                 -- JSON
  result      TEXT,
  status      TEXT NOT NULL         -- "ok" | "refused" | "no_tool" | "error" | "cancelled"
);
```

### API (memory.ts)
```ts
resolve(reference: string): { value: string; confidence: number } | null
  // maps a vague reference to a concrete active fact.
  // "the team" -> subject "team"; "my upwork" -> "target:upwork"; etc.
  // On conflicting active facts, return the highest-confidence / most-recent one.

write(subject: string, value: string, opts?: { confidence?; source? }): void
  // if an active fact with this subject exists and value differs:
  //   set old.active = 0, insert new row with version = old.version + 1.
  // else insert version 1. This gives versioning + contradiction handling.

query(subjectLike: string): Fact[]
  // for `recall`: return active facts (with confidence + updated_at) for display.

logAction(entry): void
logMiss(instruction: string): void   // status "no_tool"
```

**Decay (light v0 version):** when `resolve()` reads a fact, if `updated_at` is old
(e.g. > 30 days), return a reduced confidence. Full decay/versioning depth is a v1
concern; keep v0's version just real enough to demo correction + confidence.

---

## 8. Unregistered requests (graceful edge)

When the LLM declines or proposes a tool not in the registry:
1. Do not act, do not invent a capability.
2. Show an honest refusal: `"I can't do that yet — I don't have a tool for X."`
3. `memory.logMiss(instruction)` so the misses become a ranked backlog of what to
   build next.
4. Reinterpretation is free: many "unsupported" phrasings map onto an existing tool
   because the LLM matches on meaning — let that happen naturally; only genuine
   no-match requests reach refusal.

v0 is a **closed world**: it can only do the six registered things. That is what
keeps it reliable and demoable. Open-world (arbitrary code / computer-use) is v2.

### Unresolved references (added in M6)

Distinct from a refusal: the request *was* understood, we simply don't know the fact
yet ("open my dashboard" before anything was taught). A tool throws
`UnresolvedReferenceError` (`core/errors.ts`); the planner shows its message verbatim
(no "Something went wrong" wrapper) and logs the action as **`refused`** — a status
already in the §7 vocabulary, so the schema is unchanged. The planner distinguishes
the error *type*, never the tool.

---

## 9. Build order (milestones — each is a real stopping point)

Work strictly top to bottom. Build against `MockShell` until M0's real hotkey step.

- [x] **M0 — Skeleton.** Electron app + tray. Global hotkey opens the command bar,
      echoes typed text, closes. No LLM, no memory. Proves the shell + UX.
- [x] **M1 — First task.** Implement `summarize` end to end (capture → planner →
      LLM → showResult). No memory yet.
- [x] **M2 — The router.** Add `rewrite` and `openTarget` so the planner must
      *choose* between tools via tool-calling. Values still hardcoded.
- [x] **M3 — Memory read.** Wire `memory.resolve()` so "my dashboard" and "my tone"
      come from SQLite instead of constants.
- [x] **M4 — Memory write + correction.** Implement `remember`. A correction must
      version the old fact and change future `resolve()` output. This is the
      differentiator — give it real attention.
- [x] **M5 — Slack + confirmation.** Implement `sendMessage` with the confirm gate
      before POSTing to the webhook.
- [x] **M6 — Eval + recall.** Implement `recall`. Add a `tests/` suite of ~15
      scripted instructions run against `MockShell`, including a before/after
      memory comparison that shows tasks getting smarter after `remember`.

Definition of done for v0: M0–M6 complete, all tests green against MockShell, the
seven demo tasks work on Windows, and misses are logged.

Post-v0:

- [x] **M7 — Voice input.** A second hotkey toggles recording; the transcript goes to
      `planner.run()` on the same path typed text does. Local whisper.cpp only. Adds
      `VoiceShell` + `VoiceSession` (§4a) and a `Transcriber` interface; `/core`'s
      planner, registry, tools, and memory are untouched.
- [x] **M8 — One hotkey, and a duplicate-run fix.** Collapses M7's two hotkeys into one
      that opens the bar *and* starts listening (§4a), and fixes a listener leak in
      `showInput()` that was firing the planner once per abandoned bar opening.
- [x] **M10 — Instruction-driven email reply (Gmail in Chrome).** Adds the 4-tier `risk`
      model (§6's `risk` subsection) replacing `irreversible`; `core/compose.ts` (the app-agnostic generalization
      of `rewrite`); `core/draft.ts` (short-lived draft state for iterative tweaks); the
      `GmailSurface` interface with a CDP-backed implementation in `core/gmail/`; and three
      tools — `draftReply`, `reviseDraft`, `sendReply` (§6a). See "M10 — proven vs. live-only"
      below for the honest split.
- [x] **M9 — Make both fixes hold.** Binds capture cleanup to the window's own events so
      the leak cannot return silently (§4a), pins it with `tests/WindowsShell.capture.test.ts`,
      and turns a truncated `chooseTool` response into an explicit outcome instead of a
      misreported refusal (§3a).
- [x] **M11 — Instruction-driven page writing (Notion in Chrome).** Extracts the app-agnostic
      `CdpClient`/`pickTab` layer into `core/browser/` (M10 built it Gmail-only; M11 is the
      first thing to reuse it); splits `core/compose.ts` into `composeShared.ts` (genuinely
      shared) + `composeNote.ts` (Notion's own rules); widens `narrate` to
      `(args, deps) => string | Promise<string>`, mirroring `confirmSummary`'s M10 widening;
      adds the `NotionSurface` interface with a CDP-backed `ChromeNotion` (real device-level
      input, not `execCommand` — see §6b for why); and one tool, `addToPage` (§6b).
- [x] **M12 — System-wide dictation.** Adds `InputInjector`/`WindowsInputInjector` (§4c,
      `SendInput`+`KEYEVENTF_UNICODE` over a persistent PowerShell host — the first thing in
      this app to act on the OS outside a browser or the app's own bar); `DictationSession`;
      a SEPARATE, negotiated dictation hotkey; and `dictate.ts`'s mutual-exclusion guard
      against the instruction bar's own voice capture. Never reaches the planner — no
      registry entry, no risk tier, no confirm gate (§4c explains why that is a deliberate
      omission, not a gap). `/core` is untouched.
- [x] **M12.1 — Enter replaces the same-hotkey stop.** `DictationSession` originally shipped
      M7's toggle shape (tap the hotkey again to stop); live use showed people reflexively
      reach for Enter instead. Replaced with `begin()`/`finish()` — the same shape as
      `VoiceSession` — with `finish()` now firing on a global Enter press
      (`WindowsShell.armStopKey`/`disarmStopKey`, the same focus-independent-registration
      precedent Escape already set). Widens `dictate.ts`'s mutual-exclusion guard
      (`combineInstructionBusy`) to cover the instruction bar's whole open lifetime, not just
      while its voice sub-capture is recording — necessary now that Enter is a trigger both
      flows can reach for. See §4c and §9's M12.1 for the tradeoff this brings.
- [x] **M12.2 — Live-testing fixes: hotkey, cap length, a double-finish race, and chunk
      timing.** Four fixes from further live use, none changing the design of §4c: `Ctrl+M`
      promoted to the first dictation-hotkey candidate (a genuine 2-key combo, faster to
      reach for than the 3-4 key fallbacks); `DEFAULT_MAX_RECORDING_MS` raised 30s → 90s
      (30s was cutting off genuinely longer dictated thoughts with no warning), plus a 10s
      pre-cap warning narration; `finish()` now claims the session (`enter("transcribing")`)
      *before* its first `await`, closing a real race where Enter's global callback firing
      twice for one physical press let two concurrent `finish()` calls both pass the top-of-
      method guard and race into typing — the interleaved-character corruption this produced
      live is exactly what the fix targets; `WindowsInputInjector`'s chunking tightened from
      `25 chars/8ms` to `1 char/40ms` after live testing found the faster pacing tripping
      Windows' own key-repeat handling into genuine OS-level character repetition
      (`KEYEVENTF_UNICODE` events carry no real virtual-key code, so a fast enough stream of
      them is not the same as real typing) — at the direct cost of longer dictations now
      visibly taking longer to type.

**v0 status: complete.** 242 tests green (`npm test`) — 63 for v0, 24 added by M7, 37 by
M8/M9, 41 by M10, 36 by M11, 30 by M12, and 11 by M12.1 (M12.2 added no new tests — all four
fixes are covered by existing coverage, adjusted where a fix changed an assertion's shape;
see §9's M12.2 for specifics) (against `MockShell`, fake Gmail/Notion tabs, jsdom fixtures,
and a `MockInputInjector` standing in for real `SendInput`; no browser, inbox, Notion account,
or OS keystroke is ever touched by the test suite). The eval harness
(`npm run eval`, `tests/eval/`) runs the memory story as one continuous scenario — cold memory
refuses →
teaching fixes it → a correction versions it → recall reveals it — plus the seven demo tasks
and the closed-world refusal.

**Live-run findings:** what actually got tested, against a real `OPENAI_API_KEY` and a real
Slack webhook, and how it went:

- `open my dashboard` (cold, before any fact existed) → correctly refused, no action fired.
- `remember my dashboard is <url>` → fact stored; `open my dashboard` immediately after →
  resolved and opened the corrected URL. Resolve/write round-trip confirmed live, not just
  against `MockShell`.
- `summarize this` → real `complete()` call against `gpt-5`, summary returned and displayed.
  (This is also what surfaced the command-bar UI bugs — result area wasn't scrollable and
  the window was mis-sized/mis-positioned — fixed in `styles.css` / `main.ts`, unrelated to
  the LLM layer itself.)
- `send this to the team` → cold run correctly refused with "I don't know which channel...";
  after `remember the team is #social`, the retry resolved the channel, passed the confirm
  gate, formatted the notes, and **posted for real** to the Slack webhook — confirmed
  delivered. The one-shot nature of `WindowsShell.showInput()` matters operationally here:
  each instruction needs its own hotkey press, retyping into an already-submitted bar is a
  no-op because that cycle's IPC listener is already removed.
- The correction-routing case below was the one real bug this surfaced, and it's now fixed.

Tool choice, memory resolve/write, the confirm gate, and correction versioning all fire
correctly end to end on real infrastructure — this app works live, not just against fakes.

The correction-routing case surfaced a real gap, though: a correction that names its subject ("no, my dashboard is
actually `<url>`") routes to `remember` reliably, but a *bare* correction ("no I meant
this `<url>`") was inconsistent — the model sometimes declined, sometimes mis-fired
`openTarget` — because `chooseTool` was stateless and had no way to know what "this"
referred to. Fixed by giving the planner one turn of state (§5 step 1: the previous
`ActionLog` entry, passed to `chooseTool` for correction/pronoun resolution only). This
narrows the gap, it doesn't eliminate model judgment for genuinely ambiguous phrasing —
the tests prove the mechanism, not perfect routing. If a correction still mis-routes,
the fix is the `remember` **description** or the previous-turn framing in
`src/core/llm/prompt.ts`, not the planner's control flow.

**Provider is now selectable, not pinned:** `LLM_PROVIDER` (§3) chooses `AnthropicLLMClient`
or `OpenAILLMClient` at startup (`src/core/llm/factory.ts`), both behind the same
`LLMClient` interface. Only **OpenAI/gpt-5** has been live-verified (the findings above,
3/3 consistent runs on the correction-routing fix). **Anthropic/claude-sonnet-4-6 has not
been live-tested at all** — it's implemented against the same interface and typechecks,
but its actual tool-calling behavior against a real key (including the correction-routing
case above) is unverified until someone runs it live.

### M10 — proven vs. live-only

**Proven deterministically (41 new tests, no browser and no inbox):** drafting reads the email,
opens exactly one reply box and puts the draft in it; the narration goes out *before* anything
touches Gmail (asserted as an ordering fact across a shared timeline, not inferred); the draft
is composed *before* the reply box is opened, so a model failure leaves Gmail untouched; a
revision edits the same draft and never opens a second box; a revision prefers the user's
hand-edited box text over the stored copy; an expired or absent draft refuses honestly rather
than starting fresh; `sendReply` sends nothing on a declined confirm, exactly once on an
accepted one, shows the real recipient and the whole draft, and never even opens the dialog when
there is nothing to send; the draft is cleared after sending; the Gmail tools are absent from the
menu entirely when Chrome is not configured. The injected script is tested under jsdom against a
Gmail-shaped fixture: it clicks Reply (found by `role="link"`, matching Gmail's real markup, not
`role="button"`) and not Reply all, refuses on zero matches, refuses on ambiguity, ignores hidden
controls, never matches on class or position, finds Send through Gmail's bidi label characters,
scopes Send to the reply's own dialog, and reads the sender's display name (`fromName`) off the
`name` attribute, falling back to text content.

**Also proven, from tonight's live-Gmail fixes:** `draftReply` drafts and writes a reply for a
vague, content-free instruction ("generate a reply") rather than refusing or asking a
clarifying question; `composeReply`'s system prompt always instructs the model not to invent
the user's opinions, requests, or stance, and to write a brief neutral acknowledgment when the
instruction is vague and the source email makes no direct ask; a genuine declined-text answer
from the model (a clarifying question, say) reaches the user verbatim through `refuse()` rather
than a canned "no tool for that" message, which still applies when the model gives no text.

**NOT proven, and only a live run can prove it:** that `gmailScript.ts`'s selectors match the
real Gmail DOM. The fixture is something this repo wrote. Every selector is in that one file for
exactly this reason, and each one fails loudly rather than guessing — so the failure mode of a
Gmail redesign is a refusal, not a wrong click. Also unproven until run live: the CDP transport
against a real Chrome, and whether the model reliably routes a follow-up tweak to `reviseDraft`
rather than `draftReply` (the same class of model-judgment risk as the correction-routing case
above; if it mis-routes, the fix is the tool **descriptions**, not the planner).

### M11 — proven vs. live-only

**Proven deterministically (36 new tests, no browser and no Notion account):** the
`browser/` extraction changed nothing about Gmail's behavior (`tests/gmail.test.ts` and
`tests/compose.test.ts` pass **byte-for-byte unedited** — the acceptance bar M11 set for both
refactors); `pickTab`'s zero/many refusal rule, generic and Gmail-proven, applies unchanged
when `narrow` is absent; `addToPage` reads the page and composes *before* touching Notion, so
a compose failure leaves the page untouched; narration names the real page title and goes out
*before* `appendToPage` runs (an ordering fact across a shared timeline, same technique as
M10's Gmail tests); a throwing `narrate` now fails the whole action before the handler runs,
proven generically against a synthetic tool (not tied to any one real tool); an existing
synchronous, zero-argument `narrate` still works unmodified; the tool is absent from the menu
when Chrome isn't configured; there is no revision tool, so a follow-up tweak instruction
correctly falls through to a miss. `notionScript.ts` is tested under jsdom against a fixture
**transcribed from a live recon dump** (`scripts/notion-recon.mjs`), not hand-authored: it
finds the page title (the one place body content carries a role), scopes page-body reads to
`.notion-page-content` specifically (a broader guess, `.notion-scroller`, matched the
*sidebar's* scroller first in the real DOM), targets the last real `data-block-id` block and
never the page's own wrapper block, and refuses when there is no real content block to anchor
an append after.

**Proven live, against the real app.notion.com page used for M11 planning (not just fakes):**
the actual mechanism this milestone's design rests on — JS-dispatched `.click()`, `.focus()`,
and `document.execCommand()` calls report success on Notion's editor but silently save
nothing, confirmed across several independent attempts (direct click, focus + Selection/Range,
focusing the shared editor root); real CDP-level input (`Input.dispatchMouseEvent` +
`Input.dispatchKeyEvent` + the existing `Input.insertText`) does work; a single
`Input.insertText` call containing an embedded `\n` silently drops everything after the first
newline, while a real Enter keypress between separately-typed lines correctly creates a
genuine new block each time; the CDP tab needs to be the genuine foreground tab for real input
to register (`ChromeNotion` calls `Page.bringToFront` for this reason — unverified *why*).
The **shipped** `ChromeNotion` class (not a throwaway probe) was then run against the same
live page end to end: `readOpenPage` returned the real title/URL/body, and `appendToPage`
appended real, multi-line, marker-tagged text that was independently confirmed present on
re-read. A live Gmail regression (`ChromeGmail.readOpenEmail`, SAFE/read-only, against a real
inbox) confirmed the `browser/` extraction broke nothing in production, not just in tests.

**NOT proven, and only further live use can prove it:** whether `notionScript.ts`'s selectors
and `ChromeNotion`'s CDP sequence hold up against Notion's markup on pages with materially
different content (long pages, non-text block types adjacent to the target, a genuinely
locked/read-only page — no such page was available to test against, so `appendToPage` has no
dedicated "is this locked" pre-check and instead verifies success by reading the page back
after acting, refusing to claim success it cannot confirm); whether `Page.bringToFront`'s
visible tab-switch is an acceptable UX cost in regular use, since — unlike every Gmail tool —
using `addToPage` will visibly bring Chrome to the foreground; and whether the model reliably
avoids routing a revision-style follow-up ("make that note shorter") to `addToPage` instead of
producing an honest miss, the same class of model-judgment risk M10 flagged for
`reviseDraft` vs. `draftReply`.

### M12 — proven vs. live-only

**Proven deterministically (30 new tests, no PowerShell process and no OS keystroke):**
`DictationSession`'s full state machine, including the cap/stop/abandon paths, is pinned the
same way `VoiceSession`'s is (`tests/DictationSession.test.ts`, against `MockInputInjector`).
Specifically: `toggle()` from idle captures the foreground window before narrating anything
and before the microphone opens; a normal cycle stops, transcribes, re-checks focus, and types
in that order (`recording -> transcribing -> inserting -> idle`, asserted as an ordering fact,
not inferred); a focus change between speaking and typing refuses outright, with the
transcript preserved in the refusal message, and types nothing; the same refusal fires when
the starting focus could not even be captured (no target is treated as unsafe, never as safe
by default); a short/blocked `typeText()` write becomes a thrown-and-caught refusal, never a
partial type, and the session is not left stuck — the next tap starts a fresh recording; the
30s cap releases the microphone without transcribing or typing, and a capped recording holds
indefinitely until the next tap or `abandon()`; `abandon()` discards a live recording silently,
matching `VoiceSession`'s own rule that a cancel is not an error; the transcript is typed
byte-for-byte with no Enter synthesized around it and no rewrite pass over it. Separately
(`tests/WindowsShell.capture.test.ts`), the regression this milestone's `endCapture()` change
exists for is pinned directly: Escape, a direct `window.hide()`, and the window closing all
still discard a dictation session even though it never calls `showInput()` — before the fix,
`endCapture()`'s guard fired only when a typed-text capture was pending, so a dictation-only
session (mic live, no pending `showInput()`) was invisible to every dismissal path; a second,
narrower regression the same fix introduced and then closed is also pinned — `hide()` reaches
`endCapture()` twice on one call (its own explicit invocation and the "hide" event that same
call emits a moment later), and the fix's own naive first draft double-fired `onDismiss()` on
that second call, caught by re-running the EXISTING `VoiceSession` Escape test, not a new one.
`pinnedAgainstBlur` covers the new `"inserting"` state exactly like `"recording"`/
`"transcribing"`. The mutual-exclusion guard (`tests/dictate.test.ts`) is proven generically:
the dictation hotkey is blocked while the instruction voice session is non-idle and fires again
once it returns to idle; it is never blocked when there is no instruction voice at all (voice
disabled means nothing to conflict with, not "always blocked").

**NOT proven, and only a live run can prove it:** that `WindowsInputInjector`'s PowerShell host
actually compiles and runs its `SendInput`/`GetForegroundWindow` P/Invoke declarations under
real `powershell.exe` — verified once, manually, outside the test suite (an inert, zero-length
`SendInput` call plus a real foreground-window read, deliberately chosen so the verification
step itself could never inject a keystroke into this machine), but never exercised by
`npm test`, the same "no real binary in CI" split `WhisperCppTranscriber` and `ChromeGmail`'s
CDP transport already have; whether real keystrokes actually land correctly in materially
different real targets (a terminal, an IDE with its own autocomplete, a browser's own text
fields, Word/Excel specifically, given the M12 hotkey list was chosen around exactly those
apps' existing shortcuts); whether the elevated-window refusal (UIPI blocking `SendInput`)
fires the way the design assumes rather than failing some other way; whether `CHUNK_SIZE_CHARS`
/`CHUNK_DELAY_MS` hold up against an editor with heavier per-keystroke processing than anything
tested; and whether the 30s cap is the right length in practice — flagged in code and here as a
value real live use may need to adjust, not a settled constant.

### M12.1 — Enter replaces the same-hotkey stop

The first live test of M12 surfaced the toggle gesture as the wrong mental model: reflexively,
people reach for Enter to stop dictation, the way the instruction bar's own M8 flow already
works. `DictationSession.toggle()` was replaced with `begin()`/`finish()` — the SAME shape as
`VoiceSession` — with `finish()` now firing on a global Enter press
(`WindowsShell.armStopKey`/`disarmStopKey`) armed only between `begin()` and the session
returning to idle. See §4c above for the revised gesture and the tradeoff it brings (Enter is
captured system-wide for the duration of a recording).

**Proven deterministically (11 new/changed tests, no PowerShell process and no OS keystroke):**
`DictationSession.test.ts` was rewritten around `begin()`/`shell.pressStopKey()` (a `MockShell`
test helper standing in for the real global Enter press, the same "simulate the OS/IPC
boundary" idea `ackVoiceStarted()` already used) — the same invariants M12 proved (ordering,
focus re-check, short-write refusal, cap behavior, abandon) still hold under the new gesture,
plus new coverage: `begin()` arms the stop key exactly once and a full cycle disarms it exactly
once, whatever path got it back to idle (success, cap, or `abandon()`); a stray Enter before
any `begin()` is a harmless no-op; `begin()` itself now guards idle-only (the dictate hotkey is
start-only — a repeat press mid-recording no-ops, matching `VoiceSession`'s own "ignores
begin() while already listening"). Against the REAL `WindowsShell` (mocked electron, not
`MockShell` — the only faithful way to prove the global registration itself, not just the
session's own logic), `tests/WindowsShell.capture.test.ts` proves: firing the real "Return"
accelerator while a session is recording runs `finish()` end to end (stop → transcribe → focus
recheck → type); the accelerator is unregistered the moment the session returns to idle, so
Enter is free again for every other app; Escape still cancels independently of Enter;
`WindowsShell.isInputCapturing()` reflects `pendingInput` truthfully. `dictate.test.ts` proves
`combineInstructionBusy` generically: busy while voice is recording (unchanged from M12), busy
while the bar is merely open even with voice already idle (the gap this milestone closes), idle
when neither is busy.

**NOT proven, and only a live run can prove it:** whether registering "Return" as a global
shortcut ever collides with another already-running app that owns it (the logged-error path
exists but nobody has hit it); whether capturing Enter globally for an entire recording feels
right in practice, versus being surprising the first few times a normal Enter press elsewhere
gets swallowed while dictation happens to be running; and everything M12's own "not yet
proven" list already named that this change doesn't touch (real keystroke delivery, the
elevated-window refusal, chunk timing, the 30s cap's length).

### M12.2 — four live-testing fixes, no new tests

Unlike every prior dictation milestone, this one shipped from LIVE use directly rather than
being planned and reviewed first — all four fixes below were made, then run against the
existing suite, which caught one real regression from the fourth fix before it landed (see
below). None of the four change §4c's design; they are constant tweaks and one race-condition
fix inside it.

**1. `Ctrl+M` promoted to the first dictation-hotkey candidate.** Live use flagged the
original `Ctrl+Shift+Alt+D`/`Ctrl+Alt+D`/`Ctrl+Alt+J` candidates as slower to reach for
repeatedly than a genuine 2-key combo. No conflict found in Chrome, VS Code, Word, or Excel.
Coincidentally adjacent to the instruction bar's own `Ctrl+Alt+M` fallback (§9's M8) — the two
hotkey lists are negotiated independently by `registerHotkey`/`registerDictateHotkey` and can
never collide with each other, so this is a naming coincidence, not a technical risk.

**2. The cap raised 30s → 90s, plus a 10s pre-cap warning.** 30s was cutting off genuinely
longer dictated thoughts mid-sentence with no warning beforehand. The cap-reached narration
(`stopAtCap()`) was ALSO fixed in the same pass to derive its wording from `this.maxRecordingMs`
rather than the literal string `"30s"` it still had immediately after the constant changed —
without that, the message would have kept announcing the wrong duration indefinitely,
regardless of what `DEFAULT_MAX_RECORDING_MS` was actually set to.

**3. A double-`finish()` race, fixed by claiming the session before the first `await`.** Live
testing produced dictated text with interleaved, duplicated letters. The cause: Enter's global
callback firing twice for one physical press (an observed Windows/Electron quirk) meant two
concurrent `finish()` calls could both pass the top-of-method idle/stopped guard before either
had changed `this.state` — both then raced independently through transcription and typing into
the same window. The fix moves the state transition (`this.enter("transcribing")`) to
immediately after that guard, before the first `await`, making the guard-check-and-claim
atomic — the same "flip state before awaiting" discipline `VoiceSession.begin()` and
`DictationSession.begin()` already use for the identical class of problem. **Caught by the
existing suite, not a new test:** the fix's first draft left a second, now-redundant
`this.enter("transcribing")` call later in the same method (inherited from before the fix),
which double-emitted the "transcribing" state and failed
`tests/DictationSession.test.ts`'s "passes through recording -> transcribing -> inserting in
order" test — proof the existing coverage was doing its job, not evidence a new test was
needed.

**4. Chunking tightened from `25 chars/8ms` to `1 char/40ms`.** Live testing on longer
dictations produced genuine OS-level character repetition ("mmmmmm", "IIIIIIII") — confirmed
NOT an app-side rendering artifact. `KEYEVENTF_UNICODE` events carry no real virtual-key code
(`wVk = 0`), and the original pacing was fast enough to trip Windows' own key-repeat handling.
Confirmed fixed at `1`/`40ms` on a previously-corrupted long sentence. The direct cost,
undisputed and not yet reconsidered: a long dictation now visibly takes longer to type out
than it did before.

**NOT proven, and only further live use can prove it:** whether `1 char/40ms` is the right
trade point, or whether some intermediate chunk size/delay could recover typing speed without
reintroducing the repetition; whether the double-`finish()` race has any OTHER trigger besides
Enter's observed double-fire; and whether `Ctrl+M`'s adjacency to the instruction bar's
`Ctrl+Alt+M` ever causes real-world confusion even though the two are technically independent.

### M13 — proven vs. live-only

**Proven deterministically (71 new tests), against fakes:** the three tools through the real
planner; the argument-dependent tier mechanism, including that a resolver which throws or
returns an undeclared tier **escalates** rather than de-escalates, and that the tier is resolved
**exactly once** per run; every refusal (no match, several matches, recurring, all-day, all-day
create, an unaddressable guest, an end before a start); duration preservation across positive
and negative UTC offsets; the time-of-check/time-of-use guard; that `createEvent` with guests
declined **provably creates nothing**; that a named auth failure surfaces verbatim as `refused`
from BOTH the handler path and the earlier narration path; the whole of `googleCalendarMap`,
including the organizer-in-`attendees` quirk that decides every tier; the whole of
`GoogleCalendarAuth`, including single-flight refresh, expiry skew, `invalid_grant` → revoked,
and that a 5xx or a dropped connection is **not** called a revocation; and that no failure path
puts the refresh token or client secret into a message or a stack.

**The first live run found two bugs, both in the one file that had no tests.** The symptom was
that every calendar instruction reported the connection as revoked while a manual token refresh
with the same credentials returned `200` — so the diagnosis had to come from the actual HTTP
responses, not from reading the code path that produced the verdict.

1. **Wrong endpoint for the scope.** `calendarTimeZone()` read `GET /calendars/primary` — the
   Calendars resource, which `calendar.events` does not grant. It returned `403
   ACCESS_TOKEN_SCOPE_INSUFFICIENT` on `calendar.v3.Calendars.Get`. Because that method is the
   first call in nearly every path (narration, the confirm dialog, `readSchedule`'s handler),
   *every* instruction failed on its opening request. Now read from the events listing's own
   envelope, which the same scope covers.
2. **Every 403 was read as a revocation**, which is what made the first bug unreadable: the app
   told the user to reconnect, and reconnecting requests the *same* scopes, so it could never
   have helped. 403s are now classified by `reason`, and `insufficient-scope` was added as a
   fourth `CalendarAuthReason` — "connected but not permitted" is a different state from
   "access withdrawn", with a different fix.

The lesson is narrower than "test everything": leaving `GoogleCalendar` untested was right for
request *shaping*, which only a real API can verify, and wrong for error *classification*, which
is ordinary logic that happened to live in the same file. That logic is now tested (13 tests,
including the real captured 403 body); the shaping still isn't, because it still can't be.

**The third live bug was the one predicted above: `q=` search.** "move the test one meeting to
8pm" searched for `the test one meeting` and found nothing; "move test one to 8pm" worked. The
cause was in how the term was built, not in Google's search — and it had two halves, because
the tool description had *told* the model to pass the user's own phrasing, article included.
Fixed by asking for the name in the description AND by retrying without filler words after an
exact search misses. `FakeCalendar` had hidden it: substring matching made both the working and
the failing phrasings behave identically, so the difference the fix turns on was invisible. It
now mirrors `q=`'s AND-of-terms semantics.

**NOT proven — only further live use against a real Google account can:** whether the filler
list is right for the way this user actually speaks (it is deliberately conservative — only
obviously-generic nouns, since anything specific is more likely to be a real title word); that
`sendUpdates=all` actually emails guests when we say it will;
that the "unverified app" interstitial and the "Testing"-status 7-day expiry behave as
documented; and whether the model reliably turns spoken relative times into correct ISO instants
now that it has a clock — the prompt change is proven to render, not proven to work.

**Confirmed live:** the token refresh, the granted scope, `events.list` against the real primary
calendar, and the timezone coming back correctly from its envelope.

Every milestone from M10 on has produced at least one live bug no fixture caught. This one
produced two before a single instruction had been spoken.

### M7 voice — what is proved, and what still needs a microphone

**Proved deterministically (24 tests, no audio / no model / no mic / no electron):** every
toggle transition including the ignored press while transcribing; the 90 s cap running the
same stop path; the cap being cleared by a manual stop; blank transcript, sub-300 ms clip,
whisper failure and blocked-mic all returning to `idle` with the hotkey still live; cancel
discarding a take; and — the load-bearing one — a transcript reaching the planner and
producing an `action_log` row **indistinguishable from a typed run**, including a dictated
irreversible action still passing the confirm gate. Plus the WAV encoder/downsampler
against whisper's 16 kHz mono 16-bit contract.

**NOT verified — needs a real microphone, a downloaded whisper.cpp binary, and a model
file, none of which exist in this environment:**

- whisper.cpp transcription accuracy and CPU latency (`ggml-base.en` vs `small.en`).
- Microphone permission on Windows 11 (Settings → Privacy → Microphone must allow desktop
  apps). The renderer names this failure explicitly, but the real dialog/rejection path is
  untested.
- The 48 kHz → 16 kHz downsample against a real device: the encoder is unit-tested, but
  "does whisper transcribe *this* WAV well" is empirical.
- Whether tap-to-toggle *feels* right — including whether 90 s is the right cap, and
  whether the indicator is noticeable on an unfocused window.
**Found live, and fixed:** `Ctrl+Alt+Space` was **already in use** on the first Windows
machine this ran on — `globalShortcut.register` returned false and the voice hotkey did
nothing at all. That's what prompted the negotiated-hotkey design above; the app now
falls back to `Ctrl+Alt+M` there and says so on startup. Verified live: the app boots,
registers the fallback, and reports it.

Until someone runs it with a mic and a model, M7 is **mechanism-verified, not
speech-verified** — the same distinction as Anthropic-vs-OpenAI above.

### M8 — the duplicate-run bug, measured

Live use after M7 felt slower, and **typed input was affected too** — the clue that pointed
at the shared path rather than at voice. Measured with temporary instrumentation
(`ipcMain.listenerCount` + a concurrency counter around `runInstruction`), driving the real
app against the real API:

| | before | after |
|---|---|---|
| Listeners on `commandbar:submit` after 5 abandoned bar openings | **1 → 5** | **1** (flat) |
| Planner runs from ONE submit | **6 concurrent** | **1** |
| LLM calls for that one keystroke | **12** | **2** |

**Root cause:** `showInput()` registered a fresh `commandbar:submit` listener per call and
removed it only on a submit or an Escape. Hiding the bar any *other* way — clicking away
(blur) — stranded it. Every stranded listener fired on the next real submit, so one
keystroke ran the planner once per abandoned opening.

**This was not introduced by M7.** The blur path dates from M0; the M7 diff touches no
planner or LLM code. What M7 changed was the *usage pattern* — dictating means far more
hotkey presses and far more clicking between the bar and other windows, which is exactly
what accumulates stranded listeners. A latent M0 bug that M7 made easy to hit.

It was also a **correctness** bug, not merely a slow one: six duplicate runs meant six
`action_log` rows and six executions of the chosen tool. Had the instruction routed to
`sendMessage`, that would have been six confirm dialogs and six Slack posts.

**Fix:** the pending resolver lives on the `WindowsShell` instance with **one** persistent
listener registered in the constructor, and `hide()` — the single funnel for Escape, blur,
and auto-hide — always ends the in-flight capture. The leak is no longer expressible.
`hide()` also notifies `onDismissed`, so a dismissed bar abandons its recording instead of
transcribing something the user walked away from.

**Hardened in M9 so it cannot regress quietly.** The M8 fix bound cleanup to the shell's
own `hide()` method, which only holds while every future code path politely goes through it
— and `main.ts` used to call `commandBar.hide()` directly. Cleanup is now bound to the
**window's own `hide` and `closed` events**, so any route that hides the bar ends the
capture, including ones nobody has written yet. Two gaps closed at the same time: a window
*close* used to leave the capture pending forever, and `voiceBusy` counted `stopped` as
busy, which pinned a post-cap bar on screen with a live capture and no auto-hide (in
contradiction of the documented "click away discards everything" rule). `voiceBusy` now
means only *mic live or whisper running*.

`tests/WindowsShell.capture.test.ts` pins the invariant rather than the behaviour: 20
open/hide cycles rotating through all five hide paths (submit, Escape, blur, a **direct
`window.hide()`**, auto-hide), asserting the listener count stays flat and every capture
settles. Verified to actually catch both shapes of the bug — reintroducing per-call
listeners makes it fail with `expected 4 to be 1`, and removing the window-event binding
fails the close/dismissal cases.

**Microphone cost, measured** (6 open/close cycles, real hardware, 48 kHz device):
`getUserMedia` is **683 ms cold** (first call of the session — permission check plus device
open) and **151–173 ms warm** (mean ≈162 ms). Everything else in `start()` is under 50 ms.
This is the number the mic-indicator decision turns on: every hotkey press pays ~162 ms and
blinks the OS mic indicator, including the presses where you meant to type.

**Escape is a global shortcut while the bar is visible, not a keydown listener (fixed
after M9).** A renderer keydown handler on the `<input>` only fires when that element has
DOM focus, which requires the WINDOW to have OS focus first. That's routinely false: voice
shows the bar via `showInactive()` on purpose (dictation is about the app you're already
in), so for the entire time the "Esc to discard" hint is on screen, no keyboard event can
reach the renderer at all. Escape is registered with `globalShortcut` instead, bound to the
window's own `show`/`hide` events — the same reason `endCapture` is bound there rather than
called only from `hide()` — so it holds for every path that shows or hides the window, not
just the ones that go through `WindowsShell`'s own methods. Scoped tightly: Escape is only
held system-wide while the bar itself is on screen, not permanently.

One real conflict this surfaced: `confirm()`'s native dialog already relies on Escape as
Cancel (`cancelId: 1`), and the bar stays visible (and its Escape registration live)
straight through the confirm gate — nothing hides it between submit and `confirm()`. So the
global hook is suspended for the duration of `dialog.showMessageBox()` and re-armed after,
only if the bar is still on screen. The renderer's own keydown handler for Escape remains as
a fallback for the rare case where the global registration itself fails (something else
already owns it).

`tests/WindowsShell.capture.test.ts` pins this with a dedicated Escape suite, including the
production case directly (`startRecording()` → `showInactive()` → Escape still cancels) and
the confirm-dialog suspension. Verified to actually catch the regression: removing the
`show`/`hide` bindings fails five of the new tests.

**Typing during a recording used to close the whole bar (fixed).**
`VoiceSession.abandon()` is called from TWO different triggers wired in `main.ts` —
`onTypingStarted` (you started typing) and `onDismissed` (Escape, blur, auto-hide) — and
both funnel through `shell.cancelRecording()`. Only the dismissal case wants the bar closed,
and that closing had already happened via whatever produced the dismissal in the first
place (Escape's own `hide()` call, for instance) — `cancelRecording()` calling `hide()`
itself was pure redundancy for that path. For the typing path it was the bug: the bar
vanished (and the character just typed was wiped by the `commandbar:reset` that `hide()`
sends) the instant you started typing instead of speaking. `cancelRecording()` now only
silences the microphone; it never touches bar visibility, since deciding whether the bar
should close belongs to whichever caller triggered the cancellation, not to the cancellation
itself. `tests/WindowsShell.capture.test.ts` covers both: typing keeps the bar open with the
original capture still live and submittable, and Escape's own bar-closing is unaffected —
verified by reverting the fix and confirming the first goes red while the second stays
green.

**Baseline latency, unchanged by any of this and NOT a regression:** `gpt-5` is a reasoning
model, and it dominates every instruction. Measured per run: `chooseTool` **3.4–8.8 s**,
`complete` **2.5–6.1 s**, end-to-end **6.5–12.7 s**. By contrast the UI is not the problem
at all — hotkey → bar visible is **5–40 ms** warm (199 ms on the very first cold open). If
instructions need to feel faster, the lever is the model choice or `reasoning_effort`, not
the shell.

---

## 10. Conventions

- TypeScript strict. No `any` in core.
- `/core` must not import `electron` — it only knows the `OSShell` interface.
- Every tool handler is pure w.r.t. the shell/memory it's given (pass dependencies
  in; don't reach for globals) so it's testable against MockShell.
- Secrets only from `.env`. Never log the API key or webhook URL.
- Small commits per milestone; keep this spec updated if a decision changes.
