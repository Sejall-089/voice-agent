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

> Voice arrived at M7/M12/M14 and pointing at M15/M16. **M17 took the first, narrowest bite
> out of "no multi-step": one instruction may now resolve to a fixed, ordered sequence of up
> to three EXISTING tools, planned in a single call and executed by code (§5b). Every step
> still passes its own gate. What is still out is the agent loop — the model deciding its next
> move after seeing each result.**

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

**Added after v0 (M14):**
- Voice output: the app SPEAKS its narration, confirms, and results instead of only showing
  them. Local synthesis only (Piper), behind a `SpeechSynthesizer` interface so a cloud voice
  is a later swap rather than a rewrite. The screen keeps exactly the text it shows today and
  the spoken line is DERIVED from it (`src/core/speech.ts`) — see §4d for why one unified
  string was rejected. Voice-ANSWERING of confirm dialogs is deliberately NOT part of this:
  putting speech recognition on the one gate that must never be bypassed needs its own
  fail-closed design, and gets its own milestone if it is ever built.

**Added after v0 (M18):**
- **Launching a local app from a closed allowlist.** "Open Spotify", "open Notepad" — a new
  *kind* of local action, the first thing the shell does that is neither a URL, the clipboard,
  a notification, nor speech. The model supplies **a name the user said and nothing else**: the
  catalog of launchable apps lives in the shell, every path and protocol URI with it, and an
  unmatched name is refused with the list of what *can* be opened. There is no fuzzy matching
  and no way to pass arguments, so "open X" can never become "run X with these flags" — the
  same proposes/disposes split §5's key rule states, applied to a command line. See §9's M18.
- **Local media and volume control, and a Spotify *search*.** Three tools: `systemVolume` and
  `mediaControl` press real media keys through the same `SendInput` host dictation uses, and
  `searchSpotify` opens a Spotify search in the browser for the user to press play on.
  **They are named for the system because that is what they touch** — a media key goes to
  whichever app owns the Windows media session, which may be Spotify, a YouTube tab, or
  nothing, and a volume key moves the whole machine. None of them can read the volume back or
  ask what is playing, so every result says what was **sent**, never what is now true.
  - **This is not what M18 set out to build, and the difference is recorded rather than
    smoothed over.** The plan was Spotify playback and volume over the Web API. Those
    endpoints require Spotify Premium — and an app in development mode requires the *owner's*
    account to be Premium to function at all — and this account is free, so the connector
    could only have shipped untestable against anything real. That is what CLAUDE.md's recon
    rule forbids, so it is **parked, not abandoned**: see §9's "Parked: Spotify Web API tools"
    for the design that still stands and the one thing that would unblock it.
  - What survived from the original design is the split: launching the Spotify *app* is
    `openApp`, and nothing else ever launches it as a side effect. A search request opens a
    search; it does not start an application on the user's behalf.

**Added after v0 (M19):**
- **The app speaks MCP, and Linear is the first connector.** Until now every external app was a
  hand-built *surface* — `GmailSurface`, `NotionSurface`, `CalendarSurface` — and each one was a
  milestone. A connector is the other way round: one generic adapter that knows no app
  (`core/mcp/adapter.ts`), plus a small **definition per app** that pins which remote tools this
  build will call and how. Adding an app is a definition file, not a new surface. See §6e.
  - **The far side does not define the menu.** An MCP server announces its own tool names,
    descriptions, schemas and safety hints, and all of that is text from somewhere else. None of
    it reaches the model. The names, the descriptions the model reads, the schemas arguments are
    validated against and the risk tiers are pinned in this repo; the server's list is used for
    exactly two things — noticing it has **drifted** from what was pinned, and making a tier
    **stricter**.
  - **Closed world, kept through a config file.** `connectors.json` (repo root, committed, no
    secrets) can switch a connector on and narrow its tools. It cannot add a connector, name a
    URL, add a tool, or change a tier. The key lives in `.env` as `LINEAR_API_KEY`.
  - **Three Linear tools at launch**: `linear__create_issue` (`dangerous`), `linear__search_issues`
    and `linear__get_issue` (both `safe`). Linear's server has 59.
  - **`readEmail`**, a hand-built `safe` tool over the Gmail read that has existed since M10, so
    a chain can *start* from an email's content rather than only reply to it.
  - **The proof is a chain**: read a Gmail bug email → create a Linear issue → post the issue's
    link to Slack (§5b). Hand-built Gmail, Notion and Calendar are untouched: MCP is for apps
    that have no hand-built integration.
  - **Still out**: stdio MCP servers (nothing needs one — Linear is hosted), OAuth for
    connectors, a "connect an app" UI, Slack DMs, and every Linear tool beyond those three.

**Added after v0 (M20) — reads and one real create seen live 2026-10-10; the chain, the
two-tracker choice and the failure wording are NOT yet run live (§9):**
- **GitHub issues, as the second connector**, added to find out what in `core/mcp/` was really
  about Linear. Three tools: `github__create_issue` (`dangerous`), `github__list_issues` and
  `github__get_issue` (both `safe`), against GitHub's hosted MCP server, with a fine-grained
  token in `.env` as `GITHUB_TOKEN`. The server has 46 tools. See §6e, "The second connector".
  - **The answer to the question**: no new auth, no new headers, no new result handling — and
    three places the adapter had assumed Linear. A formatter now receives the connector's
    settings; the drift check no longer relies on the server being strict; a connector may own
    its failure wording. Plus one rule that removes a question instead of answering it: a key is
    the model's or code's, never both.
  - **The repository is never the model's to choose.** `owner` and `repo` come from
    `connectors.json` on every tool, reads included — the token can read every public
    repository on GitHub.
  - **`search_issues` was considered and left out**; `list_issues` took its place (§6e).
  - **Still out**: comments, labels, assignees, editing or closing an issue, pull requests,
    files, and the other 43 tools; Slack DMs; OAuth; stdio servers; any change to `plan.ts`.

**Added after v0 (M23) — in progress, see §9 for the build order and what is built:**
- **Background jobs.** Every instruction is one *job* running the existing chain machinery (up
  to three steps, the same per-step gates). A job starts **attached** — it behaves exactly as an
  instruction did before M23 — and is **detached** when the instruction hotkey is pressed while
  it is still working, at which point it carries on without the command bar. A detached job
  **pauses** ("needs you") at a confirm or at a tool that needs the user present, and a pause
  that nobody answers for 30 minutes expires without the tool running. At most three jobs
  execute at once; the rest queue. Jobs are recorded in SQLite and are **never resumed** after
  a restart — they are marked interrupted. See §5c.
- **A status pill.** A small frameless window at the bottom right of the work area that shows
  what jobs are doing and lists the ones waiting. It is the one place a paused job is answered
  from — and **it never approves anything**: its button opens the same native confirm dialog
  every `dangerous` call has always passed through.
- **A needs-you chime**: one short bundled sound when a job starts waiting. No speech is
  involved, and it is never played over a recording, a dictation or the app's own voice.
- **`jobStatus`**, a `safe` tool: "are my agents done yet?" is answered from the job records by
  a fixed template. No other tool is added.
- **One running instance.** A second launch focuses the first and exits. Under `npm run dev`
  that needed one more step (live finding after M23): `predev` force-rebuilt the SQLite binary,
  which Windows will not delete while the running app has it loaded, so npm stopped before a
  second Electron reached the lock. `scripts/predev.mjs` now skips the rebuild when the binary
  is in use **and** recorded as the Electron build (every rebuild clears a stamp first and
  writes what it built only on success, `node_modules/better-sqlite3/.native-target`); held and
  anything else, it fails with a sentence saying so. Real launch: `scripts/second-launch-recon.mjs`.
- **Still out**: resuming a job after a restart, a job that plans again after seeing a result
  (the open-ended loop below is unchanged), scheduling, answering a confirm by voice, a tray
  icon, and any pill control beyond open-the-dialog / cancel / mute.

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
  still explicitly out — is screenshot/vision-driven **clicking** anywhere on screen. The
  distinction is the whole point: reading a page's real structure is checkable and
  refusable; guessing from pixels is not. See §6a, §6b. **M15 split that remaining half
  again** — see the next entry.
- ~~Screenshot/vision-driven interaction with any app.~~ **The POINTING half moved into scope
  in M15 and was rebuilt on different grounding in M16; the CLICKING half is still explicitly
  out, and is the part that matters.** `pointAt` reads the target window's real controls (UI
  Automation — exact rects, names, control types), asks the planner's own model to pick ONE
  by number, and draws a marker over it. The user clicks it. Nothing is ever clicked, typed,
  or dragged on their behalf. **M15 tried this by asking a vision model to answer the
  coordinate directly, and live testing found it confidently wrong** on ordinary Windows
  chrome — one tab over, ~208px onto a neighbour — which was the one place in this codebase
  where "the model proposes, the code disposes" was broken: vision was proposing WHICH
  control and disposing WHERE it is, unaudited. M16 restores the split: the model answers a
  bounded semantic question (which numbered entry), and code — never the model — resolves
  that choice's actual rect (`core/screen/resolve.ts`). The refusability the DOM path got for
  free from role+name is available here too, and for a stronger reason than M15 had: the
  candidate list is exact, not inferred, so "is this candidate real" is a lookup, not a
  heuristic. See §4e and §6d.
  - **M15 was the first capability that sent the user's screen off the machine; M16 removed
    that, not merely reduced it.** No screenshot is captured or sent — what reaches the model
    is a list of control names. What survived is the posture: `POINTING_ENABLED` remains its
    own explicit opt-in (`VISION_ENABLED` under M15) rather than the "is it configured?" gate
    every other capability uses, because reading the contents of whichever window the user
    was last looking at is still a disclosure worth a flag of its own, and a `caution` tier so
    every read is announced as it happens.
- Auto-clicking anything the model identifies. Deliberately not built, and not a stepping
  stone that pointing is halfway across — it is the thing pointing is the alternative to, and
  M16 additionally closed the one way that decision could still be silently wrong (a
  model-emitted coordinate), which auto-click would reintroduce by construction.
- macOS or Linux shells (architect for them via the interface, implement Windows only).
- ~~More than one external connector.~~ **Overtaken long before M18 and never amended, which
  is the honest version of this entry.** v0 shipped one (Slack's webhook, M5); Gmail came in at
  M10, Notion at M11, Google Calendar at M13 — and none of those milestones struck this line,
  so the guardrail has been quietly false since M10. Spotify (M18) is the fifth, not the
  second. **What the line was actually protecting is kept, and it was never the count:** every
  connector sits behind its own interface in `/core` with an "unavailable" default, is gated on
  its own configuration so an unconfigured one is never even on the menu, and is tested against
  a fake rather than the real service. Those are the rules; "no more than one" was a proxy for
  them that stopped measuring anything once the second one was built to them. A sixth connector
  is a cost question (another OAuth flow, another live-verification pass, another thing to keep
  working), not a scope violation — so **ask before adding one**, and expect the three rules
  above to be the whole of the answer. **Linear (M19) is the sixth, and was asked for.** It is
  also the first that is not a hand-built surface: it arrives over MCP through a generic
  adapter, and the three rules map across unchanged — an `McpConnection` interface in `/core`
  with an `UnavailableConnection` default, gated on `connectors.json` plus its key so an
  unconfigured connector is never on the menu, and tested against an in-memory server rather
  than the real workspace (§6e). What M19 changes is the *cost* of the seventh: a definition
  file and a recon pass, not a surface.
- **Open-ended** agent loops. Narrowed at M17, not lifted: a FIXED plan of up to 3 existing
  tools, decided in one planning call and executed by deterministic code, is now in scope (§5b).
  What stays out is the shape where the model sees each result and decides its next move — no
  predictable step count, its own stopping-condition and ground-truth machinery, and a live
  model decision at execution time. M17 is a workflow; that is an agent, and it is a separate
  milestone with its own safety design.
- Any UI beyond the command bar, a result popup, and (M15) the pointing overlay — a
  transparent, click-through, always-on-top window that draws one highlight and dismisses
  itself. It is the deliverable of that milestone rather than an expansion of the app's
  chrome: it has no controls, cannot take focus, and cannot receive a click. **M23 adds one
  more, and it was asked for: the status pill.** It cannot take focus either, but it does take
  clicks — to open a waiting confirm's dialog, cancel a job, or mute the chime — and that is
  the whole of what it may do. Anything beyond those two windows and the bar is still out.
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
| Text to speech (M14)| **Piper**, local, via a spawned `piper.exe` | No cloud TTS, no API key, no new npm dependency — the same shape and the same reasoning as whisper.cpp above, and local for the same reason voice INPUT is. Behind `SpeechSynthesizer` (`core/types.ts`, beside `Transcriber`), so an ElevenLabs implementation is a later swap that touches nothing else. Rejected: SAPI / Chromium's `speechSynthesis` (zero install and trivial to stop mid-word, but the built-in Windows voices are the robotic ones — kept as the named fallback if Piper's setup friction proves worse than it looks), and Kokoro via `onnxruntime-node` (better still, but a second native addon, which this repo has now refused twice for the same reason). The maintained build is `OHF-Voice/piper1-gpl` (`pip install piper-tts`); the archived `rhasspy/piper` v1.2.0 zip is the no-Python option. The wrapper spawns a path from `.env`, so which one is installed is a README decision, not an architecture one. The voice model is downloaded ONCE, ahead of time — a "nothing leaves the machine" feature must not make a network call on its first utterance. **It receives non-ASCII input as mojibake, and this is now measured rather than inferred**: an en dash (U+2013, bytes `E2 80 93`) came back as spoken "â €" — the Windows-1252 reading of those bytes. Recon's Q6 synthesized the same sentence with and without `PYTHONUTF8=1` and only the second was intelligible, so `PiperSynthesizer` sets it (and `PYTHONIOENCODING`) **by default** rather than leaving it to composition: it is a property of the engine, not a choice, and a fact a caller can forget is a bug waiting to happen. `core/speech.ts` still maps typographic characters to ASCII, now as belt-and-braces rather than as the only defence. **The word conversions are a separate matter and remain load-bearing**: with the encoding fixed, `3:00–4:00 PM` is still read as disconnected digits with the dash dropped silently, so "to" has to be supplied by us — the engine applies no time normalisation of its own, and a colon is read digit by digit. Empty and whitespace-only input exit non-zero, so an empty utterance is an error to prevent, not a silence to tolerate. |
| Screen capture (M15)| **`desktopCapturer`** (electron), with `setContentProtection` on our own windows | Measured, not assumed — `scripts/screen-recon.mjs` runs under electron and answers eight questions before any of it was designed around. What it found: `thumbnailSize` is honoured EXACTLY in both directions (asking for the display's native pixel size returns exactly that; asking in DIP returns exactly that); `source.display_id` carries the same identifier as `Display.id`, so the source↔display join is real; one capture of a 1920x1080 display takes ~310ms and is 170 KB as PNG / 115 KB as JPEG(q80); `nativeImage.resize()` to a 1568 long edge costs 14ms and preserves the aspect ratio exactly. **The load-bearing finding is Q3**: `setContentProtection(true)` (Windows' `WDA_EXCLUDEFROMCAPTURE`) excludes one of our own windows from our OWN `desktopCapturer` call — measured at 98.4% of a probe window captured unprotected against 0.0% protected, taking effect on the very next frame with no lag. That is what makes LAZY capture viable: the screenshot is taken inside the `pointAt` handler, while the command bar is sitting open in front of whatever is being asked about, and the bar is simply not in the picture. Without it the fallback was to capture at hotkey-press time into planner-owned scratch state, which would photograph the screen on every instruction including the ones that never look at it. `Graphics.CopyFromScreen` over the existing PowerShell host was the alternative considered; a native addon was not, for the reason this repo has now refused one three times. |
| ~~Vision model (M15)~~ — **REMOVED at M16.10** | n/a | Grounding no longer uses a vision model at all. M15 sent a downscaled screenshot to Anthropic (or OpenAI) behind a `VisionLocator` interface and took a bounding box back; live testing found it returning the WRONG CONTROL on dense native chrome, so M16 replaced it with UI Automation, which supplies exact rectangles, and the planner's own `LLMClient`, which picks one BY NUMBER. `VISION_ENABLED` / `VISION_PROVIDER` / `VISION_MODEL`, `ModelVisionLocator`, both provider adapters, the frame-size policy and `ScreenSurface.capture()` are all deleted. See §6d and the M15 write-up for the measurements that decided it. |
| Connectors (M19)   | **MCP**, via the official `@modelcontextprotocol/sdk` (pinned `1.32.1`, the v1 line) over **Streamable HTTP**; **`ajv`** (2020 build) for argument validation | Measured before it was designed around: the SDK's client runs in Electron 33's **main process** (`process.type === "browser"`, Node 20.18) and under Node 24 with identical output, in both its ESM and CJS builds; 91 packages, no native modules, so no third rebuild. The SDK's own `InMemoryTransport.createLinkedPair()` links the real `Client` to a real `Server` in one process, which is what makes every M19 test headless without faking the protocol. **Only the HTTP transport is built**, with the key as a bearer header: Linear's server is hosted, so stdio would mean spawning `npx` on Windows for something nothing needs yet. API key rather than OAuth: Linear accepts either, its OAuth scope is the same coarse `read write`, and a key in `.env` needs no browser flow and no token store. Linear's schemas are JSON Schema **draft 2020-12**, hence Ajv's 2020 build; `ajv` was already present transitively and is declared directly because `core/mcp/adapter.ts` imports it. The SDK also ships server-side packages (express, hono) this app never loads. |
| Config / secrets   | `.env` (dotenv), never committed         | `LLM_PROVIDER`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (whichever matches), `SLACK_WEBHOOK_URL`, and (M7, optional) `WHISPER_EXE_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE`, and (M10/M11, optional) `CHROME_DEBUG_URL` — one debug Chrome, both Gmail and Notion tools gate on it, and (M12, optional) `DICTATE_HOTKEY` — dictation itself needs no new secret, only the whisper config it already shares with voice, and (M14, optional) `PIPER_EXE_PATH`, `PIPER_MODEL_PATH` — unset means the app simply does not speak, the same way unset whisper paths mean it does not listen, and (M16, optional) `POINTING_ENABLED`. **`POINTING_ENABLED` is the one gate in this app that is an explicit opt-in rather than inferred configuration**, and the asymmetry is deliberate: every other capability answers "is there a thing to talk to?" from a value set for no other purpose (a debug Chrome URL, a refresh token, a piper binary path), but the credential vision would otherwise key off — `ANTHROPIC_API_KEY` — is usually already there because the planner is using it. Reading its presence as permission would silently turn "I configured an LLM" into "I consented to the app reading my windows", which are not the same decision. Unset means the tool is never on the menu, no reader process is started, and no window is ever read. (Through M15 this gate was `VISION_ENABLED` and authorised a screenshot; M16 replaced the grounding, so nothing is captured any more.) |

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

## 3c. Usage logging (added 2026-10-15)

Every model call writes one console line: what it was for, the model, prompt / cached /
reasoning / output tokens, an estimated cost, and a running total for this app run:

```
[llm] planning gpt-5: prompt 6800 (cached 6500), output 912 (reasoning 832), est $0.0103 | session: 1 call, output 912, est $0.0103
```

**Why.** The bill is almost all OUTPUT, and on `gpt-5` most of that is hidden reasoning spent
before a tool call a few dozen tokens long. The response's `usage` block was otherwise dropped,
so which call costs what could not be seen from the app.

- **Purposes** (`LLMPurpose`, `core/llm/usage.ts`): `planning` (the first `chooseTool`),
  `retry` (the one re-ask after a multi-call answer, §5b), `summarize`, `rewrite`, `format`
  (`sendMessage`'s formatter), `compose` (`draftReply`, `reviseDraft`), `compose-note`
  (`addToPage`), `point` (`pointAt`'s chooser). `jobStatus` makes no model call of its own. The
  label is an optional last argument on `chooseTool` / `complete`; it is never sent to the model.
- **Prices are data**, in `llm-prices.json` at the repo root (USD per million tokens: `input`,
  `cachedInput`, `output`). A model with no entry is logged with its tokens and **no** cost,
  never a guess; a missing or broken table is said once at startup. Cached input is billed at
  its own rate; reasoning is already inside output and is not added twice.
- **No behaviour change.** Usage is reported after the response has been read, to an optional
  sink on each client; a throwing sink is swallowed. The request sent is identical with and
  without it (pinned in `tests/llmUsage.test.ts`). Token counts and model names only — never a
  prompt, a reply or a key. Nothing is persisted: a restart starts the total from zero.
- **Not counted:** the OpenAI SDK's own automatic retries after a failed request (a failed
  request has no usage block).

## 3d. Real-model spend in evals and recon scripts (added 2026-10-15)

OpenAI credits ran out during M22 and the opt-in evals were the likely cause: each eval was
opt-in by its own flag, and several flags at once, or a raised trial count, was a full pass
nobody had priced. Every eval and recon script that can call a real model now goes through one
gate, `tests/eval/realModel.ts` (test infrastructure; nothing under `src/` imports it):

- **Dry by default.** Without `REAL_MODEL=1` it prints the planned call count and an estimated
  cost and makes no call. The per-eval flag (`M23_STATUS_EVAL=1`, …) still chooses which eval;
  `REAL_MODEL=1` is what spends. A recon script exits before opening any window.
- **Hard cap: 60 real calls per run**, across every test file of one vitest run. Files run in
  separate processes, so each call claims a numbered slot file in a per-run temp folder,
  created with the exclusive flag — two processes cannot take the same number, and no call is
  sent without a slot. An eval that plans more calls than the cap is refused up front.
  `REAL_MODEL_MAX_CALLS=<n>` sets a different cap; above 60 it also needs
  `REAL_MODEL_ABOVE_CAP=1`, and without it the run is refused outright rather than capped at 60.
- **A running count and cost**, one line per real call (§3c's usage, priced from
  `llm-prices.json`).
- **Refused from `.env`.** Any `REAL_MODEL…` setting in `.env` refuses the run: a standing
  permission in a file is how a key that was "always present" became permission to spend it.
- The dry estimate uses `dryRunEstimate` in `llm-prices.json` (a planning-sized call: 6,800
  prompt tokens, 5,950 cached, 900 output — from the 2026-10 usage page). `complete`-only evals
  are overstated by it.
- **Not counted:** the SDK's own automatic retries after a failed request.
- `tests/realModelGuard.test.ts` pins the policy, the cap (a fake provider is asked exactly
  `cap` times), the counter, and that every file under `tests/eval/` and `scripts/` that can
  build a model client builds it only inside the gate.


## 3e. Model and reasoning effort per kind of call (added 2026-10-15)

Selectable in `.env`, **with today's values as the defaults** — nothing changes unless a
variable is set (`core/llm/modelSettings.ts`):

| Variable | Applies to | Default |
|---|---|---|
| `LLM_PLANNING_MODEL` | `planning`, `retry` (every `chooseTool`) | the provider's model: `gpt-5` / `claude-sonnet-4-6` |
| `LLM_PLANNING_REASONING_EFFORT` | the same | not sent (the API's default) |
| `LLM_TASK_MODEL` | `summarize`, `rewrite`, `format`, `compose`, `compose-note`, `point`, unlabelled `complete` | the provider's model |
| `LLM_TASK_REASONING_EFFORT` | the same | not sent |

- **Two groups, not one per purpose:** planning decides what runs; task calls work inside a tool
  that is already chosen. A cheaper setting is a sensible experiment for one and not the other.
- **Closed lists, checked at startup.** Models: `gpt-5`, `gpt-5-mini` for openai,
  `claude-sonnet-4-6` for anthropic — a model is added when it has been measured. Efforts:
  `minimal`, `low`, `medium`, `high`, openai only (the Anthropic client requests no thinking, so
  an effort there is refused rather than ignored). Anything else throws from `createLLMClient`,
  which `main.ts` calls at startup, naming the variable and the allowed values. A blank value
  means unset.
- **An unset effort is left out of the request entirely**, not sent as null — the default
  request is field for field what it was (`tests/modelSettings.test.ts`, against a request
  written out by hand). The output caps (8192 / 4096, §3a) do not change with either setting.
- The usage log (§3c) names the model that actually answered; `main.ts` prints
  `[main] models: planning … ; tasks …` at startup. The eval gate (§3d) prices a dry run with
  `LLM_PLANNING_MODEL` and refuses a real run on an unknown value.
- **Measured (2026-10-14/15, one trial each), not adopted.** `gpt-5-mini` at minimal effort
  answered in prose where a tool was expected on 8 of 39 broad-set cases (6 of 12 jobStatus
  positives, "pause", and one plan written out as text). Every miss was loud — nothing ran —
  and none dropped a step or changed an argument silently. Choosing a setting is the user's call.
- **Decision (cost), as of 2026-10-15: planning on `gpt-5-mini` at `low`, tasks on `gpt-5` at `low`, in the user's `.env`; rollback by deleting those `.env` lines.**
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
  | { kind: "notify"; payload: string }
  | { kind: "speak"; payload: string }     // M14 — see §4d
  | { kind: "openApp"; payload: string };  // M18 — a NAME, never a path or command

export interface OSShell {
  registerHotkey(combo: string, onTrigger: () => void): boolean;  // false = combo taken
  getContext(): Promise<CapturedContext>;
  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }>;
  showInput(): Promise<string>;                 // opens command bar, resolves with typed text
  showResult(text: string): void;               // result popup
  // yes/no dialog for irreversible actions; the approve button's word is the tool's (M21)
  confirm(message: string, options?: { approveLabel?: string }): Promise<boolean>;
  askUser(question: string): Promise<string | null>; // one typed line; see below
}
```

### `askUser` (added 2026-10-10)

One question, one typed line back. **`""` and `null` are different answers:** `""` is the user
pressing Enter on an empty line; `null` is no answer at all, and a caller must treat it as "do
not proceed". Not a gate — `confirm()` remains the only thing that approves a `dangerous`
action. It has exactly one caller: a chain's pre-flight, for an unknown `sendMessage` channel
(§6, "Asking instead of refusing").

`WindowsShell` reuses the command bar: the question is shown above the input
(`commandbar:ask`), and the same `commandbar:submit` channel is routed to the question when one
is open. Typed only — no microphone is opened. The decisions, each pinned in
`tests/WindowsShell.capture.test.ts`:

| Situation | What happens |
|-----------|--------------|
| Enter, with or without text | resolves with the trimmed line (`""` if empty) |
| Escape | resolves `null`, bar hidden (Escape's usual "never mind": speech and marker too) |
| No answer for 60 seconds | cancels itself exactly as Escape would (counted from when it was asked) |
| User clicks away | **stays up** — they may be looking up the answer. Not auto-hidden either |
| Bar hidden or closed by any other route | resolves `null` (bound to the window's own events) |
| Asked while the bar is busy — an instruction capture open, voice not idle (recording, stopped, transcribing, dictation inserting), a confirm dialog up, or another question open | resolves `null` **immediately and touches nothing**. An ordinary planner run blocks neither hotkey, so this is reachable; the caller cannot tell it from a dismissal |
| A confirm dialog opens while a question is up (a concurrent run) | the dialog hides the bar, so the question ends `null`. Pinned, not designed |

**Hotkeys while a question is open.** `isAskPending()` is set synchronously and read by both
guards, in the same position in each — after the confirm check, before the chain check:

- *Instruction hotkey* (`instructionHotkey.ts`, guard 3): starts nothing and calls
  `focusAsk()`, which gives the question the keyboard back without resetting what was typed
  (`commandbar:focus`, not `commandbar:show`). No narration, no barge-in, no marker cleared.
- *Dictation hotkey* (`dictate.ts`, `combineInstructionBusy` → `"asking"`): blocked. Dictation
  would type into the answer box, and its global Enter-to-finish is the key that answers.
- *Escape*: answers `null`, as above. It is also the "be quiet" key, so silencing a spoken
  question would cancel it — the same trade already accepted for the confirm dialog (§9).
- *Dictation's global Enter*: only armed during dictation, which cannot start during a question
  and during which a question is refused.

`MockShell` mirrors it: `asks` (queued answers, `null` when empty), `holdAsk` / `answerAsk()`
in the style of `holdConfirm`, `questions` (only those actually put), `isAskPending()`, and the
same refusal while a confirm or another question is pending.

**Not verified:** the renderer half (`CommandBar.tsx` — the question line, Enter on an empty
answer, the placeholder) has no test and has not been seen running. It is now reachable — a
chain naming an unknown channel — so it can be looked at live.

### Result links (added 2026-10-10, M21 — resolves M20's Finding 1)

A result is text, and not all of it is this app's: an issue title or an email body is written
by someone else and reaches the result bar unchanged. So "clickable links" does not mean every
URL. It means the issue links this app itself hands back.

**The rule — one function, one list** (`core/resultLinks.ts`, `RESULT_LINK_HOSTS`:
`github.com`, `linear.app`). A URL is a link only when all of these hold:

- the string is the URL and nothing else — lowercase `https://`, no whitespace, control
  character or backslash;
- the scheme is `https` (not `http`, `javascript:`, `file:`, `data:` or an app protocol);
- the hostname is **exactly** one in the list — `github.com.evil.com` and `gist.github.com` are
  other hosts, and `evil.com/github.com` is a path;
- no username or password (`https://github.com@evil.com` goes to evil.com);
- no explicit port.

**Used twice, on purpose.**

| Where | What it does |
|-------|--------------|
| Renderer — `ResultText.tsx`, used by `CommandBar.tsx` | `splitResultLinks` cuts the result into text and link parts, rendered as React text nodes and `<a>` elements — never `dangerouslySetInnerHTML`, so markup in a result is shown as characters. The link's text is the URL. A click, or Enter on a focused link, is **prevented** and calls `window.api.openResultLink(url)`. Anything that is not an allowed link stays plain text, unchanged. |
| Preload | one function, `openResultLink(url)` → `commandbar:open-link`. It returns nothing. |
| Main — `WindowsShell.openResultLink` | **re-validates** with the same function (the argument is `unknown`: the renderer is the process displaying other people's text and is not trusted to have checked), then opens through the existing `openUrl` action. A URL that fails is dropped with no side effect — nothing opened, shown or logged. |

**The bar's own window never navigates.** `setWindowOpenHandler` denies every new window and
`will-navigate` is prevented for every URL except the page reloading itself (the dev server's
hot reload). This is the backstop for any click the renderer's handler does not catch — a
middle click, for one.

**Verified:** `tests/resultLinks.test.ts` (the rule and the splitter, including every
look-alike above), `src/renderer/ResultText.test.tsx` (jsdom: what is drawn, what a click and
Enter do — it sits beside the component because it needs the renderer's JSX/DOM compiler
settings), `tests/WindowsShell.capture.test.ts` (main rejects each bad URL sent to it directly;
navigation refused), and `node scripts/ask-recon/run.mjs result-links` on a real Electron
window (a real click and a real Enter reach main as the right URL; `window.open`,
`location.href` and a middle click go nowhere). `scripts/vite-fs-probe.mjs` confirms the dev
server serves the renderer's import from `src/core`. **Not live-tested:** nobody has yet
clicked a link in the running app and watched the browser open.

**Not covered:** links in the confirm dialog (a native message box; cannot be made clickable)
and any host not on the list — adding a connector means adding its host to
`RESULT_LINK_HOSTS`.

**Build a `MockShell` first.** It returns canned context, logs actions instead of
running them, and lets the entire core + memory + tests run headless with no
Electron. Wire the real `WindowsShell` last.

> **`openApp`'s payload is a NAME, and that asymmetry with `openUrl` is the design (M18).**
> `openUrl` carries a resolved URL because a URL is something the model can legitimately know
> and the shell can validate on sight — `WindowsShell` refuses any protocol but http(s). A
> command line has no such check: nothing distinguishes a reasonable one from a harmful one by
> inspection. So the model never writes one. It passes the name the user said, and the shell
> resolves it against a closed catalog — names in `core/apps.ts`, commands and protocol URIs in
> `src/main/shell/appLaunch.ts` — by exact match, or refuses with the list of what it can open.
> `MockShell` runs the SAME launcher over the SAME catalog with a faked `io`, so an unmatched
> name fails in tests exactly where it fails live (CLAUDE.md's rule about lenient fakes).

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
   history — it's one bounded fact. **Since M19, so may one line about the screen: "An email is
   open in Gmail."** — asked of the Gmail surface concurrently with context capture, under a
   short deadline, and never carrying anything the email says (§9, M19 live finding 3). A
   proposed tool name is also canonicalised before the registry check in step 3: a leading
   `functions.` is dropped when, and only when, what is left is exactly a name on the menu.
   **The current local time** goes in too (M13) — see
   "The clock in the prompt" below. Through M16 this step produced exactly one tool call and
   the planner never chained anything; M17 adds a second possible answer — a fixed plan of
   several tools — without changing anything below it. See §5b.
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
5a. **Prepare** (M21) — a tool may declare `prepare(args, deps)`. The planner runs it once,
   here, and **uses the arguments it returns for everything after**: the tier, the narration,
   the confirm dialog, the handler and the log row. It exists so a dialog shows what will
   actually happen rather than a preview of the model's input (§6, "What is approved is what is
   sent"). Nothing has been approved yet, so it is handed **`PrepareDeps`** and not the full
   bundle. `PrepareDeps` has **five keys**: `context`, `instruction` (added 2026-10-11),
   `llm`, `memory` (read-only: `resolve`, no `write`) and `chained`. `instruction` is the
   user's own typed or spoken text for this turn — never email text, clipboard text or an
   earlier step's result. `sendMessage`, its one user, only **compares** it with `notes`; it
   is never sent to the model. There is no shell, no sender and no app surface in that object — a `prepare`
   cannot send, save or act because it holds nothing to do it with. It runs once per step. A
   throw ends the call before any gate: a `UserFixableError` as a refusal in the tool's words,
   anything else as an error.
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

---

## 5b. Chained plans (M17) — prompt chaining, not an agent loop

One instruction may resolve to a short, ordered **sequence** of existing tools, run without a
fresh hotkey press between them. "Reply to this and send it" was two instructions; it is one now.

**The shape is a workflow, not an agent.** One planning call returns a fixed, ordered plan;
deterministic code executes it. The model is **never consulted again** — it does not see step 1's
result and decide what to do next. That other shape has no predictable step count, needs its own
stopping-condition and ground-truth machinery, and reintroduces a live model decision at
execution time, which is precisely what M16 closed. It is a separate milestone.

### How the plan arrives — the `plan` meta-tool

`core/llm/plan.ts` defines a `plan` tool that both providers are offered alongside the registry
but which **is never in the registry**: no handler, no risk tier, so `registry.find()` cannot
resolve it. A model that names `plan` as a *step* inside a plan is refused by the ordinary
unknown-tool check, with no special case anywhere. Its input is `{ steps: [{ tool, arguments,
describe }] }`, and it produces a fourth `ToolChoice` variant, `{ kind: "plan", steps }`.

**`describe` is parsed and then unused (M29).** It is still in the schema, still required, and
still capped at 80 characters by `parsePlan`. It is not shown, spoken or logged: the preview reads
each tool's own `planPhrase` (Execution, step 1). It was kept so the planning prompt stays
byte-for-byte unchanged, which is also why the schema's own text still says the phrase "is read
out before anything runs". Removing or rewording it changes the prompt, and needs an eval with
controls first (M28).

Chosen over letting a provider emit several `tool_use` blocks: parallel tool use is trained for
*independent* work, so a dependent chain would under-trigger, and the dependency between steps
would be implicit in block order rather than stated. The meta-tool is also identical across
providers, and it leaves the single-step path **byte-identical** to every milestone before it.

`parsePlan` answers shape only — "is this even a plan". Whether the plan is *runnable* is
`core/chain.ts`'s question, so a garbled response and a plan we decline to run reach the user as
different sentences.

### Several tool calls at once — asked once more, then refused (added 2026-10-13)

A model may answer with several separate tool calls in one response (a provider's native
"parallel" batch) instead of one tool or one `plan`. That is not something this app can run:
the calls carry no order and no `{stepN}`. `classifyToolCalls` reports it as its own
`ToolChoice`, `{ kind: "multiple", tools }` — names only, arguments never decoded.

The planner then asks **exactly once more**, with a fixed sentence from code appended to the
user's instruction (`PLAN_RETRY_INSTRUCTION`, `core/llm/toolChoice.ts`): emit one `plan` listing
the steps in order, or one tool. Nothing has run and the model has seen no result, so this is
still one accepted answer decided before step 1. Whatever comes back takes the ordinary path —
a plan meets the same validation as any plan (three steps, known tools, backward references,
the `functions.` prefix rule). A second multi-call answer is refused. A single tool, a plan, a
decline and a truncated answer are never retried. It applies to both providers and to attached
and detached jobs alike, because it lives in the planner.

The refusal is logged as `refused` with `arguments: { calls: [names] }`, the way a plan refusal
records its tool names, and **not** through `logMiss`: every tool named exists, so it does not
belong in §8's backlog of tools worth building. In the bar it is followed by a second paragraph,
`What I heard: “<instruction>”`; the spoken line is the refusal alone.

**Why, and what was measured.** Found live on OpenAI `gpt-5`: "create an issue on github for
body format and send these notes to fun channel" came back as `github__create_issue` +
`sendMessage` and was refused. The two halves are independent, which is exactly when a parallel
batch is a natural answer. One real-model run of that phrase ×10 through the app's own client
and this rule (27-tool menu, a checklist on the clipboard, no previous turn): **plan on the
first try 5, plan after the retry 5, refused 0** — a retry rate of 5 in 10, 15 model calls in
all. An earlier nine-call diagnosis saw the multi-call shape on 1 of 3 trials of the same phrase
and on none of six trials of two phrasings whose second step depends on the first. Ten trials
is a small sample: "0 refused" means none was seen, not that none can happen.

**Considered and not done.** `parallel_tool_calls: false` on OpenAI: its function-calling guide
says it "ensures exactly zero or one tool is called", but nothing found documents it for
`gpt-5` on Chat Completions, and a model held to one call may simply make one of the two — a
silent half-job where there is now a loud refusal. Converting the calls into a plan in code:
the order of a parallel batch is not documented as an execution order, and a dependent task
sent that way would run its second step on invented arguments.

**The bar's text box** became a wrapping textarea in the same change: a long instruction used
to scroll sideways out of view in a single-line input. It grows to four lines, then scrolls
vertically; Enter submits, Shift+Enter does nothing, and a pasted newline is flattened to a
space. Measured in a real window by `scripts/bar-wrap-recon.cjs`.

### Cross-step data — `{stepN}`, whole results only

A **string** argument may contain `{stepN}`, replaced by step N's whole result text.

Field-level references (`{step1.attendees}`) are deliberately **not** built: every `ToolHandler`
returns `Promise<string>`, so there are no fields to reference, and giving 15 tools a declared
output contract is its own milestone. It is also not what the expressible chains need —
`draftReply → reviseDraft → sendReply` passes nothing at all (state flows through `DraftStore`
and the live compose box), and `readSchedule → addToPage` needs exactly the whole listing.

**N may name ANY earlier step, not only the immediately preceding one.** "Summarize this, add it
to my Notion page, and send the summary to the team" needs step 1 from step 3, because step 2's
result is the confirmation sentence `Added to <page>.` and not the content. The constraint is
*backward*, not *adjacent*: N strictly less than the current step's index, which is what keeps
resolution deterministic and statically checkable.

Detection is lenient where the documented form is strict — `{ step 1 }` is caught and either
substituted or refused by name, never passed through as literal characters into someone's inbox.
Substitution is a single pass, so a result that happens to contain `{step2}` is data, not an
instruction.

### The gate, and what is checked when

Everything structurally knowable is settled **before the plan is narrated**, because announcing a
plan that was always going to die on step 2 tells the user something untrue at the one moment
they are relying on it:

| Refused up front (nothing runs, nothing announced) | Stops the chain mid-flight |
|---|---|
| more than **3** steps — a named refusal, never a silent truncation | a step's own refusal, zero-match or error |
| a step naming a tool not on this install's menu (`plan` included) | a cancelled confirm |
| `{stepN}` pointing forwards, at itself, or out of range | the referenced step produced nothing to pass on |
| `{stepN}` in a top-level argument the tool declares non-text | |

Three steps, because that is what the registry can express: the longest genuinely useful chain in
it is `draftReply → reviseDraft → sendReply`.

### Execution

1. **Narrate the whole plan** — a numbered list via `notify`, one spoken sentence.
   **Transparency, not approval**: this supersedes the earlier sketch in
   `docs/context/PROJECT_CONTEXT_UPDATE_4.md`, which proposed a whole-plan approval *replacing*
   today's per-step confirm. It does not replace it.

   **Each line is the tool's own phrase (M29).** It comes from `Tool.planPhrase`, written in the
   tool's code ("reword the text you copied"); for a connector tool it comes from the pinned
   definition, never from the server. Until M29 each line was the model's `describe`, and M28's
   live run showed "Capture the selected text unchanged" over a `rewrite` step. The screen and
   speech read the same phrase from the same lookup (`previewPlan`, `spokenPlan`), and a tool
   with no phrase shows its name, never the describe.
   - **The `[main]` console line** carries each step's tool beside its phrase:
     `[plan: rewrite "reword the text you copied" > linear__create_issue "create a Linear issue" > …]`.
     It is set exactly when a preview was shown (`PlannerOutcome.plan`).
   - **The cost, accepted:** the preview is accurate but generic. Two steps of one tool read
     alike, and specifics such as the channel arrive at each step's own narration or confirm.
   - **The phrase never reaches the model:** `toToolSchemas` drops it, and
     `tests/planPhrase.test.ts` pins that. The same file holds every phrase to its rules: at most
     40 characters, printable ASCII, lowercase start, no trailing punctuation, no identifier, and
     unique across all 28 tools.
2. **Per step**, in order: substitute `{stepN}` from the results so far, then run the identical
   `runStep` a lone instruction runs — memory resolution, validation, tier resolution, narration
   gate, confirm gate, handler, log row. **There is no second gate implementation for chains to
   drift away from.** Chaining changes no step's tier: a `dangerous` tool is still `dangerous` at
   position 2 of 2, and three `safe` steps do not become risky by being chained.
3. **Stop on refusal.** Anything that is not a clean `ok` ends the chain where it stands. Nothing
   after it runs. The user gets **one** message: the tool's own words first, then the accounting
   — *"Your Notion page isn't open. I'd already done step 1 of 3, but steps 2 and 3 didn't run."*
   In one paragraph deliberately, so `toSpokenResult` does not speak only the reason and offer to
   read the accounting as "the rest".

Narration and confirm text are prefixed `Step 2 of 3: `. The status line is a single slot, so
without it the plan preview is replaced by a narration with no indication of where it belongs —
and a confirm dialog appearing with no warning partway through a plan is the most confusing
moment this feature can produce. The prefix goes in front, keeping the decisive fact in the first
paragraph `toSpokenConfirm` speaks.

**Intermediate results are shown but not spoken** — only gate speech and the final step's result
are said aloud. Mid-chain the app is working rather than answering, and `toSpokenResult`'s "want
me to read the rest?" offer would be a lie while the hotkey that would answer it is blocked.

### State, and the hotkeys

`core/chainState.ts` publishes **whether a chain is running and where** — deliberately *not* the
step results, which stay in a local inside the run so one chain's output can never reach the next.
The flag exists only because something outside `run()` reads it: `main.ts` hands one instance to
the planner and to **both** hotkey guards.

The instruction hotkey's guard order is **dictation → the bar's own voice capture (M32) →
confirm pending → question pending → chain running → barge-in**, and the ordering is
load-bearing. Inside a chain, a step parked at its gate makes the confirm and chain checks both
true, and only `CONFIRM_WAITING` names something the user can act on; swapped, the app would tell
someone to wait for a chain that is in fact waiting for them.

**The voice-capture guard (M32).** A press while the bar's `VoiceSession` is `recording`,
`stopped` (held at the length cap) or `transcribing` is ignored and logged (`[main] instruction
hotkey ignored - voice is <state>`): no detach, no `showInput`, no narration, no refocus. Until
M32 it got through every guard. It detached the attached job; `showInput()` resolved the first
bar's promise with "", so what had been said so far ran as the instruction; and the new bar was
deaf, because `begin()` does nothing unless the session is idle. A bar open for typing, with the
microphone idle, keeps its meaning: a press starts over. `VoiceLike` gains `getState()`.
`combineInstructionBusy` gains a `"chaining"` state for the same reason on the dictation side —
dictation would grab the shared microphone and type into whatever holds focus, which mid-chain is
likely the reply box the chain is writing.

`PlannerOutcome` gains `chain?: { completed, total }`, which `runInstruction.ts` appends to the
`[main]` ground-truth line as `(chain 2/3)` — `refused` alone cannot distinguish a plan that died
on step 1 from one that died on step 3.

### Chains and connectors (M19)

A namespaced connector tool is an ordinary registry `Tool`, so it can be a plan step with no
change to anything above: `validatePlan` checks its name against this run's menu like any other,
the step cap is still 3, and it passes the same per-step gate. The milestone's proof chain is
exactly three steps:

```
1. readEmail                                       safe       → From / Subject / body, as text
2. linear__create_issue { title, description: "{step1}" }   dangerous  → "Created ENG-5: <title>\n<url>"
3. sendMessage { channel, notes: "New bug filed: {step2}" } dangerous  → posted
```

Three things had to be true for that to be safe, and each is a rule rather than a property of
this one chain:

- **The model writes the title; it never sees the email.** The plan is fixed before step 1 runs
  (the whole point of §5b), so anything that depends on the email is a placeholder and anything
  that is not a placeholder is the model's own words from the spoken instruction. `team` is not
  the model's to choose at all — it has no way to know what teams exist — so it comes from
  `connectors.json` and is merged in by code.
- **A result is text a later step can use.** Linear returns one text block holding a JSON
  string; passed through raw, step 3 would post a JSON blob. Each pinned tool has a formatter
  that produces a short human line with the link on its own line (§6e).
- **Inside a chain, `sendMessage` sends verbatim and shows everything.** Standalone it shows a
  140-character preview and then reformats the notes through a model *after* the user has
  approved — a gap that predates chains and is on the M19 follow-up list (§9). A chain must not
  inherit it: the text is another step's output, the user has seen it nowhere else, and a ticket
  link is not something a rewrite gets to drop. So `ToolDeps` carries `chained: boolean`, set by
  the planner from where the call sits (never by the model), and when it is true `sendMessage`
  skips the rewrite and its confirm text is the whole message. "Chained" means the whole chain:
  any `sendMessage` step, whether or not its text came from `{stepN}`.

**Tool results are data, never instructions.** A step's result can be an email or a ticket body
— text written by someone else. Nothing interprets it: the model that wrote the plan is never
shown it, `{stepN}` substitution is a single pass (a result containing `{step2}` is characters),
it reaches the next step only as an argument value, that argument is validated against a closed
schema, and it appears in full in the confirm dialog before anything is created or sent. The
one argument a hostile email could want to set on Linear — `id`, which turns a create into an
update — does not exist in the pinned schema. **One channel is left as it was**: the previous
turn's result (first 300 characters) still goes into the *next* instruction's planning prompt
(§5 step 1), and after a chain that can be external text. Bounded, pre-existing, and recorded
here rather than changed.

**The worked example.** `planToolFor(tools)` (`core/llm/plan.ts`) appends this chain to the
`plan` tool's description as a concrete example — a response to the standing live finding that
models under-reach for `plan`. It is appended **only when all three tools are on this run's
menu**: the description tells the model every step must come from the list it was given, and an
example naming a tool it was not given would be the description contradicting itself. Whether it
changes behaviour is live-only; `tests/eval/planChoice.eval.test.ts` (opt-in,
`M19_PLAN_EVAL=1`) is the measurement, including a single-tool control for over-teaching.

### Content pointed at, never read (added 2026-10-15)

A plan sometimes filed an issue titled "Bug report", with no description, and with no step that
reads the email or text the user pointed at — recorded on `gpt-5` at default effort (1 of 6) and
`gpt-5-mini` at low (1 of 3), always with no email signal and an empty clipboard. The preview
shows the model's own words for each step ("File the bug in Linear"), so nothing on screen said
nothing was read; the dialog's "(no description)" was approved once live (SEJ-7, M19).

`checkUnreadContent` (`core/chain.ts`, pure) refuses before anything is narrated, asked,
admitted or run, when **all four** hold:

1. the instruction **points**: `this / that / these / those`, or `the email / message / mail /
   bug / report / thread / text / selection`. "Create a Linear issue titled X" points at
   nothing, so a dictated create is never refused for having no description.
2. **nothing in the plan used it**: no step whose tool declares `readsContext` (evaluated on that
   step's arguments), and no argument containing the captured clipboard text
   (whitespace-normalised; a clipboard under 8 characters is ignored, so a stray word cannot
   switch the check off).
3. a **create with no content**: a tool declaring `contentArg`, its body absent or blank, and no
   `{stepN}` in any of its arguments.
4. that create's **title is not the user's own words**: some content word of it does not appear
   in the instruction ("file this: dark mode toggle resets" passes).

**Declarations, so the planner never names a tool.** `Tool.contentArg` (`{ title, body }`) on
`linear__create_issue` (`description`) and `github__create_issue` (`body`), pinned in the
connector definitions. `Tool.readsContext` on `readEmail`, `readSchedule`, `summarize`,
`rewrite`, `draftReply`, `reviseDraft`, `addToPage`, and on `sendMessage` only when it has no
`notes` (it then sends the clipboard). Not on connector reads or `recall`: a tracker search or a
memory lookup is not "this email", and "log this" planned as search > create("Bug report") is
still refused.

**Where.** In the planner, on all three paths: after `validatePlan` on a plan (before the
one-step branch, so a one-step plan is judged too, and before `settleReferences` and `admit`),
and on a lone call after the tool lookup, before `askBeforeLoneCall` and `admit`. It sits below
the multi-call retry, so it judges whichever answer came back; a refusal is never retried. A
detached job is refused the same way, before admission: a log row, no dialog, no question.

**What the user gets.** One fixed, ASCII-only paragraph from code (no model text):
"I didn't file that issue. Nothing in my plan reads what you pointed at, so it would only have
had a made-up title. Open the email or copy the text, then ask again." Shown in the bar and
spoken. Logged `refused`, `tool: null`, `arguments: { plan: [tool names as sent] }`, never
through `logMiss` (nothing is missing from the menu). Like the unknown-reference refusal, the row
is left out of the next planning call's previous turn (`isUnreadContentRefusal`).

**Measured before it was built** against every recorded model answer containing a create (77,
`tests/fixtures/unreadContent/recorded.json`) and eight legitimate synthetic cases: it refuses the
four recorded misses (six entries) and nothing else. It does not catch the LOUD misses (a
"summarize the clipboard, then create" plan is fed by `{step1}`, and its preview names the
clipboard; M30's `checkUnaskedSteps`, below, refuses those) or a lone create that drops a send
(a different failure).

### A blank nothing fills (added 2026-10-23, M28)

Measured in M28's plan-choice eval: "log this as an issue and let #bugs know", nothing on screen,
came back once as a create whose description was the literal `"{selected_text}"`. It is not a
`{stepN}`, so nothing substitutes it; the body is not blank, so `checkUnreadContent` passes it;
and once approved the issue would read "{selected_text}".

`checkUnfilledBlanks` (`core/chain.ts`, pure) refuses when any argument, at any depth, holds a
**blank** that is not the user's own text. How a blank is told from a brace in real text:

1. **Shape.** `{`, optional spaces, one bare name (a letter or `_`, then letters, digits, `_`,
   `.`, `-`), optional spaces, `}` — `{selected_text}`, `{ clipboard }`, `{email.body}`. JSON
   (`{"a": 1}`), code (`{ return x; }`), sets (`{1, 2}`), `{}` and prose in braces
   (`{see below}`) are not this shape.
2. **Whose text.** A blank that appears in the instruction or the captured clipboard is the
   user's (a copied "Hello {name}" template) and passes; a clipboard holding one blank does not
   excuse a different one.
3. **References.** Anything the `{stepN}` parser accepts is a reference, judged by
   `validatePlan`. A near-miss it does not accept (`{step_one}`) is a blank.

**Refuses; never rewrites.** Where: on a plan after `validatePlan` (so a malformed `{stepN}`
keeps its own refusal) and before `checkUnreadContent` and the one-step branch; on a lone call
before `checkUnreadContent`. What the user gets: one fixed ASCII paragraph, "I didn't start that.
My plan had a blank in curly braces that nothing would fill in, so it would have gone out as
those characters. Copy the text you mean, or say it, then ask again." Logged `refused`,
`tool: null`, never through `logMiss`, and kept out of the next planning call's previous turn
(`isUnfilledBlankRefusal`), like the unread-content refusal.

### A step nobody asked for, before a create (added 2026-10-23, M30)

M27's live finding, measured in M28 and seen again in M29: the model sometimes puts a summarize
or rewrite step in front of a create that nobody asked for. With a long clipboard the issue would
carry the model's version of the text instead of the person's; with nothing copied, "log this as
an issue and let #bugs know" planned summarize > create > send in 14 of 25 recorded answers and
stops at "Nothing to summarize". M28's two prompt wordings fixed it and each broke a control, so
it is judged in code.

`checkUnaskedSteps` (`core/chain.ts`, pure) refuses a plan in which a step of a tool that declares
**`Tool.askedForBy`** comes **before** a create (`contentArg`), unless the **instruction** says
one of **that tool's own** words. Refuses; never rewrites the plan.

| Tool | `askedForBy` |
|---|---|
| `summarize` | summarize, summarise, summary, condense, shorten, tl;dr, tldr, tl dr, sum up, shorter, brief, gist, key points, short version, boil down |
| `rewrite` | rewrite, reword, polish, rephrase, clean up, formal, wording, tidy, make it sound |

- **Per tool, never pooled.** "polish this and file it" with a summarize step is refused; with a
  rewrite step it runs. No other tool declares the field, and it is never sent to the model.
- **How a word matches (`saysAny`).** Whole words, case-insensitive, over the instruction only;
  never the clipboard, which is the text being filed and can say anything. A two-word entry also
  matches with one object word between: it, this, that, these, those or them ("sum this up",
  "boil it down", "clean that up").
- **"tl;dr" in three forms** (added in M30's review pass): "tl;dr", "tldr" and "tl dr", all on
  `summarize`'s list, since speech-to-text rarely writes the semicolon. Word-bounded like every
  entry, so "tldrs" or "tl drive" do not match. "tl dr", as a two-word entry, would also take
  an object word between ("tl it dr"), which nobody says.
- **Not looked at:** a step that is not before a create (a plan that only summarizes,
  summarize > send, create > summarize), a lone call (one call has no step before it, so the
  check has no lone-call call site), and tools that declare no words (`readEmail`).
- **Where.** On a plan, after `validatePlan`, `checkUnfilledBlanks` and `checkUnreadContent`,
  before the one-step branch, `settleReferences`, `admit`, the preview and any step. It judges the
  answer after the multi-call retry; a refusal is never retried. A detached job is refused the same
  way, before admission.
- **What the user gets.** One of two fixed ASCII sentences from code, chosen by whether anything
  was copied: with nothing (or only whitespace), "I'd need text to work from. Copy it, then ask
  again."; with text, "I won't summarize/reword it unless you ask. Ask again to file it as it is,
  or say 'summarize' / 'rewrite' if you want that." Shown and spoken whole. Logged `refused`,
  `tool: null`, `arguments: { plan: [tool names as sent] }`, never through `logMiss`, and kept out
  of the next planning call's previous turn (`isUnaskedStepRefusal`).

**Measured** (`tests/unaskedSteps.test.ts`), with no model calls: against every plan on record
with such a step (the 77 recorded answers, M28's baseline table rebuilt trial by trial, and 8 live
runs from the action log, `tests/fixtures/unaskedSteps/replay.ts`), it refuses all **30**
unasked steps (16 recorded, 8 eval, 6 live) and lets all **5** asked-for steps run (3 eval, 2
live). Every other recorded plan is untouched, including M28's email-open and nothing-on-screen
controls that the reverted wordings broke.

**Known gaps.** Measured on 22 phrasings written by hand that ask for the step, and 4 where the
word is part of the bug. Neither set was checked against a model.
- **Wrongly refused, 1 of 22:** "file a one-line issue from this" (no listed word). "tldr this
  and file it" was the second until the review pass added "tldr" and "tl dr"; it now runs.
- **Wrongly refused by rule, not in the 22:** inflected forms ("summarized", "reworded",
  "shortened", "briefly"); "make this sound…" (only "make it sound"); a two-word entry with more
  than one word between ("sum the whole thing up").
- **Let through, 4 of 4:** "file an issue: the summarize button is broken", "log a bug that the
  rewrite tool drops the header", "file this: polish translations are missing", "create an issue
  to shorten the login timeout". The word is in the bug, so the step runs, as it did before M30.
- **With an email open and nothing copied,** a summarize step before a create gets "Copy it",
  which is accurate (`summarize` reads only the clipboard) but does not mention the email. Not
  seen in any recorded plan.
- **A refusal costs a try.** On a long clipboard, about half the next tries plan cleanly (7 of 15
  long-clipboard create runs had the step).
- **The model condensing the text inside the create call** is not judged. M30's investigation
  found no confirmed case. The `[main]` line now says, for each create with a description, whether
  it `equals clipboard` (whitespace aside), `differs from clipboard`, or is `from an earlier step`
  (`createDescriptions`, `PlannerOutcome.descriptions`); it changes no behaviour.

### A send the instruction asked for, missing from the answer (added 2026-10-23, M31)

"create a linear issue and send to fun", with a long clipboard and no email open, sometimes came
back as a lone create: the issue would have been filed and fun never told. M30's scripted run saw
it 4 times in 12; M31's recon 3 in 6 with a fresh action log and 0 in 6 with a shared one, all
three lone tool calls; live, row 559 filed a real issue that way. Nothing compared what was
asked with what was planned.

`checkDroppedSends` (`core/chain.ts`, pure) refuses a **plan or a lone call** that holds a create
(`contentArg`) and **no step** of a tool declaring **`Tool.askedWithCreateBy`**, when the
**instruction** says one of that tool's words **with a destination the app knows**. Refuses;
never adds the missing step.

| Tool | `askedWithCreateBy` |
|---|---|
| `sendMessage` | send, post, tell, let ... know, share, message, ping |

- **Its own field, not `askedForBy`.** `checkUnaskedSteps` judges every tool declaring
  `askedForBy` when its step comes before a create, and would then refuse a send step there with
  the summarize/reword wording. Never sent to the model.
- **A word plus a known destination (`asksFor`).** Over the instruction only, with quoted text
  removed, one clause at a time (split at `, . ; : ! ?`):
  - the word as a whole token ("post-merge" is not "post"), then the destination at once ("tell
    fun", "ping the team"), or after up to three object words and `to` / `in` / `on` / `into`
    ("send to fun", "share it in #social"). "let ... know" takes the destination between.
  - the destination (up to four words, longest first) is **known** when it is a `#name`; or
    `memory.resolve` (the lookup `checkReference` makes) gives a `#channel`; or, without a leading
    "the" / "my" and a trailing "channel", it is a bare name whose `#channel` some memory fact
    holds as its value ("fun" when a fact says "#fun"). `channelKnowledge(memory)` reads that set
    from `memory.query("")` once per check.
  - **A bare name is not taken as given**, as `checkReference` would take it: that would make any
    word after "to" a destination ("an issue to tell users about downtime").
- **Not looked at:** an answer with no create ("reply to this and send it", "summarize this and
  send to fun"); a plan that already has the send, before the create or after it.
- **Where.** On a plan after `checkUnaskedSteps`, before the one-step branch, `settleReferences`,
  `admit`, the preview and any step; on a lone call after `checkUnreadContent`, before
  `askBeforeLoneCall` and `admit`. Both paths judge the answer after the multi-call retry. A
  detached job is refused the same way, before admission.
- **What the user gets.** One fixed plain-ASCII sentence with no slash: "You asked me to send it
  too, but my plan had no send step, so nothing was filed. Ask again, or file it and send it as
  two requests." Shown and spoken whole. Logged `refused`, `tool: null`, `arguments: { plan:
  [tool names as sent] }`, never through `logMiss`, and kept out of the next planning call's
  previous turn (`isDroppedSendRefusal`).

**Measured** (`tests/droppedSends.test.ts`), no model calls: every drop on record is refused (the
3 recon drops, M28's "create only" trial, row 559, `tests/fixtures/sendDropped/drops.ts`); none of
the 77 recorded answers is refused (all kept their send); of M28's 45 eval trials only the "create
only" one is, and the 32 that asked for a send and kept it are not. M30's 30/30, 5/5 and 24
controls are unchanged (`checkUnaskedSteps` is untouched). M30's live fixture is not replayed:
those runs were cancelled at a dialog, and a send planned after the create was never logged.

**Known gaps.**
- **Only sends.** Row 559 also dropped "note changes in notion"; a dropped Notion step (or any
  other tool's) is not checked.
- **A channel memory has never been told about is not known**, even if it exists in Slack ("send
  to general"): the drop is let through. The bot-mode channel directory is a network call and is
  not consulted. The same for a phrase memory does not resolve ("tell the bugs channel" with no
  "#bugs" fact).
- **More than three object words** before the preposition ("send all of the notes to fun"), or a
  destination longer than four words, is not read as a send.
- **A known destination inside the content** is read as a send: "file a bug: the share button in
  #social crashes", "file an issue to tell the team lead" (when "team" resolves).
- **A refusal costs a try.** In M31's live run, 3 of 12 tries of "…send to fun" were refused this
  way, and 1 of 6 of "…post in fun".

### The previous turn's age, and a reply in the model's own words (added 2026-10-23, M32)

**What the model is given.** The app captures only the clipboard (`WindowsShell.getContext`:
`selectedText` from the clipboard, `activeApp` and `activeWindowTitle` always null) plus the
"email is open" flag. No page or screen text is ever sent. The planning request
(`renderRequest`, `core/llm/prompt.ts`) is the current time, the previous turn, the instruction,
the whole clipboard labelled `Selected text (clipboard):`, and the email line. The previous turn
carries its instruction, its arguments as JSON and a 300-character preview of its result.

**The live finding (rows 666 > 667).** "create a linear issue and post in fun" was answered in
prose, asking for "the full close-out prompt" and which channel "Claude Code" is. Row 666, 152
minutes earlier, was "rewrite this politely". As a lone call it had copied its rewording to the
clipboard, and that rewording asked to send Claude Code a close-out prompt. It reached the model
as the previous turn, and very likely as the clipboard too. It was not the screen. Of the seven
prose replies to create/send instructions in the log, four followed a refusal one to three
minutes earlier (which M21's exclusions now cover). Two had a previous turn over an hour old (rows
647 and 667, 76 and 152 minutes).

**Rule A: a stale previous turn is not sent.** In `decide()`, beside the refusal exclusions, a
last row older than `PREVIOUS_TURN_MAX_AGE_MS` (10 minutes, by the planner's injected clock) is
not handed to the model. At the cutoff it is still sent; one second past it, not. A timestamp
that cannot be read is judged as before. A correction or a pronoun follow-up comes at once, so
it keeps its turn ("no, I meant the new one"; "send it" after a draft).

**Rule B: a reply the model wrote is framed.** When the model answers with text and no tool,
`refuse()` shows and speaks it after a fixed lead: "Nothing ran. The model said: " and then the
model's words. It is plain ASCII with no slash. The text is spoken under the cap shortened by
the lead (`toSpokenWithLead`), so the lead is always spoken whole and the cut never lands on its
full stop; the rest is held for "read the rest", as for any long result. The fixed refusal ("I
can't do that yet…") is unchanged and unframed. The `[main]` line says `[reply: model prose]` or
`[reply: fixed refusal]` (`PlannerOutcome.reply`). The log row (`logMiss`) still holds no text.

**Deliberately not done** (each changes the planning prompt, and needs an eval with controls):
- keeping a content tool's result out of the previous turn;
- asking the model once more when it replies in prose to an action;
- relabelling or capping the clipboard.

**Known gaps.** A correction asked more than ten minutes later loses its previous turn. A stale
clipboard is still sent whole: only the previous turn ages out.

### Deliberately deferred

No new tools; no conditional branching mid-chain ("if I'm free at 3, book X, otherwise Y" — a
fixed plan is a straight line, not a decision tree); ~~no persistent background execution (the whole
chain runs inside one instruction; a task that survives closing the bar needs a task registry, a
notification path and cancellation, and is a larger milestone)~~ — **that milestone is M23**
(§5c): the task registry is the job store, the notification path is the pill and the chime, and
a job can be cancelled. What M23 does **not** change is everything above this line: one planning
call, a fixed plan, three steps, the same gate per step.

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

## 5c. Background jobs (M23) — the same chain, without the bar

**Closed 2026-10-22, after a live run by a person (`docs/M23-live-checklist.md`: 12 boxes
ticked, 30 open), with named gaps. §9 has the build order, what each claim rests on, the
mutation table, the gaps and the open limits.**

Every instruction is one **job**. A job runs the planner an instruction always ran — one
planning call, a fixed plan of up to three steps, the same per-step gates (§5, §5b). Nothing
about *what* may run or *who* approves it changed. What M23 adds is that an instruction no
longer has to hold the command bar until it is finished.

### Attached and detached

A job starts **attached**: the user just asked for it and is looking at the bar. An attached
job behaves exactly as an instruction did through M22 — its narration, results and speech go
to the bar, tools that act on the screen run, and a confirm dialog opens at once, for every
step.

Pressing the instruction hotkey (or the dictation hotkey) while it is still working
**detaches** it. From that press on:

- its narration and results go to its own job record, shown in the status pill — never to the
  bar's status, result or Thinking lines, the speaker, the "read me the rest" store, or the
  previous turn (`core/jobs/JobShell.ts`);
- it **pauses** — state `needs-you` — before a confirm, and before any tool tagged
  `foreground-only`. It does not open a dialog on someone who is typing.

A press is **blocked** instead, as before, in three cases: a dialog is open, a question is
open, or the attached job *holds the foreground* — it is inside a `foreground-only` step, or
between "this step needs a confirm" and that dialog being answered. Through M22 any running
chain blocked both hotkeys for its whole length; now only that narrower thing does.

**Escape while the attached job is still working (M25).** Escape means "never mind" everywhere
else in the app; until M25 it only hid the bar, and the job went on — popped the bar back up
with its answer, spoke it, and opened a dangerous confirm on someone who had just said never
mind. Now (`JobManager.escapeAttached`, run by the Escape press only — not by a question timing
out):

| the attached job | Escape |
|---|---|
| still planning, or queued for a slot (no step entered) | **cancels** it, silently: its "Cancelled before it started" goes to its own record, the bar is not re-shown, nothing is said, and it is never in the pill |
| a step has been entered | **detaches** it (trigger `escape`): it carries on in the pill, silent, with its Cancel button — it may already have done something, so it is not stopped blind |
| holds the foreground (a `foreground-only` step, or its confirm is up) | leaves it alone, as before — with a confirm up, Escape is the dialog's own Cancel |

And a voice instruction Escaped **during transcription** is thrown away: `VoiceSession.finish()`
returns nothing if the session was abandoned while whisper worked (until M25 the transcript was
run anyway). The renderer's own Escape key (`commandbar:close`), a fallback that only fires if
the global Escape could not be registered, still only hides the bar.

**An outside click while the attached job is still working (M25).** Focus leaving a *visible*
bar for another window — a click elsewhere, or Alt+Tab — while its job is planning or working
**detaches** that job (trigger `outside-click`): it moves to the pill, runs silent, and keeps its
Cancel button. The bar hides as it always did, and speech that is playing is not stopped.
Nothing else that blurs the bar does this:

| the blur | what happens |
|---|---|
| the app hid the bar itself (Escape, the 12 s auto-hide, a dismissal) | no detach — measured: the blur arrives *after* the hide, with the window already invisible |
| a confirm dialog opened | no detach — a message box blurs its window while it is still visible (measured), so the confirm-pending guard is what stops it |
| recording, transcribing, or dictation inserting | nothing changes: the bar is pinned, as before |
| typing (a capture is open, no job yet) | the bar hides, as before |
| a finished result is showing | the bar hides, as before — there is no job working |

`WindowsShell.handleBlur` decides it was focus leaving a visible bar; `main.ts` passes that to
`JobManager.detachAttached("outside-click")`, which does nothing when no job is working and
refuses one that holds the foreground. Measured by `scripts/blur-recon.cjs` (Electron 33,
Windows); `tests/outsideClick.test.ts`'s fake window copies what it measured.

### `Tool.background`

Required on every tool, with no default (`core/types.ts`):

| Tag | Tools | Why |
|---|---|---|
| `ok` | summarize, recall, remember, readSchedule, createEvent, moveEvent, sendMessage, `linear__*`, `github__*`, jobStatus | pure, or an API call working from what was captured at submission |
| `foreground-only` | draftReply, reviseDraft, sendReply, readEmail, addToPage | act on whatever is open at that moment |
| `foreground-only` | pointAt, openTarget, openApp, searchSpotify | take focus, or point at the current window |
| `foreground-only` | systemVolume, mediaControl, rewrite, elaborate | hit the current media session, overwrite the clipboard, or speak |

Independent of `risk`: `readEmail` is `safe` and still about a moment; `sendMessage` is
`dangerous` and still fine to prepare unattended, because the confirm gate is what holds it.
`tests/background.test.ts` pins this table.

### States

```
submit ─► running ─► done / failed / cancelled
            │  ▲
  no slot   ▼  │ a slot frees
          queued ─► cancelled
running ─► needs-you ─► running     (resumed from the pill)
               ├──────► expired     (30 minutes, nobody answered — the tool is NOT run)
               └──────► cancelled
queued / running / needs-you ─► interrupted   (only at startup)
```

- **Planning is not capped; executing is.** At most three jobs execute at once
  (`MAX_RUNNING`). A job holds no slot until its plan is settled, so a status question is
  answered at once however many are busy. A job that is waiting for the user gives its slot
  back; one the user has just resumed does not queue behind the cap.
- **Expiry** is 30 minutes from the moment a job starts waiting, checked on a one-second timer
  *and at the click* that resumes it. An expired step is logged with status `expired` and its
  handler is never called. Once a job has been resumed the clock no longer applies: the
  dialog's answer decides.
- **Cancel**: a queued or waiting job stops at once. A job mid-step is left to finish that
  step — a handler cannot be un-called — and nothing after it starts. **Until it does, its row
  in the pill says "Cancelling — finishing step N of M"** (or "Cancelling — stops before its
  first step" while it is still planning) **and offers no second Cancel** (M27). The pill's
  label and the rest of the list are unchanged: it still counts as running. Until M27 the row
  went on saying "Running" and offered Cancel again, so the press seemed to do nothing. The
  pending cancel is `JobView.cancelRequested`, in memory only.
- **Restart**: jobs are rows in the `jobs` table of the same SQLite file. On startup every live
  job becomes `interrupted` and is **never resumed**. A marker written immediately before each
  handler call and cleared after it is what lets the record say *"it may or may not have gone
  through"* only for a step that had started, and *"nothing was sent by that step"* otherwise.

### Context is captured once, at submission

`captureContext` (`core/planner.ts`) reads the clipboard and the email-open flag when the
instruction is given, and the job holds the result for its whole life — through a wait for a
slot, a detach and a thirty-minute pause. Nothing reads the clipboard again. The email's
*content* is not captured (it never was — §5b); the tools that read it are `foreground-only`.
The captured context is **not persisted**: a job is never resumed after a restart, so nothing
needs it, and a clipboard is as likely to hold a password as notes.

### The confirm gate, when nobody is there

A detached job waits **before** its confirm summary is built. When the user clicks its row in
the pill, the planner works the tier out again (keeping the stricter of the two answers),
builds the summary from the world as it is *then*, and asks the shell for the dialog. So what
the dialog says was true when it opened, not when the job paused.

All confirms, attached and detached, go through one queue (`shell/ConfirmBroker.ts`) that
replaced the shell's `confirmPending` boolean: one dialog on screen at a time, the next opens
when it is answered, and "is a confirm pending" — which both hotkey guards read — is answered
from the queue.

A **detached** dialog differs from an attached one only in what it may disturb, which is
nothing: it is parented to the pill window instead of the bar, the bar is not hidden (hiding
it fires the handler that ends a capture or a question), a blur does not dismiss the bar, and
speech is not stopped. **With no live pill window it is refused** — no dialog is opened, and
the request fails as an error rather than a "no" — because an unparented dialog was measured
fully covered by a visible bar. A yes given to a dialog whose job was cancelled from the pill
while it was open (the queue cannot take a request back) is discarded: nothing runs. A job that was detached without being resumed for a confirm cannot open
a dialog at all: its request resolves "not approved" without one being shown.

**Where the keyboard goes after a detached dialog** (live finding after M23). When an owned
dialog closes, Windows gives the foreground to its owner — the pill, which never takes focus —
so the bar was left without the keyboard and a half-typed instruction needed a click to go on.
The shell now records, when the first of a run of queued detached dialogs opens, whether the bar
was open **and** focused. When the last of them closes (approve, cancel, Esc or a dialog that
throws) and the bar is still open, it focuses the bar and asks the renderer to put the caret at
the end of the text, selecting nothing; the text and the waiting capture are untouched. If the
bar was closed or another app had the keyboard, nothing is focused and the foreground stays
wherever Windows puts it (measured: the pill). An attached confirm is unchanged. Pinned by
`tests/WindowsShell.capture.test.ts` and `CommandBar.test.tsx`; the real-window half is
`scripts/ask-recon/focus-after-dialog.ts`.

**"There's a confirmation waiting" comes down when nothing is** (live finding after M23). A
hotkey pressed while any dialog is up is blocked and says so in the bar — in an already-open
bar too, which a detached dialog never hides. Nothing used to take that line down: a status
line goes only when a result, a reset or a new opening of the bar replaces it, so after the
dialog was cancelled the open bar still said a confirmation was waiting. The shell now
remembers the status line it last sent and, if it is still exactly that sentence, clears it
when the last queued dialog closes (approve, cancel, Esc or a throw) and when the bar's text is
submitted. Any other status — a narration, a result, a question — is left alone, and so is
"Thinking…", which is its own channel. Pinned by `tests/WindowsShell.capture.test.ts`; the
real-window half is `scripts/ask-recon/confirm-waiting-line.ts`.

### The status pill

A frameless, non-focusable, always-on-top window at the bottom right of the primary display's
work area, excluded from screen capture, shown only with `showInactive()`.

| Group, most urgent first | Counts | Colour, when it is the top group present |
|---|---|---|
| "N needs you" | jobs waiting | amber. Pulses for 2.4 s when a job starts waiting, then steady |
| "N didn't finish" | failed, expired or interrupted — and cancelled after a step ran (M27) — see "How long a job stays" below | red dot |
| "N running" | running or queued | blue dot |
| "N done" | finished background jobs not yet seen, then a minute — see below (M26) | green dot |

**The label counts every group present, in that order, joined by " · "** — "1 running · 2
done" (M27). The **colour and the pulse are the top group's alone.** Until M27 the label counted
only the top group too, so a running job hid done ones, which since M26 can wait indefinitely
(M26's third live finding). A job cancelled before any step ran is in no group; one cancelled
after a step ran is in "didn't finish" (M27) — it stopped partway, the same thing that group
already counts, and its red, if it is the top group, is earned: something was done and
something was not.

**The collapsed pill is as wide as its label** (M27), between 232 px (`PILL_COLLAPSED`, the M23
pill) and **`PILL_LABEL_MAX_WIDTH`, 348 px** — the open list's width, so opening it never moves
the pill itself. Core writes the label every way it can be written, longest first: all the
groups; then one group fewer plus "+N more", N being the **jobs** in the groups left off; down
to the top group alone plus "+N more" (the top group is never the one left off). The page
measures each form off-screen at its natural width and reports the widths *with the labels they
are for*; main drops a report for labels it is no longer showing, then shows the longest form
within the cap at that width. If none fits, the shortest at the cap. Before a measurement (the
frame after the counts change) the full label is drawn at the last chosen width, so the pill
does not shrink for a frame; the stylesheet ellipsizes rather than wraps. The same
measure-then-resize path as the open list's height. Measured in a real window by
`scripts/pill-label-recon.cjs`: all four groups with single-digit counts fit (330 px); "+N more"
appears only with double- or triple-digit counts.

**How long a job stays in the pill** (2026-10-14). The pill only — leaving it deletes nothing:
the job's row and its action-log rows are kept.

| Job | Stays |
|---|---|
| running, queued, needs-you | while it is |
| done | **until the user has seen it**, however long that is; then one minute more (`DONE_SEEN_CLEAR_MS`, tunable) — M26. Until M26: 8 s, then gone, seen or not |
| cancelled by the user **before any step ran** | not shown at all — nothing happened (M23) |
| cancelled by the user **after a step ran** | like done: **until the user has seen it**, then one minute more, with the job's own message ("I'd already done step 1 of 2, but step 2 didn't run.") and Dismiss; brought back after a restart while unseen, however old (M27). Until M27 every cancelled job was hidden, so a job that had already done something vanished with no word of it |
| done after a Cancel came too late (during its last step) | an ordinary done row whose detail reads **"Finished before it could be cancelled — <result>"** (M27). The request is in memory only, so after a restart the same row reads as plain done — still true |
| failed, expired | **until the user has seen it**, however long that is; then one hour more |
| interrupted | until it is dismissed, and only then — it may say "may or may not have gone through" |

"Seen" means the list was open with the job in it. It is recorded once, as `seen_at` on the
job's row (added by the same guarded migration as the action-log columns), so a restart
neither resets the hour nor counts as a look; a failed job nobody opened the list for is
brought back after a restart however old it is, and since M26 so is a done one — and since M27
one cancelled after a step ran. Whether a step ran is `steps_run` on the job's row (M27, the
same guarded migration; `JobRecord.stepsRun`): the count of its handlers that were called and
returned or threw, incremented where the write-ahead marker is cleared. NULL on older rows,
read as 0, so a job cancelled before M27 stays hidden as it was. The minute
after a done job is seen is for finishing reading its result in the open list (the row shows
it, up to 420 characters, as before) — nothing new is spoken and no chime plays. Dismiss
clears a done job at once. A done job that finished in the bar was never background and never
appears. The pill's 1 s re-check is what notices a seen job's minute is up. The list shows at most **ten** jobs, the most
recent — except that a job waiting for the user is never the one left off. A job past the ten
is still counted in the pill's label and is not "seen" until it is listed.

**One console line per pill event** (`[main] <timestamp> pill …`): a click on the pill, a
row's button, the pointer entering or leaving, and every time the list opens or closes with
the reason. Added after a live report ("the list stayed open after Review…") that four
real-window runs could not reproduce and nothing had recorded. Timestamps, job ids and fixed
words only.

**The list always starts collapsed** (fixed 2026-10-13, after a live run in which a list opened
once stayed open for every later instruction). Whether it is open is one in-memory flag in the
pill's state — never a setting, never persisted. It becomes true only on a click of the pill,
and goes back to false on: a second click; **Review…** or **Resume** that took effect (a
dialog or the screen is about to need the user); an accepted
press of the instruction or dictation hotkey (the same hook that detaches the attached job,
`main/jobs/startingSomethingElse.ts`); ten seconds with the pointer off the pill's window; and
the pill emptying. **Dismiss, Cancel and Dismiss all do not close it** (M27): it stays open
while anything is still listed and closes when the last row goes — the pill emptying. Until M27
every row button closed it, so clearing several done jobs meant reopening the pill for each
(M26's first live finding). A Cancel on a job mid-step leaves its row, still running, until the
step ends (§5c, States); the list stays open with it. Nothing about a job — a new one, one that starts waiting, one that fails —
opens it. The window cannot take focus, so there is no blur: the page reports the pointer
entering and leaving, and once a second main also asks the OS where the pointer is, because
the window is resized under it and a `mouseleave` was measured not arriving.

**A mouse press outside the pill closes an open list** (M27, fix B; M26's second live finding —
until M27 it closed only ten seconds after the pointer left). With no blur to listen for, a
helper watches the mouse buttons (`main/shell/WindowsPointerWatcher.ts`, behind
`PointerPressSource`): a persistent PowerShell host, in the style of `WindowsInputInjector`,
whose background thread polls `GetAsyncKeyState` for left, right, middle, X1 and X2 **every 50
ms, reading both bits** — down now, and pressed since the last poll — and on a press reports
`GetCursorPos`. `PillController` closes the list when the point is outside the pill window's
bounds; a press inside (a row, the list's own buttons, the pill itself) is the page's business.
Any outside press counts: the desktop, another app, the instruction bar.

- **Watched only while the list is open**, whatever opened or closed it (a click, the hotkey,
  Review…/Resume, ten idle seconds, the pill emptying): `WATCH` when it opens, `STOP` — the
  polling thread joined — when it closes. A press line arriving after that is ignored.
- **Prepared when the pill first appears**, not at the click that opens the list: the host takes
  about 1.5 s to start. If the list is opened before it is ready, watching starts when it is.
- **The opening click never counts**: the first poll after `WATCH` is never a press, low bit
  included — nor is a button already held down when watching starts. The host only samples
  (`SAMPLE first down low x y`); that rule, and the press rule, are `judgeSample` in TypeScript.
- **The helper does not outlive the app**: disposed at `will-quit` (`QUIT`, then killed), as
  `WindowsInputInjector` is; and when main exits any other way, a hard kill included, its stdin
  closes and the host exits — its polling thread is a background thread. Measured 2026-10-22: the
  helper gone after dispose, after a plain exit, and within 0.2 s of `taskkill /F` on the parent,
  watching or idle.
- **Mouse buttons only**: a key (a hotkey, F24), a window hiding itself, a message box opening
  and the pill hiding and re-showing are not presses — measured, not assumed.
- **If the helper cannot start, or dies, the list works as before M27**: it closes ten seconds
  after the pointer leaves, on a second click, Review…/Resume or the hotkey. That is said once
  in the console (`outside presses cannot be watched (…)`), never swallowed, and not retried at
  the next click.

Measured first on a prototype (`scripts/pill-outside-click-recon.cjs`, 2026-10-22): 48 of 48
clicks seen, held 0-120 ms, at 50 and 100 ms; the high bit alone caught every click held 30 ms
or more at 50 ms but only a quarter of 5-15 ms taps, so the low bit is what catches a tap;
press-to-noticed median 32 ms, max 63 ms at 50 ms; the helper's processor time while polling
below what Windows measures (0 ms in 8 s); start-up about 1.5 s; inside clicks read inside the
pill's electron bounds 4 of 4 (PowerShell is not DPI-aware, so its points are DIP, like
`getBounds()`). Then on the shipped code in real windows (`scripts/ask-recon/pill-outside-click.ts`):
PASS. **Known limits:** Windows documents that another program polling the same button state
can take the "pressed since" bit first, so a tap shorter than the poll can then be missed;
taps under about 15 ms rely on that bit; a press in the pill window's transparent margin counts
as inside; a pill on a secondary display, or mixed display scaling, is not measured (the pill
lives on the primary display).

The open panel is **sized to its content**: the page measures the list and main resizes the
window to fit, up to 440 px, keeping the bottom-right corner fixed. A job's message is drawn
whole and wrapped; only text over 420 characters is shortened, between words, with an
ellipsis. Measured in a real window by `scripts/ask-recon/pill-collapse.ts`.

Clicking it opens a list. Each row has only its own buttons — **Review…** (opens the native
confirm dialog; approves nothing), **Resume** (a job that needs the screen), **Cancel**,
**Dismiss** — and the list has a mute toggle for the chime. The button labels are fixed in the
page's code; a row's title is the user's instruction and its detail may be a tool's result,
and both are drawn as text. Everything the page sends is checked again in main
(`pill/PillController.ts`): an unknown action, an unknown job, or an action that row is not
currently offering is dropped.

**Dismiss all** (M27), in the list's header row beside the chime toggle, dismisses every row **listed** that is
**done, failed, expired or cancelled** (a cancelled row is listed only when a step had run) (`dismissAllTargets` in `core/jobs/pill.ts`) — never a running,
queued or waiting job (it cancels nothing), never an **interrupted** one (it may say "may or
may not have gone through", which is why it stays until dismissed on its own), and never a job
past the list's cap of ten (not on screen; it is listed next). It is offered only while the
list is open with at least one such row; the page sends no arguments (`pill:dismiss-all`), and
main works the rows out from what it is showing at the press, so a press after the list closed,
or with nothing ended listed, is dropped. The **header row is sticky and opaque**: past the
panel's 440 px ceiling the list scrolls, which is when Dismiss all is most wanted, and the header
— heading, Dismiss all, chime toggle — stays pinned to the top of what is visible, with rows
scrolling under it. Measured by `scripts/pill-dismiss-all-recon.cjs` (six rows, at the top and
scrolled to the bottom): unpinned, the header was out of reach after 21 px of scroll; at
`--surface`'s 0.96 alpha the rows showed through it. The chime toggle had been scrolling away
since M23 for the same reason. `render.test.ts` pins both properties from `pill.html`'s own
stylesheet.

Only **background** jobs appear — one that was detached at some point, or, after a restart,
one the app closed on while a step was running even if it never left the bar (its write-ahead
marker was set, so it may have done something the user never saw the end of). A job the user
watched finish in the bar is not listed, nor one cut off before any step ran (planning, or at
its confirm: recorded as interrupted, not shown), and neither is a status question.

Where it goes is a pure function of the work area in DIP (`core/jobs/pill.ts`, `pillBounds`),
with no scale factor in it.

### The chime

One bundled sound (`src/renderer/assets/needs-you.wav`, generated by `scripts/make-chime.mjs`)
when a job enters `needs-you`. No speech engine and no network are involved. Not played for
done or failed. While dictation, an instruction recording or the app's own voice is active it
is held, and played once afterwards only if a job that wanted it is still waiting. Jobs that
start waiting within 2 s of a chime are covered by it. On by default; the mute toggle is saved
in the `settings` table. It plays on its own `chime:play` channel and its own `Audio` element
in the bar's window, never through the speech player.

### `jobStatus`

"Are my agents done yet?" routes to a `safe` tool that reads the job records and answers from
a fixed template (`core/jobs/statusAnswer.ts`) — a spoken sentence leading with whatever is
waiting, and on screen that sentence plus one line per job. It makes no model call. It reports
jobs that are live or ended in the last 30 minutes, and never itself. Completions are
otherwise silent.

### `tellTime` (M25)

The second status-only tool. "What's the time?" used to have no tool: the model answered in
prose from the planning prompt's clock line — long, different each time, and logged as a miss.
`tellTime` (`safe`, `statusOnly`, ungated) reads the clock in code and says one sentence:
*"It's 2:51 PM."* for the time, *"It's Thursday, 22 October."* for the date, and since M32
*"It's Thursday, 22 October, 2:51 PM."* for both (`what: "both"`; until M32 a combined question
got the time alone, or a two-step plan whose first answer was never shown). The time-only and
date-only wording is unchanged. The sentence is assembled from `Intl` parts with every separator written in
code, because ICU versions disagree on what goes before "PM" (some use U+202F) and node and
electron ship different ICU. Status-only, like `jobStatus`: answered at once without a job slot,
and never listed as a job.

### Action log

`action_log` gains two nullable columns, added by a guarded migration that checks for each
first (`core/memory/db.ts`): `job_id`, and `detached` — whether the job was detached when it
wrote the row. `getLast()`, which supplies the previous turn to the next planning call, skips
detached rows. `ActionStatus` gains `expired`.

### Deliberately not built

Resuming a job after a restart; cancelling a handler in flight; a job that asks a question
while detached (it is told nobody answered, and the plan is refused); a pill on any display
but the primary; a tray icon; answering a confirm from the pill or by voice.

---

## 6. Tool registry (core/registry.ts) — seven demo tasks, six tools (+3 in M10, +1 in M11, +3 in M13, +1 in M14, +1 in M15, regrounded in M16, +1 in M18 and +2 more with Spotify, +1 in M19 and 3 connector tools, +3 connector tools in M20, +1 in M25)

Each tool = `{ name, description, inputSchema, irreversible, handler }`. The
`description` and `inputSchema` are what the LLM sees (they double as the prompt).

> **`plan` is not in this table, and that is load-bearing (M17).** The `plan` meta-tool (§5b) is
> offered to the provider alongside these, but it has no handler and no risk tier and it is not
> in `registry.ts` — so `registry.find()` can never resolve it, and a model that names `plan` as
> a *step* inside a plan is refused by the ordinary unknown-tool check with no special case
> written anywhere. The closed world of this table is exactly what it was before M17.

| Tool          | Task(s) it serves                    | Reads memory? | Irreversible | Handler does | Preview phrase (M29) |
|---------------|--------------------------------------|---------------|--------------|--------------|----------------------|
| `summarize`   | 1. Summarize selection               | no            | safe         | LLM summarizes `context.selectedText`; showResult | summarize the text you copied |
| `rewrite`     | 2. Rewrite selection in my tone      | yes (tone)    | reversible   | LLM rewrites using stored tone; copyToClipboard. **In a chain (M29): returns only the rewritten text; no clipboard write, no header line** | reword the text you copied |
| `openTarget`  | 3. Open a named target               | yes (targets) | reversible   | resolve name→URL, `openUrl` | open a web page |
| `remember`    | 4. Remember X · 6. Correction sticks | writes        | reversible / **dangerous** | `prepare` settles the subject and value (M33; the bot-mode channel check moved there) → `memory.write()` (versions old fact on conflict). **`dangerous` (M33) when an active fact with exactly this subject holds a different value:** confirmed first, *Change what I remember for "team" from #social to social?*, button "Change it"; a first write and the same value stay `reversible` | save a fact to memory |
| `sendMessage` | 5. Format notes and send             | yes (channel only — `referenceArgs`) | **dangerous**| resolve channel, refusing an unknown one before the confirm → LLM formats notes → Slack webhook POST | post a message to Slack |
| `recall`      | 7. What do you remember about…       | reads         | safe         | `memory.query()` → showResult with metadata | look up a saved fact |
| `draftReply`  | 8. Reply to the open Gmail email      | yes (tone)    | caution      | read open email → compose → open reply box → insert draft | draft a reply in Gmail |
| `reviseDraft` | 9. Tweak that reply                   | yes (tone)    | caution      | re-compose from the LIVE box text → replace it | change the Gmail draft |
| `sendReply`   | 10. Send it                           | no            | **dangerous**| confirm (recipient + whole draft) → click Gmail's Send | send the Gmail reply |
| `addToPage`   | 11. Add a note to the open Notion page | yes (tone)   | caution      | read open page → compose → real-CDP click + type at the end | add a note to the Notion page |
| `readSchedule`| 12. What's on my calendar             | no            | safe         | list a time window → format as text | read your calendar |
| `createEvent` | 13. Put something on the calendar     | no            | caution / **dangerous** | create it; `dangerous` when anyone is invited | add an event to your calendar |
| `moveEvent`   | 14. Move something                    | no            | caution / **dangerous** | find it (default-deny) → move; `dangerous` when it has guests | move a calendar event |
| `elaborate`   | 15. "And the rest?"                   | no            | safe         | read back what the last spoken summary held back (§4d) | read out the rest of the last answer |
| `pointAt`     | 16. Where's the send button?          | no            | caution      | read the window's controls → model picks one BY NUMBER → code resolves its rect → draw a marker (§6d) | point at something on screen |
| `openApp`     | 17. Open an installed app             | no            | reversible   | match the user's NAME against a closed catalog → `openApp` action; refuse with the list on no match | open an app |
| `systemVolume`| 18. Turn the volume up/down/mute      | no            | reversible   | 1–15 presses of a real volume key via `SendInput`; says what was SENT as a change in percent ("Volume up about 10%"), never a level | change the volume |
| `mediaControl`| 19. Play/pause, next, previous        | no            | reversible   | one press of a real media key, to whichever app owns the media session | control what is playing |
| `searchSpotify`| 20. Find something on Spotify        | no            | reversible   | `openUrl` to a fixed-template Spotify search URL; the USER presses play | search Spotify |
| `readEmail`   | 21. What does this email say          | no            | safe         | read the open Gmail message → From / Subject / body as text (M19; gated with the Gmail group) | read the open email |
| `linear__create_issue` | 22. File an issue in Linear  | **never** (`resolvesReferences: false`) | **dangerous** | validate → merge `team` from config → drift check → remote `save_issue` → `Created ID: title` + link (§6e) | create a Linear issue |
| `linear__search_issues`| 23. Find an issue in Linear  | never         | safe (a server hint may raise it) | remote `list_issues` with `limit` and `fields` fixed in code → up to 5 lines with links | search Linear issues |
| `linear__get_issue`    | 24. What does ENG-123 say    | never         | safe (a server hint may raise it) | remote `get_issue` → title, status, link, description | read a Linear issue |
| `github__create_issue` | 25. Open a GitHub issue      | never         | **dangerous** (declared; the server hints nothing) | validate → merge `method: "create"`, `owner`, `repo` → drift check → remote `issue_write` → `Created #N: title` + link, refused if the link is outside the pinned repo (§6e, M20) | open a GitHub issue |
| `github__list_issues`  | 26. What's open on GitHub    | never         | safe (a server hint may raise it) | remote `list_issues` with repo, page size, fields and order fixed in code → up to 5 lines, links built from settings | list GitHub issues |
| `github__get_issue`    | 27. What does GitHub issue 12 say | never    | safe (a server hint may raise it) | remote `issue_read` with `method: "get"` and repo fixed → title, state, link, body | read a GitHub issue |

> **The `Preview phrase` column (M29)** is `Tool.planPhrase`: what a plan's preview shows and
> says for a step of that tool, in place of the model's `describe` (§5b, Execution). It is
> required on every tool and on every connector definition, with no default. `tellTime` ("tell
> the time or date") and `jobStatus` ("check your background jobs") have no row in this table.
> All 28 phrases are pinned word for word in `tests/planPhrase.test.ts`.

> **The three `linear__` rows are not constants of `registry.ts`**, unlike every row above them:
> they are built at startup by `core/mcp/load.ts` from a connector definition, `connectors.json`
> and the presence of a key, and handed to `buildRegistry` as a list. They are still a closed
> list — only a tool a definition in `core/mcp/connectors/` pins can be in it — and
> `tests/risk.test.ts` builds every pinned connector tool and holds it to the same whole-menu
> invariants as the rest.

> **`elaborate` and `pointAt` were missing from this table for four milestones** (added M14 and
> M15/M16 respectively; the section heading counted them, the rows were never written). Noted
> rather than quietly fixed, because the same omission had a twin in the test suite —
> `tests/risk.test.ts`'s "whole menu" invariants were built without `speech` or `pointing`
> switched on, so neither tool was under any registry-wide invariant either. Both are fixed at
> M18, and that test now asserts the menu it checks contains every group `registry.ts` exports,
> so the next addition cannot slip through the same gap.

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

### `referenceArgs` (added 2026-10-10)

`resolveArgs` inspects every top-level string **value**, so it cannot tell a tool's destination
from its message: a `sendMessage` body that read "the team" — typed, or substituted from an
earlier step's result — was swapped for the fact it named and posted. A tool may therefore
declare `referenceArgs: string[]`, and the planner then resolves **only** those arguments at
step 4. Undeclared, every top-level string is a candidate as before; `resolvesReferences: false`
still switches resolution off entirely and wins over a declaration.

| Tool | `referenceArgs` |
|------|-----------------|
| `sendMessage` | `["channel"]` — `notes` is sent as written |
| `openTarget` | `["target", "url"]` — its only arguments, so what is resolved is unchanged |

**Declaring `referenceArgs` also opts a tool into the chain pre-flight.** `runChain` calls
`preflightReferences(steps, registry, memory)` (`core/chain.ts`) after `validatePlan` and before
step 1. For each step whose tool declares `referenceArgs` (and has not set
`resolvesReferences: false`): an argument containing `{stepN}` is skipped; every other declared
argument is put to `checkReference`; and the step is refused only when **none** of them is
usable or pending. The list is read as alternatives because `openTarget`'s are — "the Spotify
web player" with a real `url` beside it must not be refused — and for a one-argument tool
"none" and "each" coincide. A refusal goes through `refusePlan`: nothing has run, the message
names the reference and its step ("Step 3 of my plan needs "the bugs channel", and I don't know
what that refers to yet…"). A one-step plan is not pre-flighted; it runs as a lone call and the
tool refuses in its own words. The pre-flight is deliberately one-sided: it never refuses a plan
the steps would have run (`tests/preflight.test.ts` runs each case alone and chained and
compares), but it can pass a plan a step later refuses — `openTarget` with a plain word that is
neither a reference nor a URL is the pinned example.

#### What is approved is what is sent (added 2026-10-10, live fix)

**The bug.** A lone "send these notes to the bugs channel" with nothing useful to send. Action
log rows 417 and 418: in one the model had copied the instruction itself into `notes` (so the
dialog previewed it), in the other there was no `notes` and the text came from the clipboard
(so the dialog showed no body at all). Both times the formatter — which ran in the handler,
*after* Send was pressed — replied "Please paste the rough notes you want formatted for the
#bugs channel.", and that was posted. Nothing checked the formatter's output. ("#bugs" was the
formatter paraphrasing the notes; it is never given the channel.)

**The fix.** `sendMessage` declares `prepare` (planner step 5a). For a lone send it:

1. checks the channel can be named (as the confirm and the handler also do) — **first, before
   any model call**, so an unknown channel never costs a formatting call;
2. refuses if there is nothing to send — no `notes` and an empty or blank clipboard — with
   "There's nothing to send. Copy the notes first (select them and press Ctrl+C), or put them
   in the instruction — for example: send "standup moved to 3pm" to the team.";
3. runs the formatter, and refuses if its reply is not a message (`isMessage`, below);
4. returns the arguments with `notes` **replaced by the exact text to post**.

The dialog then shows that whole text (no 140-character preview, no truncation) under the
destination lines, and the handler sends `notes` as it finds them. **The handler never calls
the model.** The cost, accepted: the dialog appears one model call later than before, and a
cancelled send has still paid for that call. In a **chain** `prepare` does nothing — `notes` is
already the exact text, shown in full and sent verbatim, as since M19.

**How `isMessage` decides.** A reply is *not* a message when it is empty, when it is the word
the formatter is told to use for "nothing to format" (`NO_NOTES`), or when one sentence talks
about the notes *themselves* as wanted or missing: a word for the material (notes, text,
content, message, details) together with a request for it ("paste/provide/share/send/give …
you want / you'd like / to format", "what notes would you like…") or a statement there is none
("no notes were provided", "any notes to format", "don't see … notes"). **Being a question, or
saying "please", is deliberately not the rule** — "Can everyone review the PR by Friday?" is a
message. It errs one way on purpose: a real message such as "Please share the notes you want
reviewed" would be refused (a rephrase, nothing sent), which is cheaper than posting the app's
confusion to a channel. The refusal does not repeat the formatter's words.

**Measured against the real formatter** (`tests/eval/sendFormatter.eval.test.ts`,
`M21_FORMATTER_EVAL=1`):

| Input | Should be | First wording | Current wording |
|-------|-----------|---------------|-----------------|
| "send these notes to the bugs channel" | refused | 5/5 | 5/5 |
| "post this to the team" | refused | 3/3 | 3/3 |
| ordinary rough notes | sent | 2/2 | 2/2 |
| "remind everyone the deploy is at 5pm today" | sent | **0/2** | 2/2 |
| "can someone review PR 212 before friday?" | sent | 2/2 | 2/2 |

The first wording of the `NO_NOTES` instruction ("only an instruction to send something")
refused a genuine one-line note; it now says "nothing to tell anyone … without giving them".
Every refusal in both runs was the literal `NO_NOTES`.

**Where the text came from decides whether it is formatted (live regression, 2026-10-11).**
The fix above first formatted *everything*, so `send "helluuu" to social channel` put the
user's own quoted word through the formatter, which answered `NO_NOTES` and got the send
refused. The rule is now by source:

| Source of the text | What happens |
|---|---|
| `notes` — a message the user gave in the instruction (quoted, or after "say"/"saying") | **sent as written.** No model call; nothing judges what it says. A quoted "the team", a quoted question, quoted text that reads like a command — all go out as typed. |
| `notes` that is only the whole instruction echoed back (rows 417, 419) | treated as **no notes**: falls through to the clipboard. Recognised by comparing it with the instruction (case, spacing, surrounding quotes and a closing run of `.`, `!` or `?` aside) — a comparison, not a judgement. |
| the clipboard (no `notes`) | **formatted**, and the formatter's reply must be a message (`isMessage`). |
| neither | refused before any dialog. |

**Known edge cases of the echo comparison, not fixed.** Quotes are stripped first and closing
punctuation second, once each, so two echoes are not recognised and are offered in the dialog
as the message (the user can still cancel):

- punctuation *after* a closing quote: `"send these notes to the bugs channel"!`
- the single ellipsis character: `send these notes to the bugs channel…`

Neither has been seen live. An instruction that is nothing but the message (`hello` as the
whole instruction, `notes: "hello"`) is, by the same rule, an echo and not a message.

`PrepareDeps` therefore has five keys, the fifth being `instruction`: the user's own words as
typed or transcribed, read-only — never email, clipboard or step text, and only compared,
never sent to the model. The tool description now tells the model to put a dictated message in
`notes` word for word, never the instruction itself, and never clipboard text. Measured before
and after (`tests/eval/quotedMessage.eval.test.ts`, `M21_QUOTED_EVAL=1`, 5 trials per cell):

| Instruction | Context | Before | After |
|---|---|---|---|
| `send "helluuu" to social channel` | no email | 5/5 | 5/5 |
| `send "helluuu" to social channel` | email open | 5/5 | 5/5 |
| `send "hello guys" to social channel` | no email | 5/5 | 5/5 |
| `send "hello guys" to social channel` | email open | 5/5 | 5/5 |
| `send "hello guys" to social channel` | email open, unrelated clipboard text | 5/5 | 5/5 |
| `tell the social channel saying we ship friday` | no email | 5/5 | 5/5 |
| `say good morning team in the social channel` | email open | 5/5 | 5/5 |
| `send these notes to the team` (notes on the clipboard) → no `notes` | — | 5/5 | 5/5 |

The planner was already putting the quoted words in `notes`; the bug was entirely in the tool.
**Not reproduced:** once, live, with an email open, `send "hello guys" to social channel`
came back as prose asking what to do with the email (row 452, `no_tool`). Thirty-plus trials
across the conditions above, including the previous turn the app actually had, all planned
`sendMessage`. What the live run had that these do not is its real clipboard, which nothing
recorded — and a `no_tool` row does not store the model's reply.

**Still true:** "selected text" is the clipboard, so a send with no `notes` formats whatever
was last copied. It is now *shown* before it is sent, which is the protection; it is not
checked for relevance. The action log's `notes` is now the text that was sent, not the model's
argument.

#### Where a message really goes (added 2026-10-10)

A Slack **app** webhook is bound to the one channel it was created for and **ignores the
`channel` field**. So the channel `sendMessage` resolves, checks and confirms is not where the
message lands — and through M20 the confirm ("Send to #help?") and the result ("Sent to #help.")
said that it was. They no longer do.

`SLACK_WEBHOOK_CHANNEL` (optional, in `.env` beside `SLACK_WEBHOOK_URL`, read in `main.ts` and
handed to `SlackSender`) is a **label** for the webhook's own channel. **It must be quoted** —
`SLACK_WEBHOOK_CHANNEL="#social"` — because dotenv reads an unquoted value starting with `#` as
a comment and yields the empty string. That state (present but blank) is treated as unset, and
`webhookChannelWarning` (`core/senders/SlackSender.ts`) produces one startup warning naming the
cause and the fix. The sender carries it as
`MessageSender.postsTo` (`null` when unset), and every text that names a destination is worded
from that — never from the asked channel:

| | `SLACK_WEBHOOK_CHANNEL=#social` | not set |
|---|---|---|
| Confirm | `Send to #social via your Slack webhook?` | `Send via your Slack webhook?` |
| Result | `Sent to #social via your Slack webhook.` | `Sent via your Slack webhook.` |
| Failure | `Could not send to #social via your Slack webhook: <error>` | `Could not send via your Slack webhook: <error>` |
| Second line, when the asked channel is not the webhook's | `(You asked for #help; the webhook posts to its own channel.)` | `(You asked for #help. A webhook posts to its own channel and ignores this.)` — always present |

"The same channel" ignores case, surrounding spaces and a leading `#`. The message body still
follows after a blank line and the step label still goes in front, so the first paragraph —
the part that is spoken — is the whole question, note included. The asked channel is still
sent in the request body and still recorded in the action log, as what was asked for.
`tests/sendMessage.test.ts` holds a guard that collects every confirm and result text and
fails if the asked channel appears anywhere but that note.

**In webhook mode, channel names still do not choose where a message goes.** "The bugs
channel" → `#bugs` is a fact the app can store and repeat but cannot act on: every message goes
wherever the single webhook points, the pre-flight question and the "Saved: …" line are about
the name only, and a literal channel that does not exist is still accepted. All of this is
unchanged by M22. **M22 made channel names real in a different way than first planned:** not
one webhook per channel, but a Slack **bot token** (§6f). In bot mode the name you give is the
channel posted to, checked against Slack's own channel list before any dialog.

#### Asking instead of refusing (added 2026-10-10)

A tool may declare `askForReference: { <arg>: { question, retry, accept } }`. When the
pre-flight's refusal is for an unresolved reference in such an argument, `runChain`
(`settleReferences` in `core/planner.ts`) asks the user through `shell.askUser` instead of
refusing. **Only `sendMessage.channel` declares it.** `openTarget`, an empty channel, a one-step
plan and a lone `sendMessage` are refused exactly as before, in the same words — in webhook
mode. In bot mode a lone send (or a one-step plan) with an unknown phrase now asks, as
described in §6f.

- **The question:** `Before I start: which channel do you mean by '<reference>'?`
- **What counts as an answer:** `checkChannel` against a memory that knows nothing — so a
  literal channel name only. An empty line is not one, and neither is anything starting with
  my/the, *even a reference memory could resolve*.
- **Budget:** at most **two questions per chain** (`MAX_QUESTIONS_PER_CHAIN`), and for any one
  reference a first asking and one retry. Two unknown channels get one question each; a retry
  spent on the first leaves none for the second; a third unknown channel is never asked about.
- **`null`** (Escape, the 60s timeout, or the bar was busy) ends it at once, with no retry.
- **Whenever asking does not produce an answer** the pre-flight's own refusal is shown,
  unchanged ("…teach me with: remember the bugs channel is <what it is>."): nothing run, and
  nothing saved for that reference.
- **A valid answer** is written with `memory.write(normalizeReference(reference), value,
  { source: "user:<date>" })` — the same subject and source `remember` would have used, so a
  stale fact is superseded rather than duplicated — then `Saved: <reference> = <value>` is
  shown and held for `SAVED_HOLD_MS` (1.5s; the plan preview uses the same status line and
  would otherwise replace it instantly), and the pre-flight runs again from the top.
- **The plan is not rewritten.** The step still says "the bugs channel"; `runStep` resolves it
  as it resolves anything. The model is not consulted again, and the answer comes only from
  `askUser` — never from the clipboard, an email or a step's result.
- **Bot mode (M22) adds three things, and webhook mode none of them** (§6f): before asking,
  `ReferenceQuestion.lookup` tries "the X channel" as `#X` in Slack, exactly, and uses it without
  saving it; `accept(answer, reference, deps)` became async and returns `accepted` / `rejected`
  (ask again, optionally with the tool's own wording) / `refused` (stop, save nothing), so an
  answer is checked against Slack **before** `memory.write` and saved as Slack's own `#name`;
  and once every reference is settled, each step's `Tool.preflight` runs on the plan as written.

Everything happens before the plan is previewed, before any dialog, and before `chain.begin()`:
while the question is open it is `isAskPending()` that holds the hotkeys, not the chain.

**The refusal is not shown to the next planning call (live fix, 2026-10-10).** The planner
feeds the last action-log row to the model as "the previous turn". After an unanswered
question that row was the pre-flight's refusal, and its words ("teach me with: remember the
bugs channel is…") made the real model answer the *next* instruction in prose with a question
of its own instead of writing the plan — 5 of 5 trials. The planner shows that prose as an
ordinary result: it looks like a question and nothing is waiting on it, so the instruction
hotkey (correctly) opens a fresh bar over it. That was reported live as "the hotkey dismissed
the question"; the hotkey guard was not involved. So `decide` now leaves out a last row that
`isUnknownReferenceRefusal` (`core/chain.ts`) recognises — refused, no tool, carrying the
pre-flight's unknown-reference clause — and passes no previous turn instead. The log row itself
is unchanged. Every other row is shown as before, **including a lone `sendMessage`'s own
"teach me with" refusal**, which has a tool name and is a different row.

**And the prompt says not to ask (2026-10-10).** `CHOOSE_SYSTEM` gained one narrow rule, placed
before the "If no tool fits… a clarifying question" sentence: a phrase starting "my" or "the"
that the model does not recognise goes into the tool call or plan exactly as said, and the
model never replies with a question about what it refers to — the app resolves it or asks. It
covers what a *name* means and nothing else; a request missing a detail still gets a question.
Measured with the refusal deliberately shown to the model
(`tests/eval/unknownReference.eval.test.ts`, `M21_REFERENCE_EVAL=1`, 5 trials per cell):

| Case | Before the rule | After |
|------|-----------------|-------|
| Chain, pre-flight refusal as previous turn → plan with channel "the bugs channel" | 0/5 | 5/5 |
| Lone send, the tool's own refusal as previous turn → `sendMessage`, same phrase | 0/5 | 5/5 |
| "file this bug in Linear and tell the social channel" → the M19 plan | 5/5 | 5/5 |
| "send these notes to the team" → `sendMessage`, channel "the team" | 5/5 | 5/5 |
| "move my meeting" → still a clarifying question | 5/5 | 5/5 |
| "schedule a meeting" → still a clarifying question | 5/5 | 5/5 |

**Seen on a real screen** with `scripts/ask-recon/` (run through `run.mjs`; **the scripts send
real keystrokes and flash a window** — read the header first):

- `dismissed-then-again` runs the real planner, registry, hotkey handler, shell and renderer in
  a real window against the real model: ask, dismiss with Escape, give the instruction again.
  Before either fix the second attempt came back as prose (`no_tool`); after both it is a real
  question (`isAskPending()` true and the question rendered). It executes no tool, uses a
  throwaway memory database, and holds the context fixed and empty — its first run picked up
  1,737 characters of clipboard, which changed the model's answer and made the bug vanish.
- `hotkey-during-question` (typed and dictated) presses the hotkey through the OS while a
  question is open: the question stays pending and rendered, the half-typed answer stays in
  the box, no capture opens. This is what cleared the hotkey guard.

The second row is the case the row filter above does **not** cover (a tool's own refusal is
still shown), so the two fixes overlap on the first row only. One run of five per cell shows the
direction, not a guarantee. **Not eliminated:** a prose reply is still displayed as a result,
so any other way the model comes to ask in prose will look like a question nothing waits on.

Consequences worth knowing: answers already given are **kept** when the plan is then refused
for a later reference (a three-channel plan saves two facts and refuses on the third); the save
writes no action-log row of its own; and neither the question nor the "Saved" line is spoken.

"Does this value name something we know?" is one function, `checkReference(value, memory)` in
`core/memory/checkReference.ts`: a literal is taken as given; a "my/the" reference must resolve
through `memory.resolve` (one lookup, never chased); empty, or a reference that does not
resolve, is not ok. It returns a fact (`empty` / `unresolved` + the words), never a sentence.
`isVagueReference` lives there too and is the single definition `resolveArgs` uses.

`sendMessage` then checks the result with `checkChannel(value, memory)`
(`core/tools/sendMessage.ts`), built on `checkReference`, which returns `{ ok, channel }` or
`{ ok: false, reason }`. Both
`confirmSummary` and the handler ask it, so an unknown or empty channel is refused **before**
the dialog is shown rather than after Send is pressed. A literal channel (`#bugs`) is still
taken as given — there is no list of real channels to check it against. The action log records
the resolved channel, as it always has.

### `risk` (added in M10 — replaced `irreversible`)

Until M10 a tool answered one question: *is this irreversible?* A boolean was enough, because
everything the app could do was either a local, undoable transform or the one Slack POST.
Acting inside another app's GUI breaks that. Most GUI actions have no undo at all — you cannot
un-open a reply box or un-type into a field — so "reversible?" stops being the useful question.
Four tiers (`core/risk.ts`, adapted from clacky's `permission.py`) replace it:

| Tier | Means | Planner does |
|------|-------|--------------|
| `safe` | read-only | run |
| `reversible` | mutates, but recoverable (a tab, a versioned fact), or a clipboard write the user asked for | run |
| `caution` | irreversible but routine and low-stakes | run, but **narrate first** |
| `dangerous` | irreversible **and** high-stakes | **confirm first**, no exceptions |

**The clipboard is not recoverable in itself (corrected in M29).** Until M29 this table listed
"clipboard" as a recoverable thing. It isn't: the app keeps no copy of what a clipboard write
replaces. A write is acceptable at `reversible` only because the user asked for it: "rewrite
this" puts the rewrite there on purpose. M28's live run found `rewrite` planned as a chain step
nobody asked for. Its preview line was the model's "Capture the selected text unchanged", and it
replaced the copied text for good. So inside a chain `rewrite` now writes nothing (§6, the
`rewrite` row). A tool that writes the clipboard without being asked to does not belong in this
tier.

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

### `confirmLabel` (added 2026-10-10, M21)

The confirm dialog's approve button said "Send" on every confirm — true while every `dangerous`
tool sent something, and wrong once one of them created an issue. A tool may now declare
`confirmLabel`, and `OSShell.confirm` takes it as `{ approveLabel }`.

| Tool | Button |
|------|--------|
| `sendMessage` | Send |
| `sendReply` | Send reply |
| `createEvent` (when it has guests) | Create event |
| `moveEvent` (when the event has guests) | Move event |
| `linear__create_issue`, `github__create_issue` | Create issue |
| anything else | Send (the default) |

**It is a plain string, not a function, on purpose.** `confirmSummary` is a function because
it describes one particular call and must read the arguments and the world. The label is the
opposite: the one part of the dialog that reads as a command. So it is fixed in the tool's
code and cannot see an argument, a model's words, an email or a server's description — and the
planner puts `tool.confirmLabel`, and nothing else, into `confirm`'s options. For a connector
tool it is pinned in the definition beside the pinned description (`ConnectorToolDef`), and
the adapter never consults the server's own description, title or annotations for it.

**What a label cannot change.** `WindowsShell.confirm` builds `buttons: [label, "Cancel"]`
with `defaultId: 1` and `cancelId: 1` as before: the approve button is first, and Cancel is
still the second button, the default (a stray Enter) and what Escape means. A blank label
falls back to "Send" (`shell/confirmLabel.ts`, the one function both shells use, so
`MockShell.confirmLabels` records exactly what Windows would show). The message keeps its
`Step N of M:` prefix; the prefix is never on the button.

### `confirmSummary` (added in M5, widened in M10)

An irreversible tool should also define `confirmSummary(args): string`. The planner calls it
with the **resolved** arguments (step 4 runs before step 6), so the confirm dialog always
describes the *concrete* action — "Send to #design-team?" as it then read; see "Where a message
really goes" for what `sendMessage` says now — and never the vague phrasing the
user typed ("send to the team"). Showing the unresolved version would be a trust bug: the
user must approve what will actually happen. Tools without it fall back to a generic
`Run <tool>?`. (`sendMessage`'s summary also REFUSES a channel step 4 could not resolve, so
that dialog is never shown — see `referenceArgs` above.)

M10 widened it to `(args, deps) => string | Promise<string>`. A GUI action's concrete facts —
who this reply would actually reach, what is sitting in the box right now — live in the app
being acted on, not in the arguments the model proposed, so a dialog that could not read them
would be describing a guess. It may do **SAFE work only**: it runs before the user has agreed
to anything. If it throws, the planner never opens the dialog and nothing runs — "we cannot say
what would happen" is itself a refusal.

### 4d. Voice output (M14) — a parallel contract, not a change to OSShell

Same shape as §4a's answer for the microphone, and for the same reason: `/core` has no business
knowing a speaker exists. `SpeechShell` (`src/main/shell/SpeechShell.ts`) is playback —
`play(wav)` and `stopPlayback()` — while `SpeechSynthesizer` (`core/types.ts`, beside
`Transcriber`) is text→audio. Two interfaces rather than one because the engine is swappable
(Piper now, ElevenLabs later) while "play these bytes, let me stop them" is the same job on any
OS with any engine. `SpeechSession` sits between them, holding the queue.

```
idle ──speak()──► synthesizing ──► playing ──► idle
                       │              │
                       └──stop()──────┴──► idle (queue cleared, nothing said)
```

**`speak()` returns immediately.** It queues; it does not wait for audio. A `caution` tool
narrates and then acts, and if speaking blocked, the app would say "opening the reply box" and
then sit there for two seconds before opening it. The announcement is meant to overlap the
action — that is what narrating *while* acting means.

**`stop()` is instant and total** — the queue is cleared, playback is cut off, and work already
in flight is invalidated by a generation counter (a boolean could not do it: two barge-ins in
quick succession have to invalidate two different utterances). Without that last part, audio
synthesized before the interruption would arrive *after* it and talk over the instruction the
user is already speaking.

**A clip is waited for as long as it lasts (M24).** The renderer plays the audio and reports
`speech:ended`; `WindowsShell.play()` waits for that report for the clip's own length — read from
its WAV header (`src/main/shell/playbackLimit.ts`), else estimated from its size at Piper's
22,050 Hz 16-bit mono, else a 120 s ceiling — plus a 5 s grace (`PLAYBACK_GRACE_MS`). Until M24
it waited under `RENDERER_REPLY_TIMEOUT_MS`, a 15 s bound meant for a quick renderer *reply*:
anything longer was treated as finished at 15 s, `isSpeaking()` went false mid-sentence, a held
chime played over it, and the next utterance's `speech:play` stopped it. Each clip is numbered,
and the renderer names the number in its report (`speechEnded(id, error)`), so a report that
arrives late for a clip main gave up on cannot end the wait for the next one. A crashed renderer
or a closed window ends the wait at once. `SpeechPlayer.stop()` settles the clip's `play()`, so
a barge-in is reported as an ordinary end and the wait is over the moment the sound is.

**An utterance overtaken by events is dropped, not said** (M14; refined in M24). Speech
describes a moment, so an utterance that has waited more than 8 s (`DEFAULT_STALE_AFTER_MS`) is
dropped when its turn comes, and at most 8 wait at once (the oldest go first). **Time spent behind
a clip that is still playing does not count as waiting** — the user was listening, the world did
not move on. Time with nothing playing — a synthesis backlog, the gap after a clip — does. (Before
M24 every clip was cut at 15 s, so waiting behind one was short; once a clip plays to its end, a
"Sent." queued during a 30 s read-out would otherwise be dropped for no reason but the length of
what came before it.)

**The microphone is never open while the app is talking.** Enforced in the shell's
`startRecording()`, the one chokepoint every path to the microphone passes through, rather than
at each hotkey — the same lesson M8 learned when cleanup bound to a single code path leaked on
every other one. This is not a UX preference: the instruction hotkey opens the bar *and* the
microphone in the same moment (§4a), so an app still speaking would be transcribed by whisper
into the user's own instruction.

**Nothing is lost when speech is cut off**, which is what makes barge-in safe rather than
destructive: the full text is already on screen. That is the two-representations decision
(§6's `speakResult`) paying for itself — speech is the disposable channel, the screen is the
durable one.

**A synthesis failure is reported and survived**, not swallowed: one bad utterance must not
wedge a queue whose next item might be a confirm question. It is reported *once* per broken
spell rather than per utterance — a misconfigured engine fails on every one, and burying the
screen in the same message is as useless as saying nothing. Saying nothing is worse, though: a
speaker that has quietly stopped working is indistinguishable from one that had nothing to say,
which is this project's least favourite failure mode (§4a's dead hotkey).

**What the engine wrapper proves, and what it cannot** (`core/synthesizers/PiperSynthesizer.ts`).
M13's split, applied deliberately this time rather than rediscovered. Request *shaping* — the
flag spelling piper accepts, what it does with the text, whether the audio is intelligible —
needs a real binary. Everything that decides **what the user is told when it goes wrong** is
ordinary branching and is tested (`tests/piper.test.ts`) against a stand-in that reproduces each
failure on demand: a missing binary names `PIPER_EXE_PATH`, a non-zero exit surfaces the engine's
own last line, a hang times out, and *three separate shapes* of "exited 0 and produced nothing
usable" are caught rather than played as silence — M11's rule that a success report is not proof
anything happened, in a new place.

No failure reason is derived from **parsing stderr**, and that omission is the point: nobody has
run this engine yet, and a classifier written from imagined output is exactly M10's
hand-authored selector that had never matched anything. `scripts/tts-recon.mjs`'s Q7 captures the
real wording for the two most likely setup failures; teaching the classifier to tell "wrong voice
file" from "wrong flag" is worth doing *after* that, with evidence behind it.

**Where playback lives.** In the renderer, beside the microphone (`src/renderer/audio/player.ts`),
not in the main process — that is where the Web Audio APIs are, and it puts both halves of "voice"
in one process, which makes "never listen while speaking" a local guarantee rather than a
cross-process race. An `<audio>` element rather than `decodeAudioData`: its `ended` event is
exactly the signal `play()` has to resolve on, with no decode step that can fail separately.

Two Electron settings are load-bearing and easy to lose. `autoplay-policy=no-user-gesture-required`
— every utterance is triggered by a hotkey or by the planner finishing, never by a click inside the
window, so without it the first thing the app tries to say fails silently. And
`backgroundThrottling: false` — the bar is hidden most of the time, and Chromium throttles media
in hidden windows.

`play()` resolves on whatever the renderer reports, and resolves even when it reports **nothing**
(a crashed or destroyed renderer, caught by the same timeout the voice path uses). The queue
drains by awaiting it, so a `play()` left pending would strand every utterance behind it forever.

**The pending-confirm guard (§8).** While a `dangerous` action is on screen awaiting a yes or
no, **both** hotkeys are blocked and the block is announced — narrated and spoken — rather than
silently ignored, because a hotkey that does nothing is indistinguishable from a broken app.

`WindowsShell.confirmPending` is set **synchronously before** `showMessageBox` is called, so
there is no instant in which the dialog is visible and the guard does not know it, and cleared in
the `finally`, so a dialog that throws cannot leave the app permanently deaf. The dictation
hotkey is blocked by the same condition (`combineInstructionBusy`): it would otherwise take the
shared microphone and type into whatever has focus, which with a modal dialog up is the dialog.

Without it, the press starts a **second concurrent planner run** while the first is still parked
at the gate — and does real damage on the way: `showInput()` calls `window.focus()`, taking
focus off the dialog, and `window.show()` re-registers the global Escape that `confirm()`
deliberately released so the dialog's own cancel would work.

This was found in live testing, having been designed and approved and then never built: it was
added to the plan after the build order was written and never folded into it. The handler now
lives in `src/main/instructionHotkey.ts` rather than inside `main.ts`, which is the part worth
keeping — importing `main.ts` boots electron, so a guard living there has no test that *could*
have failed. Answering a confirm **by voice** remains deliberately out of scope: that would put
speech recognition on the one gate that must never be bypassed, and gets its own milestone with a
fail-closed design or it does not happen.

**Three things the live pass found, and what each one actually was.**

*The runtime the tests run under is not the runtime the app runs under.* "Mon" and "Aug" were
being read aloud as words. The date expansion required the whole weekday-day-month shape with
single spaces — and **node's ICU writes `Wed 26 Aug` where electron's writes `Wed, 26 Aug`**,
so the rule silently stopped matching in the app while every test passed. Fixed on both sides:
`formatDay` normalises the comma away so the string has one shape everywhere, and the expansion
is now two independently-anchored rules (a weekday expands when a day-number follows, a month
when one precedes) so a separator change cannot take the whole thing down again. The tests for it
use **literal strings covering both ICU forms** — a test that asks the runtime to produce its own
input can only ever prove the transform works on that runtime.

*Speech describes a moment, and a queue can outlive it.* The app was heard referring to a confirm
dialog that had been cancelled five seconds earlier. Cold start was **~3–5s per utterance** (the
engine reloaded its model on every invocation, as its own docs warn), so utterances piled up and
arrived after the world had moved on. Two fixes, both about correctness rather than speed: an
utterance queued more than 8s ago is **dropped rather than said**, and answering a confirm
**silences anything still queued about it**. Both stay in place even now that the latency itself
is fixed (below) — a faster engine only shrinks this window, a queue can still outlive a moment.

### The cold-start fix (post-M14)

Reloading the model per utterance was a **named, deferred gap** at the end of M14, on the
argument that fixing it required knowing which of two things the installed engine actually
supported — a question deliberately left to recon rather than memory. It confirmed one candidate
and ruled out the other: `piper1-gpl`'s HTTP server mode exists but needs Flask (not installed)
and binds `0.0.0.0` by default, the wrong trade for a "nothing leaves the machine" app, so it was
never wired up. The working answer is `--output-dir`, not `-f/--output_file` — a from-memory
design would have reached for the flag it already knew (`-f` writes ALL stdin into one WAV);
`--output-dir` is what actually keeps the model loaded across calls, writing one timestamped WAV
per stdin line and announcing each with `INFO:__main__:Wrote <path>` on stderr once it closes.

**Measured through the shipped class, not just the recon scripts**: ~3–5s per utterance before,
~2.9s to load the model on the first call after, then **108–160ms per call after that** — roughly
20–30x. `PiperSynthesizer` now holds one warm process (`ensureWarmProcess`), serializes calls
through a promise chain so only one utterance is ever in flight on it, and parses `Wrote <path>`
per-utterance rather than globally so a failure reports THIS call's last stderr line and not one
left over from whichever call preceded it.

A warm process fails in ways the old per-spawn path never had to consider, both found by running
it rather than assumed: a blank line reaching stdin produces no output and no error, ever — a
permanent hang rather than the old path's clean exit 1, which is why the empty-text guard in
`synthesize()` is now load-bearing rather than a second lock on an already-locked door. And a
line with nothing phonemizable (recon's `"..."`) crashes the process outright
(`wave.Error: # channels not specified`) — not a new bug, the old per-spawn path exits 1 on the
same input, but warm mode makes it fatal to the *session* instead of to one call. The fix is
**restart, never retry**: the call that crashed the process rejects with the engine's own last
line, and the *next* call gets a fresh process — retrying the same text would just crash the
replacement too. `dispose()` releases the warm process (and its temp dir) on `will-quit`, the
same pattern `WindowsInputInjector` already established for M12's persistent PowerShell host.

`legacyFlags` — previously only a flag-spelling switch between the maintained and archived
builds — now also selects **which strategy runs**: the maintained build gets the warm path, and
`legacyFlags: true` keeps the original spawn-per-utterance path entirely, unchanged. Not a
hedge — the archived rhasspy v1.2.0 build isn't installed anywhere this project can test, so
whether it even supports `--output-dir` is unconfirmed, and replacing a working path with an
unverified assumption would repeat the mistake recon exists to avoid.

*Stopping speech should not cost you a bar to dismiss.* The only interrupt was the instruction
hotkey, which also opens the bar and the microphone, so "just be quiet" left something to clean
up. **Escape now stops speech** as well as dismissing the bar — the gesture that already means
"never mind" everywhere else in this app — and the hotkey's behaviour is unchanged.

### Speech is an action, not a method (added in M14)

`LocalAction` gained a fourth kind, `{ kind: "speak" }`, beside `notify`. It is an **action the
core requests** rather than a method on `OSShell`, for the same reason narration is: whether this
install can actually speak is the shell's business. A shell with no synthesizer accepts it and
does nothing — the same shape `notify` had for every milestone before M10 had anything to
narrate — so `/core` never learns whether there is a speaker, exactly as it never learns whether
there is a microphone (§4a).

The consequence worth having: the whole speech *policy* lives in `planner.ts` and
`core/speech.ts`, and is provable under `MockShell` with no audio device and no electron. The
planner speaks at three points, and the order is deliberate at two of them:

| when | order |
|---|---|
| `caution` narration | `notify` first, then say it |
| `dangerous` confirm | **say it before the dialog opens** — once `showMessageBox` is up it owns the user's attention, and a question asked after the thing it is about has appeared is not a question |
| any result, refusal, or failure | show it first (the screen is instant), then say it |

A tool's `speakResult` is worked out **before** the result is shown, so a tool that cannot say
what it did fails the run rather than leaving the screen and the voice disagreeing — the same
rule `narrate` and `confirmSummary` already follow. Empty spoken text emits no action at all:
the real engine exits non-zero on empty input, so "there was nothing to say" must not become an
error in the log.

### `speakResult` (added in M14)

The fourth optional hook, and the same shape and reasoning as `narrate` and `confirmSummary`:
the planner asks the tool how to describe itself and never learns which tool it asked.

```ts
speakResult?: (result: string, args: ToolInput, deps: ToolDeps) => SpokenText | Promise<SpokenText>;
```

Optional, because the default is good — `core/speech.ts` derives a spoken line from the
displayed result generically, and most tools return one short sentence that needs nothing more.
A tool defines this only when the generic derivation would say something a person would not.

**`readSchedule` is the case that justified the hook.** Its result is a formatted list, and the
generic head-of-list reads attendees' addresses out loud, character by character — "with alex at
example dot com and sam at example dot com". Nothing outside the tool knows those are addresses
rather than words, so the fix cannot live in the generic path. Spoken, they become a count:
*"You have 5 things coming up. First up, Wed 26 Aug, 3:00–4:00 PM, One, with 2 guests. Want me
to read the rest?"* The screen still names every guest in full; this is a derived version, not a
rewrite of what is shown.

It takes the result the handler already produced rather than re-deriving from the world: the
spoken and the displayed version must describe the same answer, and a second read of a calendar
could legitimately return something different.

**`elaborate` (M14, `safe`)** is the other half of the same decision. Speech is terse, so a
remainder is held (`core/speechStore.ts` — one slot, 5-minute TTL, in memory, never SQLite for
the same reason `DraftStore` isn't), and this tool reads it out. It empties the slot: "read them
out" twice must mean "there's nothing more" the second time, not a repeat. With nothing held it
raises `UserFixableError`, so the user gets *"There's nothing more to read out."* verbatim
rather than "Something went wrong". Its own `speakResult` returns the held text **verbatim** —
letting the generic derivation shorten an already-shortened remainder would let "read me the
rest" answer with another "want me to read the rest?".

**An answer that holds nothing back no longer empties the slot (M25).** Until M25 every spoken
answer without a remainder CLEARED it, so "read them out" could never answer with a list from two
instructions ago — and a live run showed the price: a one-second "what's the time" in the middle
of a long summary threw away the rest the user was hearing. Now such an answer only marks the
slot (`SpeechStore.passOver()`), and when the marked remainder is read out it starts with a
fixed lead-in, *"From the earlier answer:"* — so the old worry (old content with nothing saying
so) is answered by saying so, not by forgetting. A new remainder still replaces the old one, it
is still delivered once, and the 5-minute TTL is unchanged. A detached job's answers neither
fill, mark nor empty the slot: nobody heard them.

Gated in `buildRegistry` on `speech: true`, a third kind of gate beside Gmail's browser and the
calendar's account: whether this install can speak at all. With no synthesizer nothing ever
fills the store, so the tool could only ever refuse, and an unofferable capability does not
belong on the menu the model chooses from (§8's rule about keeping the miss log honest).

---

### 4e. The screen and window-reading surfaces (M15, regrounded on UI Automation in M16)

Voice input (§4a) and voice output (§4d) both got a *parallel shell contract* next door to
`OSShell`, on the grounds that `/core` has no business knowing a microphone or a speaker exists.
Pointing does not follow that pattern, and the reason is worth stating because it looks like an
inconsistency and is not.

Speech reaches `/core` as a fire-and-forget `LocalAction`: the planner says "say this" and never
hears back. Reading a window's controls is a **request/response** — the `pointAt` handler needs
the candidate list *back* — so the shape that fits is the one Gmail, Notion and Calendar already
use: interfaces declared in `core/types.ts`, injected through `ToolDeps`, each with an
`Unavailable*` default so a tool can never reach a capability this install was not configured
for.

```ts
// core/types.ts, beside GmailSurface / NotionSurface / CalendarSurface
export interface ScreenSurface {
  point(target: PointerTarget): Promise<void>;         // draws only; never clicks
  clearPointer(): void;                                // idempotent
  displayForNative(rect: NativeRect): Promise<DisplayBounds>;
}

export interface ElementSurface {
  probe(): Promise<WindowProbe>;                        // cheap: count + window class
  enumerate(): Promise<WindowElements>;                 // the real read: names, types, rects
  verifyTarget(): Promise<TargetCheck>;                 // still the right window, unmoved?
}

export interface ElementChooser {
  choose(
    candidates: readonly Candidate[],
    target: string,
    windowTitle: string,
  ): Promise<ChoiceResult>;
}
```

**`ScreenSurface` no longer captures anything.** Through M15 it also owned `capture(): Promise<
Screenshot>` — `desktopCapturer`, a downscale, a per-provider frame-size policy — all of it
deleted at M16.10 along with the vision model that was its only caller. What is left is the
overlay and a display lookup, because the native→DIP conversion below needs to know which
physical display a rect landed on and the caller only has native pixels to give it.

**Three interfaces rather than one**, for the same reason `SpeechShell` and `SpeechSynthesizer`
are two: `ScreenSurface`, `ElementSurface` and `ElementChooser` fail for different reasons and
have different fixes — a window can be unreadable while the model is perfectly reachable, and the
model can be unreachable while the window is fine — so one class per capability means the message
the user gets names the thing that is actually wrong. `ElementChooser` rides the planner's own
`LLMClient.complete()` rather than a new transport: the request is text (a numbered list) and the
reply is a few tokens, so there is no per-provider adapter to write, unlike M15's `VisionApi`.

**Native pixels and DIP are the two live spaces, and the mapping is derived, never stored.** UI
Automation answers in physical screen pixels; the overlay places windows in DIP. On this machine
that is 1280x720 DIP at `scaleFactor` 1.5 over a 1920x1080 panel. `core/screen/geometry.ts`
derives the ratio the same way M15's image-px mapping did:

```
display.width (DIP) / display.nativeWidth (native px)
```

`DisplayBounds` still carries no `scaleFactor` field, for the identical reason M15 left it out:
it invites `x * scaleFactor`, which agrees with the correct formula on a single display and
silently diverges the moment a second monitor has a different scale factor. What M16 added is
the **origin**: native rects can come from anywhere on the desktop, not just (0,0), so
`nativeX`/`nativeY` are read from the OS via `screen.dipToScreenPoint` — never computed — and
`toScreenRect` translates the physical origin *before* scaling and adds the DIP origin *after*.
`ScreenRect` is additionally phantom-branded, so `toScreenRect` is the only function that can
produce one: M15 relied on a separate type name alone to keep a native/image rect from reaching
the overlay, and that was documentation, not enforcement, under TypeScript's structural typing.
The rounding rule is unchanged from M15: edges are rounded and the extent derived from them,
never position and size rounded independently.

**The pointing overlay.** A transparent, frameless, `focusable: false` window covering one
display, shown with `showInactive()` and `setAlwaysOnTop(true, "screen-saver")`. Three of its
options are load-bearing rather than cosmetic:

- **`setIgnoreMouseEvents(true, { forward: true })`** — the premise of the whole milestone. The
  user clicks the thing we point at, so the marker must not be able to receive that click.
  Without it the overlay eats the click and the app looks broken in the most confusing way
  available.
- **`setContentProtection(true)`** — so one marker is never in the screenshot taken for the next
  question, by the same mechanism that keeps the command bar out of the first. (This protection
  predates and is independent of M15's vision capture, which is why it survived that capture
  code being deleted: it also keeps the marker out of screenshots any OTHER application takes.)
- **`focusable: false`** — pointing at a control in another app must not take focus from it; a
  text field the user was typing in has to keep receiving their keystrokes.

It carries **no preload and no IPC** for the rect itself — `ScreenRect`'s compile-time brand never
crosses a process boundary where it could be stripped, because there is no channel for a
position; every consumer of it is a main-process Electron call.

**The rect and label reach the renderer as URL QUERY STRING parameters, not the hash — and this
was a real, live bug, not a stylistic choice.** Through M16.10 they rode in the hash, on the
documented claim that "each `point()` is a fresh navigation, so a stale marker cannot survive a
reload." That claim was false and went unverified until a human caught it live at M16.11: a
hash-only URL change is a *same-document* navigation in Chromium, so `overlay.html`'s script —
which reads its position once, at load — never re-ran, and the marker kept showing the
**previous** question's answer. Every new question wrong; only repeating a question verbatim
(which happens to produce an identical, "already-loaded" URL that Chromium reloads anyway)
showed the right one. Fixed by moving the parameters into the query string, which forces a real
navigation on every call, plus a monotonic nonce, so an *exact* repeat is also a distinct URL
rather than depending on that same-URL-reload behaviour. If this ever moves back into the hash,
the script must listen for `hashchange` or the bug returns.

The 3px border is drawn *outside* the reported rect (content-box, deliberately) so the highlight
frames the control rather than covering its own edge pixels — on a 20px toolbar icon an inset
border would eat a third of the thing it is pointing at. Verified at M15 by drawing at a known
rect and photographing the result: the drawn box landed within 2px of the request, with a
see-through interior.

It **dismisses itself after 10s**, and is cleared by Escape and by either hotkey. That is the
same reasoning that makes `SpeechSession` drop utterances older than 8s rather than say them
late: a marker answers a question asked at a moment, and one still pointing at a button that has
since scrolled away is worse than none. There is deliberately **no "press Esc to dismiss" hint**
on it — the bar owns the global Escape only while the bar itself is visible, and the expected
next move (clicking the thing) blurs and hides the bar, releasing the key. A hint that stops
working the moment the user does what the marker is for is worse than no hint.

**Decided (2026-08-27): the 10s dismiss timer stays as-is.** It does not shorten if the user
switches away from the target window before it elapses, so a correct-when-drawn marker can sit
over the wrong (now-foreground) app for up to that long. Raised during M16.11 along with a
recommendation to shorten it to ~5s; on reflection, kept at 10s and no focus-loss detection was
built. Focus-loss detection would need to poll `GetForegroundWindow` through the UIA host, adding
a background loop to a milestone that has already produced four live bugs, and would risk
dismissing a marker mid-use when a notification steals focus transiently — a worse failure than
the one it would fix. This is a closed decision, not a deferred one.

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

## 6d. The pointing flow (M16, regrounded from M15's vision)

One tool, `pointAt`, in the same registry as everything else. The LLM proposes it with a
`target`; the planner disposes — registry check, validation, risk gate, execute, record.

```
"where's the send button?"
  -> planner picks pointAt { target: "the send button" }
  -> narrate: "Checking the controls on screen for the send button…"   (caution tier, said first)
  -> readSettledWindow()     probe -> wait -> enumerate, until the control list stops moving
                             (native: 0 delay. Chromium: one 350ms settle, on class alone)
  -> buildCandidates()       filter + dedup + number, PURE — no model has run yet
  -> chooser.choose()        one bounded question: WHICH numbered entry?
                             the model never emits a coordinate
  -> resolveChoice()         the deterministic gate — refuses, or hands back a candidate
  -> verifyTarget()          still the same window? still at the same rect? (else: stale)
  -> toScreenRect()          native px -> screen DIP, via a display looked up from the OS
  -> screen.point()          the marker; the user clicks it themselves
  -> "Pointing at \"Send\" — top right of Gmail - Compose."
```

**Why this replaced M15's vision pipeline.** M15 sent a screenshot to a vision model and asked
it to answer WHERE the target was — a bounding box. Live testing found it returning the wrong
control on ordinary Windows chrome, confidently: one tab over on a tab strip, ~208px onto a
neighbouring toolbar icon. Not imprecision — the model proposing an action's coordinates was the
one place in this codebase where "the LLM proposes, the planner disposes" was broken, because
vision was proposing WHICH control *and* disposing WHERE it is. M16 inverts it: UI Automation
enumerates the window's real controls with exact rects (deterministic), and the model's entire
output is one integer picking an entry off a list this process built. An integer cannot be off
by 208 pixels. It can be the *wrong* integer — a semantic error, which is the error class models
are actually good at, and the class the deterministic gate below is built to catch.

**A consequence worth stating plainly: no screenshot is taken.** What reaches the model is
control *names*, as text — "File", "Edit", "Advice.txt", "New" — plus the user's own words. M15's
whole privacy posture existed because a picture of the screen left the machine; that capability
is gone from the tree, not merely unused.

**Why a tool and not a mode.** Unchanged from M15: a separate hotkey was the alternative and was
rejected for the same reason M8 collapsed typing-vs-speaking into one path — it would make the
user decide, before opening the bar, which kind of request they were about to make, and it would
create a second route where a model decides something outside the registry.

**The settle step exists because the window's own control list can be caught mid-load.** Recon
measured a real Electron window (VS Code) reporting 13 elements on the first UIA touch and 613 a
second later — Chromium activates its accessibility tree lazily. Answering during that window
would match the user's words against 2% of the real candidates and return something confident
and wrong: M15's exact failure class, relocated from coordinate space into enumeration timing.
`core/screen/settle.ts` is a pure decision over a probe sequence (no clock, no PowerShell) that
distinguishes three states a raw element count cannot: `lazy-shell` (Chromium by class, content
unknown), `chrome-only` (settled, and there is genuinely nothing but the window frame), and
`sparse` (few candidates, but real — a Save/Discard dialog, which must be answered from and never
retried into the ground).

**The deterministic gate** (`core/screen/resolve.ts`) is this milestone's counterpart to M15's
`locate.ts`, and the contrast says what the redesign bought: `locate.ts` had to *manufacture*
checkability out of properties a wrong box tends to violate — none of which prove an answer
right. Here the answer is an index into a list this process wrote, so every check is exact:

| The answer | What it means | What happens |
|---|---|---|
| `none` | the model looked and it is not there | refuse, naming how many controls WERE looked at — a checkable claim, unlike vision's |
| `ambiguous` (model-volunteered) | several things match | refuse, and name them |
| a number outside the list | the model lost track of a long list | refuse (`untrustworthy`) — **never clamped** to the nearest valid index |
| two candidates identical in every field the model saw (name, type, position) | a coin flip the model had no basis for | refuse (`ambiguous`), naming both — by column/landmark where one exists, ordinal otherwise |
| the chosen control is disabled | it exists but cannot be clicked | refuse (`disabled`) — a different fact from "not found," and said as one |
| the window is no longer the one just enumerated, or has moved | the user switched away, or the window was dragged, while the app was working | refuse (`stale`) — checked immediately before drawing, the latest possible moment |

**A refusal is `refused`, not a miss.** Unchanged from M15: §8's miss list is a ranked backlog
of tools worth building, and "that control isn't there" is not a missing tool. Every one of the
above is thrown as a `UserFixableError` (`ElementNotFoundError`), so the planner shows the
tool's own wording verbatim and logs `refused`.

**Why `caution`.** Unchanged in shape, changed in what it is protecting: not `safe`, because it
reads the contents of whatever window the user was last looking at, and it draws. Not
`reversible`: the overlay itself qualifies (`clearPointer()` un-draws it completely), but the
control names have already gone to a model by the time that runs, and the tier has to describe
the worse half. Not `dangerous`: nothing reaches another person, nothing is written anywhere, and
a confirm dialog in front of every "where's the send button?" would make the capability unusable
for the one thing it is for. So it narrates — and the narration says the true, smaller thing now:
"Checking the controls on screen for X…", never "looking at your screen", because nothing is
photographed.

**`resolvesReferences: false`.** Unchanged from M15. `target` is a literal description of
something visible, not a reference to look up; letting memory near it would rewrite "my inbox"
into a URL and then hunt the screen for one.

**The result sentence stands on its own.** Unchanged in principle: "Pointing at "Send" — top
right of Gmail - Compose" is derived from the same candidate the marker is drawn at, so the words
and the highlight can never describe different places — the marker is the disposable channel and
the text is the durable one (§4d), so the answer survives being spoken, missed, or timed out; and
naming what the app *thinks* it found makes a marker sitting on "Discard" while the label says
"Send" visible as a disagreement rather than trusted as an answer. Now it also names the
*window*, not just a screen quadrant — because a candidate list is scoped to one window, "top
right" of which window is part of the claim being made.

**What is deliberately not here:** clicking, typing, dragging, scrolling to find something
off-screen, or pointing at more than one thing. No fallback to vision for a window with no usable
control tree — that case is refused honestly (`unreadable`/`unsettled`), because a fallback's
engagement condition (canvas apps, unlabelled UI) is exactly the condition vision was measured
worst at. No retry-with-a-different-model on a refusal, for the same reason M15 rejected it: a
second guess after a rejected first one is a worse guess dressed up as diligence.

---

## 6e. Connectors over MCP (M19)

An app reached over the Model Context Protocol rather than through a hand-built surface. Linear
is the first. Everything is in `src/core/mcp/`:

| File | What it decides |
|---|---|
| `types.ts` | `McpConnection` (list tools, call tool), `ConnectorDef`, `ConnectorToolDef` |
| `connectors/linear.ts` | Linear's definition: every name, description, schema, tier and formatter |
| `connectors/github.ts` | GitHub's (M20): the same, plus its own failure wording |
| `transport.ts` | how a connector's link is built: Streamable HTTP, the key as a Bearer token, https only (M20 — out of `main.ts`, where it had no test) |
| `config.ts` | what `connectors.json` means, and which tools survive it |
| `load.ts` | the join: config + `.env` → built `Tool[]`; `CONNECTORS` is the closed list |
| `adapter.ts` | a pinned tool → an ordinary registry `Tool` |
| `tiers.ts` | what a connector tool costs |
| `flatten.ts` | an MCP result → one string |
| `failure.ts` | what a failed call means |
| `SdkConnection.ts` | the real connection (official SDK), and the unavailable default |

### What recon found, and what it forced

`scripts/linear-recon.mjs` (strictly read-only) asked the live server before any of this was
written. Linear's docs list no tools, and the third-party directories that do were **wrong**:

- **There is no `create_issue`.** The server has `save_issue`, which creates when `id` is absent
  and **updates any issue** when it is present — and takes `patch`, `removeLabels`, `state`,
  `assignee` and some thirty other fields. An allowlist written from those directories would
  have exposed "edit any issue" under the name "create".
- **A result is one text block holding a JSON string.** No `structuredContent`, no
  `resource_link`, no `outputSchema` on any of the 59 tools. An issue's link is the `url` field
  inside that string.
- **Every failure is a normal result with `isError: true`.** Nothing is thrown. Two formats from
  one server: a bare sentence (`Error: Could not find team "X"`) and JSON carrying a `message`.
- **A rejected key is a thrown `StreamableHTTPError`, code 401**, at connect.
- **Schemas are draft 2020-12 with `additionalProperties: false`.**
- **Search is fuzzy** (found by the live check, not recon): a nonsense query still returned an
  issue. An empty result is rare and a non-empty one is not proof of a match.

### The name is not the capability

So our tool name is not the remote name. `linear__create_issue` maps to remote `save_issue`
with a pinned schema of exactly two model-supplied arguments, `title` and `description`, and
`additionalProperties: false`. `id` is not in the schema, so it cannot be sent, so update is
unreachable. **The capability exposed is defined by the pinned schema, not by the reach of the
remote tool** — and the adapter refuses at startup to build a tool whose schema does not close.

### Closed-world loading

- A connector exists because there is a definition for it in `core/mcp/connectors/` and it is
  listed in `CONNECTORS`. A tool exists because that definition pins it.
- `connectors.json` (repo root, committed, no secrets) chooses among those:
  ```json
  { "connectors": { "linear": { "enabled": true,
      "tools": ["create_issue", "search_issues", "get_issue"],
      "settings": { "defaultTeam": "…" } } } }
  ```
  **Everything defaults to off.** A connector is on only when `enabled` is literally `true`; a
  tool is exposed only when listed by name; an enabled connector with no `tools` list exposes
  nothing. A name the definition does not pin — including a real remote tool like `save_issue`
  or `delete_comment` — is logged and ignored. A malformed allowlist drops the whole connector
  rather than being half-read.
- A tool whose required setting is missing (`create_issue` needs `defaultTeam`) is left off the
  menu rather than offered and then refused.
- **The menu is decided offline**, from that file and whether `LINEAR_API_KEY` is set — the rule
  `main.ts` has kept since M13. The connection opens lazily, on the first call.
- `/core` never reads `process.env` or the file: `main.ts` reads both and supplies the
  transport, and `loadConnectorTools` is where the join is tested.

### What the adapter does, every call

Before the call, in order — and the **gates run the same three steps**, so a confirm dialog is
never shown for a call that could not have been made, and what it shows is what will be sent:

1. **Validate** the model's arguments against **our** pinned schema (Ajv). An unlisted argument
   is refused here and nothing is sent.
2. **Merge** the arguments code fixes — `team` for a create, `limit: 5` and `fields` for a
   search. **A key is the model's or code's, never both (M20):** a definition where a fixed key
   is also in the pinned schema is refused at startup, so the merge has nothing to decide.
   (Through M19 this read "Fixed wins", and no test using a real definition could tell which
   side won.)
3. **Check drift** against the **server's** schema: the remote tool must still exist, still
   accept exactly what is about to be sent, and (M20) **name every key of it** in its
   `properties`. This is the only use the server's schema is put to. A mismatch is a named
   refusal that never echoes an argument's value.

After it: an `isError` result is a **failure** (`tool-failed`) — in the server's own words,
bounded to 300 characters, **unless the connector defines its own failure wording (M20)**, in
which case the server's text is never shown at all; an empty result, or one the tool's formatter cannot read, is a
failure too (`bad-result`) — M11's rule that reporting success proves nothing. A failed call is
**never retried**: a dropped connection is reopened by the *next* call, because the one that
failed may have been a create that landed.

Connector tools set `resolvesReferences: false`. Memory resolution rewrites any top-level string
beginning "the" or "my", and this install's fact for "the team" is a Slack channel.

### Tiers (`core/mcp/tiers.ts`)

Built to fail toward caution at every step, because a connector tool is one line in a
definition and it is easy to add one without thinking about it:

1. A tool is `safe` **only by being declared so**, in code, in its connector's definition.
2. A tool with no declared tier is `caution`.
3. A name that reads as a delete, a removal or a send (whole words: `delete`, `remove`,
   `destroy`, `purge`, `erase`, `send`) is `dangerous` whatever was declared — checked on
   **both** names, ours and the server's.
4. **The server's hints may only raise a tier.** `destructiveHint: true` → `dangerous`;
   `readOnlyHint: false` → at least `caution`. Nothing a server says lowers anything, and an
   *absent* hint is not a hint.

Rules 1–3 are known without a connection. Rule 4 needs the server's tool list, so any tool
below `dangerous` carries a `RiskPolicy` (§6, M13) that reads it; if that read fails,
`resolveRisk` escalates to the worst declared tier and the confirm summary then fails on the
same connection — fail-closed twice. `linear__create_issue` is `dangerous` as a constant.

### Failures (`ConnectorError`, a `UserFixableError`)

| Reason | Means | Says |
|---|---|---|
| `not-configured` | no connection was built | I'm not connected to Linear. |
| `denied` | the key was rejected (401/403) | names `LINEAR_API_KEY`; repeats nothing the server said |
| `unreachable` | network, DNS, closed link — *during a tool call* | I couldn't reach Linear: … |
| `connect-failed` (M21) | anything that went wrong **while connecting** — opening the link or reading the tool list — other than a rejected key | Linear didn't answer while I was connecting, so nothing was sent. It is safe to try again. (With a cause other than a timeout: "I couldn't reach Linear while I was connecting (…), so nothing was sent. It is safe to try again.") |
| `timeout` | a **tool call** that was sent got no answer in 20 s | says the change **may or may not** have gone through |
| `invalid-arguments` | failed our schema | nothing was sent |
| `drift` | the server changed under the pin | nothing was sent; the connector needs updating |
| `tool-failed` | the server said no | Linear said no: *its words* |
| `bad-result` | "success" we cannot read | check Linear before trying again |

No message can contain the key: only the *name* of its variable is ever passed in.

#### The phase of a failure, and two budgets (added 2026-10-10, live fix)

**Found live.** The session's first GitHub use timed out and the chain said the create "may or
may not have gone through" (action-log row 413). It had never been sent: a `dangerous` connector
tool's connection is opened by its **confirm summary** (`prepare` → `listTools`), before the
dialog. Nothing was created — the retry got the next issue number.

**The same error means two things**, and only the caller knows which. A connect timeout and a
call timeout are the identical `McpError(-32001)`. So `classifyMcpFailure` takes a required
`phase` argument, passed from the `catch` that caught the error (`SdkConnection.ts`), never
inferred from the error's type or text:

| Phase | Where it is caught | A timeout or failure there means |
|-------|--------------------|----------------------------------|
| `connecting` | `open()` (the `initialize` exchange) and `listTools()` | `connect-failed` — nothing was sent, safe to try again |
| `calling` | `callTool()` only | `timeout` / `unreachable` / `tool-failed`, as before — the call **was** sent |

A rejected key is `denied` in either phase (trying again would not help). `callTool` awaits the
connection *outside* its `try`, so a link that cannot be opened reaches the caller as the
connecting failure it is. The chain accounting is unchanged and still follows the reason.
**A failed call is still never retried, in either phase**; the next call opens a new connection.

**Two budgets** (`SdkConnectionOptions.connectTimeoutMs`, `timeoutMs`):

| Request | Budget | Constant |
|---------|--------|----------|
| `initialize` (opening the connection) | **30 s** | `DEFAULT_CONNECT_TIMEOUT_MS` |
| `tools/list`, and every tool call | 20 s | `DEFAULT_REQUEST_TIMEOUT_MS` |

Measured cold the same day, four connects each (initialize + tools/list): GitHub 1.4–3.6 s,
Linear 2.9–7.1 s. So 20 s was not tight for a typical connect and the live one was an outlier;
30 s is room for an outlier — about four times the slowest connect measured — not a measured
need. (It was 45 s for one commit; reduced because 65 s before a dialog was too long.)
**Worst case before a dialog appears: 50 s** (30 + 20) on top of the planning call — still
long, and the reason for the next line.

**"Connecting to GitHub…"** is shown on the shell's existing status line (`narrate`, the one
`caution` narrations use) each time a connection is about to be opened: once per attempt,
before anything is sent, not again while it stays open, and not spoken. `SdkMcpConnection`
owns the wording and the timing (`onConnecting`); `main.ts` only hands it `shell.narrate`.
That three-line wiring is the one part with no test.

### The second connector (M20): GitHub

Added to answer one question — is a new app "a definition plus config"? — by picking a server
that differs from Linear. `scripts/github-recon.mjs` (strictly read-only) and the fixtures in
`tests/fixtures/github/` are the evidence; its README says which two shapes were **not**
captured.

**What recon found** (hosted server `https://api.githubcopilot.com/mcp/`, protocol 2025-11-25):

- **Auth and shape are the same as Linear's.** A bare `Authorization: Bearer` header; one text
  block of JSON per result; failures as `isError` results; a rejected token as a thrown
  `StreamableHTTPError`, code 401. No extra header is needed.
- **`issue_write` creates or updates depending on the VALUE of `method`**, and an update can
  close. Its hints say not-read-only and nothing about destructive.
- **The server silently ignores an argument it does not know**, and none of its schemas set
  `additionalProperties: false`.
- **The token reads every public repository**, and writes wherever it was granted.
- **A list item has no URL**; `state` is `OPEN` in a list and `open` in a read.
- **A failure's text carries the API URL**, and for a rate limit a user ID and a request ID.
  A missing issue and a missing repository are the same 404 from `issue_read`.
- **`search_issues` is not usable here**: it returned nothing for queries that had to match, a
  `repo:` qualifier typed into the query displaced the repository named in the arguments (seen
  in the request the server built), and it is limited to about ten calls a minute.

**What that forced in `core/mcp/`** — the answer to the question is "nearly":

| Change | Why |
|---|---|
| `format(text, args, settings)` | List links have to be built from the pinned owner and repo; and a formatter that knows where a result should have come from refuses one from elsewhere. |
| Drift: every sent key must be in the server's `properties` | A renamed `body` would validate against a schema that forbids nothing, be dropped, and create an empty issue. |
| A fixed key may not also be a model key (startup refusal) | `method` is the whole difference between create and update; merge order should not be a question. |
| `failure(text, args, settings)` on a tool | The M19 fallback *is* the server's text. A connector that defines this shows its own sentence or, unrecognised, only "GitHub said no." |
| `transport.ts` | Not forced by GitHub (same header). Moved because it was the one deciding piece with no test; now refuses a non-https URL. |

Nothing changed in the planner, the registry, the chain gate, the tiers or `plan.ts`.

**The definition** (`connectors/github.ts`). `owner` and `repo` are required settings on all
three tools, fixed in code, reads included.

| Tool | Remote | The model may send | Fixed in code |
|---|---|---|---|
| `create_issue` | `issue_write` | `title`, `body` | `method: "create"`, `owner`, `repo` |
| `list_issues` | `list_issues` | `state`: `OPEN` / `CLOSED` | `owner`, `repo`, `perPage: 5`, `fields`, newest first |
| `get_issue` | `issue_read` | `issue_number` | `method: "get"`, `owner`, `repo` |

`state` is upper-case because the adapter sends model arguments unchanged and that is the
server's spelling. A create's result is `{id, url}` (from the server's source — never captured);
the formatter reads the issue number out of the link and refuses a link that is not to an issue
in the pinned repository.

**Failure wording**, matched on the measured status-and-reason and built from our own arguments
and settings:

| The server's text contains | Said |
|---|---|
| `: 404 Not Found` (get) | I couldn't find issue #N in owner/repo. |
| `: 404 Not Found` (other), `Could not resolve to a Repository` | I couldn't find owner/repo — check connectors.json, and that GITHUB_TOKEN can see it. |
| `: 403 Resource not accessible by personal access token` | GITHUB_TOKEN isn't allowed to do that in owner/repo — check its Issues permission. |
| `: 403 API rate limit exceeded` | it is rate-limiting me. Try again in a minute. |
| starts `An interactive form has been shown` | it showed a form instead of creating the issue. Nothing was created. |
| anything else | *(nothing — "GitHub said no.")* |

The last row but one is the **form handoff**: by the server's source, `issue_write` answers a
client that advertises the `io.modelcontextprotocol/ui` extension with an `isError` result
saying it showed a form and wrote nothing. This app advertises no extensions, so by the source
it cannot fire. That has not been tested by a real create.

### Not built

Stdio servers; OAuth; any Linear tool beyond the three; priority, labels and assignee on create;
a UI for adding connectors (the config file only). For GitHub: everything but the three tools
above — no editing, closing, commenting, labels, pull requests or files, and no search.

---

## 6f. Slack bot-token mode (M22)

**Why.** A Slack app webhook posts to the one channel it was created for, whatever channel it
is handed. Through M21 the app could only be honest about that ("Send via your Slack webhook?
(You asked for #help…)"); it could not send where it was asked. M22 adds a second way to post:
a **bot token**. With it, the channel you name is the channel posted to — and a name Slack does
not have is refused before anything is asked or sent.

### Mode selection (`core/senders/slackMode.ts`)

| `.env` | Mode | Startup line |
|---|---|---|
| `SLACK_BOT_TOKEN` set (non-blank) | **bot** | `[main] Slack: bot mode (SLACK_BOT_TOKEN)` |
| both `SLACK_BOT_TOKEN` and `SLACK_WEBHOOK_URL` set | **bot wins**; the webhook is ignored | the bot line, plus a warning naming both variables |
| `SLACK_BOT_TOKEN` present but blank | **webhook**, with a warning that it is being ignored | `[main] Slack: webhook mode (SLACK_WEBHOOK_URL)` |
| only `SLACK_WEBHOOK_URL` | **webhook** | as above |
| neither | webhook, able to send nothing | `[main] Slack: webhook mode - SLACK_WEBHOOK_URL not set, nothing can be sent` |

The token is trimmed. Startup lines name variables only — never a value or any part of one.
In code, **bot mode is `sender.mode === "bot"`** (with a channel directory present, for every
check added in prompt 5); a sender that says nothing is a webhook, so every M21 path is reached
exactly as before.

**Webhook mode is M21, unchanged:** the webhook posts to its own channel, the dialog says "Send
via your Slack webhook?" with the "(You asked for …)" note, a remembered or answered channel is
saved as typed, a literal channel that does not exist is accepted, and nothing in this section
runs. The M21 tests pin it, and `tests/m22.webhookUnchanged.test.ts` shows none of the bot-mode
checks touching Slack in webhook mode.

### Setup

1. Create a Slack app with a **bot user**, and give it these bot token scopes:
   `chat:write`, `chat:write.public`, `channels:read`, `groups:read`. Install it to the workspace.
2. Put the bot token in `.env`, **quoted**: `SLACK_BOT_TOKEN="xoxb-…"`. (Quoting is not
   required for a token, but it is the safe habit after M21's `#` lesson; the real `.env` parser
   reads quoted, single-quoted and unquoted forms the same — `tests/slackMode.test.ts`.)
3. Restart the app; the startup line says which mode it is in.
4. To post in a **private** channel, add the bot to it (`/invite @your-bot`). Public channels
   need nothing (`chat:write.public`).
5. **If the token is ever exposed** — pasted, logged, committed, shown — revoke it by
   reinstalling the app (or rotating the token) and put the new one in `.env`.

### The channel directory (`core/senders/SlackChannelDirectory.ts`)

Where channel IDs come from. `conversations.list` (public and private, unarchived, 200 a page,
every page followed by `next_cursor`, capped at 50 pages), token in the `Authorization` header
and nowhere else.

- **Which channels:** every public channel, and **only the private channels the bot is a member
  of** — measured by recon (`scripts/slack-recon.mjs`): with two private channels and the bot in
  one, only that one was listed.
- **Matching is exact**, after trimming, one leading `#`, lower-casing and NFC: `#Help`, `help`
  and ` #help ` are one name. A typed Slack ID (`C0123…`) is just a name that matches nothing; an
  ID only ever comes from the list. Two channels with one name are refused as ambiguous.
- **Cache:** filled on first use and trusted for **10 minutes**; past that it is refreshed
  before being answered from, and a failed refresh is a failure — nothing stale is served. A
  name missing from a fresh list triggers **one refresh**, at most once every **30 seconds**, so
  a channel created a minute ago works with no setup and a repeated typo does not hammer Slack.
  **Besides that normal rule, one extra refresh is allowed on a miss** (prompt 7) if at least
  **5 seconds** have passed since the last fetch (`extraRefreshMinGapMs`) and no other extra has
  run in the last 30 s — so a channel created seconds ago works within seconds. However fast
  misses come, that is **at most two list fetches in any 30 s**, and a miss right after a fetch
  never costs a second one. Concurrent lookups share one request: never more than one in flight.
- **Suggestions:** up to three real names — prefix, then substring, then within a small edit
  distance — shown, never used.
- **Failures are fixed codes**, never text: `no_token`, `auth`, `network`, `timeout`,
  `rate_limited`, `slack_error`, `bad_response`, `ambiguous`. Recon found every Slack failure is
  HTTP 200 with `ok: false` and a code (`invalid_auth`, `not_authed`). `resolve()` never rejects.
  8s per request, 20s per refresh, no retries.

### Sending (`core/senders/SlackBotSender.ts`)

`chat.postMessage` with **the directory's ID, never a name** — the sender looks the name up again
itself, so nothing the model wrote or an email contained is ever posted to directly. The text is
**escaped** (`&`, `<`, `>` → `&amp;`, `&lt;`, `&gt;`) so a message cannot trigger `<!channel>`,
`<!here>` or a mention, and Slack shows it as written. One request per send (10s timeout),
**never retried**.

**Every failure says whether it might be in the channel** (`SendResult.outcome`):

- `not_sent` — Slack refused outright (`ok: false`: `channel_not_found`, `not_in_channel`,
  `is_archived`, a token error, `ratelimited`, a text error) or HTTP 429. Safe to try again.
- `maybe_sent` — a timeout, a network error, a 5xx or other non-2xx, or a 200 that cannot be
  read. The user is told it **may have been sent** and to check Slack before trying again.

Leak rule, for the directory and the sender alike: the token, URL, headers, response bodies and
any error's `.message` never reach a result, an exception, a log line or the action log.
(M22 also fixed the two older places that did put `error.message` into what the user sees —
`SlackSender` and `GoogleCalendar`.)

### What the user sees (`core/tools/sendMessage.ts`)

All bot-mode refusals happen **before any dialog**, and are worded in one place
(`slackRefusalText`):

| Case | Text |
|---|---|
| Dialog | `Send to #help?` — Slack's own name for the channel, never the words typed — then the whole message after a blank line |
| Sent | `Sent to #help.` then the message |
| Refused by Slack | `Could not send to #help: <the sender's fixed reason>` |
| Unknown outcome | `Could not confirm the message to #help. It may have been sent. Check Slack before trying again.` |
| Not found | `I couldn't find a Slack channel called #hepl. I can post to public channels and to private channels the bot has been added to. Similar channels: #help.` |
| Slack unreachable | `I couldn't reach Slack to check the channel, so nothing was sent.` (also: token rejected, rate limited, ambiguous) |
| Bot mode, no directory | `I couldn't check Slack channels, so nothing was sent.` (fail closed) |

Suggestions are a **statement**, not "Did you mean …?": a refusal ending in a question read as
a question nothing was waiting for, to the user and to the model, which is shown the refusal as
the previous turn (`tests/eval/unknownReference.eval.test.ts`, bot-mode case: 5/5 planned a
send, none answered in prose). The only questions the app asks are its own (`askUser`) and the
dialog titles.

### Where a channel is checked

- **Lone send:** in `prepare`, before the formatter is paid for; again in the dialog and the
  handler (the cache makes repeats cheap).
- **Lone send to a phrase nobody has taught the app** (prompt 7) — "send these notes to the
  second channel", no memory entry: in bot mode it **asks**, exactly as a chain does, through the
  chain's own machinery (`settleReferences` on a plan of one step, opted into by
  `ReferenceQuestion.askWhenAlone`). "Before I start: which channel do you mean by 'the second
  channel'?" — the answer is checked against Slack **before** it is saved, `Saved: the second
  channel = #help` is shown, and then the normal `Send to #help?` dialog. It is asked before
  `prepare`, so no formatter call is paid until there is a channel. Unanswered (Escape, the 60 s
  timeout, a busy bar) or out of budget (two questions): the M21 refusal ("I don't know which
  channel "the second channel" means — teach me with: remember …"), and nothing saved. Slack
  unreachable while checking: refused, nothing saved. **Webhook mode never asks:** a lone send
  still shows the M21 "teach me with: remember …" text.
- **Chain:** in the **pre-flight**, before step 1 (`Tool.preflight`, run inside
  `settleReferences`, on the plan as written). A channel Slack does not have, or a Slack that
  cannot be asked, refuses the **whole plan** — no email read, no issue created. A channel taken
  from an earlier step (`{stepN}`, anywhere in the channel) is refused outright: "In bot mode I
  need you to name the Slack channel yourself, not take it from an earlier step, so nothing was
  done." The placeholder is visible only there; by the time the step runs it has been filled in.
- **"the help channel":** memory first, always. On a memory **miss**, a leading the/my/our is
  dropped and the rest goes through the same spellings as any name (below) — "the help
  channel" is `#help`, "the new channel" is `#new-channel` (prompt 11). Found: used — the dialog
  still names it — and **never saved**. Not found: the question — in a chain, and since prompt 7
  for a lone send too (above). A near match is never taken.
- **"social channel"** (prompt 7): a name Slack does not have is tried **once more** with a
  trailing word "channel" dropped — a leading `#` kept, exact match only, nothing saved — so
  "social channel", "#social channel" and "fun channel" are `#social`, `#social` and `#fun`, and
  the dialog shows Slack's name. "channel" on its own is not stripped to anything and does not
  resolve, and "social chanel" is never corrected. If the retry misses too, the refusal is about
  what was typed, with its suggestions; if Slack cannot be asked on the retry, it refuses. The
  same retry applies to a send's checks, the pre-flight, the answer to the question and
  `remember` (`resolveSlackName` in `core/tools/sendMessage.ts`).
- **Spaces as hyphens** (prompt 11): Slack names cannot contain spaces, so on a miss the name is
  also tried with every run of spaces as one hyphen, and with both "channel" dropped and
  hyphens — "new channel" → `#new-channel`, "all wicky micky" → `#all-wicky-micky`. The full
  order: as typed (a hit ends it); then, ALL of — without "channel", with hyphens, both — each an
  exact match. One channel found (however many spellings reach it): that channel. **Two different
  channels found** — "social channel" with both `#social` and `#social-channel` — refused as
  ambiguous ("More than one Slack channel is called #social channel, so nothing was sent."),
  never a silent pick. Slack unable to answer any spelling: refused. Nothing saved, a typed Slack
  ID never accepted, "new chanel" never corrected, webhook mode untouched.
- **A remembered channel** is checked in Slack every time it is used; one Slack no longer has is
  refused with similar channels, and is not forgotten.
- **The answer to "which channel do you mean?"** is checked in Slack before it is saved, and
  saved as Slack's own `#name`. Not found: asked again with similar channels, within the same
  budget of two questions; unreachable: the plan is refused and nothing is saved.
- **`remember`:** a fact whose value starts with `#`, or whose subject ends in "channel", is
  checked in Slack and saved as `#name`; not found or unreachable refuses and writes nothing
  (the unreachable texts end "so nothing was saved."). Other facts are untouched.

### Known limits (M22)

- **Private channels the bot has not been added to are refused as not found** (confirmed by
  recon). The refusal says so: "…and to private channels the bot has been added to."
- **A channel deleted and recreated with the same name while a dialog is open could receive the
  message.** The handler re-checks the channel by NAME after the dialog; the ID approved is not
  carried to the send.
- **"our help channel" is treated as a literal name**, not a phrase: only "my …" and "the …" are
  references (`isVagueReference`, unchanged), so it is looked up as typed and not found.
  **Still true after prompt 7:** the "channel" retry makes it "our help", which is not a channel
  either.
- **A channel created less than about 5 s ago can still be refused** until the next refresh:
  the extra refresh on a miss waits 5 s after the last fetch (and one extra per 30 s), so a
  channel that new may be reported as not found. Asking again a few seconds later finds it.
- **Renamed channels are refused**, with similar channels. Names are stored (memory holds
  `#name`) and resolved to an ID at send time.
- **A failure after an irreversible step can still orphan an issue.** A bot-mode channel is now
  checked before step 1, but the post can still fail or time out at the send step, after the
  issue exists.
- **A timeout or network error on the post is reported as "may have been sent"** — including
  when offline with a warm cache, where nothing can actually have been sent.
- **Rate limits (429) and server errors (500) are handled by tests built from Slack's
  documentation, never captured live.** The directory answers `rate_limited` and the bot sender
  `not_sent` "Slack is rate limiting. Try again shortly." for every 429 shape tried — with or
  without Retry-After, an empty or non-JSON body, a Retry-After that is huge or not a number —
  never sleeping or retrying on it (`tests/rateLimit429.test.ts`).
- *(Resolved in M23-pre, listed here so the record stays readable: the webhook post now has a
  10 s timeout that ends in the existing "Could not reach Slack: the request did not get an
  answer." (`tests/slackSender.timeout.test.ts`); an offline or failed model call now leaves an
  action-log row (see "Related live finding" below).)*
- **Model prose that looks like a question can still confuse the next turn** in rare cases;
  the "Similar channels" wording removes one trigger, not every one.
- **In a plan, bot mode refuses `sendMessage` only for a `{stepN}` channel.** A literal or
  remembered channel in a plan sends, after the pre-flight has checked it.

### Tests and evidence

Recon: `scripts/slack-recon.mjs` (read-only: `auth.test`, `conversations.list`; writes no
files). Fakes: `tests/fakeSlackFetch.ts` (scripted Slack, including a network error that quotes
the token and URL), `tests/FakeChannelDirectory.ts` (independent matching, async, checked
against the real class). Mutation passes were run on the directory (prompt 3), the sender and
mode selection (prompt 4), the pre-flight / ask / remember logic (prompt 5) and the lone-send
ask, the "channel" retry and the extra refresh (prompt 7), and the spaces-as-hyphens spellings
(prompt 11); every survivor got a test that kills it. Prompt 7 came from the first live run (a
lone send that could not ask; "social channel"; a just-created channel refused for 30 s).
The **warm-list "may have been sent"** case (live checklist 10.2) is covered by
`tests/maybeSent.warm.bot.test.ts` — real directory and real bot sender on one scripted Slack:
the list read a minute earlier still shows the dialog, the post then fails (network error or
timeout), the result says it may have been sent, exactly one post and no list read, nothing
leaked. **Not human-watched.** **Not yet fully run live** — `docs/m22-live-checklist.md`.

**Related live finding (prompt 11): an instruction that threw was lost.** With the model
unreachable, `Planner.decide` threw an OpenAI "Connection error"; the hotkey runs the instruction
fire-and-forget, so the bar showed nothing and the console an unhandled rejection.
`createRunInstruction` (`src/main/runInstruction.ts`) now catches it: the bar says "I couldn't
finish that: something went wrong before anything was done. Check your connection and try
again.", and the console logs `[main] error: <error class>` — never the error's message
(`tests/runInstruction.failure.test.ts`). **Since M23-pre it also leaves an action-log row**: no
tool, no arguments, the instruction as typed, the fixed text above as the result, status `error`
— written in the same catch, guarded so a log that cannot be written changes nothing else
(`tests/runInstruction.logRow.test.ts`).

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
- [x] **M15 — Vision guidance: point, don't click.** Splits the one remaining half of
      screenshot-driven computer-use (§2) and moves in the safe side of it: capture the screen,
      ask a vision model where the named control is, draw a marker over it, and let the USER
      click. Adds `ScreenSurface` + `VisionLocator` (§4e) — surfaces injected through `ToolDeps`
      like Gmail/Notion/Calendar, not shell contracts like the microphone, because capture is a
      request/response; `core/vision/` (the pure geometry, the deterministic gate, the prompt and
      its parser, the Anthropic transport); `src/main/screen/` (`WindowsScreen` +
      `PointerOverlay`); one tool, `pointAt` (§6d); and a second renderer entry, `overlay.html`.
      `OSShell`, `MockShell`, `preload.ts` and `CommandBar.tsx` are all untouched.
      **Two things distinguish it from every milestone before it.** It is the first capability
      that sends the user's screen off the machine, so it is the first gated on an explicit
      `VISION_ENABLED` opt-in rather than on configuration that exists anyway. And it is the
      first where the app acts on a model's *guess* about pixels — which is only acceptable
      because the guess drives a suggestion and a person is the executor. See "M15 — proven vs.
      live-only" below for what that leaves unverified, which is more than usual.

      > **SUPERSEDED BY M16.** Both distinguishing properties above are gone. Nothing is
      > photographed any more, the flag is `POINTING_ENABLED`, and no model produces a pixel —
      > UI Automation supplies exact rectangles and the model picks one by number. This entry is
      > kept because the MEASUREMENTS that killed the approach are the most valuable thing M15
      > produced; the architecture it describes no longer exists in the tree.

- [x] **M16 — Regrounding `pointAt` on UI Automation.** Replaces M15's vision-model grounding
      entirely, not just its accuracy. Deletes `core/vision/` (~2,900 lines: the locator, both
      provider adapters, the prompt/parser, the geometry, `SMALL_TARGET_PX`) and
      `ScreenSurface.capture()`. Adds `core/screen/` (`elements.ts` — the pure filter/dedup/
      numbering step; `settle.ts` — the pure growing-vs-stuck decision; `prompt.ts` and
      `resolve.ts` — the choose contract and its deterministic gate; `geometry.ts` — native px
      → DIP; `ModelElementChooser`, riding the planner's own `LLMClient` rather than a new
      transport); `src/main/uia/WindowsElements.ts` (a persistent PowerShell host over UI
      Automation, modelled on M12's `WindowsInputInjector`); and the `ElementSurface`/
      `ElementChooser` interfaces (§4e). `pointAt`'s registry entry, the overlay, and
      `setContentProtection` all carry over unchanged — this changes where coordinates come
      from, nothing else about what the tool does. Renames the opt-in flag
      `VISION_ENABLED` → `POINTING_ENABLED`, because what it authorises shrank from a
      screenshot to a list of control names. Live testing (M16.11) found and fixed two real
      bugs no fixture or host-level test could reach — a foreground snapshot that always
      captured the app's own command bar, and a marker that always showed the previous
      question's answer — see "M16 — proven vs. live-only" below and
      `docs/context/PROJECT_CONTEXT_UPDATE_8.md` for the full account.

- [x] **M17 — Narrow multi-step autonomy (prompt chaining).** The first bite out of §2's
      "no multi-step" guardrail, and deliberately the narrowest one: one instruction can resolve
      to a FIXED, ordered plan of up to 3 tools that already exist, decided in a single planning
      call and executed by deterministic code (§5b). Adds `core/llm/plan.ts` (the `plan`
      meta-tool — offered to both providers, never in the registry, so a nested plan is refused
      by the ordinary unknown-tool check), `core/chain.ts` (the pure gate: the cap, the
      closed-world check, `{stepN}` substitution, the plan preview, and the new
      how-much-ran-and-how-much-did-not sentence), `core/chainState.ts` (running/where — never
      the step results), a fourth `ToolChoice` variant, and `MockShell.holdConfirm`. Extracts
      `runStep` from `Planner.run` so a chained step goes through the SAME gates a lone
      instruction does — there is no second gate implementation to drift. Both hotkey guards
      gain a chain state, ordered BEHIND the M14 §8 confirm guard.
      **What it is not:** an agent loop. The model answers once and is never consulted again;
      the step count is known before anything runs. Nothing branches, nothing survives the
      instruction, and no step's risk tier changes by being chained. See §5b for the full
      design and what was deliberately deferred (field-level `{step1.attendees}` references,
      which no tool can currently emit, and which the expressible chains turn out not to need).

- [x] **M18 — Opening apps, and local media control.** Two capabilities that happen to share
      one sentence ("open Spotify") and are deliberately kept apart underneath it.
      **Ticked after the live pass (2026-10-07), which is what this box was held open for.** It
      was left unchecked while the code was complete but unrun by a person; the pass then found
      four bugs no fixture caught — as every milestone from M10 on has (CLAUDE.md) — including
      one in the shared PowerShell input host that dictation depends on. All four are fixed.
      **Ticked with things still open, and they are listed rather than implied:** two
      unexplained observations, the unrun checklist items, and the parked list. See
      `docs/M18-live-checklist.md` and "M18 — proven vs. live-only" below.
      **Launching an app** adds a fifth `LocalAction` kind, `openApp`, carrying *the name the
      user said* — the shell resolves it against a closed allowlist (`core/apps.ts` holds the
      names, `src/main/shell/appLaunch.ts` holds the paths and protocol URIs), so the model
      never supplies a path, a command, or an argument. Exact matching on id, label or alias
      only; an unmatched name is refused with the list of what *can* be opened, never
      approximated. `APPS_EXTRA` lets a user add their own `Name=command` entries, validated at
      startup — a malformed entry is reported and never launched.
      **Local media control** adds a sixth `LocalAction` kind, `mediaKey`, carrying one of six
      NAMES (`core/media.ts`) whose virtual-key codes live in `src/main/shell/mediaKeys.ts` —
      the same name/keycode split `apps.ts`/`appLaunch.ts` uses, so there is not a keycode
      anywhere in `/core`. It is pressed through the **existing** `SendInput` host dictation
      uses: `InputInjector` gains `pressKey(vk, count)` (same primitive, same process, same
      un-swallowable short-write signal — a second contract would have meant a second
      PowerShell host), and `HOST_SCRIPT` gains a purely additive `KEY` command alongside the
      untouched `TYPE` one, reusing its measured 40 ms inter-press gap (M12.1).
      Three tools, all `reversible`, all ungated: `systemVolume` (1–15 presses, default 5 ≈
      10%), `mediaControl` (play/pause, next, previous) and `searchSpotify` (a fixed-template
      search URL through `openUrl`). **A repeat count is honoured only for the volume keys** —
      `mute` and `playPause` are toggles that five presses would return to their starting
      state, and five `next` presses skip five tracks — and `pressesFor` enforces that in the
      tool *and* in the shell. The injector is now built unconditionally rather than only
      alongside whisper, since media keys have nothing to do with voice; `ensureStarted()` is
      lazy, so an install that never dictates and never presses a key still never spawns it.
      **What it is not:** no reading the current volume (nothing can, so nothing claims to), no
      per-app volume, no playlists or queueing, no launching an app with arguments, and no
      auto-launching Spotify to satisfy a search request.

      > **Parked: Spotify Web API tools.** M18 was planned as `playOnSpotify` and
      > `spotifyVolume` over the Web API, behind a `SpotifySurface` with the same
      > unavailable-default, config-gated, tested-against-a-fake rules every surface since M10
      > has followed. **It is parked because the account is free.** Spotify's playback and
      > volume endpoints require Premium, and an app in *development mode* — which is the only
      > mode a personal project can be in, since extended quota has required a registered
      > organisation with 250k+ MAU since 2025-05-15 — additionally requires the app owner's
      > own account to be Premium for the app to function at all. Building it anyway would have
      > meant a connector untestable against anything real, which is exactly what CLAUDE.md's
      > recon rule exists to prevent.
      >
      > **Trigger to resume: a Premium account.** Nothing else about the design changes. What
      > still stands, unmodified: `SpotifySurface` (`search`/`play`/`getVolume`/`setVolume`),
      > `core/spotify/errors.ts` with a `SpotifyError extends UserFixableError` whose reasons
      > come from captured recon output rather than recalled names, classification as an
      > **exported pure function** so it is tested directly (`GoogleCalendar.classify` is a
      > private method and that is the one thing not to copy), `UnavailableSpotify`,
      > PKCE-refresh `SpotifyAuth`, and a `FakeSpotify` that is async, rejects a volume outside
      > 0–100, and throws the **same error class** the real transport throws for "no device".
      > `playOnSpotify` stays `caution` with its narration doing the search so the user hears
      > the title before it plays, and the handler playing that same resolved URI rather than
      > searching twice.
      >
      > **What already exists and does not need rebuilding:** `npm run spotify:connect` (PKCE
      > on a loopback **IP literal** — `localhost` has been rejected as a redirect URI since
      > 2025-04-09, with all clients migrated by November 2025), `scripts/spotify-recon.mjs`,
      > and the `.env.example` block. Three API facts worth keeping, all confirmed against the
      > live docs: search `limit` is now **0–10, default 5** (not the 50/20 it once was);
      > `GET /v1/me/player` signals "no active device" as **204 with an empty body**, not a
      > JSON error, so a classifier keyed only on error bodies would miss it; and the player
      > response carries `device.supports_volume` and a **nullable** `volume_percent`, so a
      > volume tool must refuse on both rather than defaulting a null to 0 and then applying a
      > relative change to it.

- [x] **M19 — MCP support, with Linear as the first connector.** **Ticked after the live pass
      (2026-10-09), with a caveat that is part of the tick.** The box was held open for that
      pass, following M18's precedent, and the pass found three bugs no fixture caught — the
      confirm dialog covered by the instruction bar, a plan that skipped `readEmail` and filed
      an invented issue, and the clipboard taken for "this bug" (with a `functions.`-prefixed
      tool name on top). **The covered confirm dialog is fixed. The plan-choice problem is
      REDUCED, NOT FIXED** — an earlier version of this entry said all three were fixed, and
      that overstated it. With an email open and other text on the clipboard, the model still
      sometimes files the clipboard: seen live once *after* the "An email is open in Gmail."
      hint shipped, and in 1 of 12 eval trials with long, realistic clipboard text. The confirm
      dialog shows the text in full and is what caught it — the gate held, the plan did not.
      **A second fix then shipped (verb-keyed wording, a confirm label, a log line) and its
      live re-run passed** — the same case, same kind of clipboard, three steps from the
      email (finding 4). That is improved and measured, still not certain, and the confirm
      dialog remains what is relied on. **Seen live by a person:** the Gmail → Linear →
      Slack chain working end to end; the step 2 and step 3 confirm dialogs fully visible; and,
      after the plan-choice fixes, the short instruction planning three steps with the real
      email in the description — in **one** live run. (An earlier version of this entry said
      3 of 3; it was one. Whether unrelated text was on the clipboard for that run was not
      recorded, so the exact failing case is not claimed as re-verified live: the 3-of-3
      figure for it is the eval's, not a person's.)
      **NOT run live, and resting on tests alone:** every decline and failure case, the
      long-email dialog, the injected-instruction email, and the `functions.` prefix rule
      (seen live only as the refusal that prompted it). 50 checklist boxes remain open and say
      so; see `docs/M19-live-checklist.md`, "Live results 4". Adds `core/mcp/` — a generic adapter that turns a pinned
      connector tool into an ordinary registry `Tool`, a closed-world loader driven by
      `connectors.json`, tiers that a server's hints can raise but never lower, and Linear's
      definition (three tools of the server's 59). Adds `readEmail`, and makes `sendMessage`
      verbatim inside a chain. The proof is one chained instruction: Gmail bug email → Linear
      issue → Slack link. The planner's gate, the registry's closed world and M17's per-step
      gating are unchanged; hand-built Gmail, Notion and Calendar are untouched. See §6e, §5b's
      "Chains and connectors", and "M19 — proven vs. live-only" below.

- [x] **M20 — a second connector (GitHub issues), to find out what in the MCP path was
      Linear-specific.** **Ticked after a PARTIAL live pass (2026-10-10), with a caveat that is
      part of the tick.** A person ran sections 0, 1 and 2 of `docs/M20-live-checklist.md`:
      the console listed all six connector tools and an older Linear instruction still worked;
      the reads worked (list, an issue by number, not-found); and the first real create showed
      its confirm dialog first, named `Sejall-089/throwaway_repo`, and answered `Created #3:
      M20 live test` with a working link. **The form handoff did not fire, and the create
      result matched the `{id, url}` the server's source describes.**
      **Section 3, the Gmail → GitHub → Slack chain, has since been run** (three runs,
      2026-10-10; checklist, Live results 3): the plan had three steps and picked GitHub, not
      Linear; the step 2 dialog named the repository and showed the whole email; the step 3
      dialog showed exactly the text then posted; issues #5 and #6 exist and Slack got one
      message for each; and issue #5's body on github.com is the email (From, Subject, then
      the full text). **Run 1 created issue #4 and then stopped at step 3** because "the bugs
      channel" was not a channel it knew — M19's orphaned-issue follow-up, seen again and not
      an M20 bug (Finding 3; the follow-up list below has it). The chain's two declines were
      not run.
      **Section 5 is STILL UNRUN and rests on tests alone:** the **failure wording** (wrong
      repository, rejected token, a token that may not write, and the console line for an
      unrecognised failure). **Section 4, the choice between two trackers, is half run:** "file this bug"
      with no tracker named picked Linear, once (cancelled; nothing created) — and its body
      was the instruction text itself, M19's made-up-description finding again, shown by the
      dialog and caught there (checklist, Live results 2 and Finding 2; not an M20 bug).
      "file this bug in Linear" has not been run. Also seen by the person,
      and confirmed after the first report: cancelling the dialog created nothing, and
      github.com showed exactly one new issue with #1 and #2 untouched. Within sections 0-2,
      four boxes are still open — the token's permissions, the `connectors.json` entry, the
      recon script, and listing closed issues. 15 boxes ticked, 12 open; the live results in
      the checklist say which.
      What follows was written before the pass.
      Built and tested headless.
      Adds `connectors/github.ts` (three tools of the server's 46), `transport.ts`, and four
      changes to the generic adapter (§6e, "The second connector"): `format` receives settings,
      drift requires the server to name every sent key, a fixed key may not also be a model
      key, and a connector may own its failure wording. `tests/FakeMcpServer.ts` was split into
      a protocol harness (`tests/fakes/McpHarness.ts`) and per-app behaviour, with a
      `FakeGitHubServer` written from recon. `plan.ts`, the planner, the registry and the tiers
      are unchanged; hand-built Gmail, Notion and Calendar are untouched.
      **Proven headless:** the three tools through the SDK's real client; that hostile
      arguments (`method: "update"`, `issue_number`, `state`, `owner`/`repo`) are refused before
      anything is sent, against a fake that really would update, close and write elsewhere;
      that the repository on every call is the configured one; that no failure message carries
      a URL, a user ID or a request ID; the confirm gate and the Gmail → GitHub → Slack chain
      with both connectors on one menu.
      **Checked read-only against the real server:** the tool names, schemas and hints; that
      the Bearer header alone connects; that the fixed list arguments are accepted; the 404,
      missing-repository, missing-argument and rejected-token shapes; and (2026-10-10) a
      non-empty list and both single-issue shapes, captured from two issues made by hand in
      the configured repository — #1 open, #2 closed — and now the fixtures the formatters are
      tested against. Earlier recon runs listed 0 issues there; the non-empty fixtures were
      then built on a public repository's structure, and have been replaced.
      **NOT verified, by anyone or anything** (as of the build; the first item was then
      settled by the live pass above and is kept for the record):
      - ~~**A real create.**~~ **Seen live 2026-10-10:** one create worked, the handoff did not
        fire, and the result was read as `{id, url}`. Once, by one person; the raw result was
        not saved, so the fixture is still "from source". Every create *failure* is unmeasured.
      - **Part of the mutation pass.** Nine rules were broken one at a time (2026-10-10), each
        was caught, and the suite was green after each revert. In the adapter: the shared-key
        startup refusal (1 test failed), the unknown-key drift check (3), settings reaching the
        formatter (14), and "an unrecognised failure shows none of the server's text" (6). In
        the GitHub definition: `create_issue` declared `safe` (7), the fixed `method` changed
        to `"update"` (7), `owner`/`repo` dropped from `get_issue`'s fixed arguments (14), the
        pinned-repository link check disabled in the create and get formatters (2), and the
        rate-limit matcher widened to any 403 (2). **Not mutated:** `owner`/`repo` on create
        and list, the pinned page size, fields and order, the 404 and form-handoff matchers,
        and the transport's https and header rules. For those, "pinned" still means "has a
        test written for it", not "has a test that was seen to fail".
      - **A token without Issues access on an issue call**, and **every create failure** —
        the permission wording was written from a stand-in (`list_branches`).
      - **Whether a model ever picks GitHub when it should, or when it should not.** The plan
        eval was re-run once with both connectors on the menu (below), but every phrase in it
        names Linear or no tracker: it shows GitHub's presence did not pull those phrases
        away, and says nothing about a phrase that names GitHub.
      **The plan eval, once, with both connectors on the menu** (2026-10-10, `gpt-5`,
      `M19_PLAN_SET=verbs`, 28 calls; the eval's config now supplies GitHub's `owner` and
      `repo`, without which its tools are silently left off the menu). **27 of 28 matched,
      against M19's 28 of 28. No call chose a GitHub tool, and the tools chosen were the
      expected ones in all 28.** The one mismatch is "log this as an issue and let #bugs
      know", trial 2 of 3: the right three steps, each named with the provider's `functions.`
      prefix (`functions.readEmail > functions.linear__create_issue > functions.sendMessage`).
      The eval compares raw names, so it counts as a miss; the app's `canonicalToolName`
      (`core/chain.ts`) strips that prefix, so the same answer would have run. It is the first
      time a real model has produced the prefix since that rule shipped — M19's follow-up list
      says none had in 15 eval calls. One trial cannot say whether the larger menu made it more
      likely.
      **An unrecognised GitHub failure is now logged to the console** (added 2026-10-10): the
      person is still told only "GitHub said no.", and the server's text — one line, bounded
      at 1000 characters — goes to an injected logger that `main.ts` points at the console. It
      is not on the error, so it cannot reach the screen, speech, the action log or a later
      chain step; tests assert its absence from each of those.
      **The confirm button says "Send" on a create** — cosmetic, a follow-up, not fixed (the
      M19 follow-up list has the detail; a GitHub create is one more dialog it mislabels).
      **Fixed in code by M21 (2026-10-10), not live-tested:** it now says "Create issue".
      **Links in the result bar are plain text, not clickable** — **resolved in code by M21
      (2026-10-10), not yet live-tested**: GitHub and Linear issue links in the result bar are
      now clickable (§4, "Result links"); nobody has yet clicked one in the running app. As
      found: a UI
      follow-up for the result bar, not an M20 bug, not fixed. The links are correct, but one
      had to be copied into a browser. Seen on GitHub results only; it likely applies to
      Linear's too, not checked (`docs/M20-live-checklist.md`, Finding 1). **Only the result
      bar needs the fix:** the link is not clickable in the step 3 confirm dialog either, but
      that is a native Windows message box and cannot be made so, and Slack linkifies the
      link itself once it is posted.
      **Follow-ups noted, not started:** `search_issues` and every write beyond create.
- [x] **M21 — close the orphaned-issue gap: check references before a chain starts, and ask
      instead of refusing.** **Code-complete and PARTLY run live (2026-10-10 and 2026-10-11).**
      **Closed Oct 11 2026 after the live pass; unwatched checklist items listed in
      docs/M21-live-checklist.md.** That checklist says which items a person watched (15) and
      which nobody has (14). 1704 tests green and 66 skipped at `22f9efb`
      (the skips are the opt-in real-model evals).

      **What it closes.** M19 and M20 both found a chain creating a real issue at step 2 and
      only then discovering, at step 3, that it did not know the Slack channel — SEJ-7, SEJ-8,
      GitHub #4, and #5 when the channel was taught and the email filed again. That gap is
      closed **for references that resolve from memory**:
      - `sendMessage`'s channel check runs **before** its dialog, not after Send (`7233b96`).
      - Tools declare `referenceArgs`; the planner resolves only those, so a message body is
        never rewritten by memory (`a113949`). One rule decides "does this name something we
        know": `checkReference` (`453314f`).
      - `runChain` pre-flights every step's references after `validatePlan` and **before step
        1** — nothing read, created, announced or asked when one is unknown (`6429979`).
      - An unknown `sendMessage` channel makes the app **ask** (`OSShell.askUser`, `b61b90e`;
        the pre-flight ask, `ce269a0`) and remember the answer, then run. At most two
        questions per chain; no answer leaves the user at the old refusal.
      - Confirm button labels are per tool (`22f9efb`); issue links in the result bar are
        clickable (`bd57ea1`); a lone send formats **before** the dialog and sends exactly
        what was shown (`3320860`, `69b39cb`).

      **Six live findings, each with its cause and its fix.** All were found by a person at
      the keyboard, after the tests were green.

      1. **A dismissed question was followed by something that looked like a question and was
         not one.** *Cause:* the refused run was logged in the pre-flight's words ("teach me
         with: remember the bugs channel is…"), the next planning call was shown that row as
         the previous turn, and the model answered in prose with its own "what is the bugs
         channel?". The planner shows a prose reply as an ordinary result, so the instruction
         hotkey — correctly — opened a fresh bar over it. It was reported as the hotkey
         guard failing; the guard was never involved. *Fix:* that one kind of row is not shown
         to the next planning call (`6cd26e4`), and the prompt gained a narrow rule: an
         unrecognised "my…/the…" name goes into the plan as said and is never asked about
         (`f942693`). Measured with the refusal deliberately shown, 5 trials per cell
         (`tests/eval/unknownReference.eval.test.ts`):

         | Case | Before | After |
         |------|--------|-------|
         | Chain, pre-flight refusal as previous turn | 0/5 | 5/5 |
         | Lone send, the tool's own refusal as previous turn | 0/5 | 5/5 |
         | "file this bug in Linear and tell the social channel" | 5/5 | 5/5 |
         | "send these notes to the team" | 5/5 | 5/5 |
         | "move my meeting" still gets a clarifying question | 5/5 | 5/5 |
         | "schedule a meeting" still gets a clarifying question | 5/5 | 5/5 |

      2. **The dialog named a channel the message did not go to.** *Cause:* a Slack **app**
         webhook posts to the one channel it was created for and ignores the `channel` field;
         with "the bugs channel" taught as `#help`, the dialog said `#help` and the message
         landed in `#social`. *Fix:* the confirm, result and failure texts name only where
         the webhook really posts — its own channel when `SLACK_WEBHOOK_CHANNEL` says what
         that is, otherwise just "your Slack webhook" — and show the asked channel as a note
         (`836dae3`).
      3. **`SLACK_WEBHOOK_CHANNEL=#social` did nothing.** *Cause:* in `.env` an unquoted value
         starting with `#` is a comment, so it parsed as blank — on advice this repo gave.
         *Fix:* the quoted form is documented in `.env.example` and the README, and startup
         warns when the variable is present but blank (`cc688da`).
      4. **Slack received the formatter's own question.** A lone "send these notes to the bugs
         channel" with nothing useful to send posted "Please paste the rough notes you want
         formatted for the #bugs channel." — twice. *Cause:* the formatter ran in the handler,
         **after** the dialog, and the dialog showed a preview of the raw input or nothing at
         all. *Fix:* `Tool.prepare` runs once, before the tier and both gates, and its result
         is what the dialog, the handler and the log all use. For `sendMessage` it checks the
         channel **first** (so an unknown channel costs no model call), refuses when there is
         nothing to send, runs the formatter, and refuses a reply that asks for the notes.
         It has no side effects by construction: it is handed `PrepareDeps` — five keys
         (`context`, `instruction`, `llm`, a read-only `memory`, `chained`; `instruction` was
         added by the regression fix below) and no sender or shell. The handler never calls
         the model (`3320860`, `69b39cb`).
         **This fix caused a regression, found live the next day (2026-10-11):** `send
         "helluuu" to social channel` was refused with "what I was given to send wasn't
         notes". *Cause:* the fix formatted everything, including a message the user had
         given in the instruction, and the formatter's new `NO_NOTES` rule called a short
         greeting "nothing to tell anyone" (3 of 3 against the real model). *Fix:* **where the
         text came from decides whether it is formatted.** A message given in the instruction
         (`notes`) is sent as written — no model call, no judgement of what it says. Only
         clipboard text is formatted and has its formatter reply judged. `PrepareDeps` gained
         its fifth key, `instruction` (the user's words, read-only), so that `notes` which is
         merely the whole instruction echoed back (rows 417, 419) is recognised by comparison
         and treated as no notes. The planner side was measured and was never the problem
         (`tests/eval/quotedMessage.eval.test.ts`, 8 cases, 5/5 before and after).
      5. **"It may or may not have gone through" about a create that was never sent.**
         *Cause:* the session's first GitHub connection timed out while **connecting** —
         which happens in the confirm summary, before the dialog — and a connect timeout and
         a call timeout were worded alike. *Fix:* failures are phase-aware, decided by where
         the error is caught: connecting → "nothing was sent, safe to try again"; calling →
         the old warning (`2cb4a74`). Budgets: 30 s to connect, 20 s for `tools/list` and
         every call (`f9f9144`); worst case before a dialog, 50 s. "Connecting to
         <Connector>…" shows on the status line meanwhile. **A failed call is still never
         retried.**
      6. **Result links were plain text** (M20's Finding 1). *Fix:* `https` links to exactly
         `github.com` or `linear.app` are drawn as links; main re-validates before opening,
         and the bar's own window cannot be navigated (`bd57ea1`).

      **KNOWN GAPS — not fixed in M21, stated plainly.**
      - **A channel that comes from a `{stepN}` placeholder cannot be pre-checked.** It does
        not exist until that step has run; the step refuses it then, after earlier steps ran.
      - **"Known channel" means "resolves in memory" or "is a literal".** `#typo` is accepted,
        and an answer of `#typo` is remembered exactly as typed. Nothing checks a channel
        exists.
      - **A webhook failure after an irreversible step can still orphan an issue.** The
        pre-flight removes the *unknown-name* cause; a create that succeeds followed by a
        Slack post that fails still leaves an issue nobody was told about.
      - **Channel names only gain meaning with one webhook per channel** — the planned next
        milestone ("B"). Today `#help` exists in Slack, "the bugs channel" can be taught as
        `#help`, and the message still goes to `#social`, because one webhook posts to one
        channel. The texts are now honest about that; the behaviour is unchanged.
        *(Addressed by M22 — as a bot token, not one webhook per channel. See §6f.)*
      - **A prose reply from the model can still look like a question nothing is waiting
        on.** Fix 1 removes one trigger and the prompt rule a second; a prose reply is still
        displayed as an ordinary result.
      - **The question window stays on top of other apps** — by design (it must survive
        switching away to look something up, and cancels itself after 60 s) — so it can cover
        the very thing the user switched to look at.
      - **Connectors are not warmed at startup.** The first connector use of a session pays
        the whole cold connect before its dialog can appear.
      - **A late answer after a timeout is invisible.** If a server answers after the app gave
        up, nothing is shown or logged; for a create that is the "may or may not" case.
      - **Esc-to-stop-speaking cancels a pending confirm** (M19 follow-up, still open).
      - **A remembered channel is shown as it was typed** — "help", without the "#", when
        that is what was answered.

      **What was learned** is in `CLAUDE.md` ("M21"): seven rules, each from one of the
      findings above.
- [x] **M22 — Slack bot-token mode: a message goes to the channel you name, and a new channel
      needs no setup.** **Closed 2026-10-13 after a live run by a person** —
      `docs/m22-live-checklist.md` says what was watched (steps 1–9 and 11, the offline-model
      message, a #help regression check), what is covered by script or test only (10.1 simulated,
      10.2, 12.1/12.2, 13.1) and the live findings. 2206 tests green across 95 files, 75
      skipped (the opt-in real-model evals).

      **Open limits, carried deliberately** (full list in §6f):
      - "our help channel" is treated as a literal name, not a phrase.
      - A channel created less than about 5 s ago can be refused until the next refresh.
      - A post failure after an irreversible step in a chain can still orphan an issue (the
        channel is checked before step 1; the post itself can still fail or time out).
      - The webhook fetch has no timeout (webhook mode only). *Addressed in M23-pre: a 10 s
        timeout, same failure text.*
      - The 429 and 500 shapes from Slack were never captured live. *M23-pre: still true; now
        handled by tests built from Slack's documentation.*
      - An offline or failed model call is reported in the bar but writes no action-log row.
        *Addressed in M23-pre: it now leaves an `error` row with the fixed text.*

      **What changed.** With `SLACK_BOT_TOKEN` set, the app posts with a bot token instead of
      the webhook, to the channel ID Slack's own channel list gives for the name asked for. A
      name Slack does not have is refused before any dialog, with similar channels; a Slack
      that cannot be asked refuses rather than guesses; a chain is checked before step 1, and a
      channel taken from an earlier step is refused there. "the help channel" finds `#help` in
      Slack on a memory miss without saving it; answers and `remember` channel facts are checked
      in Slack and saved as `#name`. Every failure of a post says whether it may have gone
      through, and a post is never retried. Webhook mode is M21, unchanged. Full description,
      setup and known limits: **§6f**.

      **How it was built** (six prompts): recon (`scripts/slack-recon.mjs`, read-only) before
      any fixture; the directory and a scripted Slack; the bot sender, mode selection and a fix
      for two old places that put `error.message` in front of the user; bot-mode wording in
      `sendMessage`; the pre-flight, ask flow, `remember` and "the X channel"; then wording and
      docs. A mutation pass after each code prompt; every surviving mutation got a test.
- [x] **M23 — background jobs, a status pill and a needs-you chime.** **Closed 2026-10-22,
      after a live run by a person (12 boxes ticked, 30 open — `docs/M23-live-checklist.md`),
      with named gaps.** Scope is §2's M23 entry; the design is §5c. The close-out record, with
      the gaps it is closed with, is at the end of this entry.

      **Build order** (agreed 2026-10-13; everything agreed after the first plan is folded in
      here, per CLAUDE.md "Scope added mid-milestone"):
      0. This entry, §2 and §5b amended; one running instance (`requestSingleInstanceLock`,
         the decision tested behind a fake app object).
      0b. Two recon scripts **before any fixture**: a click on the non-focusable pill bringing
         a native dialog to the front, and the chime playing from the hidden bar window.
      1. Job model, `JobManager` state machine, SQLite job store. `action_log.job_id` added by
         a guarded migration (column checked first; tested on a copy of a real `memory.db` and
         on a fresh one). `getLast()` ignores rows a detached job wrote.
      2. Per-job chain state; attached / detached; the hotkey guards block only on an attached
         job mid foreground-only step, an open dialog or an open question, and otherwise detach.
      3. Context captured at submission (clipboard + the email-open flag), in memory only,
         never re-read and never persisted.
      4. `Tool.background: "ok" | "foreground-only"`, required, no default; the two pause
         reasons (a confirm, a foreground-only tool) for a detached job.
      5. Confirm broker: a queue that replaces the shell's `confirmPending` boolean, one dialog
         at a time, 30-minute expiry checked when the pill is clicked, the pause taken
         **before** `confirmSummary` so the summary and tier are computed when the dialog opens.
         A detached confirm is not parented to the bar, does not hide it, does not end a
         capture or a question, and does not stop speech.
      6. `jobStatus` and its templated answer; status runs never appear in the pill or in
         their own answer; planning happens outside the cap.
      7. Pill window, pure state reducer, pure position function, list UI (open dialog / cancel
         / mute), a pulse on entering needs-you then steady amber. A detached job writes only
         to its job record — never the bar, the result popup, `pointTarget`, the draft or
         speech stores, or the speaker.
      8. The chime: a pure `shouldChime`, its own `chime:play` channel and `Audio` element,
         mute persisted in a `settings(key, value)` table.
      9. Restart: `running` / `needs-you` → `interrupted`, never resumed; a step-started marker
         written before each handler so an interrupted job can say "may have gone through" or
         "nothing was sent".
      10. The `jobStatus` routing eval against the real model (asked for: ~20 phrasings × 3
          trials, once), a headless three-job simulation, then `/milestone-closeout`.

      **Built (2026-10-13): every item above.** The full mutation pass and the live checklist
      followed at close-out (2026-10-21/22) — see the close-out record at the end of this entry.

      **What the three recon scripts measured** (this machine, Electron 33, 1920×1080 at 150%,
      2026-10-13) — each run *before* the code that depends on it:

      | Script | Question | Measured |
      |---|---|---|
      | `scripts/pill-click-recon.cjs` | does a real click reach a `focusable: false` window? | yes; the page received it |
      | | does that click take focus or the foreground? | no — `pillFocused=false`, foreground not ours, bar got 0 `hide` / 0 `blur` |
      | | dialog **parented to the pill**, bar hidden | on top 9/9, topmost, foreground; bar 0 hide / 0 blur |
      | | dialog **parented to the pill**, bar on screen | on top 9/9, topmost, foreground; bar still visible, 0 hide / 0 blur |
      | | dialog **unparented**, bar on screen | **0/9 — fully covered by the bar**, not topmost (M19's finding again) |
      | `scripts/chime-recon.cjs` | does an `Audio` play and end in a window never shown? | yes — `ended`, `currentTime` 0.42 of 0.42 s (first play ~990 ms to `ended`: device warm-up) |
      | | do two elements overlap without cutting each other off? | yes, both `ended` |
      | | does pausing one leave the other playing? | yes |
      | `scripts/pill-render-recon.cjs` | the BUILT page in a real window: bridge, drawing, real clicks | `window.pill` present and `window.api` absent; three rows and their buttons drawn; a real click on "Review…" reached main as `pill:action(job-review, review)`, on mute as `pill:mute(true)`, on the pill as `pill:expand(true)`; the window never took focus |

      That is why a detached dialog is parented to the pill (`WindowsShell.presentConfirm`),
      and why the chime has an `Audio` element of its own.

      **What those scripts cannot say**, and so is not claimed: that the chime was *audible*
      (only that Chromium's pipeline ran to `ended`); what a human click does where the
      scripts used a synthetic one from a child process — in particular that the dialog gets
      *keyboard* focus; anything on a second monitor or at a scale other than 150%; and the
      whole app end to end, which has not been started with this code at all.

      **`scripts/job-migration-check.mjs`**, run against a *copy* of this machine's real
      `memory.db` (503 action-log rows, 18 facts, the seven-column pre-M23 table): both
      columns added, every column and row kept, all existing rows NULL in both, `getLast()`
      unchanged, a second start a no-op, and a stamped row and a job row written and read
      back. The original file was not opened for writing.

      **An independent review of the diff** (a fresh agent, findings only, 2026-10-13) passed
      the tags, the SQL filter, the migration guard, the step-started marker and the absence
      of any leftover `confirmPending` boolean, and found four real faults, all fixed with a
      test each:
      - a detached dialog with no pill window opened **unparented** → now refused, no dialog;
      - a connector's "Connecting to Linear…" line was written to the bar by whichever job
        opened the connection, detached or not → shown only when the job that has the bar is
        itself on a connector tool (`main/jobs/connectingNotice.ts`);
      - cancelling a job whose dialog was already open or queued did not withdraw it, and
        pressing its approve button ran the handler → the answer is discarded;
      - a result landing in a visible, unfocused bar during another job's detached dialog was
        never auto-hidden → it is; and the hotkey's "a confirmation is waiting" line no longer
        pops the bar up after that dialog closes.

      **Found by the review and NOT fixed — open limits:**
      - `pointAt`'s target window is one app-wide value set at each hotkey press, not captured
        per job. A `pointAt` job detached during planning and later resumed from the pill reads
        the window of the most recent press, not its own. The one-slot `DraftStore` has the
        same shape for a resumed `reviseDraft` / `sendReply`.
      - While any dialog is open, an attached job's `askUser` is told "could not be asked".
      - Resuming a job that waits on a **confirm** is not held back while the user is typing
        or recording: the dialog opens and takes the keyboard for its duration (the bar and
        the capture are left intact).
      - `MockShell.isForegroundFree` knows only dialogs and questions, not captures or
        recordings, so the "busy" resume rule is tested against the real shell's own unit test
        and not end to end.

      **Found live after the build and NOT fixed — open limit** (measured 2026-10-21, decided
      not to build):
      - **The user's own app does not get the keyboard back after a detached dialog.** When the
        dialog closes while the user is in another app, Windows leaves the foreground on the
        pill (the dialog's owner, which cannot take focus or type), and the user has to click
        back into their app. (When the *bar* was focused it does get it back — §5c.)
      - Measured on this machine, real windows: the only approach that worked was a **new
        helper process started after the dialog closes**, 5 of 5. It needs ~0.5 s to start,
        and keys typed in that time go to the pill and are lost. `SetForegroundWindow` from the
        existing input helper failed; so did the same with `AttachThreadInput`, from a helper
        started when the dialog opens, and Electron's `pill.blur()` (which handed the
        foreground to the taskbar).
      - Not shown, and so not claimed: that a check run before the restore would reliably leave
        alone a window the user switched to during the dialog (a helper started with a third
        window in front still succeeded, so the OS's foreground lock is no guard); elevated
        windows were not tested; `ForegroundLockTimeout` on this machine is at its maximum
        (2147483647), so a machine with the default may behave differently.
      - Revisit only if it proves annoying in daily use.

      **Tests at the end of the build** (2026-10-13): **2488 passed across 112 files, 95
      skipped** (the opt-in real-model evals, 20 of them new), typecheck clean on both configs.
      It was 2242 across 98 at the commit before. Run as plain `npm test`, with the app closed
      and `better-sqlite3` rebuilt for node by its own `pretest`. (During the build the suite
      was run against a separately installed node build of the same SQLite version, because a
      running `npm run dev` held the project's binary open; the figures agree.)

      New files: `tests/jobManager.test.ts` (the state machine, expiry on a fake clock, the
      cap), `tests/jobs.run.test.ts` (real planners as jobs: interleaved chains, the snapshot,
      expired / cancelled pauses with handler spies, addition A), `tests/jobs.hotkey.test.ts`,
      `tests/jobs.simulation.test.ts` (three concurrent jobs end to end),
      `tests/jobStore.test.ts` (the migration, `getLast()`, restart, settings),
      `tests/confirmBroker.test.ts`, `tests/pill.test.ts` (reducer, position, a fake
      `BrowserWindow`, the controller), `tests/chime.test.ts`, `tests/statusAnswer.test.ts`,
      `tests/background.test.ts`, `tests/singleInstance.test.ts`, `tests/connectingNotice.test.ts`,
      `src/renderer/pill/render.test.ts` (jsdom), plus a detached-confirm block in
      `tests/WindowsShell.capture.test.ts`.

      **Fixed after the build — an attached job killed mid-step** (live finding, 2026-10-21). A
      job that never left the bar and was killed with the app showed nowhere after a restart.
      `markInterrupted` now also makes a job `background` when its write-ahead step marker is
      set (§5c); one cut off while planning or at its confirm is recorded as interrupted and
      not shown. **Known limit, not fixed:** the marker is set around EVERY handler, read-only
      ones included, so an app closed during `readEmail` or a long summary shows "may or may not
      have gone through" for a step that could not have sent anything — the same false alarm a
      detached job already has. Fixing it would need the step's risk tier recorded when the
      marker is set. Revisit only if it proves annoying in daily use.

      **Fixed after the build — the provider's parallel wrapper as a plan step** (live finding,
      2026-10-22, gpt-5-mini at low effort). "summarize this and send to fun then create a issue
      of body in linear and write in notion" (four actions) came back as one plan,
      `["functions.summarize", "multi_tool_use.parallel"]`, and was refused as an unknown tool.
      Now a lone call or a plan step named exactly `multi_tool_use.parallel` is the multi-call
      case: asked once more with the fixed `PLAN_RETRY_INSTRUCTION`, then refused by
      `refuseMultiple` (names logged, never `logMiss` — a top-level wrapper used to reach it).
      Never unwrapped. Any other unknown name is refused as before, with no retry. When BOTH
      answers were the wrapper (the model was packing actions to fit the cap), the refusal uses
      the over-cap wording below rather than the multi-call one; a genuine multi-call answer,
      either time, keeps the multi-call wording (changed 2026-10-22 after the live trials). A plan that
      ran only after that retry adds "I planned N steps. If you asked for more, say the rest
      after." to its preview, said as its own utterance — the only sign of an action dropped to
      fit the cap. A plan over the cap now says "That's more than 3 steps. Say the first three,
      then the rest." (by step count alone; the instruction's words are not counted). **Not
      changed, deliberately:** the `plan` tool's "At most 3 steps" — a prompt change needs an
      eval; revisit if dropped actions show up in daily use. Mutations, each caught: no
      plan-step check (7 tests), no top-level check (6), a loose match (5), retry on any
      unknown name (2), second answer unchecked (5), note always shown (3), never shown (1),
      note merged into the plan's speech (1), cap off by one (6).

      **The `jobStatus` routing eval, against the real model** (asked for; run ONCE,
      2026-10-13; `tests/eval/jobStatus.eval.test.ts`, `M23_STATUS_EVAL=1`). Provider
      `openai` (`gpt-5`), 20 phrasings × 3 trials = 60 `chooseTool` calls, the full menu with
      `jobs: true`, context taken through `captureContext` with a fixed clipboard of unrelated
      standup notes, no email open, no previous turn. **60 of 60.**

      | | Phrasing | Chosen (3 trials) |
      |---|---|---|
      | 3/3 | are my agents done yet | jobStatus ×3 |
      | 3/3 | what's running | jobStatus ×3 |
      | 3/3 | anything waiting on me | jobStatus ×3 |
      | 3/3 | are my jobs done | jobStatus ×3 |
      | 3/3 | did that finish | jobStatus ×3 |
      | 3/3 | how are my background jobs doing | jobStatus ×3 |
      | 3/3 | is anything still running in the background | jobStatus ×3 |
      | 3/3 | what's the status of my agents | jobStatus ×3 |
      | 3/3 | do any of my jobs need me | jobStatus ×3 |
      | 3/3 | have my agents finished | jobStatus ×3 |
      | 3/3 | what are my agents up to | jobStatus ×3 |
      | 3/3 | is there anything I need to approve | jobStatus ×3 |
      | 3/3 | *near miss:* tell the team the agents are done | sendMessage ×3 |
      | 3/3 | *near miss:* post "the background jobs are finished" in the bugs channel | sendMessage ×3 |
      | 3/3 | *near miss:* start an agent to check Gmail | no tool ×3 |
      | 3/3 | *near miss:* run a job that summarizes this | summarize ×3 |
      | 3/3 | *near miss:* remember that the agents finish by five | remember ×3 |
      | 3/3 | *near miss:* what do you remember about my agents | recall ×3 |
      | 3/3 | *near miss:* what's on my calendar today | readSchedule ×3 |
      | 3/3 | *near miss:* is the build done? ask in the team channel | sendMessage ×3 |

      Positives 36/36, near-miss negatives 24/24. **What this does not show**: Anthropic was
      not run; one clipboard and no previous turn were used, and a previous turn that is
      itself a job-status answer (or a long clipboard that talks about agents) may move it;
      "did that finish" with a foreground action as the previous turn is the phrasing most
      likely to be about something else, and that was not measured.

      **A first, partial mutation pass** (nine rules, Edit tool, one at a time; the full pass
      is still owed at close-out):

      | Rule broken | Caught by |
      |---|---|
      | planner carries on after an expired / cancelled confirm wait | first run: 1 test, and only by the row's status — the handler-never-called tests passed, because the job shell's "no permit, no dialog" rule caught it behind them. Tests strengthened (the summary must not be BUILT; the row's status and wording); then 3 |
      | planner runs a step the gate refused to enter | 2 (the foreground-only expiry test, the simulation) |
      | confirm queue shows a second dialog over the first | 4, across the queue, MockShell, WindowsShell and two real jobs |
      | a detached job's result goes to the bar | 4 |
      | a detached job speaks | 2 |
      | a detached dialog is presented like an attached one | 5 |
      | a detached dialog stops speech / restores the bar | 1 |
      | `getLast()` stops skipping detached rows | 2 |
      | an "attached" permit honoured after a detach | **survived** — the check was unreachable (a job holding that permit cannot be detached, which is tested), so the line was removed rather than left as a rule nothing can exercise |

      **Also after the build — the pill's event log** (8c5ba4f, 2026-10-14): one console line
      per pill event, with its reason, after a live report nothing had recorded; and each job
      state's time in the pill, with `seen_at` saved with the job (§5c, "How long a job stays").

      **CLOSE-OUT RECORD (2026-10-21/22). CLOSED 2026-10-22, with these gaps:** 0.4 with real
      Linear, §10 (M21's two Linear items), 5.2 and 9.2 not run; the 30-minute expiry, a second
      monitor or another display scale, and the `checkUnreadContent` refusal path not watched;
      and the open limits recorded in this entry — the foreground not returned to the user's own
      app after a detached dialog, the read-only false alarm on a restart, a spoken result over
      15 s, and the `plan` tool's "At most 3 steps" left unchanged.

      **Tests:** **2824 passed across 124 files, 95 skipped** (the opt-in real-model evals),
      plain `npm test` with the app closed and the native build rebuilt for node by `pretest`;
      typecheck clean on both configs. **Eval:** the wrapper phrase, 3 trials on gpt-5-mini
      low, run by the user through the spend gate (`wrapper-trials.mjs`, 6 calls, ~$0.015);
      nothing else against the real model at close-out.

      **The full mutation pass** (2026-10-22, Edit tool, one rule at a time, focused suites, each
      reverted; no survivors). With the first pass above and the fixes after the build, every
      rule M23 added has been broken at least once:

      | Rule broken | Tests that failed |
      |---|---|
      | the cap lets a fourth job run | 6 |
      | the 30-minute expiry never fires | 8 |
      | a foreground-only resume ignores "the foreground is not free" | 2 |
      | a job holding the foreground is detached anyway | 2 |
      | the hotkey guard (`attachedBlocks`) never blocks | 5 |
      | status runs listed in `views()` | 1 (the pill's own filter also holds it) |
      | a yes for a job cancelled during its dialog is honoured | 2 |
      | context re-read at planning instead of captured at submission | 1 (the snapshot test) |
      | interrupted mid-step loses "may or may not have gone through" | 6 |
      | interrupted while planning loses "nothing was run" | 3 |
      | the SQLite store reloads dismissed jobs | 1 |
      | old unseen failures are not reloaded | 1 |
      | the migration adds a column without looking first | 8 |
      | a done job never fades | 4 |
      | a cancelled job is shown | 4 |
      | failed/expired: no hour after being seen | 11 |
      | an interrupted job is hidden | 3 |
      | a waiting job can fall off the ten-row list | 1 |
      | the pulse repeats on every re-send | 1 |
      | the pulse outlives the wait | 1 |
      | an emptied list is not closed | 3 |
      | a job starting to wait opens the list | 10 |
      | `pillBounds` drops the margin | 8 |
      | the chime ignores busy | 8 |
      | the chime ignores mute | 4 |
      | no two-second coalescing | 5 |
      | mute not read at startup | 1 |
      | "Connecting to…" shown for any job | 3 |
      | a second instance carries on | 1 |
      | a multi-call answer refused without the one retry | 30 |
      | *fixes after the build:* the keyboard after a detached dialog | 3 (restore regardless; after every dialog; caret not moved) |
      | `predev` and the stamp | 3 (skip whenever locked; any error is a lock; always clear) |
      | an attached job killed mid-step | 3 (in-memory flip, SQLite flip, flip regardless) |
      | the parallel wrapper and the cap wording | 9, then 2 more for 76ad0c3 (always generic: 4; always cap: 5) |
      | the "confirmation waiting" line | 2 (never clear: 7; clear everything: 4) |

      Single-test rules, worth knowing: the status-run filter, the snapshot, the SQLite reload
      rules, the ten-row cap, both pulse rules, mute at startup, and the second instance.

      **Before the live pass, everything scriptable was run against the real app**
      (2026-10-21/22): real hotkeys, real clicks on the pill, real keys into the app's own
      dialogs; a scratch `--user-data-dir` per instance; a fake OpenAI server and a fake Slack
      webhook injected through the child's environment (`OPENAI_BASE_URL`, `SLACK_WEBHOOK_URL`);
      Linear, GitHub, Calendar and Chrome off — Linear and GitHub cannot be faked without a code
      change (their URLs are fixed in `core/mcp/connectors/`). It covered §0–§8 of the checklist
      and the screen-capture exclusion; per-box results are in the checklist.

      **Live (2026-10-22, by a person; `docs/M23-live-checklist.md`, 12 ticked, 30 open).**
      *Watched:* Review… keeps a half-typed instruction and gives the keyboard back; dialogs with
      the mouse, a normal confirm and Review…; the chime heard (volume fine) and held back during
      dictation; "are my agents done yet?" against the pill; kills mid-step (with "may or may
      not have gone through") and while planning (shown nowhere); a failed job still red after a
      restart; a second `npm run dev` saying "I'm already running"; the hotkey blocked during a
      slow foreground step; the stale-line fix re-watched. The Gmail → Linear → Slack chain
      reached its Linear dialog (not approved). *Covered by script or test only:* 25 boxes,
      including mid-send kills, the cap, mute across a restart, the list's closing rules, both
      focus cases and the queued-dialog cancel. *Not run:* 0.4 with real Linear, §10 (M21's two
      Linear items), 5.2, 9.2 (the "I planned N steps" note was never produced by the real
      model), the 30-minute expiry, a second monitor or another scale, and the
      `checkUnreadContent` refusal path.

      **Findings.** (1) A stale "There's a confirmation waiting" line after a detached dialog
      closed in an open bar — **fixed in 515b0a6**, re-watched: pass. (2) A long spoken result
      ends early — **open limit below, out of M23**. (3) The wrapper, live: the wrapper both
      times in 2 trials of 3, then a 4-step plan in the third; nothing ran, nothing was dropped;
      **76ad0c3** now gives the wrapper-twice case the over-cap sentence. **The retry text did
      not move gpt-5-mini low in 2 of 3 — revisit only with an eval; not changed.** (4) Three
      checklist wordings (2.8, 2.9, 4.2) were wrong, and are corrected.

      **Open limit, found at close-out and NOT fixed (out of M23): a spoken result longer than
      15 s is treated as finished at 15 s.** `WindowsShell.play` waits for the renderer's
      `speech:ended` under `RENDERER_REPLY_TIMEOUT_MS` (15 s), a bound meant for a reply, not for
      playback. Measured twice in the real app: an utterance of 15 831 ms; at 15.0 s the shell
      logged `[WindowsShell] playback did not report back: The recorder didn't respond.` (the
      message also names the wrong device), `isSpeaking()` went false, and a held needs-you
      chime played **733 ms before the speech ended** (the first run: 15.4 s, 335 ms early).
      Shorter results (13.8 s measured) are unaffected. Not measured: a second queued
      utterance would presumably start over the end of the first, since the player stops
      whatever is playing. Pre-dates M23 (M14's timeout); M23's chime is what exposes it.
      **Fixed in M24** (below): the M24 repro measured the second case too — the next utterance
      does not start over the first, it *stops* it.
- [x] **M24 — speech longer than 15 s plays to its end.** **Closed 2026-10-22, after a live run
      by a person and a loopback-recorded scripted run (3 boxes ticked, 11 open —
      `docs/M24-live-checklist.md`), with named gaps.** Agreed as the fix for M23's open limit.
      The close-out record is at the end of this entry. Three separate changes, each its own
      commit:

      1. **Playback waits as long as the clip lasts** (§4d). Root cause, found before any code
         was changed: `WindowsShell.play()` waited for `speech:ended` under M7's 15 s
         renderer-*reply* bound, reused in M14. That bound did not cut audio itself — what cut it
         was the next utterance, whose `speech:play` makes the player stop whatever is playing.
         The wait is now the clip's length from its WAV header + `PLAYBACK_GRACE_MS` (5 s), with
         an estimate and a 120 s ceiling as fallbacks (`src/main/shell/playbackLimit.ts`); each
         clip is numbered so a late report cannot end the next clip's wait; a crash or a closed
         window ends the wait at once. Found with it, from the same timer: `SpeechPlayer.stop()`
         never settled its `play()`, so after every barge-in main waited the full 15 s with
         nothing playing, and a reply queued in that time (a confirm's "Sent.") could be dropped
         as stale; and the preload sent `speechEnded`'s error where main never read it, so no
         playback failure was ever logged. Real Piper: a 585-character `elaborate` remainder is
         37.4 s of audio and gets a 42.4 s limit (`tests/piperPlaybackLimit.live.test.ts`,
         opt-in).
      2. **The staleness rule counts waiting, not listening** (§4d). With clips playing to the
         end, anything queued more than 8 s before a long clip finished was dropped. Time behind
         a playing clip no longer ages an utterance; a synthesis backlog still does; the 8 s
         value and the 8-item cap are unchanged.
      3. **A blocked microphone is reported.** The same argument-order bug on the recorder:
         `voiceStarted(error)` put the error in the payload slot, so a denied microphone was
         taken as started and the bar showed itself recording with nothing listening. Now
         `(null, error)`, the shape `sendAudio` already used; both voice paths go back to idle
         with "Couldn't start recording: …".

      **Tests:** 46 new (2824 → 2870, 124 → 127 files, plus one opt-in file):
      `playbackLimit.test.ts` (15), `speechPlayback.test.ts` (26 — the real shell, queue, player
      and preload `api` against a fake speaker on a fake clock, including every barge-in gesture,
      a stalled and a crashed renderer, and a job's long answer followed by a 39 s "read the
      rest"), `SpeechSession.test.ts` (+2), `micBlocked.test.ts` (3). Two existing tests in
      `WindowsShell.capture.test.ts` were re-justified: one asserted the old 15 s release.

      **Mutation pass** (each made and undone with the Edit tool): the fixed 15 s bound put back
      (9 tests failed); `stop()` not settling `play()` (8); `speechEnded`'s order swapped back
      (13; dropping only the error, 1); no grace (14); no clip-id check (2); no crash handler (1);
      no window-closed handler (1); no AbortError guard (1); the old age calculation (9); no
      staleness at all (5); `voiceStarted`'s order swapped back (2). One survivor was found and
      fixed: a stalled-renderer test used a 10 s clip, whose 10 s + 5 s grace equals the old 15 s
      bound, so it passed with the bound restored.

      **Known limits:** the grace and the ceiling are reasoned, not measured (nothing has timed
      `speech:play` to sound on a real device); the dictation hotkey's own `speech.stop()` lives
      in `main.ts` and has no test that could fail (the microphone-opening path that also stops
      speech is tested); a renderer reload mid-clip is neither a crash nor a report, so it waits
      out the clip's limit.

      **Close-out record (2026-10-22).** `npm test`: 2870 passed across 127 files, 96 skipped (the
      opt-in real-model evals and the opt-in real-Piper check); both typechecks clean. Eval
      skipped (not run against the real model).

      **Live, by a person (3 ticked):** a "read the rest" over 30 s heard to its last sentence
      (1.1); a long answer interrupted with the hotkey and a short question answered out loud
      (3.2); the blocked microphone on the instruction hotkey (5.1). **By script only (9, open):**
      the real app (dev build, real Piper, a scratch profile, a fake model and Slack webhook on
      localhost) driven over CDP, SendInput and UI Automation, with what reached the speakers
      recorded by WASAPI loopback — auto-hide mid-clip, the capped answer, the chime after the
      last speech sample (410 ms gap), a narration queued 15.9 s before a clip's end said after
      it, Escape / dictation hotkey silence within 0.1 s, a confirm answered mid-question, a
      renderer reload's single timeout line at exactly clip + 5 s, and the dictation hotkey with
      the microphone denied (1.2, 1.3, 2.1, 2.2, 3.1, 3.3, 3.4, 4.2, 5.2). **Not run (2):** 2.3
      (optional), 4.1 (needs the output device disabled).

      **Findings** (none a regression of M24; all four are M25): "read the rest" after a short
      answer said nothing more (`say()` cleared the slot — M14.4's rule); Escape while
      "Thinking…" did not stop the instruction, and Escape during transcription did not discard
      it; a job reached the pill after one Escape: most likely an earlier run was still thinking
      when the hotkey was pressed (hotkey detaches by design); not reproduced with Escape alone;
      the M25 log lines will confirm live;
      "what's the time" got a long answer (no time tool).
- [x] **M25 — three live findings from M24, and what Escape and an outside click do to a running
      instruction.** **Closed 2026-10-22, after a live run by a person and a loopback-recorded
      scripted run (4 boxes ticked, 15 open — `docs/M25-live-checklist.md`), with named gaps and
      one finding, investigated and decided for M26.** The close-out record is at the end of this
      entry. Each
      finding was investigated without code changes first (a scripted repro on the real planner,
      job runner and shell). Build order, one commit each, each diff approved first:

      1. **"Read the rest" survives a short answer in between** (§6, `elaborate`). Root cause:
         `Planner.say()` cleared the remainder on every answer that held nothing back. Now it is
         kept and marked, and read out after *"From the earlier answer:"*. Tests:
         `readTheRest.test.ts` (3, the live sequence through the real job runner),
         `speechTools.test.ts` (+5), and two re-justified (`plannerSpeech.test.ts`, whose old
         "clears a stale remainder" pinned the rule being changed; `jobs.run.test.ts`, which now
         also checks a detached job does not mark the slot). Mutations: `clear()` put back (2
         tests failed); no lead-in (2); `passOver` marks nothing (4); a detached job's
         `passOver` reaches the slot (1); a new `hold` inherits the mark (1).
      2. **A short, exact time and date answer** (§5c, `tellTime`). Root cause: there was no
         time tool, so the model answered in its own words through the no-tool path (logged as a
         miss). `tellTime` answers "It's 2:51 PM." or "It's Thursday, 22 October." from the clock.
         Tests: `tellTime.test.ts` (17: literal expectations in two zones across midnight and
         noon, the spoken form, a planner run logged as `ok`), and two approval lists in
         `background.test.ts` widened on purpose (re-justified: a status-only tool must be on the
         approved list and `safe`). Mutations: 24-hour output (6 failed); the date added to the
         time answer (7); the zone ignored (6); `statusOnly` dropped (1); Intl's whole formatted
         string used — **survived at first**, because this node's ICU (78) puts a plain space
         before "PM"; the parts source was made injectable and a test now hands in U+202F and a
         lowercase "pm" (1). Not run: a real-model eval of the routing (only when asked).
      3. **Detach triggers and three log lines** (addendum B). A live run found a job in the
         pill and nothing in the log to say how it got there. `JobManager.detachAttached()` now
         takes the trigger — `hotkey`, `dictation`, `outside-click`, `submit` or `escape` (a
         restore at startup is not one: it relabels jobs that were live as interrupted and detaches
         nothing) — and the "detached" change carries it. The trigger word is decided by the
         handler that accepted the press (`instructionHotkey.ts`, `dictate.ts`) or by `submit()`,
         never by `main.ts`. Three lines, no more:
         `[main] job <id> detached by <trigger> ("<first 40 chars>", <state>, step <n>/<total>)`
         (`JobRunner`), `[main] instruction hotkey accepted`, `[dictate] hotkey accepted` (each
         only after the handler's own guards — an ignored press already logs why). Tests:
         `detachLog.test.ts` (7). Mutations: the wrong trigger at the instruction hotkey (1
         failed) and at the dictation hotkey (1); `submit()` naming another trigger (1); the
         line without its trigger (3); "accepted" logged before the guards (1).
         **Known gap (addendum C, deliberately not fixed):** a second instruction-hotkey press
         while a voice recording or transcription is in progress is not blocked, and detaches
         the attached job.
      4. **Escape on a running instruction** (§5c, "Attached and detached"). Root cause: Escape
         only hid the bar — nothing told the job. Now it cancels a job that has not entered a
         step (silently), detaches one that has (trigger `escape`), and leaves alone one holding
         the foreground; and (E5) `VoiceSession.finish()` returns nothing if Escape came while
         whisper was transcribing. Tests: `escapeJob.test.ts` (6, through the real Escape key,
         planner, job runner and voice session — the investigation's repro promoted),
         `jobManager.test.ts` (+5 for `escapeAttached`). Mutations: cancelling even after a step
         started (2 failed); cancelling without silencing it (2); the E5 re-check removed (1);
         the Escape key not telling the jobs (3). One survivor, and it was dead code: an
         explicit "holds the foreground" check — a job only holds the foreground after it has
         started, and `detachAttached` already refuses it; the check was removed.
      5. **An outside click on a thinking bar detaches its job** (addendum A; §5c, next to the
         Escape rule). Decided: "outside click" is any focus loss to another window the app did
         not cause, Alt+Tab included; while recording the bar stays pinned, as before. Recon
         first (`scripts/blur-recon.cjs`, real windows): the app's own hide blurs AFTER the
         hide with the window invisible — so a flag around `hide()`, as planned, would never
         have been set, and visibility is the test instead; a message box blurs its window
         while it is still visible — so the confirm-pending guard is load-bearing. Tests:
         `outsideClick.test.ts` (7: the five agreed cases, speech untouched, typing). Mutations:
         every blur treated as an outside click (5 failed, the Escape test among them, as
         required); the visibility check dropped (1, the Escape test); the hook before the
         confirm guard (2, the dialog test among them); the open-capture check dropped (1).

      **Close-out record (2026-10-22).** `npm test`: 2922 passed across 132 files, 96 skipped
      (the opt-in real-model evals and real-Piper check); both typechecks clean. The suite ran
      before each of the five commits (2878, 2896, 2903, 2914, 2922). Eval skipped (not run
      against the real model) — so whether the real model routes "what's the time" to `tellTime`
      rests on the person's 2.1, not on an eval. The mutation pass is recorded per change above:
      every mutation was caught except two, both resolved — T3 (Intl's whole string; the parts
      source made injectable and a test added) and F5 (a dead check, removed).

      **Live, by a person (4 ticked):** "read the rest" after a short answer, with the lead-in
      (1.1); the short time answer (2.1); Escape while thinking — silent, no pill row (4.1); an
      outside click while thinking — the job in the pill, silent (5.1). **By script (3, open):**
      the real app on HEAD, a fake model and Slack webhook, what reached the speakers recorded by
      WASAPI loopback and transcribed by the app's own whisper — a dangerous instruction Escaped
      while thinking never opened a dialog (4.2), focus moved away by SetForegroundWindow detached
      the job (5.2, in part), and speech playing at an outside click played to its end (5.5).
      **By tests only (12, open):** 1.2, 1.3, 2.2, 2.3, 3.1–3.3, 4.3, 4.4, 5.3, 5.4, 5.6.

      **Finding, investigation complete:** a done job disappears from the pill after about 10 s.
      Cause: M23's deliberate 8 s fade (§5c, `DONE_FADE_MS`) plus the pill's 1 s re-check. It
      matters now because M25's outside click detaches jobs whose result is the point, and a done
      detached job's result is stored (job record, action log) but unreadable once the pill
      clears. **Fix decided: M26 — keep a done job in the pill until it has been seen.** Not
      fixed in M25.

      **Known gaps:** a second instruction-hotkey press during a recording or transcription is
      not blocked and detaches the attached job (addendum C); any focus loss counts as an
      outside click while a job is thinking; the renderer's own Escape fallback still only hides
      the bar.

- [x] **M26 — a finished background job stays in the pill until it has been seen.** **Closed
      2026-10-22, after a live run by a person (3 boxes ticked, 0 open —
      `docs/M26-live-checklist.md`), with named gaps and three live findings planned for M27.**
      The close-out record is at the end of this entry. M25's
      finding (option A): a done detached job left the pill after 8 s (`DONE_FADE_MS`, M23) plus
      the 1 s re-check, and its result could not be read after that. One commit.

      **The rule (§5c, "How long a job stays").** A done background job stays in the pill —
      green, "N done" — until its list has been opened with that job in it, then one minute more
      (`DONE_SEEN_CLEAR_MS` in `core/jobs/pill.ts`, named and tunable). It reuses the `seenAt` /
      `seen_at` mechanism failed and expired jobs already use, unchanged: `PillController` already
      marked every listed row with a Dismiss button seen, done rows included, so no new marking
      code. Dismiss clears it at once. The row shows the result as before (up to 420 characters).
      Nothing new is spoken and no chime plays (`chime.ts` comment updated). A done job that
      finished in the bar was never background and never appears. The 1 s re-check is kept: it
      is what notices the minute is up. `DONE_FADE_MS` is removed.

      **Restart.** A done job nobody has seen is brought back after a restart however old it is
      (`JobStore.loadUnacknowledged`, both stores — as failed jobs already were). Until M26 a
      done job was restored only inside the 24 h window, and then faded. A seen one keeps only
      what was left of its minute.

      **Tests** (the real pill rules and controller, a fake clock): `pill.lifecycle.test.ts` —
      unseen done stays at 8 s, a minute, a day, a month; seen, it is shown just under a minute
      later and gone at a minute; "3 done"; a done job seen alongside a failed one leaves at a
      minute while the failed one keeps its hour; never-detached done never appears; through the
      real controller, still shown at 60 s, opening the list sets `seenAt` and shows the result,
      gone a minute later; Dismiss clears at once; and on SQLite, unseen done survives a restart
      ten days later, seen-just-before keeps the rest of its minute, seen-a-day-old is not
      restored; shown COLLAPSED for two minutes, ticked every second as the app's re-check does,
      it reads "1 done" and is not seen — only opening the list sets `seenAt`, and it clears a
      minute after that. `jobStore.test.ts`, for both stores: an old done job (older than the
      restore window, so the window cannot explain it) comes back only while unseen and not
      dismissed. Re-justified, not just re-run: `pill.test.ts`'s "done fades" became "done stays
      until seen", and `pill.collapse.test.ts`'s "THE BUG" now seeds a seen done job and waits
      out its minute (it relied on the 8 s fade to empty the pill). Failed, expired and
      interrupted tests are untouched and pass.

      **Mutations** (each with the Edit tool, each reverted): the 8 s fade restored in `isShown`
      — 7 failed; marking seen skipped for done rows in `PillController` (failed rows still
      marked) — 3 failed; a done job given the failure's hour instead of the minute — 5 failed
      (the seen-together test among them); the done clause dropped from the SQLite restore query
      — re-run on its own, 1 failed ("DONE, UNSEEN, survives a restart"); marking seen whenever
      the pill shows a row instead of when the list is open — 9 failed, the collapsed test among
      them. **One survivor, now pinned:** the same done clause dropped from the IN-MEMORY store's
      copy of the rule failed nothing (every restart test runs on SQLite). The two-store
      `jobStore.test.ts` test above was added for it, and the mutation then failed exactly its
      `InMemoryJobStore` case.

      **Live** (`docs/M26-live-checklist.md`, only what needs a person): an outside-click-detached
      summary still green after 30 s; clicking the pill shows the result and the job clears; and
      Dismiss clears it at once.

      **Close-out record (2026-10-22).** `npm test`: 2934 passed across 132 files, 96 skipped
      (the opt-in real-model evals and real-Piper check); both typechecks clean. Eval skipped
      (not run against the real model — nothing in M26 routes through the model). The mutation
      pass is recorded above: six mutations, every one caught, the one first-run survivor (the
      in-memory store's restore rule) pinned by a new test before the commit.

      **Live, by a person (3 of 3 ticked):** a done job detached by an outside click is still
      green after 30 s (1.1); opening the pill shows its result and it clears about a minute
      later (1.2); Dismiss clears it at once (1.3). **By tests only:** a done job surviving a
      restart, unseen, however old; the exact one-minute tail; "N done" with several; a done job
      in the bar never appearing; failed and expired unchanged.

      **Findings (2026-10-22), investigated without code changes; none fixed in M26, all three
      planned for M27.** Each comes from a rule M23 chose on purpose, which M26 made matter more
      by letting done jobs stay and accumulate:
      1. **Dismiss on one of several done jobs closes the list**, so the pill has to be reopened
         for each. Every row button that takes effect closes the list
         (`PillController.onAction`, 2026-10-13, so the list is out of the way of the dialog
         Review… opens); Dismiss and Cancel inherited it. Pinned by `pill.collapse.test.ts`,
         "Dismiss closes it".
      2. **With the list open, clicking elsewhere does not close it.** The pill is
         `focusable: false` and shown inactive so it never takes the keyboard (M23, measured);
         it therefore never blurs, and nothing reports an outside click. The list closes only
         10 s after the pointer leaves.
      3. **With done jobs in the pill and another job running, the label shows only "1
         running"**, hiding the done jobs until the list is opened. The pill shows one mode at a
         time (needs-you, didn't finish, running, done) and counts only that group
         (`pillView`). Before M26 a done job left after 8 s; now it can be hidden indefinitely.

      **Known gaps:** the restart rule for unseen done jobs is tested, not watched live;
      `DONE_SEEN_CLEAR_MS` (one minute) is a first guess, named so it can be tuned; and the three
      findings above.

- [x] **M27 — three pill fixes from M26's live findings.** **Closed 2026-10-23, after a live run
      by a person (10 boxes ticked, 16 open — `docs/M27-live-checklist.md`), with named gaps and
      one finding not fixed (plan choice, under investigation).** The close-out record is at the
      end of this entry. Each fix comes from an M23 rule built when a done job lasted 8 s. One
      commit per fix, in this order: C (the label), A (Dismiss keeps the list open, plus "Dismiss
      all"), B (an outside click closes the list); added during the milestone and committed
      separately: the Cancelling row (d5b90e0), and a live finding's follow-up — a Cancel that
      came too late, and a job cancelled after a step ran (c698d04).

      **Fix C — the label shows every group present (M26 finding 3).** Committed (6aa77f4). The rule is in §5c,
      "The status pill": every group in priority order ("1 running · 2 done"), colour and pulse
      from the top group, the collapsed pill widened to fit up to `PILL_LABEL_MAX_WIDTH` (348
      px), past it the top groups and "+N more" (jobs left off). `core/jobs/pill.ts` builds the
      forms and picks one; `renderer/pill/render.ts` measures them (`measureLabels`) and reports
      (`reportMeasurements`, moved out of the page's `main.ts` so it can be tested); main checks
      the report (`PillController.onLabelWidths`, IPC `pill:label-widths`).

      Tests: `tests/pill.label.test.ts` (new; the real manager and controller on a fake clock
      where a job's life matters) — two done plus one running reads "1 running · 2 done" and
      still does ten minutes later; all four groups through the controller; the colour is the
      top group's for all fifteen combinations of groups, handed over in reverse priority; a
      cancelled job is in no count, including "+N more"; the forms and "+N more"; the cap (at it
      fits, one pixel over does not), the floor, nothing fitting; a stale measurement dropped
      (with the precondition that old and new labels are as many, so only the label check can
      drop it); malformed reports dropped; the last width kept until re-measured.
      `render.test.ts`: the pill drawn at main's width; each form measured at max-content with
      the probe removed; widths reported only when main lacks them. **Re-justified, not just
      re-run:** `pill.test.ts`'s "needs-you outranks everything" and "failed outranks running"
      pinned one-group labels (M23's rule) and now assert the colour plus every group;
      `pill.collapse.test.ts`'s "a job entering needs-you or failing while collapsed" now also
      shows the failure arrived; `jobs.simulation.test.ts`'s "2 need you" was hiding a done job —
      the live finding itself — and is now "2 need you · 1 done".

      Mutations (each with the Edit tool, each reverted): the label back to the top group only —
      18 failed; the colour from the last group present instead of the first — 6 failed; a
      measurement accepted without checking its labels — **survived first** (the stale test sent
      one width for a two-form label, so the count check dropped it first); the test was fixed to
      send as many widths and assert that precondition, and the mutation then failed it.

      Real window (`scripts/pill-label-recon.cjs`, built page, no pointer or keys): every case
      drawn whole, no ellipsis, pill as wide as the window — "1 running" at 232, "1 running · 2
      done" at 232 (160 measured), three groups at 249, four at 330, four with double-digit
      counts at exactly 348, and triple-digit counts as "123 need you · 456 didn't finish · +889
      more" at 313.

      **Fix A — Dismiss no longer closes the list; "Dismiss all" (M26 finding 1).** Committed
      (6d5029d). The
      rule is in §5c, "The status pill": Dismiss, Cancel and Dismiss all leave the list open while
      anything is listed, and it closes when the last row goes; Review… and Resume still close it.
      `PillController.onAction` collapses only for those two; the closing on the last row is the
      reducer's existing "nothing left to show". Dismiss all: `dismissAllTargets` (core),
      `PillView.dismissAll`, `PillController.onDismissAll`, IPC `pill:dismiss-all` with no
      arguments, and the button in the list's header beside the chime toggle, the header made
      sticky and opaque in `pill.html`. Decision taken here: a Cancel on the only row
      while it is mid-step leaves the list open, showing it running, until the step ends — the
      row has not gone.

      Tests: `tests/pill.dismiss.test.ts` (new; the real manager and controller, interrupted jobs
      made by a real restart on a shared store) — dismiss one of four and the list stays open,
      down to the last; dismissing the last closes it and the next job arrives collapsed; Cancel
      on a row that is not the last stays open, on the last closes (with the precondition that it
      was the only row), mid-step stays until the step ends; Review… and Resume still close it
      with other rows listed; dropped presses and a refused Resume (the user busy) change no job
      and leave it open, with the contrast that the same Resume closes it once free; Dismiss all
      offered only when open with an ended row, clears done/failed/expired and leaves running,
      needs-you and interrupted with no cancel requested of any (asked of the manager, because a
      running job told to cancel stays "running"), closes the list when nothing is left, covers
      only the ten listed and not the two past the cap, is dropped when closed or with nothing
      ended listed, and covers what is listed at the press, not at the draw. `render.test.ts`:
      the button beside the chime toggle only when offered, its click carries nothing, the header
      sticky and opaque read from `pill.html`'s own stylesheet, its label in the
      no-approve-words check. **Re-justified:** `pill.collapse.test.ts`'s `it.each(["review",
      "cancel"])` "a row's button closes it" had one job, so for Cancel it could not tell the old
      rule from the last row going — it is now Review… alone, asserted with the row still
      listed, and Cancel's cases moved to the new file with their precondition; "Dismiss closes
      it" (the finding, pinned) is reversed to "stays open". `scripts/ask-recon/pill-collapse.ts`
      step 6 relabelled: after Dismiss with a row left, the list is expected open.

      Mutations (each with the Edit tool, each reverted): close on any row button again — 4
      failed; Dismiss all includes interrupted — 2 failed; Dismiss all cancels the live rows — 1
      failed, through the needs-you row only; **narrowed to cancelling only running rows it would
      have survived** (a cancelled running job stays "running"), so the test now asks
      `isCancelRequested` of every row left and the narrowed mutation failed it; Review… no
      longer closing — 3 failed.

      Real window (`scripts/pill-dismiss-all-recon.cjs`, built page, a DOM click, no pointer;
      ends PASS or FAIL, and refuses to PASS when the list did not scroll):
      **first found the button under the scroll** when it sat in a foot under the last row —
      four rows measure 461 px against the 440 px ceiling, and it was neither visible in the list
      nor what a click at its centre hits; a sticky foot fixed that. **Then moved beside the chime
      toggle (2026-10-22, at the user's request), it found the header itself scrolled out of
      reach** after 21 px — the chime toggle had been doing so since M23. The header was made
      sticky; the recon's screenshot then showed rows through it at `--surface`'s 0.96 alpha, so
      it was made opaque. Now, with six rows at the top and scrolled 152 px to the bottom, Dismiss
      all and the chime toggle are visible and are what a click at their centre hits; the press
      reaches main as `pill:dismiss-all` with no arguments; a view without `dismissAll` draws no
      button. **Mutation: the header unpinned (`position: static`)** — the recon on that build
      reported FAIL (visible at the top, not scrolled to the bottom), and the jsdom suite did
      not notice (no layout), so `render.test.ts` now reads `pill.html`'s stylesheet and pins
      sticky, `top: -8px` and the opaque background; it failed on the same mutation.

      **A cancelled job shows Cancelling (found while building fix A).** Committed (d5b90e0).
      Read through the
      real manager and controller: after Cancel on a job mid-step, its row still said "Running —
      Step 1 of 2 · summarize", the label "1 running", and Cancel was offered again; a second
      press did nothing visible. Nothing was stuck — the next step is refused and the runner ends
      the job — but nothing said the press had registered. Now `JobView` carries
      `cancelRequested` (in memory only; the stored `JobRecord` is unchanged), and the row says
      "Cancelling — finishing step N of M", or "Cancelling — stops before its first step" while
      still planning, with no buttons. Label, mode and the other rows unchanged (§5c, States).
      Tests (`pill.dismiss.test.ts`, real manager and controller): the contrast (not cancelled:
      Running, Cancel offered); mid-step Cancel shows the wording, no buttons, the label "1
      running · 1 done" and every other row exactly as before, the list open; a second press is
      dropped and changes nothing; the step ending refuses step 2 and, ended by the runner, the
      row goes and the list closes; still planning shows the planning wording and admit refuses;
      a waiting job cancels at once and is never drawn as Cancelling. Mutations (Edit, reverted):
      the field dropped from the view — 3 failed; the second Cancel kept — 3 failed.

      **Fix B — a press outside the pill closes the open list (M26 finding 2).** Committed
      (718f09e). The rule
      and its measurements are in §5c, "The status pill". Recon FIRST, on a prototype
      (`scripts/pill-outside-click-recon.cjs`): no problem found — every click seen, 32 ms median
      reaction at 50 ms, no measurable CPU, 1.5 s start-up, inside/outside agreeing with
      electron's bounds, no press from a key, a hide, a message box or a re-show, none while
      stopped, none from a press just before watching began. The one finding that shaped the
      design: a click shorter than the poll is caught only by the low bit, so both bits are read.
      Built: `PointerPressSource` (interface) and `WindowsPointerWatcher` (`main/shell/`; the
      script, the line parser and the start-up/failure handling split from the process so they
      can be tested); `PillController` prepares it when the pill first appears, watches exactly
      while the list is open, closes on a press outside `pillBounds`, and logs once if it cannot
      watch; `main.ts` wires it and disposes it at quit.

      Tests (`tests/pill.outsideClick.test.ts`; the press source a fake that is ASYNC like the
      real one and fails with the real one's types): a press outside closes the list and stops
      watching; a press on the bar counts; inside, at both corners, does not, and one pixel past
      the edge does; prepared when the pill appears, not before and not at the click, once;
      watched only while open and stopped by each way it closes (second click, hotkey, Review…,
      ten idle seconds, emptied); a press arriving after close is ignored; opened before ready,
      watched once ready, and not if closed by then; no pill, no outside; a failure to start is
      logged once, nothing is watched, the list still closes after 10 s, and it is not retried at
      the click; a death later is logged once and watching ends; with no watcher passed, nothing
      changes. The transport, with the process faked: mouse buttons only (1, 2, 4, 5, 6) in the
      script it runs; only a well-formed PRESS line is a press; one spawn, READY across chunks;
      WATCH 50 / STOP, no press delivered after STOP; failures as Errors (exit before READY, the
      spawn throwing, no READY in time, the host killed); a death after READY told once and
      nothing written after; dispose not reported as a failure.

      Mutations (each with the Edit tool, each reverted): inside presses treated as outside — 1
      failed; polling kept after the list closes — 3 failed; a helper failure swallowed silently
      — 2 failed; **the first-read discard removed — SURVIVED** while the rule lived in the C#
      string, which no test can run (the fake-host tests see only printed lines). The host was
      made a sampler and the rule moved to `judgeSample` in TypeScript, with tests that a button
      already down when watching starts, and the opening click's low bit, are not presses; the
      same mutation then failed 5, and `git diff` was empty after the revert.

      Lifecycle (measured, scratch parent holding the real watcher): the helper is gone after
      dispose, after a plain exit without dispose, and within 0.2 s of `taskkill /F` on the
      parent, watching or idle — the same as `WindowsInputInjector` (stdin closes, `ReadLine`
      returns null, the host exits; the polling thread is a background thread). No fix needed.

      Real windows, the shipped code (`scripts/ask-recon/pill-outside-click.ts`: the real
      controller, pill window over the built page and watcher; real clicks): PASS — the opening
      click does not count; a click on the list's heading, F24, a window hiding and re-showing
      and a message box leave it open; a click on another window closes it and stops watching;
      with it closed a click does nothing; reopened, a second outside click closes it again.

      **A Cancel that came too late, and a job cancelled after a step ran (live finding,
      2026-10-22/23).** Built. A person pressed Cancel on a running job: the row said
      "Cancelling — finishing step…", then turned to Dismiss and the pill to "done". Investigated
      read-only first, with the real manager, runner, planner and pill (scripted model): case (a)
      — the cancel arrived during the job's LAST (or only) step; a cancel takes effect only at the
      next gate, so that step finished and the job ended done, legitimately, with nothing saying
      the Cancel had come too late. The same run found the other half: a job cancelled during step
      1 of 2 ended `cancelled`, and every cancelled job was hidden (M23), so its own message — "I'd
      already done step 1 of 2, but step 2 didn't run." — was never shown.
      Decided and built: (1) **too late** — a done job with a cancel requested reads "Finished
      before it could be cancelled — <result>"; green, "N done", Dismiss; wording only, in memory,
      so after a restart it reads as plain done. (2) **Cancelled after a step ran** — shown like a
      done job (until seen, then the minute), with its own message and Dismiss, counted in **"didn't
      finish"** (chosen from the existing groups: it stopped partway, which is what that group
      counts), an ended row for Dismiss all, and restored after a restart while unseen. Cancelled
      before any step ran stays hidden. What tells the two apart is a new saved count,
      `JobRecord.stepsRun` / `jobs.steps_run` (asked and approved: a column, added by the guarded
      migration list, rather than overloading `acknowledged`, which `jobStatus` also reads).
      Tests (`tests/pill.cancelled.test.ts`, the real manager, runner, planner and pill over
      MockShell, scripted as the investigation was): one-step too late; last-of-two too late, both
      handlers run; the contrast, nobody cancelling, reads plain; case B shows its message,
      Dismiss, "1 didn't finish", list left open, step 2 never run; cancelled at the first confirm,
      nothing run, stays hidden; cancelled while waiting for OK on step 2 (step 1 ran) — the
      manager ends it before the planner writes its message, and the message still arrives and is
      what the row shows (found by reviewing the diff, probed, then pinned); seen, it clears at the minute; unseen, it stays a day and is seen
      on opening; Dismiss all takes it with a done row; on BOTH stores, an unseen one is restored
      ten days later with its message and the before-any-step one is not, and a seen one past its
      minute is not. **Re-justified, not just re-run** — each passed under the new rule for a
      reason unrelated to it: `pill.dismiss.test.ts`'s "when the step ends … leaves the pill" never
      ran a handler (its `midStep` only entered the step), so the job had run nothing; it now runs
      the handler as the planner does and asserts the row STAYS with its message. "…while it is
      mid-step" was a job still planning: retitled, with `stepsRun 0` asserted. The "cancelled is
      never shown / never counted" tests in `pill.test.ts`, `pill.lifecycle.test.ts` and
      `pill.label.test.ts` now say "before any step ran", assert `stepsRun 0`, and where the old
      title would now be false carry a `stepsRun 1` contrast. The two column-list pins
      (`jobStore.test.ts`, `pill.lifecycle.test.ts`'s migration test) gain `steps_run`, an old row
      reading 0.
      Mutations (Edit, each reverted): the too-late wording dropped — 2 failed; every cancelled
      job hidden again — 9 failed; a job cancelled before any step shown — 12 failed; and the
      in-memory store's restore clause dropped (M26's survivor shape) — 1 failed, its
      `InMemoryJobStore` case.

      **Close-out record (2026-10-23).** Plain `npm test` (the dev app closed, SQLite rebuilt for
      node — the first plain run of M27; every run during the build used a scratch SQLite copy
      because the dev app held the real one): **3021 passed across 136 files, 96 skipped** (the
      opt-in real-model evals and real-Piper check). Both typechecks clean. Eval skipped (not run
      against the real model — no M27 change routes through the model).

      **Mutation table** (each with the Edit tool, each reverted, recorded per fix above):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Label counts every group (C) | top group only | 18 tests |
      | Colour from the top group (C) | colour from the last group | 6 |
      | A measurement applies only to the labels shown (C) | label check removed | **survived first**; test fixed to send as many widths, then 1 |
      | Dismiss/Cancel keep the list open (A) | close on any row button | 4 |
      | Review… still closes (A) | Review… no longer closes | 3 |
      | Dismiss all: ended rows only (A) | include interrupted | 2 |
      | Dismiss all cancels nothing (A) | cancel running rows | **would have survived**; test now asks `isCancelRequested`, then 1 |
      | Header pinned (A, the move) | `position: static` | the recon (FAIL); jsdom suite blind — stylesheet test added, then 1 |
      | Cancelling row (d5b90e0) | field dropped / second Cancel kept | 3 / 3 |
      | Outside press closes, inside does not (B) | inside as outside | 1 |
      | Watch only while open (B) | keep polling after close | 3 |
      | Helper failure is said (B) | swallowed silently | 2 |
      | First read after watching is not a press (B) | discard removed | **survived** while in the C# string; rule moved to `judgeSample`, then 5 |
      | Too-late wording (c698d04) | wording dropped | 2 |
      | Cancelled after a step ran is shown (c698d04) | all cancelled hidden | 9 |
      | Cancelled before any step stays hidden (c698d04) | shown | 12 |
      | Restore rule, both stores (c698d04) | in-memory clause dropped | 1 |

      **Live, by a person (10 of 26 ticked, 2026-10-23):** the label with mixed states (1.1,
      1.2); dismissing several jobs in a row (2.1); Dismiss all beside the chime toggle, and with
      a scrolling list (2.4, 2.5); the Cancelling row (3.1); an outside click on the desktop with a
      real mouse and a touchpad (4.1); and the three cancel cases — too late (5.1), cancelled after
      a step ran (5.3), cancelled before any step (5.5). **By tests or scripts only (16):** the
      label widening (1.3; widths measured in a real window, the transition not watched), a
      cancelled job not counted (1.4), the last row closing the list (2.2), Review… closing it
      (2.3), Dismiss all leaving an interrupted job (2.6), the step-ends and waiting-job cancels
      (3.2, 3.3), an outside click on another app and on the bar (4.2, 4.3; another window clicked
      by the real-window scenario, the bar by tests only), inside clicks and the opening click
      (4.4, 4.5; the real-window scenario), hotkeys and dialogs (4.6; F24 and a message box by
      script — the dictation hotkey and Escape not run), right and middle clicks (4.7; the
      prototype recon), clicks while closed (4.8), the last of two steps too late (5.2), Dismiss
      all with a stopped-partway row (5.4).

      **Findings.** (1) Found during M27 and fixed in it: a Cancel during a job's last step ended
      it "done" with no word, and a job cancelled after a step ran vanished — fixed in c698d04,
      re-watched (5.1, 5.3, 5.5). (2) **Not fixed in M27, under investigation:** "'create a linear
      issue and send to fun' with clipboard text selected planned three steps, including
      'Summarize the selected clipboard text', which the instruction did not ask for. Under
      investigation." No M27 change touches planning; the cause is not known, and the next step
      is to reproduce it — with the clipboard state recorded, as M19's plan-choice lesson says —
      before anything is edited. *(M28 reproduced and measured it: it comes with a long
      clipboard. Two wordings were tried and reverted; still open. See M28. M29's live run saw
      it again, now named in the preview as "Summarize the text you copied"; see M29. M30
      refuses such a step in code unless the instruction asks for it; see M30.)*

      **Known gaps / open limits:** another program polling the mouse buttons can take the
      "pressed since" bit, so a very short tap may then be missed; taps under ~15 ms rely on that
      bit; a press in the pill window's transparent margin counts as inside; a pill on a
      secondary display or with mixed scaling is not measured; the too-late wording is in memory
      only (after a restart the row reads as plain done); `PILL_LABEL_MAX_WIDTH` (348 px) and
      "+N more" were reached only by script; the 16 open boxes above.

- [x] **M28 — refuse unfilled placeholders in plan arguments; the plan-choice eval set.**
      **Closed 2026-10-23, after a live run by a person (2 of 2 boxes ticked —
      `docs/M28-live-checklist.md`), with M27's plan-choice finding still open and two live
      findings not fixed (the live record is at the end of this entry).** M28 set out to fix that
      finding with prompt wording. Two wordings were measured and both reverted; what shipped is
      a deterministic check the measurement turned up, and the eval set as the baseline for the
      next attempt. One commit.

      **The finding, reproduced.** M27's live run: with text selected and no email open,
      "create a linear issue and send to fun" planned summarize > create > send. Four texts push
      toward a reading step and none says text already in the prompt is used as given:
      `CHOOSE_SYSTEM`'s "plan the tool that reads it as an EARLIER step" (`prompt.ts`), the plan
      tool's worked example (`plan.ts`), the Linear and GitHub create descriptions ("in a plan
      this is normally an earlier step's whole result") and `summarize`'s own description.

      **The eval set** (`tests/eval/planChoice.eval.test.ts`, `M19_PLAN_SET=m28`, 45 calls,
      3 trials a case, gpt-5-mini at low effort — the configured planning model). `given` cases
      also check the create's description holds the whole clipboard and that the Linear
      definition's `describe` (the dialog's text) shows all of it. Tool names are scored the way
      the planner reads them (`canonicalToolName`), and each trial records what the planner's
      pre-flight would do with it (`checkUnfilledBlanks`, `checkUnreadContent`). Clipboards:
      short (a one-line bug, ~110 chars), long (prose + stack trace, ~1,500), unrelated (offsite
      notes, ~300).

      **Baseline — the app's wording, unchanged by M28** (54 answered calls: the 45, and 9
      re-run after an eval-harness bug lost their plans; "as given" = the whole clipboard in the
      description and in the dialog):

      | Phrase | On screen | Trial 1 | Trial 2 | Trial 3 | Expected | Result |
      |---|---|---|---|---|---|---|
      | create a linear issue and send to fun | short clipboard | create > send, as given | create > send, as given | create > send, as given | create > send, as given | 3/3 |
      | create a linear issue and send to fun | long clipboard | create only, no description, no send | **summarize** > create > send | create > send, as given | create > send, as given | 1/3 |
      | log this as an issue and let #bugs know | short clipboard | create > send, as given | create > send, as given | create > send, as given | create > send, as given | 3/3 |
      | log this as an issue and let #bugs know | long clipboard | **summarize** > create > send | **summarize** > create > send | **summarize** > create > send | create > send, as given | 0/3 |
      | summarize this and file it in Linear | long clipboard | summarize > create | summarize > create | summarize > create | summarize > create | 3/3 |
      | file this bug in linear and tell the social channel | email open + short | readEmail > create > send | readEmail > create > send | readEmail > create > send | the same | 3/3 |
      | create a linear issue and send to fun | unrelated clipboard | **summarize** > create > send | create > send, as given | create > send, as given | create > send, as given | 2/3 |
      | file this bug email in Linear and tell the bugs channel | nothing | readEmail > create > send | readEmail > create > send | readEmail > create > send | the same | 3/3 |
      | make a Linear ticket from this email, then post the link in #bugs | nothing | readEmail > create > send | readEmail > create > send | readEmail > create > send | the same | 3/3 |
      | log this as an issue and let #bugs know | nothing | **summarize** > create > send | **summarize** > create > send | **summarize** > create > send | readEmail > create > send | 0/3 |
      | file this bug in Linear and tell the social channel | nothing | readEmail > create > send | readEmail > create > send | readEmail > create > send | the same | 3/3 |
      | find the login issue in Linear | nothing | search_issues | search_issues | search_issues | the same | 3/3 |
      | log this as an issue and let #bugs know | email open + long | readEmail > create > send | readEmail > create > send | readEmail > create > send | the same | 3/3 |
      | reply to this and send it | email open + long | draftReply > sendReply | draftReply > sendReply | draftReply > sendReply | the same | 3/3 |
      | summarize this | email open + unrelated | summarize | summarize | summarize | the same | 3/3 |

      **The extra step comes with length.** Unwanted summarize steps with no email open: short
      clipboard 0 of 6, unrelated 1 of 3, long 4 of 6 (plus one create that dropped both the
      description and the send). M27's live clipboard was not recorded; by these numbers it was
      probably long.

      **Two wordings, both reverted** (45 answered calls each; the first needed 31 trials re-run
      after the network dropped, unbilled):

      | | Baseline | 1: unconditional | 2: conditional, after the verb rule |
      |---|---|---|---|
      | Unwanted summarize — long + unrelated clipboard | 5 of 9 | 0 of 9 | 0 of 9 |
      | Long + unrelated rows pass | 6 of 9 | 9 of 9 | 9 of 9 |
      | Short-clipboard rows pass | 6 of 6 | 6 of 6 | 6 of 6 |
      | "summarize this and file it in Linear" summarizes | 3 of 3 | 2 of 3 | **1 of 3** |
      | Email open + short: "file this bug…" reads the email | 3 of 3 | **1 of 3** | 3 of 3 |
      | Email open + long: "log this…" reads the email | 3 of 3 | **1 of 3** | **1 of 3** |
      | Nothing on screen: "file this bug in Linear…" reads (or is refused) | 3 read | 1 read, 2 create with no description | 2 read, 1 refused by `checkUnreadContent` |
      | Nothing on screen: "log this…" (separate finding) | summarize ×3 | create with no description ×2, `"{selected_text}"` ×1 | create with no description ×3, all refused |

      Wording 1, in `CHOOSE_SYSTEM` and both create descriptions: "selected text is already
      shown to you, so it needs no reading step: put it in the argument as given, however long
      it is; summarize, rewrite or shorten it only when the user asks." Wording 2: the same,
      only "when selected text is shown and 'this' means it by the rule above", placed after the
      verb rule. Option 2 (ask when a plan summarizes) was not approved and not tried; no planner
      code rewrites plans.

      **Lesson.** An unconditional "use selected text as given" rule fixed the long-clipboard
      summarize steps (5 of 9 to 0 of 9) but regressed explicit "summarize" and the open-email
      verb rule; the conditional version fixed one of the two regressions; reverted. A rule
      added to the planning prompt competes with the rules around it — measure the controls,
      not only the failing case. And a fixture's size can decide whether a failure reproduces
      at all: a one-line clipboard never showed this one.

      **What shipped: `checkUnfilledBlanks`** (§5b, "A blank nothing fills"), from wording 1's
      `"{selected_text}"`. Tests: `tests/unfilledBlanks.test.ts` (new, 18) — the shape, nested
      arguments, every `{stepN}` form, near-misses, literal braces that are not the shape, the
      user's own text, and through the planner: a plan, a one-step plan and a lone call refused
      with nothing run, the precondition that `checkUnreadContent` alone would have let it
      through, the previous-turn rule, and controls that a valid `{step1}` and a brace-filled
      clipboard as given still run.

      Mutations (each with the Edit tool, each reverted; run twice, once on wording 2 and once
      after the revert, the same counts both times):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Refuse a blank (both planner paths) | check removed | 4 |
      | A blank in the user's own text passes | exclusion dropped | 6 |
      | Shape: one bare name only | spaces allowed inside | 1 |
      | `{stepN}` is a reference, not a blank | not excluded | 4 |

      **Build record (2026-10-23, before the live pass).** `npm test`: **3039 passed across 137 files, 96
      skipped**. Both typechecks clean. Real-model spend for M28: about $0.17 over 144 answered
      calls (baseline 54, wording 1 45, wording 2 45), all from the eval above, run on the
      user's go.

      **Known gaps / still open:** M27's plan-choice finding (a long clipboard often gets an
      unwanted summarize step; visible in the preview and at the dialog, box 2.1). **Separate
      finding:** with nothing on screen, "log this as an issue and let #bugs know" never plans
      its M19 expectation (readEmail first) on gpt-5-mini — summarize ×3 on the shipped wording,
      which stops at the summary for want of text; that expectation was recorded on gpt-5. The
      eval does not record a lone call's arguments, so the two "summarize this and file it" lone
      creates under wording 2 are unexplained.

      **Live, by a person (2 of 2 ticked, 2026-10-23), on the shipped wording.** 1.1: with the
      clipboard empty, "log this as an issue and let #bugs know" filed nothing. 2.1: with the long
      clipboard, "create a linear issue and send to fun" showed no summarize step in any try,
      cancelled at every Linear dialog. One plan was three steps and two were two steps (create
      with the clipboard as the description, then post). So the case box 2.1 was written for, a
      summary step shown in the preview, did not occur. `npm test` at the close (plain run, SQLite
      rebuilt for node): **3039 passed across 137 files, 96 skipped**; both typechecks clean.
      Eval skipped at the close (not run against the real model).

      **Live findings, from the action log (rows 647–652, read read-only) and the code; neither
      fixed, no code changed:**
      1. **A step labelled "Capture the selected text unchanged to use as the issue
         description" was `rewrite`.**
         - **What it did.** With `tone: ""`, `rewrite` fell back to "clear, natural, and
           concise". It reworded the text with a model call and **copied the rewrite over the
           user's clipboard**. It is `reversible`, so it ran unnarrated and unconfirmed.
         - **What reached the dialog.** Its whole result, including the tool's own line
           "Rewritten (clear, natural, and concise) and copied to clipboard.", became the
           create's description through `{step1}`.
         - **It spread to the later tries.** The two later two-step plans used the clipboard as
           given, which by then held the rewrite.
         - **Who wrote the label.** The preview line is the step's model-written `describe`
           (`previewPlan`). The tool's name is used only when that phrase is empty, so nothing
           on screen said `rewrite` until the dialog showed reworded text.
         - **Related.** The same family as M27's finding (an extra step before a create), with
           a tool the eval never saw there.
      2. **With nothing copied, the request for the text was the model's prose** (`no_tool`,
         row 647). It offered to re-log SEJ-21, taken from the previous turn: `getLast()` skips
         detached rows, and the last attached one was row 642, a cancelled post naming SEJ-21.
         No state waited for an answer: M21's lesson, live.

- [x] **M29 — `rewrite` leaves the clipboard alone inside a chain; code-written plan preview
      lines.** **Closed 2026-10-23, after a live run by a person (9 of 9 boxes ticked —
      `docs/M29-live-checklist.md`), with two carried-over findings still open (M27's
      plan-choice finding and M28's prose question; the live record is at the end of this
      entry).** Both fixes come from M28's live finding 1. Fix 1 was committed as `bd3abc9`.
      Fix 2, option A of the M28 investigation (code-written preview lines), was committed as
      `41ed34d`.

      **Fix 1: `rewrite` never touches the clipboard inside a chain.**

      - **The change.** When `deps.chained` is true, `rewrite` returns only the rewritten text.
        It makes no `copyToClipboard` call and adds no "Rewritten (tone) and copied to
        clipboard." line (`tools/rewrite.ts`).
      - **Outside a chain, unchanged.** A lone call, or a one-step plan (which the planner runs
        as a lone call), still replaces the clipboard and keeps the header line: there, the user
        asked for the rewrite.
      - **Why chained.** Inside a chain the result goes to a later step through `{stepN}`, so the
        clipboard write served no one. In M28's run it also replaced text the person had not
        asked to have reworded, and the app keeps no copy. The header line went into the Linear
        description as its first line. `deps.chained` is set by the planner from where the call
        sits (M19), never by the model.
      - **Its tier stays `reversible`.** In a chain it now mutates nothing.
      - **The wording that called the clipboard recoverable is corrected.** `risk.ts` and the
        §6 tier table now limit `reversible` to a clipboard write the user asked for.
      - **Not changed.** The tool's description, which the model reads, still says it copies to
        the clipboard. Editing it would change the planning prompt, which cannot be measured
        without model calls. `Tool.background` stays `foreground-only`.

      **`MockShell` now holds a clipboard.** `getContext()` returns its current `clipboard` as
      `selectedText`, and `copyToClipboard` sets it ("" reads back as null). That is how
      `WindowsShell` behaves, since its `getContext()` reads `clipboard.readText() || null`.
      Until now the mock returned the same context forever, which is more lenient than Windows
      (CLAUDE.md): a rewrite read back on a later try, which is how M28's bug spread, could not
      be seen. `LiveClipboardShell` (`tests/jobWorld.ts`, M23) had modelled this already; it
      now shares the base class's field.

      **Other tools whose result reaches a later step with a status line in front.** Surveyed,
      not changed:

      | Tool | Result | Would a later step use it? |
      |---|---|---|
      | `draftReply` | "Draft is in the Gmail reply box — read it before sending.\n\n<draft>" | Plausibly, e.g. "draft a reply and post it to #team". The line would be sent, but the send's dialog shows the whole text first. |
      | `reviseDraft` | "Updated the draft in the Gmail reply box.\n\n<draft>" | The same. |
      | `addToPage` | "Added to <page>.\n\n<note>" | Rarely. M17 chose `{step1}` over `{step2}` for the summary because this result is not content. |
      | `sendMessage` | "Sent to #x.\n\n<text>" or "Sent via your Slack webhook.\n\n<text>" | Rarely; it is usually the last step. |
      | `sendReply` | "Sent.\n\n<text>" | Rarely; it is the last step of its chain. |
      | `remember`, `openTarget`, `openApp`, `searchSpotify`, `createEvent`, `moveEvent`, `pointAt` | one status line, no content | Nothing to strip. The whole result is the status. |
      | `summarize`, `readEmail`, `readSchedule`, `recall`, `tellTime`, Linear and GitHub create/search/get | content only, or a line that is the content ("Created ENG-5: title" + link) | No header. |

      `rewrite` was the only one whose line was false in a chain ("copied to clipboard") as well
      as unwanted. Every other line is still true, and every send or create shows the whole text
      at its confirm before anything goes.

      **Tests (MockShell):**
      - `tests/tools.test.ts`, 2 new: outside a chain, the clipboard holds the rewrite, the
        result keeps its header, and the next capture reads the rewrite; a one-step plan does
        the same.
      - `tests/planner.mcp.test.ts`, 3 new, replaying M28's live plan. The rewrite and create
        arguments come from action log rows 648–649 and the copied text from
        `docs/M28-live-checklist.md` §2. The send step's arguments were never logged, so its
        notes are a stand-in. The tests check:
        - cancelled at the Linear dialog, as live: no clipboard write, and the clipboard and the
          next capture still hold the original;
        - the dialog's description is exactly the rewritten text;
        - approved: Linear's `save_issue` receives exactly the rewritten text, and the clipboard
          is untouched.

      Mutations (each made with the Edit tool and reverted):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | No clipboard write in a chain | write it, then return the bare text | 2 |
      | No header in a chain | return the header line in a chain | 2 |
      | Only a chain skips the write | treat every call as chained | 3 |
      | The mock's clipboard moves | `getContext()` back to a fixed context | 1 |

      After `MockShell`'s clipboard became a field rather than a getter, the first and fourth
      mutations were run again together and caught by 3.

      **Build record (2026-10-23, before the live pass).** `npm test`: **3044 passed across 137
      files, 96 skipped**. Both typechecks clean. No model calls.

      **Fix 2: each preview line is the tool's own phrase, not the model's `describe`.**

      - **`Tool.planPhrase`.** A required string on every tool, with no default, like
        `background`. It is a lowercase imperative ("reword the text you copied"), capitalised
        on screen and placed after "First,"/"Then," in speech. The 28 phrases are in §6's table
        and pinned in `tests/planPhrase.test.ts`. The elaborate phrase is 36 characters, so the
        short alternative was not needed.
      - **Connector tools.** `ConnectorToolDef.planPhrase` is required and pinned in the
        definition beside `confirmLabel`; the adapter copies it, and nothing is taken from the
        server.
      - **Screen and speech read the same phrase** from one lookup (`previewPlan` and
        `spokenPlan` now take the run's tools). A tool with no phrase, which validation rules
        out, shows its name, never the describe.
      - **The `[main]` line** gets `[plan: tool "phrase" > …]`. It is set from
        `PlannerOutcome.plan`, which is present exactly when a preview was shown.
      - **`describe` is still in the plan schema,** required and capped at 80 characters. It is
        not shown, spoken or logged. The planning prompt is unchanged: `core/llm/` and
        `registry.ts` have no code changes (the two `plan.ts` edits are comments), and every
        tool-file change is a `planPhrase` line. `toToolSchemas` drops the field, and a test
        pins that.
      - **Not changed.** The `[main] refused plan, as sent:` line (M19) still prints a refused
        plan in full, describes included. It is console only and existed before this fix.

      **Tests.** 151 new; 3195 total.
      - `tests/planPhrase.test.ts` (new, 144):
        - all 28 phrases word for word;
        - each rule over every phrase: at most 40 characters, printable ASCII, lowercase start,
          no trailing punctuation, no identifier, and no two alike. An identifier is a word with
          an underscore, or camelCase starting lowercase, as tool names are. A brand ("GitHub")
          or a plain word ("summarize") is not one;
        - the schemas, and what the planner hands `FakeLLM`, have exactly `name`,
          `description` and `inputSchema`.
      - `tests/chain.test.ts`: the preview tests rewritten. Each plan's describe differs from
        its tool's phrase, so the tests tell the two apart. The M28 step reads "Reword the text
        you copied", no describe text is shown or spoken, the screen, speech and console fall
        back to the tool's name, and `planPhrases` is checked.
      - `tests/planner.chain.test.ts`: its fakes have phrases unlike their describes, and its
        three preview assertions were re-justified on that basis.
      - `tests/mcpAdapter.test.ts` (+2): the phrase is the pinned one, and holds after a real
        call to a server whose description and title say "Capture the selected text
        unchanged".
      - `tests/planner.mcp.test.ts` (+2, the M28 replay): the notify payload, the spoken
        preview and `outcome.plan`; and the real `[main]` line through `createRunInstruction`.
      - `tests/contextHints.test.ts` (+1): the line's exact format.

      Mutations (each made with the Edit tool and reverted):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | The screen shows the phrase | show `describe` when present | 7 |
      | No describe as a fallback, on screen | fall back to `describe` when there is no phrase | 1 |
      | The same, for speech and the console | fall back to `describe` in `labelFor` | **0, then 1** |
      | A connector's phrase is pinned | the adapter takes the server's name for the tool (`remote`) | 4 |
      | Speech reads the same phrase | speak `describe` while the screen shows the phrase | 7 |
      | The console names the phrase | drop it, keeping the tool names | 2 |
      | The model never sees a phrase | `toToolSchemas` passes it through | 2 |

      The third mutation survived at first: the fallback test checked only the screen. Speech
      and the console have their own lookup (`labelFor`). The test now checks all three, and
      the mutation was re-run and caught. The connector mutation uses the server's name for the
      tool because the server's description and title only arrive asynchronously, after
      connecting. A phrase is a plain string fixed when the tool is built, so the server cannot
      supply one.

      **Build record (2026-10-23, before the live pass).** `npm test`: **3195 passed across 138
      files, 96 skipped**. Both typechecks clean. No model calls.

      **Live, by a person (9 of 9 ticked, 2026-10-23).**
      - **Fix 1.** In a chain with a rewrite step, the Linear dialog's description had no
        "Rewritten (…) and copied to clipboard." line. After cancelling, a paste into Notepad
        gave the original text ("Tried the migration again…"); the next try's description was
        not a rewording of a rewording. A plain "rewrite this politely" still replaced the
        clipboard and kept its header line.
      - **Fix 2.** The on-screen and spoken previews both gave the three fixed phrases: "reword
        the text you copied", "create a Linear issue", "post a message to Slack". The terminal's
        `[main]` line showed `rewrite "reword the text you copied"`. Tries without a rewrite
        step showed only the phrases for the tools in their plans.
      - **The phrase that reached the rewrite step** was the checklist's fallback, "rewrite this
        and file it in Linear, then tell fun". On "create a linear issue and send to fun" the
        model planned no rewrite step in this run. So the M28 case itself (a rewrite nobody
        asked for) was not seen live. The same code path was, since the handler reads only
        `deps.chained`, never the instruction. The replay tests in `tests/planner.mcp.test.ts`
        cover the M28 plan itself.
      - **Close-out test run.** 3195 passed across 138 files, 96 skipped; both typechecks
        clean. The first run used `better-sqlite3` aliased to a scratch node build of the same
        version (12.11.1), because the dev app from the live pass held the SQLite binary that
        `npm test`'s pre-step rebuilds. After the app was closed, plain `npm test` gave the same
        count. Eval skipped (not run against the real model).

      **Proven vs. live-only.**
      - **Proven by tests against `MockShell`:** the M28 plan itself (rewrite > create > send
        with the logged arguments) leaves the clipboard intact; every phrase and every rule on
        it; that the model never receives a phrase; the fallback on screen, in speech and on
        the console.
      - **Seen only live:** the real clipboard, the real speech engine reading the phrases, and
        the real terminal line.

      **Live findings, carried over; neither fixed in M29, no code changed for them:**
      1. **Steps the instruction did not ask for, before a create (M27's plan-choice finding,
         still open).**
         - **Seen live:** with the long clipboard, "create a linear issue and send to fun"
           sometimes planned a summarize step before the create. The preview now names it:
           "Summarize the text you copied".
         - **Also seen:** with a long clipboard, the model sometimes condenses the text itself
           inside the create call's description, with no separate step. No preview line can
           show that; the Linear dialog shows the description in full before anything is
           filed.
         - **What M29 changed:** a rewrite step is now visible as what it is and no longer
           touches the clipboard. Whether the model adds such a step at all is unchanged; see
           M28's measurements (two wordings, both reverted).
      2. **With nothing copied, the request for the text is the model's prose (M28's finding 2,
         still open).** Nothing in the app waits for an answer (M21). Not touched.

      **Known gaps / open limits.**
      - **The planning prompt is unchanged, by decision.** Rewrite's description still says it
        copies to the clipboard, and the plan schema still says `describe` "is read out".
        Changing either needs an eval with controls.
      - **The preview is accurate but generic.** Two steps of one tool read alike.
      - **Inside a chain, a rewrite the user did ask for** ("polish this and post it") no
        longer leaves the polished text on the clipboard. That was decided, and is not a
        finding.

- [x] **M30 — refuse a summarize or rewrite step nobody asked for, before a create.** **Closed
      2026-10-23, on replay, test and scripted evidence; no box ticked by a person (0 of 6 —
      `docs/M30-live-checklist.md`). The refusal has not been seen against a real model plan: 0
      of 12 scripted live trials produced an unasked step (the close-out record is at the end of
      this entry).** For M27's plan-choice finding. Committed as `5e40d4d` (the build and the
      review pass) and `d8b1bac` (the scripted live results). No model calls in the build.

      **The investigation** (read-only, before any code). Every plan on record with a summarize
      or rewrite step before a create: **30 the person did not ask for** (16 of the 77 recorded
      answers, 8 in M28's baseline eval table, 6 live runs in the action log) and **5 they did**
      (3 eval, 2 live). All 30 were summarize except one live rewrite (M28's row 648). By what
      was copied: nothing, 19 (all "log this as an issue…" or "file this bug in Linear…"); short,
      0 of 25; long, 7 of 15 create runs; email open, none. Options compared: refuse (A), ask
      "summarize first or as is?" (B), re-ask the model once (C). **A was approved**, with two
      wordings and extended word lists; B would have the planner edit a plan on the user's say-so,
      a new exception to "refuses; never rewrites", and C needs an eval. No condense check was
      built: none of the corpora has a confirmed case of a description condensed inside the create
      call (rows 659–660, the suspected ones, are byte-for-byte a summary from row 654 four minutes
      earlier, most likely copied by hand), so a console item measures it instead.

      **What shipped** (§5b, "A step nobody asked for, before a create"):
      - **`checkUnaskedSteps`** in `core/chain.ts`, on the plan path in `runChain` after
        `checkUnreadContent`. No lone-call call site: one call has no step before it.
      - **`Tool.askedForBy`**, declared by `summarize` and `rewrite` only; the lists are in §5b.
        The planner reads declarations, never tool names, like `contentArg` and `readsContext`.
        Not in `toToolSchemas`, so the planning prompt is unchanged.
      - **Two fixed refusals** (`UNASKED_STEP_NO_TEXT`, `UNASKED_STEP`), kept out of the next
        planning call's previous turn (`isUnaskedStepRefusal`), one `refused` row, no miss.
      - **The `[main]` line** gains `[description: equals clipboard | differs from clipboard |
        from an earlier step]`, one entry per create with a description, after `[plan: …]`
        (`createDescriptions`, `PlannerOutcome.descriptions`). Judged on the answer as sent, so a
        refused plan is described too. No behaviour change.
      - **`decide` split** in two (`decide` asks, `dispose` acts on the answer), so the
        description item is added to every outcome in one place.
      - **The M28 eval's three clipboards** moved, unchanged, to
        `tests/fixtures/planChoice/clipboards.ts`, so the replay uses the same text. The eval's
        cases and wording are otherwise untouched.

      **Tests.** 96 new; 3291 total (84 at the build, 12 from the review pass's tldr forms).
      - `tests/unaskedSteps.test.ts` (new, 74), against the real registry and connector
        definitions:
        - the declarations are exactly the approved lists, on those two tools only, sharing no
          word; the creates are the two connector creates;
        - matching: every listed word, case, whole words ("summarized", "briefcase", "informal"
          do not match), one object word between a two-word entry and not two;
        - "tl;dr", "tldr", "tl dr", "TLDR" and "Tl Dr" ask for a summary through `summarize`'s
          real declaration, and not for a rewrite; "tldrs", "atldr", "tl drive" and "xtl;dr" do not;
        - the rule: before a create only, a `functions.` prefix, every unasked step named,
          the instruction judged and never the clipboard (both directions);
        - per-tool lists: "polish this and file it" with a summarize step refused; "summarize
          this and file it" with a summarize step runs and with a rewrite step is refused;
        - both wordings word for word, plain ASCII, under the 240-character spoken cap and spoken
          whole; the refusal row recognised and nothing else;
        - **the replay:** recorded.json refuses exactly the 16 and none of the other 61 (all 16
          had nothing copied, so all get the copy-the-text wording, and none is also refused by
          the two older checks); M28's table (8 refused, 37 run) and the live log (6 refused,
          2 run) as hand-labelled in the fixture; 30 refused and the 5 asked-for steps run; the
          24 email-open and nothing-on-screen control trials untouched;
        - **the phrasing set:** of 22 that ask, exactly "file a one-line issue from this" is
          refused, and "tldr this and file it" runs; all 4 verb-in-the-bug phrasings let the step
          through. Both pinned as known gaps;
        - `createDescriptions`: equals (whitespace aside), differs (a condensed clipboard, no
          clipboard), from a step, nothing without a description or a create, one per create.
      - `tests/planner.unaskedSteps.test.ts` (new, 19), the real planner with made-up tools that
        declare their own words: refused before the preview, any dialog, narration or step, with
        one row and no miss, in both wordings; tool names logged as sent; judged after the
        multi-call retry; the plan kept whole for the console; an asked-for plan runs to every
        dialog; the other tool's word is refused; a step not before or after the create, and a
        lone step, run; kept out of the next previous turn in both wordings, with the control that
        an ordinary refusal is not; `outcome.descriptions` for a plan, a lone call and a cancelled
        plan; a real Linear create over a fake MCP server sends nothing; a detached job is refused
        before admission.
      - `tests/contextHints.test.ts` (+2): the `[main]` line's exact format, one create and two.
      - **Re-justified, not just re-run:** `tests/planner.mcp.test.ts`'s M29 replay ran M28's live
        plan (an unasked rewrite) under "create a linear issue and send to fun", which M30 now
        refuses: the five tests failed. M29's rule still governs a rewrite the person asks for, so
        they now run the same plan and arguments under "rewrite this and file it in Linear, then
        tell fun" (M29's live phrase, rows 662–663), and a new first test (+1) pins that the live
        phrase is refused with no model call, no dialog and the clipboard untouched.

      Mutations (each made with the Edit tool and undone with it; the tree checked clean after):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Refuse on the plan path | check disabled in `runChain` | 11 |
      | Refuse on the lone-call path | not run: there is no lone-call call site (one call has no step before it) | — |
      | Per-tool lists | one shared list (every tool's words pooled) | 4 |
      | Judge the instruction | judge the clipboard text instead | 14 |
      | The no-clipboard wording | always the text-copied wording | 4 |
      | Kept out of the previous turn | exclusion dropped | 2 |
      | Only a step BEFORE a create | steps after the create judged too | **survived first**; fixed, then 2 |
      | One object word in a two-word entry | slot removed | 2 |
      | The console item | dropped from the outcome | 3 |
      | "tldr" and "tl dr" ask for a summary (review pass) | both removed from `summarize`'s list | 7 (the pinned list, the 4 variants without the semicolon, the 1-of-22 count, "tldr this and file it" runs) |
      | M29's rule, still held under an asked-for rewrite (review pass) | `rewrite` writes the clipboard in a chain again | 3 of the 5 re-justified M29 replay tests (below) |

      **The M29 check.** With `if (deps.chained) return rewritten;` disabled, three of the five
      re-justified tests in `tests/planner.mcp.test.ts` failed: "cancelled at the Linear dialog,
      as live: the clipboard still holds what was copied", "the dialog's description is the
      rewritten text alone — no header line" and "approved: Linear receives only the rewritten
      text, and the clipboard is untouched". The other two, "the preview names each step by its
      tool's phrase, never the model's describe" and "the [main] line names each step's tool
      beside its phrase", test M29's preview fix, never read the clipboard, and stay green under
      this mutation by design. Restored; the file passed again.

      The position mutation survived because the "summarizes after filing" case's instruction
      said "post a summary", and "summary" is on the list: it passed for the wrong reason. It now
      uses an instruction with no listed word (asserted), and a planner test runs create >
      shrink; both failed under the mutation.

      **Build record (2026-10-23, before the live pass).** `npm test`: **3279 passed across 140
      files, 96 skipped** at the build; **3291 passed across 140 files, 96 skipped** after the
      review pass. Both typechecks clean. No model calls; eval skipped (not run against the real
      model). The review pass also scanned the new fixtures for emails, phone numbers, URLs, keys,
      user paths and real names: nothing personal (the one hit was a date).

      **Known gaps:** §5b's list (1 of 22 phrasings wrongly refused, inflections, 4 of 4
      verb-in-the-bug phrasings let through, the email-open wording, a refusal costs a try, and
      condensing inside the create is measured on the console, not judged). M28's prose question
      with nothing waiting is not touched.

      **Scripted live run (2026-10-23, `d8b1bac`).** The real planner through the real call site,
      real planning calls (gpt-5-mini, low), the long clipboard, every connector faked (Linear
      over `FakeMcpServer`, GitHub unavailable, Slack `FakeSender`, an in-memory log, `fetch`
      limited to `api.openai.com`), Cancel at every dialog. 17 real planning calls, est. ~$0.024.
      - **Box 1, "create a linear issue and send to fun": 0 of 12 refused.** No trial planned a
        summarize or rewrite step, so the refusal was never exercised against a real model plan.
        Every trial reached the Linear dialog with `[description: equals clipboard]`, and the
        fakes saw 0 creates and 0 sends.
      - **Box 2, "summarize this and file it in Linear": 5 of 5.** Not refused, the preview
        "Summarize the text you copied / Create a Linear issue", `[description: from an earlier
        step]`, the dialog's body step 1's output. The summarize step's own model call was faked
        to stay within budget. 4 of 5 plans used the `functions.` prefix; canonicalised correctly.
      - **No UI driver** (Playwright or similar) is in the repo, so the bar's DOM was not read.

      **Close-out record (2026-10-23).** `npm test`: **3292 passed across 140 files, 96
      skipped**; both typechecks clean. One more than the review pass's 3291:
      `tests/realModelGuard.test.ts` checks every file under `scripts/` for a model call outside
      the spend gate, and the new `scripts/m30-say-refusal.ts` (no model call) is one more file.
      - **Verified:** the refusal logic, by the replay (30 of 30 unasked steps refused, 5 of 5
        asked-for steps run, 24 control trials untouched), by the harness's dry run with M27's
        plan scripted in (the exact wording on the bar and to speech, no preview or dialog, the
        refused plan logged with summarize before the create, nothing filed), and by the tests.
      - **Not reproduced live.** In 12 scripted trials the model never planned the step M27, M28
        and M29 saw (M28's baseline: 1 of 3 on this phrase with this clipboard; M29's live run:
        sometimes). Why is unknown: chance at a low rate, a difference between this run and the
        app's (one shared in-memory log, a menu without the jobs tools), or a change in the model
        behind the same name are all possible, and none was tested.
      - **Box 1.2's sound** needs a person: `npx vite-node scripts/m30-say-refusal.ts` speaks the
        exact sentence through the real Piper engine, built as `main.ts` builds it, from the
        refusal constant through the planner's own `toSpokenResult`.
      - **Known gaps** carried: "file a one-line issue from this" is wrongly refused (no listed
        word); "sum the whole thing up" is wrongly refused (more than one word between a two-word
        entry); inflected forms; 4 of 4 verb-in-the-bug phrasings let through; the rest of §5b's
        list.

      **Open finding, for M31 (not fixed in M30):** in 4 of the 12 scripted trials of "create a
      linear issue and send to fun", the planner produced a lone create and dropped the send (no
      plan; the issue would have been filed and fun never told). The same shape appears in M28's
      baseline (one "create only, no description, no send" trial) and is the "lone create that
      drops a send" §5b names as a different failure. *(M31 refuses it; see M31.)*

- [x] **M31 — refuse a create plan that drops a requested send.** **Closed 2026-10-23, after a
      live run by a person (2 of 2 boxes ticked — `docs/M31-live-checklist.md`), with named gaps
      and six open findings (the close-out record is at the end of this entry).** For M30's open
      finding. Code and tests committed as `3f3a861`; the scripted results and checklist as
      `da35b0e`; the human results as `bcb60a2`.

      **Recon (live model, faked connectors, 12 calls).** The M30 harness, copied, now saving each
      raw answer's kind and arguments; "create a linear issue and send to fun", M28's long
      clipboard, no email open; gpt-5-mini at low effort.

      | Log | Trials | Dropped the send | Kind of every drop |
      |---|---|---|---|
      | fresh per trial | 6 | **3** (#1, #4, #6) | lone tool call (3 of 3) |
      | shared across trials | 6 | 0 | — |

      No one-step plan dropped it. The three answers are a lone `linear__create_issue` with the
      clipboard as copied as the description. Saved, with the clipboard replaced by a marker, in
      `tests/fixtures/sendDropped/drops.ts` with M28's "create only" trial and row 559 (its real
      title and description replaced). Why a fresh log drops more is not known; the previous turn
      a shared log hands the model (the last trial's cancelled create) is one difference.

      **What shipped** (§5b, "A send the instruction asked for, missing from the answer"):
      `checkDroppedSends`, `asksFor`, `channelKnowledge`, `droppedSends`, `isDroppedSendRefusal`
      and `DROPPED_SEND` in `core/chain.ts`; `Tool.askedWithCreateBy`, declared by `sendMessage`
      only; the check on the plan path (before the one-step branch) and the lone-call path in
      `planner.ts`, and kept out of the previous turn. `scripts/m30-say-refusal.ts` gains
      `--dropped-send` for the sound check. No prompt change.

      **Decisions taken in the build, against the plan as written:**
      - **A sibling field, not `askedForBy`.** Reusing it would put `sendMessage` under M30's
        check whenever a send step came before a create, refused with the summarize/reword
        wording.
      - **The destination rule is stricter than `settleReferences`,** which takes any bare literal
        as given. A bare name counts only when memory holds its `#channel`; a `#name` or a phrase
        `memory.resolve` turns into a `#channel` also counts. A pure function, with memory passed
        in as `preflightReferences` takes it. The bot-mode channel directory (a network call) is not
        consulted.
      - **The wording** ends "Ask again, or file it and send it as two requests." rather than the
        suggested "Ask again and I will plan both.", which promises a plan the model may not make.
      - **M30's live fixture is not replayed:** its runs were cancelled at a dialog and never logged
        a send planned after the create.

      **Tests.** 58 new; 3350 total.
      - `tests/droppedSends.test.ts` (new, 42), the real registry and connector definitions, memory
        holding the app's own channel facts (`#help`, `#social`, `#fun`, "team" = `#social`):
        the declaration (exact list, on `sendMessage` only, never in the schemas); what memory
        knows; the phrasing set — all 7 asking phrasings ask, all 7 content phrasings do not
        ("ping the team" resolves through "team", so it is not a gap); a `#name` with empty
        memory, a bare name only when known, a resolved phrase and "the X channel", three object
        words and not four, "let ... know", whole tokens and clauses, quotes but not
        apostrophes; the rule on both shapes, a GitHub create, the `functions.` prefix, a send
        before or after the create, no create, no send asked, `sendReply` not the send; the
        refusal text (ASCII, no slash, under the cap, spoken whole) and its row; the replay — 5
        drops refused, 77 recorded answers not, M28's eval: only "create only" refused, 32
        asking-and-kept not.
      - `tests/planner.droppedSends.test.ts` (new, 16), the real planner with made-up tools: a lone
        create refused before the dialog with one row, no chain and no miss; judged after the
        multi-call retry; controls (no send asked; a channel nobody taught); a one-step plan and a
        plan with another kind of send refused; names logged as sent; create > send and send >
        create run; no create runs; the clipboard is not judged, both directions; kept out of the
        previous turn, with its control; a real Linear create over a fake MCP server sends
        nothing; a detached job refused before admission.

      Mutations (each made with the Edit tool and undone with it; the tree checked clean after):

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Refuse on the lone-call path | check disabled there | 5 |
      | Refuse on the plan path | check disabled there | 4 |
      | A word needs a known destination | any send word counts | 11 |
      | Judge the instruction | judge the clipboard text, both call sites | 10 |
      | `sendReply` is not the send | any step named send/reply satisfies it | 2 |
      | Kept out of the previous turn | exclusion dropped | 1 |

      All six were caught the first time.

      **Scripted live verification (2026-10-23, 24 calls, the check built in).** Fresh log per trial,
      Cancel at every dialog, every connector faked as in the recon.

      | Instruction | Trials | Refused by M31 | Ran: create > send, cancelled | Other | Creates / sends at the fakes |
      |---|---|---|---|---|---|
      | "create a linear issue and send to fun" | 12 | 3 (lone tool calls) | 6 | **3**: summarize > create > send, refused by **M30** | 0 / 0 |
      | "create a linear issue and post in fun" | 6 | 1 (lone tool call) | 3 | **2**: summarize > create > send, refused by **M30** | 0 / 0 |
      | "create a linear issue" (control) | 6 | 0 | — (6 lone creates, each to its dialog, cancelled) | 0 | 0 / 0 |

      **The five "other" trials** are outside the two endings the plan allowed, so by its own
      wording they are failures. They are M30's check working: each plan put an unasked summarize
      step before the create, and each was refused with M30's exact wording before any preview
      or dialog, with nothing at the fakes. **This is the first time M30's refusal was seen against
      a real model plan** (M30's own scripted run, with a shared log, saw 0 in 12). No trial ended
      any other way. Dry run, scripted (no model): a lone create and a one-step plan for "create a
      linear issue and send to fun" are both refused with the exact wording, no preview, no
      dialog, nothing filed.

      **Model calls:** 36 (recon 12, verification 24), est. ~$0.058.

      **Build record (2026-10-23).** `npm test`: **3350 passed across 142 files, 96 skipped**. Both
      typechecks clean.

      **Known gaps:** §5b's list (only sends are checked — row 559's Notion step is not; a channel
      memory was never told about; four object words; a known destination inside the content; a
      refusal costs a try). M28's prose question with nothing waiting is not touched.

      **Live, by a person (2 of 2 ticked, 2026-10-23).**
      - **H1.** The refusal heard through real Piper (`scripts/m30-say-refusal.ts
        --dropped-send`): natural, no slash.
      - **H2.** In the real app with text copied, "create a linear issue and send to fun" showed
        Step 1 of 2 (create, then send). Cancelled at the Linear dialog; nothing filed.

      **Close-out record (2026-10-23).**
      - **Tests: 3350 passed across 142 files, 96 skipped; both typechecks clean.** Plain `npm
        test` could not run: the dev app from H2 held the SQLite binary that its pre-step
        rebuilds (EBUSY/EPERM). The suite ran with `better-sqlite3` aliased to a scratch node
        build of the same version (12.11.1).
      - **Recon:** fresh-log trials dropped the send 3 of 6, shared-log 0 of 6, every drop a lone
        tool call.
      - **Mutations:** six, all caught (table above).
      - **Scripted live:** 36 real planning calls, est. ~$0.058 (tables above).
      - **Eval skipped** (not run against the real model).

      **Proven vs. live-only.**
      - **Proven by tests against `MockShell`:** the rule on every drop on record and every kept
        send; both paths, the multi-call retry and a detached job; the row, the miss and the
        previous turn; the clipboard never judged.
      - **Scripted, with the real model and faked connectors:** 4 drops refused, 9 create > send
        plans reached the dialog, the control never refused, nothing at the fakes.
      - **Seen only live:** the real app's create > send preview and dialog (H2); the real speech
        engine saying the refusal (H1).

      **Open findings, not fixed in M31:**
      1. **Refusal rate.** 9 of 18 scripted send requests were refused (4 by M31, 5 by M30), so a
         person re-asks about half the time. Candidate, M32 or later: on either refusal, ask the
         model once more with the missing or unasked step named, and refuse only if the second
         answer fails too. It needs an eval with controls and a model-call budget. Replay can test
         the trigger and the wiring with a scripted second answer.
      2. **A Slack channel never taught to memory is not a destination,** so a drop there goes
         unrefused. Candidate: consult the bot-mode channel list. That is a network call, so it
         needs a design decision first.
      3. **Only sends are checked.** Row 559 also dropped a Notion step.
      4. **Why a fresh action log drops (and adds unasked steps) more than a shared one is
         unknown.** Recon: 3 of 6 against 0 of 6. M30's shared-log run saw 0 unasked steps in 12;
         M31's fresh-log run, 5 in 18.
      5. **Known gaps already in §5b:** more than three words between "send" and "to"; a known
         channel inside the bug text ("the share button in #social crashes"); M30's "file a
         one-line issue from this" and "sum the whole thing up".
      6. **A prose reply live (H2's earlier try).** "create a linear issue and post in fun" got a
         prose answer asking for a "close-out prompt" text and which channel "Claude Code" is. No
         tool ran and nothing was filed. Sejal's reading is that the model took the chat page on
         screen as context. It is the same family as M28's and M29's prose-reply finding. For
         the small-items milestone: investigate what context the model was given (screen text
         from the focused page?) before changing anything. *(M32 found the cause: row 666's
         rewrite, through the previous turn and the clipboard, not the screen. See M32.)*

- [x] **M32 — small items: a second hotkey press during voice capture; a stale previous turn and
      framed prose; the date and time together; Escape with the pill list open.** **Closed
      2026-10-30, after a live run by a person (6 of 6 boxes ticked — `docs/M32-live-checklist.md`),
      with fixes A and B unproven live and seven open findings (the close-out record is at the end
      of this entry).** Four code commits (`cee6da6`, `7f73d3e`, `ffff188`, `8c2afb6`), the
      scripted results and checklist (`4db4c6c`) and the human results (`03944ee`). Tests ran
      with the scratch SQLite build throughout: the dev app held the real one.

      **1. A second instruction-hotkey press during voice capture** (`cee6da6`; §5b, "State, and
      the hotkeys"). Ignored and logged while the bar's `VoiceSession` is recording, stopped or
      transcribing; idle (typing) still starts over. Tests (`tests/instructionHotkey.test.ts`,
      +5): an async stateful fake voice in each busy state (no detach, no `showInput`, no run,
      the first capture's text delivered once); idle as the control; the real `VoiceSession` with
      a slow fake transcriber (a press mid-recording submits nothing; mid-transcription, the first
      instruction runs once). One case flaked once under full-suite load: it waited a fixed 40 ms
      for a fake's 20 ms transcription. The waits on outcomes now poll, and that fix went in with
      commit 2.

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Ignore a press during capture | guard removed | 4 (and 4 again after the polling fix) |
      | Every busy state counts | only "recording" | 3 (and 3 again) |

      **2. A stale previous turn, and the model's prose framed** (`7f73d3e`; §5b, "The previous
      turn's age, and a reply in the model's own words").
      - **Why the prose reply happened (finding 6 of M31).** Row 666's rewrite reached the model
        through the previous turn and, very likely, the clipboard; no screen text is captured.
      - **Recon, before the change** (live, 6 calls). Row 667's setup in the M30/M31 harness: a
        "rewrite this politely" turn 152 minutes old whose result asks to send Claude Code a
        close-out prompt (neutral wording), the same sentence on the clipboard, and "create a
        linear issue and post in fun". **0 of 6 gave prose**: all six planned create > send and
        reached the dialog (the old previous turn was sent every time). The prose reply did not
        reproduce in 6 trials; the two live cases are the evidence. A and B were built as planned.
      - **Built.**
        - A: `PREVIOUS_TURN_MAX_AGE_MS` = 10 minutes, with an injected clock (a new last
          `Planner` parameter, `now`).
        - B: `PROSE_LEAD` = "Nothing ran. The model said: ", spoken through `toSpokenWithLead`
          (`toSpokenResult` gained an optional cap).
        - `PlannerOutcome.reply` for the `[main]` line.
      - **Tests** (`tests/previousTurnAndProse.test.ts`, new, 18):
        - turns timed like 642/647 and 666/667 get none; 2 minutes old is sent whole; at the
          cutoff it is sent and one second over it is not;
        - a correction and "send it" after a draft inside the window keep their turn; two runs
          in a row; an unreadable timestamp; the real default clock;
        - framed prose on the bar, in speech and on the outcome; a long reply (the lead spoken
          whole, the first cut under the cap, never landing on the lead, the rest held);
        - the fixed refusal and an unknown tool unframed; the `[main]` line both ways; M30's
          and M31's refusals untouched.
        - **Re-justified, not just re-run:** three tests pinned prose shown verbatim
          (`planner.test.ts`, `planner.multicall.test.ts`, `voice-integration.test.ts`). They
          now pin it after the lead, and still check that the model's words, not the canned
          refusal, are what is shown.
        - recorded.json's 77 answers and the M31 fixtures are judged by the pure checks, which
          this did not touch; their suites stay green.

      | Rule | Mutation | Caught by |
      |---|---|---|
      | Drop a stale turn | no cutoff | 3 |
      | Only stale turns are dropped | the cutoff applied to fresh turns | 5 |
      | Prose is framed on the bar | shown unframed | 5 |
      | The lead is spoken | dropped from speech | 2 |
      | The lead survives the spoken cap (extra) | spoken under the full cap | 1 |

      **Live, after the change** (12 calls, fresh log per trial):

      | Setup | Trials | Ran to the dialog, cancelled | M30/M31 refusal | Prose | Other |
      |---|---|---|---|---|---|
      | Row 667's setup (previous turn 152 min old) | 6 | 5 (create > send) | 1 (M30: summarize > create > send) | 0 | 0 |
      | Corrections 40 s after a cancelled create | 6 | 4 | 0 | 0 | **2** |

      In all six of the 667 setup the previous turn was not sent, and in all six corrections it
      was. The two "other" corrections, with their plans:
      - "actually, post it in social instead" planned `remember` with `team` = `social` and ran it
        (reversible, no dialog). The harness memory discards writes, but in the app this would
        replace the fact `team` = `#social` with the bare word `social`. A finding (below), not
        caused by M32: the previous turn was sent as before.
      - "no, I meant the social channel" planned `sendMessage` with "the social channel" and was
        refused by its own reference check. That is a harness artefact: its memory holds only
        `#fun`, where the app's holds `social channel` = `#social`. Nothing ran.

      **3. The date and time together** (`ffff188`; §5c, "`tellTime`"). `what: "both"`, one
      description sentence, and *"It's Friday, 23 October, 5:41 PM."*. Tests (`tests/tellTime.test.ts`,
      +8): literal answers for both in two zones, ASCII, the other two answers unchanged, assembly
      from hostile ICU parts, the schema, the planner, the spoken form. Mutation: "both" handled as
      time, caught by 5. Eval (15 calls, no email, nothing copied), before and after:

      | Phrase | Before (enum time/date) | After (time/date/both) |
      |---|---|---|
      | "what's the time" | `time` (1/1) | `time` (1/1) |
      | "what's the date" | `date` (1/1) | `date` (1/1) |
      | "what's the date and time" | `time` — only the time answered (1/1) | `both` (2/2) |
      | "what day and time is it" | a two-step plan, date then time; only the time shown (1/1) | `both` (2/2) |
      | "remind me at 3 pm tomorrow" (control) | `createEvent` (2/2) | `createEvent` (3/3) |

      No control regressed, so the prompt change stands.

      **4. Escape with the pill list open** (`8c2afb6`; no behaviour change). Tests: with the bar
      hidden by another route the app holds no Escape (`WindowsShell.capture.test.ts`, +1), and
      `escapeAttached()` before and after a job's first step leaves an open list open
      (`pill.collapse.test.ts`, +2). The dictation-hotkey collapse already had its test
      (`pill.collapse.test.ts`, "the dictation hotkey collapses it too"). Not part of the plan:
      keeping Escape registered after a hide was caught by 2. Whether the real OS hands Escape to
      the front app is a person's check (H4).

      **Model calls: 33 of the 40 allowed**, est. ~$0.032 (recon 6, after 12, time 6 + 9). One
      more run was refused by the spend gate with no call made: its per-run counter folder,
      keyed by process ID, had been left by an earlier run with the same reused ID. It was re-run.

      **Build record (2026-10-23).** `npm test` (scratch SQLite): **3384 passed across 143 files,
      96 skipped**. Both typechecks clean.

      **Deliberately not done.**
      - From finding 6: keeping a content tool's result out of the previous turn, re-asking once on
        prose, and relabelling or capping the clipboard. Each changes the planning prompt and
        needs an eval with controls.
      - "What did that job say?" waits on decisions that are yours: which job (the newest finished,
        one matched by its instruction's words, or ask), which states (done only, or failed and
        cancelled-after-a-step too), a time window, whether reading it marks it seen (the pill's
        one-minute clock), a new tool or an extension of `jobStatus`, how stored text (possibly a
        model's, possibly your clipboard's) is spoken, and background jobs only or also ones
        watched in the bar.

      **Findings at the build** (carried into the close-out's open findings below).
      1. **A correction can plan a memory write that replaces a fact.** "actually, post it in
         social instead" planned `remember team = social`. It is `reversible` and runs with no
         dialog; in the app it would overwrite `team` = `#social`.
      2. **A stale clipboard is still sent whole.** Only the previous turn ages out.
      3. **The spend gate's counter can be reused across runs** when a process ID repeats within
         12 hours. It fails closed (no call made), and costs a re-run.

      **Live, by a person (6 of 6 ticked).**
      - **H1** (passed, 2026-10-29): a second instruction-hotkey press during recording and
        during transcription.
      - **H2** (passed, 2026-10-29): the framed prose wording heard through Piper.
      - **H3** (passed, 2026-10-29): the date and time answered together, heard.
      - **H4** (passed, 2026-10-29): with the pill list open and another app in front (Win+R),
        Escape reached that app and the list stayed open. **Decided: Escape does not close the
        list**; no change.
      - **H5** (passed, 2026-10-29): Word dictation landed at the caret. One Ctrl+Z removed the
        dictated sentence with the 3-4 blank lines typed just before it; a sentence typed by hand
        after 3-4 Enters undid the same way, so it is Word's own typing-run grouping, not the app.
      - **H6** (passed, 2026-10-30): terminal dictation, reported as "h6 passes" with no further
        detail.

      **Close-out record (2026-10-30).**
      - **Tests: 3384 passed across 143 files, 96 skipped; both typechecks clean.** Plain `npm
        test` could not run: an electron instance still held the SQLite binary its pre-step
        rebuilds (EBUSY/EPERM). The suite ran with `better-sqlite3` aliased to a scratch node build
        of the same version (12.11.1).
      - **Model calls:** 33 of the 40 allowed, est. ~$0.032.
      - **Eval skipped** at the close (not run against the real model).
      - **Mutations:** every one caught (the tables above).

      **Proven vs. live-only.**
      - **Fixes A and B are verified by tests and by the two log rows (647, 667), not live.** The
        prose reply did not reproduce in the scripted run: 0 of 6 before the change and 0 of 6
        after.
      - **Seen live:** the hotkey guard (H1), the framed wording and the combined date-and-time
        answer through real Piper (H2, H3), Escape's routing with the list open (H4), and
        dictation into Word and a terminal (H5, H6).

      **Open findings, not fixed in M32:**
      1. **A correction can plan a memory write that overwrites a fact.** "actually, post it in
         social instead" planned `remember` with `team` = `social`, which would replace `team` =
         `#social` with the bare word "social". It is `reversible`, so there is no dialog. A real
         hazard. **The first item of the next investigation:** how often a correction becomes a
         `remember` call, and what the guard should be.
      2. **"no, I meant the social channel" was refused by `sendMessage`'s own channel lookup** in
         the scripted run, because the in-memory stand-in held only `#fun`. A test-setup artefact;
         nothing to fix unless it reproduces.
      3. **Prose replies.** A (the ten-minute cutoff) and B (the framed lead) are unproven live,
         because the prose reply did not reproduce. Watch for it in real use.
      4. **Left out of M32 on purpose.**
         - "What did that job say?": its open decisions are which job, which states, a time
           window, whether reading marks it seen, a new tool or `jobStatus`, how stored text is
           spoken, and background jobs only.
         - The investigation's fixes C, D and E: a content-free previous turn, re-asking once on
           prose, and relabelling or capping the clipboard. Each needs an eval.
      5. **M31's refusal rate is still open.** About half of live send requests are refused and
         need re-asking. Candidate: re-ask once; needs an eval.
      6. **From M31:** a Slack channel never taught to memory is not a destination; row 559's
         missing Notion step.
      7. **The spend gate refused a run once** because Windows reused a process ID from an earlier
         run that held a slot. Re-running fixed it. Noted, not fixed.

**v0 status: complete.** *(The counts in this paragraph are history, as of M19, 2026-10-09; the
current count is in M27's close-out record above.)* **1214 tests green** (`npm test`) across 63 files, plus 55 skipped —
the opt-in real-model evals, which make no API calls unless asked. M19 added 132 over M18's
993, in five new files: 17 for the connection and failure classification
(`mcpConnection.test.ts`), 16 for the config loader (`mcpConfig.test.ts`), 50 for the adapter,
tiers, flattening and formatters (`mcpAdapter.test.ts`), 7 for the loader (`mcpLoad.test.ts`),
40 for the planner end to end (`planner.mcp.test.ts`), and 2 new registry invariants in
`risk.test.ts`. The first live finding (the covered confirm dialog, 2026-10-09) added 13 more in
`WindowsShell.capture.test.ts`, taking 1125 to 1138; finding 4 (verb wording, the clipboard
confirm label, the `[main]` line) added 30 more, taking it to 1214; findings 2 and 3 (the email hint, the `functions.` prefix, refused-plan logging) added 46 in `contextHints.test.ts` and `planner.mcp.test.ts`, taking it to 1184. The M18 count follows: 993 across 57 files, plus 46 skipped. M18's live pass added 49 to
the 944 it shipped with: the input-host protocol layer (`hostChannel.test.ts`), the percent
conversion and wording, and the not-installed launch failure. As shipped, M18 added 146 over
M17's 798, in five new files: 28 for the app catalog (`apps.test.ts`), 40 for the launch table
and `APPS_EXTRA` (`appLaunch.test.ts`), 14 for `openApp` through the planner plus the
`openTarget` split (`openApp.test.ts`), 22 for the media-key mapping and press policy
(`mediaKeys.test.ts`), 32 for the three local-control tools (`localControls.test.ts`), 1 for the
two-step chain, and 9 from M18's own result strings entering both `speech.test.ts` fixture
sweeps. The historical count follows. (M17 added 123 over
M16's 675: 19 for the plan parser, 37 for the chain gate (32 original, plus 5 for
`previewHoldRemaining`), 9 for the chain state, 30 for chained planner runs (26 original, plus 4
for the preview read-time hold) including the pending-confirm regression at step N of N, 5
re-justifying the system prompt after its one-tool rule changed, 12 across the two hotkey guards,
1 closing the gap between those two guard suites with a real chain wired to the real hotkey
handler, and 10 for `classifyToolCalls` — the fix for the multi-tool-call live bug above). The
count below is the pre-M17 history. Through M12.1 that
was 242 — 63 for v0, 24 added by M7, 37 by M8/M9, 41 by M10, 36 by M11, 30 by M12, and 11 by
M12.1 (M12.2 added no new tests — all four fixes are covered by existing coverage, adjusted
where a fix changed an assertion's shape; see §9's M12.2 for specifics). M13 and M14 added 259
between them. M15 (including M15.1's provider swap and its size-confidence gate) added 96, all
of which were later deleted with M15 itself at M16.10; M16 nets +78 over the pre-M15 total —
built up through the milestone, cut down by M16.10's deletions, then built back up again by
M16.11's live-bug fixes and the tests they added. (Against `MockShell`, fake Gmail/Notion tabs,
jsdom fixtures, a `MockInputInjector` standing in for real `SendInput`, and — from M16 —
`FakeElements`, `FakeChooser`, and a `FakeScreen` with no screenshot fixture left to carry; no
browser, inbox, Notion account, OS keystroke, or screen capture is ever touched by the test
suite, and — unlike M15 — no image is ever constructed to be sent, because none is sent.) The
eval harness
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

### M15.1 — the provider swap, and what running the probe actually found

Anthropic billing was blocked upstream (mandate registration succeeds, the charge fails), so the
milestone's central open question was answered on **OpenAI / `gpt-5`** instead. The swap cost one
adapter and one constant — `ModelVisionLocator` never changed, which is the `VisionApi` seam
earning itself — but it was **not** cosmetic, and the reason is the finding:

**GPT-5 answers pixel coordinates in the space OpenAI RESIZED the image to, not the space we
sent.** With `detail: "high"` (which is required — without it the model cannot reliably find a
control at all) the API scales the image so its SHORTEST side is 768. Measured against a fixture
whose element positions were read out of the DOM:

| frame sent | boxes landing inside the target button |
|---|---|
| 1568x823 (the M15 long-edge rule) | **0 / 4** — consistently ~36px high, centre on nothing |
| 1463x768 (shortest side 768) | **4 / 4** |

Normalised 0-1 coordinates were tried as the alternative fix and were **worse**: 2/4, and both
failures landed on a *different button*. So the fix is to remove the mismatch at source rather
than compensate for it — `core/vision/frame.ts` holds the per-provider frame rule, it travels
with the locator so the two cannot be chosen independently, and `geometry.ts` never learns about
any of it.

**The three probe cases, on the verified path:**

- **Absent target** → `notFound`, both for an obviously-absent thing ("the espresso machine") and
  for the harder case of something plausible on that UI but not present ("the print button"). It
  declined rather than inventing a box. *This is the assumption the whole milestone rests on, and
  it holds.*
- **Visually similar decoy** — Send and Discard side by side, same size, same pill shape, 119px
  apart. Asked for each specifically: both correct, verified by drawing the returned box over the
  screenshot and looking. Neither drifted onto the other.
- **Ambiguous** → `ambiguous` with candidates named. Asked for "a button" it listed all five;
  asked for "the red button" it named Discard *and* the red window-close circle rather than
  picking.

**The real accuracy gap, and it is not a footnote.** Boxes carry a systematic offset of roughly
**+20px right and +12px down**. On a 95-130px button that is absorbed — the centre stays well
inside. On a **small icon it is not**: asked for a 39px settings gear and a 41px paperclip, the
centre landed outside the target **0/4 times**, while the box SIZE was near-perfect. So the model
knows how big the thing is and is slightly wrong about where — and at the time this was first
written, `core/vision/locate.ts`'s checks did NOT catch it: the box is in-frame, plausibly sized,
and tight, so it passed everything and became a marker ~20px off the icon.

**M15.1 closed that gap with a REFUSAL, not a correction.** `SMALL_TARGET_PX` (40, in image
pixels, checked on the box's shorter side) now refuses rather than points below that size —
labelled `imprecise`, a fourth `PointingRefusal` distinct from `not-found`: the thing genuinely
is on screen, the model just cannot be trusted to aim at it, so the message says "click it
yourself" rather than "try rephrasing". The number is explicitly a **placeholder from four
samples**, commented as such in the code, not a bias correction — nudging the box by +20px would
require confidence this milestone does not have, where refusing requires only knowing where the
measured failures started. That is tolerable for the "point, don't click" design in a way it
would not be for auto-click: an unhelpful refusal costs a rephrase or a manual click, not a
misfired action.

**What is still open:** whether 40px is the right line for real (non-fixture) application icons,
and whether a single flat threshold is even the right SHAPE of fix once there is more than four
samples behind it. Revisit both from evidence, the way `EDGE_TOLERANCE` and `MAX_FRAME_FRACTION`
were tuned, not from this fixture alone.

**Latency is the other cost.** 7-46s per call, typically ~20s, against the planner's own 6-13s.
The "Thinking…" indicator covers it, but a "where is X" that takes half a minute is a different
interaction from one that takes three seconds.

### M16 — known limitations, carried deliberately

Recorded here rather than left implicit, because both are things a future reader would otherwise
have to rediscover.

- **Multi-monitor DPI math has never run on real multi-monitor hardware.** The native-pixels →
  DIP conversion (`core/screen/geometry.ts`) translates the physical origin before scaling and
  adds the DIP origin after, which is the correct form on a desktop spanning displays with
  different scale factors. It is unit-tested against hand-derived values — including a test that
  asserts the *specific wrong answer* the un-translated formula would produce — but the machine
  this was built on has exactly one display, so every term that is zero there has only ever been
  exercised as a literal in a test. Same category of unverified-for-lack-of-hardware gap as this
  project's Mac shell (§4): the interface and the arithmetic are written for it, nothing has run
  against it. On a single display the wrong formula and the right one agree exactly, which is why
  this is worth writing down instead of trusting a green suite.

- **`pointAt` cannot target this app's own UI.** The target window is snapshotted *before* the
  command bar takes focus, so the bar is never a candidate — and the app is itself an Electron
  window, which is the class of window M16's recon found returning a bare accessibility tree
  (R1/R1a). Asking the app to point at itself is the one limitation a user is most likely to
  trip over first.

- **Some windows expose no controls *right now*.** Deliberately present tense: recon measured
  Claude desktop flat at 14 elements (window frame only) across 9.4 seconds, and then fully
  populated an hour later in the same process. "This app is unsupported" is not a claim the code
  can make or that the docs should.

- **Every Chromium window pays a ~460ms settle delay**, whether or not its tree was ever going to
  move, because the trigger is the window class alone. Native windows pay nothing. Accepted as a
  correctness-over-latency trade; the sound optimisation (a per-window-handle memo of "already
  seen settled") is named but not built. **Confirmed live at M16.11 (2026-08-27): the wait —
  ~1.5–2s total on a real VS Code window, one 350ms settle plus the read — is noticeable but not
  annoying.** `SETTLE_MS` in `core/screen/settle.ts` was left at its measured value on that
  basis, a decision rather than an open question.

- **`-Command -` may not reliably deliver stdin commands to a PowerShell host** (found M16.8,
  not acted on). M16's UIA host printed `READY` and answered nothing under that invocation, and
  the same was reproduced against `WindowsInputInjector`'s own unmodified script driven from
  node. M16 switched to `-File`; M12 was left alone because shipped dictation works and runs
  under electron's spawn, where the behaviour may differ. Full note and the symptom to watch for
  are in `src/main/shell/WindowsInputInjector.ts`.

- **The taskbar, the desktop, and open popup menus are out of scope.** They are separate
  top-level windows, and enumeration is scoped to the foreground window.

### M19 — proven vs. live-only

**The live pass was run on 2026-10-08/09 and the box is ticked — with named gaps.** A person
saw the proof chain work, the step 2 and step 3 dialogs fully visible, and the short instruction
plan three steps with the real email in one live run (the clipboard's contents for that run
were not recorded). **A later live run failed**: with a long block of text on the clipboard the
same instruction planned two steps and offered the clipboard as the issue — finding 4 below.
Plan choice with a non-empty clipboard is unreliable, and is not claimed as fixed.
**Not run live, resting on tests alone:** the decline and failure cases, the long-email dialog,
the injected-instruction email, and the `functions.` prefix rule. `docs/M19-live-checklist.md`
has the per-item record and "Live results 4" lists the gaps. *(The rest of this section was
written before the pass; "What the live pass has found" below is what it turned up.)*

**Measured against the real thing, by script, read-only** (weaker than a person seeing it, and
marked as such in the checklist):

- `scripts/linear-recon.mjs` — the live server's 59 tools, their schemas and hints, the shape of
  a read result, the wording of five failures, and a rejected key. Every fixture in
  `tests/fixtures/linear/` is transcribed from it (sanitised: workspace, team and user names and
  UUIDs replaced; structure untouched). The **create** result shape was captured once, by hand,
  during recon — the only real issue anything automated-adjacent has made (`SEJ-5`).
- `scripts/linear-live-check.ts` — the **real adapter** over the real transport, driving only the
  tools whose pinned tier is `safe`. Passed 2026-10-07: both reads resolved to `safe` under the
  live hints, the code-fixed `limit` and `fields` were accepted by the live schema (the drift
  check ran against a real `tools/list`), the formatters read live results, and a missing issue
  came back as *"Linear said no: Could not find referenced Issue."* It also found that search is
  fuzzy.
- The SDK under Electron 33's real main process, ESM and CJS, and `npm run build`.
- The native confirm dialog with long text: at 5k, 10k, 20k and 40k characters UI Automation
  reports the whole string present, the window capped at the work-area height, the body in a
  scrolling pane, and both buttons on screen. A 20k dialog took more than 1.5 s to appear.

**Proven deterministically (132 new tests, no key and no network).** The protocol is *not* faked:
`tests/FakeMcpServer.ts` is the SDK's real `Server` on its real in-memory transport, talking to
the real `Client` inside `SdkMcpConnection`. Its rules are written from the recon captures and
from the server's captured schema, not from the adapter. Covered:

- **Tool listing and naming** — namespaced names, this repo's descriptions and schemas (asserted
  to share nothing with the server's captured ones), the remote name never shown to the model,
  and the menu built without a connection.
- **Argument validation** — `id` on create is refused and never sent, as is every other field
  the remote tool would have accepted; the fake implements the update half *on purpose* so this
  can be proven rather than assumed. Model-supplied `limit`/`fields` refused; fixed-wins proven
  against a definition that deliberately allows the key.
- **Connector failure** — rejected key, timeout, server-side throw, dropped link (reconnect on
  the next call, never a re-send), each as the real SDK error type with the captured code and
  message.
- **Disabled connector**, missing key, no config file, malformed config, a config naming a
  remote tool or a connector the build does not define.
- **Tier defaults** — unclassified → caution, dangerous-sounding names on either name, hints
  raise and never lower, absent hints ignored, a failed tier read escalating and then refusing.
- **Drift** — remote tool gone, a fixed argument no longer accepted, a newly required argument.
- **Injected instructions**, both directions: an instruction-shaped email becomes a ticket body
  and nothing it says happens (one planning call, one create, zero updates, Slack to the planned
  channel); an instruction-shaped ticket body is posted as text.
- **Declining a confirm stops the chain** at step 2 and at step 3, with `MockShell.holdConfirm`
  so the dialog genuinely blocks and "nothing was touched while it was up" is asserted *during*.
- **A failed middle step means later steps never run** — refused by Linear, unreachable,
  unreadable result, timeout — each a `ConnectorError` raised by the real adapter, never a bare
  `Error`, and the Slack dialog never shown.
- **Verbatim send** — the Slack text equals the confirm text exactly, with zero `complete` calls;
  the standalone path asserted unchanged.
- **A 20,000-character description** carried whole into the confirm text.

Seven rules were checked by breaking the code and watching a test fail (ignoring `isError`,
skipping validation, letting hints lower a tier, leaving memory resolution on, marking chain
steps unchained, skipping `prepare` in the confirm summary, previewing the chained message).
One mutation **survived** — "model arguments win over fixed ones" — because Linear's own
schemas reject the key before the merge is reached; a test against a permissive definition was
added to close it.

**Live-only, and genuinely unverified.**

- Whether a real model **chooses `plan`** for the bug-report instruction, and whether the worked
  example helps or over-teaches. The opt-in eval measures it; it has not been run.
- Whether the model writes a sensible **title** from a spoken sentence.
- Whether `app.getAppPath()` finds `connectors.json` under `npm run dev`.
- Every rendered thing: the plan preview, the `Step 2 of 3:` dialogs, whether the long-text
  dialog actually scrolls for a person, how a result with a URL and an identifier like `SEJ-5`
  **sounds**.
- The first-call latency of a lazily opened connection.
- A real create through the adapter. Deliberately never automated.

**What the live pass has found so far (2026-10-09).**

1. **The confirm dialog was covered by the instruction bar.** On the first live chain, step 3's
   dialog opened behind the bar with its text and both buttons hidden. The bar is an
   always-on-top window in the centre of the screen and the dialog was unparented in the same
   place; what had kept them apart since M5 was a side effect (the dialog takes focus → the bar
   blurs → the blur handler hides it) that only works for a bar that *had* focus. A chain's
   step result re-shows the bar with `showInactive()`, and an unfocused window never blurs.
   **Fixed in `WindowsShell.confirm()`**, with three rules that now hold for every confirm, not
   only chained ones:
   - the dialog is **parented to the bar window** — Windows keeps an owned window above its
     owner whatever the owner does, and an owned window of a topmost window is topmost, so
     neither the bar nor another application can cover it;
   - the bar is **hidden for the dialog's lifetime** by a plain window hide (not the dismissal
     path: no capture is ended, nothing is reset) and **restored afterwards if it was showing**,
     unfocused, with the same auto-hide an unfocused result gets;
   - **while a confirm is pending, nothing shows the bar, arms the global Escape, or runs the
     dismissal path** — `narrate()` and `showResult()` deliver their text and leave the window
     alone, `registerEscape()` refuses, and a blur is ignored. This closed a second route into
     the same bug: the hotkey's "there's a confirmation waiting" re-showed the bar over the
     dialog and took Escape back from it.

   The hotkey guard order is unchanged (dictation → confirm pending → chain running), and
   Escape on a focused dialog is still the dialog's own Cancel. 13 more tests in
   `tests/WindowsShell.capture.test.ts` hold the dialog open and assert what the shell did with
   the window while it was up; ten rules were broken one at a time and all ten are caught (one
   survived the first pass — a test step ran after `narrate()` had already cancelled the timer
   it was meant to exercise — and was reordered). One existing test was **re-justified rather
   than re-run**: "does not re-arm after the dialog if the bar was hidden in the meantime" set
   itself up by hiding the bar mid-dialog, which `confirm()` now does itself, so its
   precondition distinguished nothing and its expectation had become wrong. **None of that
   proves the dialog is visible**: z-order is something Windows does with real windows, so
   `scripts/confirm-zorder-recon.cjs` measures it (0/9 points on top before, 9/9 after) and the
   re-check by a person is in the checklist.

   One visible change outside chains: a **declined lone confirm** used to leave the bar hidden;
   it now comes back briefly and hides itself.

2. **A plan that skipped `readEmail` filed an issue about nothing.** "File this bug in Linear and
   tell the social channel", with a bug email open, was planned as two steps — create, then
   send — and the create's description was written by the model ("Filed from the desktop
   assistant. User instruction provided: …"). The confirm gate fired and was approved, so a real
   issue (SEJ-7) was created with no email in it; step 2 then refused on an unknown channel. The
   same words a minute later came back as chat asking for the details. Cause: the planner sees
   only the clipboard — `WindowsShell.getContext()` returns null for the window title and app —
   so "this bug" pointed at nothing, and no wording said that content the user is pointing at
   must be *read by a tool*, never invented or asked for. **Fixed by wording only (Part A)**, in
   three places: the planner prompt (never invent content, never ask for what a listed tool can
   read; plan the read as an earlier step), `readEmail`'s description ("this email / this bug /
   this report" → `readEmail` first), and `linear__create_issue`'s description (the description
   is the user's words or an earlier step's result, never made up; omit it if there is nothing).
   Measured with the opt-in eval, three trials per phrase, as the app sees it (no window title):

   | Phrase | Before | After |
   |---|---|---|
   | file this bug in Linear and tell the social channel | 3/3 | 3/3 |
   | log this as an issue and let #bugs know | 2/3 (one chat reply) | 3/3 |
   | find the login issue in Linear (single-tool control) | 3/3 | 3/3 |
   | reply to this and send it (must not gain `readEmail`) | — | 3/3 |

   **What that does and does not show.** The control held and nothing was over-taught. But the
   live-failing phrase already passed 3/3 *before* the change — the eval never reproduced the
   live failure, so it cannot show the change fixed it. The live run differed in ways the eval
   does not model: whatever was on the clipboard, and the previous turn in the prompt. The
   earlier single-trial run also had this phrase's neighbour choose `summarize` once. Treat the
   wording as a reasonable tightening with a clean bill on over-teaching, not as a proven fix;
   the live re-run is what decides it. **Part B — telling the planner that an email is open in
   Gmail — is deliberately not built**, and is to be proposed again only if this fails live.

3. **With unrelated text on the clipboard, the same instruction was refused for naming
   `functions.linear__create_issue` — and the refusal was hiding something worse.** Two
   separate things, found together:

   **(a) A provider prefix in a tool name.** OpenAI's models see every tool internally as
   `functions.<name>`. A direct tool call's name travels in a structured field and arrives
   clean; a plan step's `tool` is a string the model types, and sometimes it types the name the
   way it sees it. The action log holds five unknown-tool refusals in two families:
   `functions.linear__create_issue` and `functions.readSchedule` (a real tool, prefixed), and
   `multi_tool_use.parallel` ×2 and `parallel` (the model reaching for parallel calls — naming
   nothing). **Fixed with one rule**, `canonicalToolName` in `core/chain.ts`, applied to plan
   steps and to the single-step path alike: a name already on the menu is kept; otherwise, if
   it starts with exactly `functions.` — once, case-sensitive — the prefix is dropped and the
   remainder accepted **only if it is exactly a name on this run's menu**; anything else is
   returned untouched and refused as before, quoting what the model wrote. The function can
   only ever return a menu name or its own input, so the closed world is not loosened:
   `functions.plan`, a double prefix, `Functions.…`, a mis-cased name, a prefixed real remote
   tool that is not pinned (`functions.linear__save_issue`) and both `parallel` forms all stay
   refused. An automatic re-plan was rejected: a second model call, non-deterministic, and
   against §5b's "consulted once".

   **(b) The plan underneath was wrong.** Re-running the phrase in the eval with unrelated
   clipboard text: **0 of 3** plans read the email. Two filed the *clipboard text* as the bug;
   the third did the same with the prefix. Had (a) been fixed alone, the refusal that kept that
   plan from the confirm dialog would have gone. The cause is the one finding 2 pointed at and
   Part A's wording did not cure: the prompt labels the clipboard "Selected text", and nothing
   told the planner an email was open, so "this bug" had one candidate. **Fixed (Part B)** with
   one line in the planning prompt, `An email is open in Gmail.`, present only when Gmail says
   so:
   - `GmailSurface.hasOpenEmail()` — a new read-only method that reuses `readOpenEmail`'s own
     tab selection, reads nothing from the tab, and **never throws**: no Chrome, no Gmail tab,
     nothing open and two tabs matching are all `false`. Existing Gmail behaviour is unchanged.
   - `core/contextHints.ts` — `emailOpenHint()` runs **concurrently with context capture** under
     an 800 ms deadline (the real check measured 8–42 ms; an unreachable Chrome answers `false`
     in ~1 ms). Slow, failed or unconfigured all mean *no hint* and no delay beyond the
     deadline — the context is then exactly what it was before this existed.
   - **A bare fact, deliberately.** No subject, no sender. Those are words written by whoever
     sent the email, and the planning prompt is the one place text is read as instruction. The
     accepted cost: the model still cannot write a specific title, having still not seen the
     email.
   - The line sits under the instruction and *above* the clipboard text.

   **Logging**, because diagnosing (a) took the action log and a guess: a refused plan's row now
   records every step's tool name **as sent**, in order, in `arguments` (`{ plan: [...] }`) —
   names only, since that row is the previous turn fed to the next planning prompt — and
   `runInstruction` prints the full raw plan, or a refused single tool name, on the console.

   **Measured** (opt-in eval, `gpt-5`, 3 trials each, context as the app now sends it):

   | Phrase | Context | Before | After |
   |---|---|---|---|
   | file this bug in linear and tell the social channel | unrelated clipboard | **0/3** | 3/3 |
   | file this bug in Linear and tell the social channel | clean clipboard | 3/3 | 3/3 |
   | log this as an issue and let #bugs know | clean clipboard | 3/3 | 3/3 |
   | find the login issue in Linear (single-tool control) | clean clipboard | 3/3 | 3/3 |
   | summarize this (must stay `summarize`) | unrelated clipboard | — | 3/3 |

   "After" is with an email open and the hint present. The last row is the over-teaching risk
   the hint introduces — "summarize this" has always meant the clipboard — and it held. 46 new
   tests; nineteen rules were broken one at a time and all nineteen are caught. **Still a
   model's choice measured three times**: the live re-run is what decides it, and the checklist
   has the items. `ChromeGmail.hasOpenEmail` itself is transport and has no unit test; it was
   run against the real debug Chrome.

4. **After the hint shipped, the model still chose the clipboard (2026-10-09).** Bug email
   open; on the clipboard, several paragraphs of unrelated technical text. "File this bug in
   linear and tell the social channel" was planned as two steps — *"File a new Linear issue
   from the selected text"*, then tell the channel — with no `readEmail`. The create dialog
   showed title "Bug report" and the clipboard text as the description, and was cancelled:
   nothing was created. The app was running the fixed build, and the Gmail check answers `true`
   in 7–23 ms against that tab, so the hint was almost certainly in the prompt — *almost*,
   because neither the log nor the console records whether it was sent.

   **Why the hint was not enough**, read off the prompt itself:
   - `readEmail`'s own description, written for finding 2, says *"If the request shows
     selected text, 'this' usually means that text instead."* It predates the hint and now
     contradicts it.
   - The clipboard is labelled **"Selected text"**, which asserts the user chose it. A
     clipboard always holds something.
   - The hint is one short line under the instruction; a thousand characters of clipboard
     follow it and are the last thing the model reads.

   **The eval had been flattering the fix.** Its clipboard case was sixty words about an
   offsite — nothing like a bug, and nothing like a real clipboard. Rebuilt with long text that
   competes for the word "bug" (a message about code; prose with a stack trace), email open,
   hint present, 3 trials each on `gpt-5`:

   | Clipboard | Phrase | Read the email |
   |---|---|---|
   | a message about code | file this bug email in Linear and tell the bugs channel | 3/3 |
   | a message about code | file this bug in linear and tell the social channel | 3/3 |
   | prose + stack trace | file this bug email in Linear and tell the bugs channel | 3/3 |
   | prose + stack trace | file this bug in linear and tell the social channel | **2/3** |

   Intermittent, then, not constant — and three trials per cell cannot tell a fix from luck at
   that rate.

   **Shipped: wording, a confirm label and a log line. The live re-run PASSED (2026-10-09).**
   With the bug email open and a long, bug-related block of text on the clipboard — the
   condition that had failed — a person ran three things, once each: "file this bug in
   linear and tell the social channel" planned three steps from `readEmail` with the real
   email in the description; "summarize this" summarized the clipboard; "reply to this and
   send it" drafted a reply to the open email. Not seen live: the "from your clipboard
   text" confirm line, whose triggering case was not run.
   - **Wording, keyed on the VERB.** Summarize, rewrite, translate, explain and fix act on
     the clipboard text; file, log, reply to and forward act on the open email when one is
     open, even past a clipboard; "this text", "what I copied" and "these notes" always
     mean the clipboard. In the planner prompt and in `readEmail`'s description, whose old
     "selected text wins" sentence is gone. With an email open the clipboard is labelled
     as possibly unrelated and the hint comes *after* it; with none open the prompt is byte
     for byte what it was.
   - **The first version keyed on the NOUN and was not shipped.** "This bug / email /
     message / report means the email" fixed the failing case and broke "summarize this",
     which began answering with `readEmail` (2 of 6, against 6 of 6 on the old wording —
     measured, so a regression, not something already there). A "bare 'this' means the
     clipboard" patch was rejected before it was tried: it would break "log this as an
     issue".
   - **The confirm says where the text came from.** When an email is open and an argument
     IS the clipboard text (whitespace-insensitive, whole or trimmed, at least 20
     characters), the first line reads "… from your clipboard text?" — the line that is
     spoken and read before deciding. A label only (`core/contextHints.ts`,
     `markFromClipboard`).
   - **The `[main]` line says what the model was told**: `[email hint: sent, check 8ms;
     clipboard: 1050 chars]`. Counts and a flag, never the clipboard's text — so "was the
     hint in the prompt?" is answerable next time.
   - Deliberately **not** built: a code rule refusing clipboard plans whenever an email is
     open. A background Gmail tab is common, and it would block ordinary "send these notes".

   Measured with the opt-in eval (`M19_PLAN_SET=verbs`, `gpt-5`, email open with the hint):

   | Phrase | Clipboard | Old wording | Noun rule | **Verb rule (shipped)** |
   |---|---|---|---|---|
   | file this bug in linear and tell the social channel | prose + stack trace | 2/3 | 10/10 | **10/10** |
   | file this bug in linear and tell the social channel | a message about code | 3/3 | 3/3 | **3/3** |
   | summarize this | prose + stack trace | 3/3 | 2/3 | **3/3** |
   | summarize this | a message about code | 3/3 | 2/3 | **3/3** |
   | summarize this | short, unrelated | 3/3 | — | **3/3** |
   | log this as an issue and let #bugs know | prose + stack trace | — | — | **3/3**, reads the email |
   | reply to this and send it | prose + stack trace | — | — | **3/3**, `draftReply > sendReply` |

   One model, two clipboard texts; only the ten-trial row has enough runs to say much. 30
   new tests; fifteen rules broken one at a time, all caught.

   **None of this can make a model's choice certain.** Plan choice with a non-empty
   clipboard is improved and measured, not guaranteed; the confirm dialog — which shows the
   text in full, and now says when it is the clipboard's — is what is relied on.

**Follow-up list (not M19).** Everything noted during the milestone and deliberately left out
of it. None of it is started.

- **The `functions.` prefix rule has never met a real prefixed name.** `canonicalToolName` was
  written from one live refusal and one older log row. Since it shipped, no model has produced
  the prefix — not in the app, not in 15 eval calls — so the rule has only ever run in tests.
  It is safe by construction (it can return only a menu name or its own input), but "works on
  the form a real model sends" is unobserved. When one appears, the console now prints
  `[main] refused plan, as sent: …` if it is refused, and the action log row carries the raw
  names; a run that *succeeds* with a prefix leaves no trace at all, which is worth changing if
  this is ever chased. **Update, 2026-10-10 (M20):** a real model has now produced it — once in
  28 eval calls, on all three steps of an otherwise correct plan (§9, M20). Seen in the eval,
  which does not run plans; the rule has still never handled one in the running app.

  > **WATCH — the `functions.` prefix (opened 2026-10-10, nothing changed yet).**
  > **Sighting:** `gpt-5`, `M19_PLAN_SET=verbs`, both connectors on the menu (three more tools than M19's). The
  > phrase "log this as an issue and let #bugs know", trial 2 of 3, came back as
  > `functions.readEmail > functions.linear__create_issue > functions.sendMessage`. The other
  > 27 calls in that run, and the other two trials of the same phrase, had clean names.
  > **What it means today:** in the app, nothing — `canonicalToolName` strips the prefix and
  > the plan runs. In the eval it is a false MISMATCH, because the eval compares the names the
  > model typed. So the eval's pass rate currently mixes two things: wrong plans, and right
  > plans spelled with a prefix.
  > **Not known:** whether the larger menu made it more likely (one sighting in one run
  > cannot say; M19 recorded none in 15 eval calls on the smaller menu), and whether it ever appears on a
  > single-tool call rather than a plan step.
  > **Watch for:** (1) the next eval run — count prefixed answers separately from real
  > misses; (2) a live run — `[main] refused plan, as sent: …` means the rule FAILED on a
  > real prefix, and a prefixed plan that *succeeds* leaves no trace; (3) any prefix other
  > than `functions.`, which the rule does not know.
  > **Deliberately not done:** the eval is unchanged. Making it apply `canonicalToolName`
  > before comparing would be the fix for the false mismatch, and is a decision — it would
  > also stop the eval from showing how often the prefix occurs unless it counts them.
- **A Gemini provider, as its own milestone.** Only `anthropic` and `openai` exist behind
  `LLMClient`. The smallest route is the OpenAI client pointed at Google's OpenAI-compatible
  endpoint, but nothing about it is tested and three things are expected to need work: Gemini
  accepts only a subset of JSON Schema in tool definitions (the connector schemas use
  `additionalProperties`, `minLength`, `maxLength`); the `plan` meta-tool's free-form
  `arguments` object; and the `max_completion_tokens` / `finish_reason === "length"` handling
  the truncation outcome depends on. Tool-choice and plan-writing quality on a third model
  family is a separate question again, and would need its own eval run — the M19 plan-choice
  results are about `gpt-5`. Its own milestone, not a config change.
- **A chain stops AFTER the issue is created when the Slack channel is unknown, orphaning the
  issue.** `sendMessage` refuses an unresolved channel ("the social channel" with no fact for
  it) in its own handler — at step 3, by which time step 2 has already created a real issue
  nobody was told about (SEJ-7 and SEJ-8 in live testing). Everything structurally knowable is
  meant to be settled before a plan is narrated (§5b); whether a channel reference resolves is
  knowable then, and is not checked. Not designed: it needs a way for a tool to pre-flight its
  arguments at plan-validation time without that becoming a second gate.
  **Seen again, 2026-10-10 (M20), with GitHub:** "the bugs channel" was unknown, so the chain
  created issue #4 in `Sejall-089/throwaway_repo` and stopped at step 3; teaching the channel
  and re-running filed the same email again as #5. Still not designed
  (`docs/M20-live-checklist.md`, Finding 3). One detail from reading the code then, not from
  a run: the refusal was in `sendMessage`'s handler, which runs AFTER that step's confirm gate
  — so the step 3 dialog would ask "Send to the bugs channel?" before the step is refused.
  **Fixed in code 2026-10-10, not yet re-run live.** Two changes (§ `referenceArgs`):
  the step's own check is now `checkChannel`, asked from the confirm summary, so a step is
  refused with no dialog; and `runChain` runs a pre-flight (`preflightReferences`) after
  `validatePlan` and before step 1, which refuses the WHOLE plan — nothing read, created,
  announced or asked — when a step names a reference memory does not know. Against the fake
  Linear and GitHub servers the unknown-channel chain now makes zero calls. And instead of
  only refusing, it now ASKS which channel was meant, saves the answer and runs — so the
  second half of the live finding (teach the channel, re-run, file the email twice) no longer
  needs a second run at all (§6, "Asking instead of refusing"). What it does not
  cover, each of which still stops at the step as before: a channel that is a `{stepN}`
  placeholder (unknowable until that step runs); a LITERAL channel that does not exist
  (`#typo` — there is no list of real channels, and a webhook may ignore `channel` anyway);
  and any tool that does not declare `referenceArgs`.
- **M22: a channel name decides where a message goes — BUILT, as a Slack bot token rather than
  one webhook per channel; NOT YET RUN LIVE.** In bot mode the channel named is the channel
  posted to, checked against Slack's own channel list (public channels, and private ones the
  bot is in) before any dialog; `#typo` is refused with similar channels, and an answer or a
  `remember` is checked and saved as Slack's `#name`. Webhook mode is unchanged: one webhook
  still posts to one channel whatever is named. See §6f; live checklist
  `docs/m22-live-checklist.md`.
- **A "forget this fact" command. NOT DONE.** The app can remember and correct a fact but
  cannot drop one. The M21 live pass needed "the bugs channel" forgotten several times, and it
  was done by hand each time — deactivating the row in `memory.db`. Saying "forget the bugs
  channel" is routed to `remember` with an empty value and fails ("I need both what to
  remember and what its value is"). Not designed: it should deactivate rather than delete, the
  way a superseding write does, and say what it forgot.
- **Config warnings shown in the app, not only the terminal. NOT DONE.** The blank
  `SLACK_WEBHOOK_CHANNEL` warning is a `console.warn` at startup — watched live, terminal
  only; nothing shows in the app window. A user who is not looking at the terminal, or a
  packaged build with no console, sees only the symptom (a dialog that names no channel). The
  same is true of every other startup line that says a capability is off.
- **A shell environment variable can hide the blank-`SLACK_WEBHOOK_CHANNEL` warning. NOT
  DONE.** dotenv does not override a variable already set in the process environment
  (measured with the real loader, dotenv 16.6.1). If the launching shell has
  `SLACK_WEBHOOK_CHANNEL` set, a blank or unquoted line in `.env` is ignored: no warning, and
  the app uses the shell's value — so what `.env` says and what the app does can disagree with
  nothing to show for it. The same applies to every key the app reads.
- **"playback did not report back: The recorder didn't respond" — seen twice, cause unknown.
  NOT INVESTIGATED.** It appeared twice in the terminal during the M21 live pass. It is the
  line `WindowsShell.play` logs when the renderer does not answer a `speech:play` within the
  15-second reply timeout; the wording says "recorder" only because playback shares the voice
  path's wait helper. **Not from M21** — nothing in M21 touched speech or playback. What made
  the renderer not answer was not looked into.
- **Warm connectors at startup. NOT DONE.** A connection opens lazily, on the first instruction
  that uses it, so the first connector call of a session pays the whole cold connect — measured
  at 1.4–7.1 s, and once, live, over 20 s (M21) — before its dialog can appear. Opening each
  configured connection in the background at launch, the way the pointing reader is pre-warmed
  (M16.11), would move that wait to where nobody is waiting. Not designed: it means network
  use at startup with no instruction given, a failure there must stay silent and must not
  poison the first real use, and a connection opened at launch can have dropped by the time it
  is needed. Until then the wait is labelled ("Connecting to GitHub…") and a failure in it
  says nothing was sent (§6e, "The phase of a failure").
- **The confirm dialog's approve button says "Send" on every confirm, including a create.**
  `WindowsShell.confirm()` hard-codes `buttons: ["Send", "Cancel"]`, which was accurate while
  the only `dangerous` tools sent something (Slack, Gmail). It now also fronts
  `linear__create_issue` and calendar events with guests, where "Send" describes nothing — and
  it was the button pressed to approve SEJ-7. Name it after the action ("Create issue", "Send
  message"). Not designed: the label has to come from the tool, so it needs a way to reach
  `shell.confirm()` (today it takes one string), with "Cancel" staying the default button.
  **Done 2026-10-10 (M21), not live-tested.** `confirm(message, { approveLabel })`; a tool
  declares `confirmLabel`, a fixed string in its code, and the planner passes that and nothing
  else (§6, "`confirmLabel`").
- **Esc to stop speaking cancels a pending confirm.** Escape is this app's "be quiet" key, and
  it is also the native dialog's Cancel. The app speaks the confirm question, so someone
  silencing it with Esc cancels the confirm — fail-safe (nothing is sent), but it stops a chain.
  Left as native Cancel by decision. One idea, not designed: stop speaking the question a
  different way, or do not speak it while the dialog has focus. Electron offers no clean way to
  turn Esc off on this dialog without risking it mapping to the first button, which is Send.
- **Standalone `sendMessage` reformats after the confirm.** The dialog shows a 140-character
  preview of the notes; the handler then rewrites them through a model and sends that. What is
  sent is not what was approved. Fixed for chains in M19; unchanged for a lone send.
  **Fixed 2026-10-10 (M21)**, after it was hit live — Slack received the formatter's own
  "Please paste the rough notes you want formatted for the #bugs channel." twice. See §6, "What
  is approved is what is sent". Tests and two evals; not re-run live.
- The previous turn's result (300 characters) reaches the next planning prompt; after a chain it
  can be external text. Left as is, by decision.
- Gmail's "no email open" is a bare `Error`, so as step 1 of a chain it reads "Something went
  wrong: …" rather than as a plain refusal. Pre-existing (M10); hand-built Gmail was not touched.
- `findTool` in `registry.ts` keeps a static list and cannot resolve connector tools. Nothing in
  `src/` calls it; the planner uses `registry.find`.
- Priority, labels and assignee on create; a `speakResult` for connector tools if URLs or
  identifiers are read badly.

### M18 — proven vs. live-only

**The live pass is under way (2026-10-07) and has found four things no test caught** — see
"What the live pass found" at the end of this section, and `docs/M18-live-checklist.md` for the
per-item record. The rest of this section was written before the live pass
rather than after it, which is a first for this file and is the point: every milestone from M10
on has produced at least one live bug no fixture caught, so writing down *in advance* which
claims rest on fixtures makes the checklist a test of specific doubts rather than a lap of the
feature. `docs/M18-live-checklist.md` is the list.

**Proven deterministically (993 tests, `npm test`; 944 when this list was written):**

- **The app catalog.** Normalisation ("the Spotify app", "  NOTEPAD. ", "calc"), exact matching
  and its refusals ("spotifyy", "spot", "notepad.exe", "my music player" — each of which a
  fuzzy rule would have accepted), every built-in name resolving uniquely back to its own entry,
  and `APPS_EXTRA`'s fifteen rejection classes with the exact sentence each produces and the
  entry's absence from the catalog.
- **`openApp` end to end through the planner**, against a `MockShell` running the **real**
  launcher over the **real** built-in catalog — so "it refused Photoshop" is the matching code
  refusing, not a mock agreeing. Including that the refusal names the whole closed list.
- **The media-key mapping**, with the six virtual-key codes written independently in the test
  rather than imported, plus a dedicated assertion that volume up and down cannot be
  transposed (adjacent codes, and the most obviously wrong thing that could ship).
- **The repeat policy**: a count honoured only for the volume keys, forced to one for `mute`,
  `playPause`, `next` and `previous`, enforced in the tool *and* the shell, and never resolving
  outside 1–15 for any input including `NaN`, `-5`, `2.5` and a string.
- **`searchSpotify`'s URL construction**: thirteen encoding cases including
  `https://evil.example.com`, `../../etc`, `ac/dc`, `50% off` and two non-Latin titles, each
  asserting the host and path prefix literally, so no query can retarget the request.
- **Result honesty**: no result states a resulting level or the word "playing". A volume
  result reports the CHANGE that was sent, in percent and always with "about" ("Volume up about
  10%"; capped: "Volume up about 30% (my limit per request, you asked for 80%)") — the test
  requires every number in the sentence to be that step or the user's own request quoted back,
  and is itself checked against "now at 40%" and "to 50%" so it can fail. *Changed after the
  live pass: this used to read "no result string contains a percentage", back when the result
  was a press count.* M18's user-facing strings are in both `speech.test.ts` fixture
  sweeps, where the strict `FakeSynthesizer` enforces the engine's real character limits.
- **Both `resolvesReferences: false` flags**, verified to FAIL with the flag flipped on. The
  first drafts of those tests proved nothing — see the step C commit.
- **A two-step chain** (`openApp` → `searchSpotify`) through the M17 runner with no new chain
  code, with step order read off the side effects and the plan preview pinned as a literal.

**Only a live run can prove these, and each is here because something specific could be wrong:**

1. **That dictation still works.** `HOST_SCRIPT` gained a `KEY` command, and the `TYPE` path is
   untouched — but they share one PowerShell host, and that file carries its own KNOWN ISSUE
   note (M16.8) about the fragility of its `-Command -` invocation. This is the highest-value
   check in the list and it is a *regression* check, not a feature one.
2. **That `VkEvent` actually moves the volume.** Nothing under vitest sends a real `SendInput`.
   The down/up pair, `wScan = 0`, and `KEYEVENTF_KEYUP` are written from the Win32 contract, not
   observed — the same standing this repo's first Gmail fixture had before a live page corrected
   it.
3. **How far 5 presses actually moves it.** "About 2% per press" is from documentation, and the
   default of 5 was chosen from it. If a press turns out to be 10%, the default is a jolt.
4. **That 15 presses leaves no stuck or repeated key.** The 40 ms gap is inherited from M12.1's
   measurement for `KEYEVENTF_UNICODE` events, which carry `wVk = 0` — a real virtual key is a
   *different* signal to Windows' key-repeat handling, so the number is borrowed, not verified
   for this case.
5. **Which app a media key reaches.** The tools claim only "sent", precisely because this is
   unknowable from inside the app — but what actually happens with Spotify playing, with only a
   YouTube tab playing, and with both is worth writing down once.
6. **Whether `openApp` starts a second copy** of an already-running app, and what Windows does
   with `spotify:` when Spotify is not installed (the protocol handler may show a system dialog
   rather than failing, in which case `{ ok: true }` is reported for a launch nobody saw).
7. **Which tool the model picks** for "open Spotify" vs "open the Spotify web player" vs "play X
   on Spotify". Every test in this repo drives tool choice through `FakeLLM`, so no test can
   speak to this at all.
8. **`spotify:connect` on a free account** — whether consent completes, and what the recon
   captures for the Premium-required path. That capture is the fixture the parked work needs.

**What the live pass found (2026-10-07, in progress).** Per-item results, each marked
human-verified or script-verified, are in `docs/M18-live-checklist.md`.

- **A units bug** (item 3). One press is about 2%, as documented — but the tool's argument was
  a press count, so "turn it up by 10" moved the volume 20%. The argument is now `percent`.
  Human-verified at 10, 5 and 80 (10 → 40, the cap).
- **The input host swallowed its first command** (item 1's file, not item 1's fear). `-Command -`
  made stdin the script source; `-File` fixed it, with request ids and per-verb budgets.
- **A raw Win32 error reached the user** (item 6). With Spotify not installed there was no
  system dialog and no false success — the launch failed with "Failed to open: No application is
  associated with the specified file for this operation. (0x483)". `appLaunch.ts` now says
  "Spotify doesn't seem to be installed." for exactly that case; other failures keep their own
  reason. Script-verified only.
- **The volume result spoke in key presses**, the units bug again on the way out. It now reads
  "Volume up about 10%". Script-verified only; "%" needs no respelling for speech — Piper's
  phonemizer returns the same phonemes for "10%" as for "10 percent".
- **Answers to items 5 and 6:** with both Spotify and YouTube playing, "pause" stopped YouTube
  only; with nothing playing it *started* Spotify; opening an already-running Notepad starts a
  second window every time.
- **Two observations are open and unexplained:** a tool request ("open calc", "pause", "open Spotify") three times
  answered with chat text instead of a tool run; and dictation once typed "aame" for "name"
  with a correct transcription — not reproduced in 400 scripted repeats across the old and new
  host, and the encoding is byte-exact up to the `SendInput` call.

**Parked after M18.** Recorded so they are not lost; no work has been done on any of them.

- Three odd model replies ("open calc", "pause", "open Spotify") returned chat text instead of running a tool, always on the first try, and the second try worked; clipboard text is the suspect; not reproduced by script yet.
- `searchSpotify` could open the Spotify app first (`spotify:search:`) with a browser fallback; needs a contract change.
- "Set the volume to 50%" is not supported: the app cannot read the current level.
- The instruction bar may keep showing the previous result while a new command is typed (unconfirmed).
- 26 leftover `va-uia-*` folders in the temp directory from the UIA host, which only cleans up on a clean exit.
- Spotify Web API tools are parked until a Premium account exists.
- The terminal shows the em dash in refusal messages as "ΓÇö" (console encoding only; the bar renders it correctly).

### M17 — proven vs. live-only

**Proven deterministically (103 new tests, no API key and no network).** The plan parser against
every malformed shape a model can return — a non-array `steps`, an empty plan, a step with no
tool name, arguments that are an array, and one bad step among three good ones (which fails the
*whole* plan rather than silently running a shorter one). The chain gate: the 3-step cap as a
named refusal, the closed-world tool check *against the menu this install actually built* (a plan
naming `readSchedule` on a machine with no calendar is refused, not attempted), forward/self/
out-of-range references, and a placeholder in a non-text argument — each with nothing run and
nothing announced. `{stepN}` substitution including the skip-back case, the single-pass rule (a
result containing the characters `{step2}` is data, not an instruction), and the loose-form
detection that stops `{ step 1 }` reaching an inbox as literal text.

Through the planner: steps run in order, one log row per step, the plan is narrated before
anything runs, the substitution happens *before* the gate (asserted on the confirm dialog's actual
text), a `dangerous` step still confirms at position 2 of 2, three `safe` steps produce no dialog
at all, a mid-chain `UserFixableError` stops the chain with the accounting, and a cancelled
confirm reports 1 of 2 done. Both hotkey guards, including the ordering when a chained step is
parked at its dialog and *both* conditions are true.

**The regression test this milestone was required to carry** (M14 §8, at step N of N) uses
`MockShell.holdConfirm`, so the dialog genuinely blocks: while it is up, `isConfirmPending()` and
`chain.isRunning()` are both asserted true, the confirm text is asserted to be
`Step 3 of 3: …`, and the step after it is asserted not to have run. A confirm fake that resolved
instantly could only ever have proved the guard was *consulted*.

**One test found one real bug during the build** — `previewPlan` was capitalising the tool-name
fallback, rendering `readSchedule` as `ReadSchedule` on screen: an identifier that no longer
matches anything in the registry, which is the kind of small lie that sends someone looking for a
tool that does not exist.

**Live-only, and genuinely unverified.** Whether a real model *chooses* to chain when it should
and declines to when it shouldn't. The prompt is deliberately lopsided — the one-tool default is
restated before `plan` is mentioned, and fenced with "when — and only when" — and the tests pin
that framing, but framing is not behaviour. Also unverified: whether the model writes `{stepN}`
into sensible argument positions, how the plan preview and the "Step 2 of 3:" prefix actually
read on screen and sound out loud, and whether three chained steps feel like a coherent single
action or like the app talking over itself. Per CLAUDE.md, the rendered thing needs eyes on it —
the `[main] … (chain 2/3)` line proves what the app decided, not what the user saw. Every
milestone since M10 has found at least one bug the fixtures could not; budget for it.

**Live testing found exactly that bug, on the first pass.** The same 4-step instruction, run
twice, produced two different outcomes. Once, the model wrapped everything through `plan` but
named a bogus `multi_tool_use.parallel` tool inside one step — caught cleanly by `validatePlan`'s
ordinary unknown-tool check, working exactly as designed. The other time, the model answered with
a *real* `readSchedule` call **alongside something else in the same response**, and both provider
clients only ever looked at the FIRST tool call — `response.content[0]` for Anthropic,
`tool_calls[0]` for OpenAI — silently discarding the rest. `readSchedule` ran, spoke, and the run
just ended: no refusal, no narration, no log line, the spinner stopped with nothing on screen.

Root cause was **not** the `plan` mechanism — that was already sound. It was that a chooseTool
response can contain more than one tool call at all, and nothing checked for it. Fixed by pulling
the decision out into `core/llm/toolChoice.ts`'s `classifyToolCalls` (zero calls → the caller's
own decline handling; exactly one → unchanged; more than one → refused by name, never truncated
to whichever came first), tested directly rather than left in the transport — the CLAUDE.md
lesson about thin transports needing error-classification tests, applied a second time. Anthropic
additionally gets `disable_parallel_tool_use: true` on its `tool_choice` (a plain, documented SDK
field) so the API is asked not to produce this in the first place. OpenAI does **not** get the
equivalent `parallel_tool_calls: false` — the SDK's own type docs carry no reassurance for
gpt-5's reasoning-model family, and guessing wrong would turn a rare silent drop into every
OpenAI-configured install failing every call. Left as an open, live-testable question rather than
a guess; the classification fix closes the hole regardless of whether it is ever set.

Still unverified: whether a model *chooses* to chain when it should and declines to when it
shouldn't in the general case, whether `{stepN}` lands in sensible argument positions, and how
the plan preview and per-step prefix actually read and sound. This was one specific failure mode
confirmed and fixed, not a clean bill of health on model behavior.

**A second live bug, in "how the plan preview reads":** confirmed reproducible on a 3-step chain
whose steps all finished fast (no real waiting between them) — the preview text was replaced by
step 1's result in well under a second, not long enough to actually read it. The spoken narration
for every step was fully audible both times; this was screen-only. Root cause: `notify`'s status
text is overwritten the instant the NEXT screen update fires, and nothing throttled that to the
pace a person reads at — only speech had that property already, because
`executeAction({kind:"speak"})` returns once an utterance is QUEUED, not once it is heard, so
audio plays out at its own pace in the background regardless of how fast the planner executes.

Fixed with a minimum, **adaptive** read-time hold: `core/chain.ts`'s `previewHoldRemaining(shownAt,
now)` — pure, mirroring `renderNow`'s split — decides how much of `MIN_PREVIEW_HOLD_MS` (2.5s) is
still owed given how much real time already passed narrating the preview, and `runChain` waits out
only that remainder before letting step 1 begin. Adaptive rather than a flat pause on purpose: a
step 1 that is already slow for a genuine reason (a real API call, a confirm dialog someone took a
moment to answer) is never delayed further on top of that. Applies only to genuine multi-step
chains — the single-step collapse path returns before any preview is ever shown, so it never
reaches this at all.

**A third live finding, not a misclassification: the step cap was genuinely unexercised.** Six
varied attempts at a 4-step chain (already over `MAX_STEPS`) all failed the same way, confirmed by
the model's own error text: reasoning-token budget exhausted before a `plan` tool call ever
completed. Every one was caught correctly and safely as `{ kind: "incomplete" }` — the same
distinct outcome the original M9 budget fix produced, never misclassified as a garbled plan or a
silent miss — but none of the six ever reached `validatePlan`'s own step-cap refusal, because the
response never finished forming a `plan` block for it to refuse. The cap was provably safe from
fixtures the whole time; it just had never been reached by a real model.

Root cause: `CHOOSE_MAX_TOKENS` (4096, set at M9 for a single tool call's reasoning + output) was
never recalibrated when M17 added a structurally bigger response shape — several steps, each its
own tool name, arguments object, and describe phrase, on top of the reasoning needed to decide
whether to chain at all against a prompt deliberately weighted toward not doing so. Raised to 8192
in both `anthropic.ts` and `openai.ts`, per that constant's own original reasoning: "a cap the
model does not reach costs nothing." Whether 8192 is itself enough headroom is a live-only fact —
request shaping, not classification, per CLAUDE.md — so this is a considered raise, not a
proven-sufficient one. It needs a live re-test, not a fixture, to confirm the cap is now reachable.

### M16 — proven vs. live-only

**Proven deterministically (over 100 new tests, no PowerShell and no desktop for most of the
build).** Filtering, dedup and numbering against eight fixtures — six transcribed from real
recon dumps, two synthetic and labelled as such — including a byte-for-byte proof that the
narrowing UIA condition used in production loses zero real candidates against pulling the whole
tree (measured live at M16.8: 85 candidates either way). The settle decision as a pure state
machine with no clock. The choose prompt and parser against every malformed reply shape. Native
px → DIP geometry with hand-derived literals on the actual 1.5×-scaled machine, including a test
asserting the *specific wrong answer* an un-translated origin would produce. And the safety
property the whole milestone rests on: **on every refusal path, `FakeScreen.pointed` stays
empty** — an answer the gate does not trust must never become a marker.

**Proven against the real PowerShell host, not just fakes (M16.8).** All three regression
targets re-verified at their exact fixture rects on live Notepad and Explorer. Two real bugs
found this way that no fixture could have shown: `-Command -` does not reliably deliver stdin
commands (fixed with `-File`; see the limitation above), and enumerating a real window's whole
tree costs seconds, not milliseconds, until narrowed at the source.

**Live-verified through the actual app — real hotkey, real keypress, not a script (M16.11).**
All nine checklist items confirmed by a human at the keyboard, including markers re-checked
visually after two further bugs were found and fixed *by that same process*:

- **The foreground snapshot was reading the command bar, every time.** `snapshotPointTarget()`
  was fire-and-forget; the read always resolved after `showInput()` had already taken focus, so
  the app answered every question about itself. Root cause was async-vs-sync ordering, not a
  race — it could never have worked. Fixed by awaiting the snapshot, pre-warming the reader at
  startup so that await is cheap, and having the host refuse to name one of the app's own window
  handles even if asked.
- **The marker was one call behind.** Its position travelled in the URL hash; a hash-only change
  is a same-document navigation, so the overlay's script — which reads its position once, at
  load — never re-ran, and the marker kept showing the *previous* question's answer. Every new
  question wrong, every identical repeat right, which is a more dangerous shape than "always
  wrong": a first answer looks authoritative and nothing on screen suggests it is stale. Fixed by
  moving the position into the query string (a real navigation) plus a nonce (so even an
  identical question forces a fresh load).
- Two live-only findings became refusal-wording fixes: a raw COM exception (`"Unrecognized
  error."`) was reaching the user verbatim through the `unreadable` path — the host now returns
  classified codes, never engine text, and retries a `FindAll` fault once; and a disabled control
  was being filtered out of the candidate list entirely, collapsing "present but unusable" into
  "not found" — disabled controls are now kept, marked, and refused with their own wording
  (`disabled`).
- The ambiguity refusal's wording was refined after a live five-column Explorer window: naming
  candidates by left-to-right ordinal ("3rd from the left") technically worked but made the
  reader count columns against their own view. Candidates that sit inside a labelled container
  (a column header) are now named by it ("under \"Date modified\""); ordinals remain the
  fallback when no clean landmark exists, never mixed with landmarks in one sentence.

**One honest gap held rather than chased.** The `unreadable` refusal's live wording was never
provoked: every cold-Electron-launch attempt found the target app's tree had already populated
by the time the hotkey landed. The refusal path itself is proven deterministically and was
exercised live in its *sibling* form (`unsettled`, and `disabled`/`stale`/`ambiguous` all fired
live); only this one specific message's live appearance is unconfirmed. Not blocking — the code
path is identical to the ones that did fire, and PROJECT_CONTEXT_UPDATE_8 records why it
resisted forcing (the same populate-then-go-bare timing R1a measured).

**Still not verified: multi-monitor**, for lack of a second display — see the limitation above.
The overlay-dismiss timing question (should switching away from the target window cut the
10-second auto-dismiss short?) and the Chromium settle-delay's subjective feel were both raised
during M16.11 and are now decided, not open — see §4e and the M16 known-limitations entry above:
the timer stays at 10s, no focus-loss detection was built, and the settle delay is confirmed
acceptable as measured.

### M15 — proven vs. live-only

**Proven deterministically (96 new tests, no screen captured and no image sent anywhere).** The
whole pointing flow runs under vitest against `FakeScreen` and `FakeVisionLocator`: the
image-px→DIP mapping at four scale factors and three display origins including a negative one;
every refusal in `core/vision/locate.ts` and the exact wording of each; the response parser
against every malformed shape; the transport's failure classification for 400/401/403/429/5xx,
a bare network error, and being thrown something that is not an `Error` at all; the tool's tier,
its narration firing *before* the capture, memory being kept away from `target`, the registry
gate, and the action log holding text and no image bytes.

Two of those deserve naming, because they are the milestone's actual safety property rather than
coverage for its own sake. **`screen.pointed` is asserted EMPTY on every refusal path** — an
answer the gate does not trust must never become a marker, because the user clicks what we point
at. And **the wrong-pixel-space case is tested explicitly**: coordinates for the 1920x1080
capture arriving against the 1568x882 frame we actually sent is the likeliest real coordinate
bug, and without the bounds check it is a confident marker in the wrong place with no symptom.

**Proven by measurement rather than by test.** `scripts/screen-recon.mjs` answered the capture
questions against the real API before any of it was designed around (§3's stack row has the
numbers). The overlay was verified by drawing at a known rect and photographing the result: the
drawn box landed within 2px of the request, with a see-through interior. That check caught two
things — the 3px border being drawn outside the rect (correct, but accidental until it was
measured and then made deliberate) and, first, a magenta detector loose enough to pick up desktop
content and report a wildly misplaced marker. A loose measurement produces a confident wrong
answer, which is the same failure mode the whole milestone is about.

**Live-only — now largely DONE, on a different provider than planned.** See M15.1 above for the
full account. In short: the probe was run against `gpt-5`, the model does decline on absent
targets and does report ambiguity rather than picking, the decoy case is correct and visually
verified, and the provider swap surfaced a coordinate-space bug that the original 1568-long-edge
frame would have shipped with.

What remains genuinely unverified:

- **Small-icon accuracy is a known limit, and now a known REFUSAL rather than a silent miss.** A
  systematic ~(+20, +12)px offset put the marker outside a 39px icon 4 times out of 4 before
  `SMALL_TARGET_PX` existed; `checkLocation` now declines below ~40px instead of drawing there.
  The threshold itself is still a 4-sample placeholder, not a measured line — whether 40px is
  right for real application icons, not just this fixture, is unverified.
- **Anthropic has never been run at all.** It is implemented against the same `VisionApi` seam and
  typechecks, and its frame rule in `core/vision/frame.ts` is read from documentation rather than
  measured — which is exactly the kind of assumption that just cost OpenAI 4/4 misses. Treat
  `ANTHROPIC_FRAME` as a starting point for whoever runs that recon.
- **Everything was measured on a synthetic fixture**, not on live application chrome. A rendered
  compose window has crisp edges and generous hit targets; real Windows apps have neither.
- Multi-monitor is unverified — this machine has one display, so `pickSource`'s `display_id` join
  and `getDisplayMatching` for overlay placement have never run against a second screen. The join
  is written to REFUSE rather than fall back when it cannot be made confidently, but that path
  has never fired.
- A UAC prompt or a locked session (recon Q7) has not been tried. `WindowsScreen` classifies an
  empty thumbnail as `no-display` and says "try again once you're back at your desktop", which is
  a guess about what that state produces, not a transcription of it.
- The in-app path (hotkey → `pointAt` → overlay on a real foreground window) has not been driven
  end to end; only the recon script and a standalone overlay probe have.

**`FakeVisionLocator` is now transcribed rather than imagined.** Its `notFound` and `ambiguous`
fixtures are branches the real model was observed using; its `nativeCoordinates` fixture stopped
being hypothetical the moment a wrongly-sized frame made every real answer look exactly like it.

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
