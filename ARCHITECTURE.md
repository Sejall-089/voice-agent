# ARCHITECTURE.md — Voice-Action Agent

Documentation of how the app is put together and how a request flows through it.
All diagrams are Mermaid, so they render directly on GitHub / most Markdown viewers.
For scope, stack, and build tasks, see `spec.md`.

---

## 1. One-line mental model

The app is a **translator**: it takes three inputs — what you *typed*, what you're
*looking at*, and what it *remembers about you* — and turns them into exactly one
concrete action.

```
instruction + context + memory  ──►  one exact function call  ──►  one result
```

Everything below is the machinery that makes that translation reliable.

---

## 2. Component architecture

Three layers own the work. The shell is thin and per-OS; the core and memory are
shared and portable. The LLM and Slack are external services the app talks to.

```mermaid
flowchart TB
    User(["You — one hotkey, then speak or type"])

    subgraph App["Your app"]
        direction TB
        Shell["OS shell (thin, per-OS)<br/>one hotkey · capture · run actions · UI<br/>+ voice capture"]
        Core["Core (shared brain)<br/>planner + tool registry"]
        Memory["Memory engine<br/>SQLite: facts · confidence · versions"]
        Shell --> Core
        Core <--> Memory
    end

    Whisper["whisper.cpp (local)<br/>speech → text · nothing leaves the machine"]
    Piper["Piper (local)<br/>text → speech · nothing leaves the machine"]
    Chrome["Chrome (Gmail + Notion tabs)<br/>DevTools Protocol · one debug Chrome,<br/>two app surfaces in it"]
    LLM["LLM (selectable: Anthropic/OpenAI)<br/>reasoning / tool choice"]
    Slack["Slack webhook<br/>the one external action"]
    Calendar["Google Calendar<br/>REST API · read, create, move"]
    Vision["Vision model (Anthropic)<br/>where is this control? · opt-in;<br/>the one thing that sees your screen"]
    Screen["Screen capture + pointing overlay<br/>photograph · draw a marker · never click"]
    OS["OS &amp; target apps<br/>browser, clipboard, any focused window"]

    User --> Shell
    Shell <--> OS
    Shell <--> Whisper
    Shell --> Piper
    Core <--> LLM
    Core --> Slack
    Core <--> Chrome
    Core <--> Calendar
    Core <--> Vision
    Shell --> Screen
    Core <--> Screen
```

**Where voice sits:** entirely in the shell, in BOTH directions. Input converts speech into the
same string the command bar would have returned and hands it to the same call site; output
(M14) takes text the core asked to have said and plays it. The core never learns either exists —
it requests speech as an *action*, exactly as it requests a notification, and a machine with no
synthesizer accepts that action and stays quiet.

**Where vision sits (M15):** the screen is a *surface* the core reaches through `ToolDeps`,
not a shell contract like the microphone — because capture is a request/response and the
`pointAt` handler needs the picture back, where speech is fire-and-forget. Note what the arrows
say about privacy: `Whisper` and `Piper` never leave the machine, and `Vision` is the one box
that receives a picture of your screen. It is off unless `VISION_ENABLED=1`.

**Read it as:** you sit at the top; the stacked boxes are *your* app; the boxes on
the right are things the app uses but does not own. The shell is the only part that
knows it's on Windows.

### What each piece does
- **OS shell** — the hands and ears. Notices the hotkey, grabs context (clipboard
  text + active window), carries out local actions (open URL, copy, notify), and
  shows the command bar / result / confirm dialogs. Makes no decisions. This is the
  only layer you rewrite per OS, and it sits behind the `OSShell` interface.
- **Core** — the brain, identical on every OS. The *tool registry* is the menu of
  things the app can do; the *planner* runs the loop that turns an instruction into
  one validated tool call.
- **Memory engine** — makes it *yours*. Resolves vague references before acting
  ("the team" → `#design-team`) and records facts after. This is the differentiator.
- **Gmail surface (M10)** — the first app the brain can act *inside*. Behind the `GmailSurface`
  interface like everything else external, so tests run against a fake tab. It finds controls by
  their real role and accessible name over the DevTools Protocol; it never clicks a coordinate,
  and it refuses outright when a control is missing or ambiguous.
- **Notion surface (M11)** — a second app in the same debug Chrome, behind `NotionSurface`
  (two methods, deliberately narrow — read the page, append to it). Notion's body content
  carries no ARIA roles at all, so it identifies the append target structurally by
  `data-block-id` and document order instead of role + name. It also can't act through the
  same JS-level DOM calls Gmail uses — see §4b for why real CDP-level mouse/keyboard input was
  required instead.
- **`core/browser/`** — the generic transport BOTH surfaces sit on: a hand-rolled CDP client
  (`CdpClient.ts`) and tab-selection logic (`tabs.ts`'s `pickTab`), pulled out of the
  Gmail-only code that first proved it in M10 once a second app (M11) needed the identical
  "don't guess which tab" rule.
- **Calendar surface (M13)** — the first surface that is an API rather than a browser, behind
  `CalendarSurface`. Not a change of principle: a calendar event is structured data with no live
  draft box, so a DOM would buy nothing. It is also what forced risk tiers to depend on a call's
  *arguments* — an event with guests emails them the instant it exists.
- **Speech (M14)** — two interfaces, not one. `SpeechSynthesizer` (`core/types.ts`, beside
  `Transcriber`) turns text into audio and is swappable — Piper now, a cloud voice later;
  `SpeechShell` (`src/main/shell/`) plays it and can stop it. `SpeechSession` sits between them
  holding the queue. What is said is *derived* from what is shown (`core/speech.ts`), never
  authored twice — see §4d.
- **Screen + vision (M15)** — two interfaces again, and split for the same reason speech's are:
  they fail differently and have different fixes. `ScreenSurface` (`src/main/screen/`) takes the
  picture and draws the marker; `VisionLocator` (`core/vision/`) answers *where is this*. Both
  are *surfaces* injected through `ToolDeps`, not shell contracts like the microphone, because
  the handler needs the picture back. Between them sits the part that matters:
  `core/vision/locate.ts`, which refuses an answer it cannot trust rather than pointing at it.
- **LLM / Slack / Chrome / Calendar / Vision / OS** — rented reasoning, the external actions, and
  the things the shell's hands touch. Vision is the only one that is sent a picture of your
  screen, and the only one behind an explicit opt-in rather than "did you configure it".

---

## 3. The planner loop (what happens inside the core)

The single path every command takes. Simple tasks skip the memory and Slack steps;
the skeleton never changes.

```mermaid
flowchart TB
    A["Instruction + context<br/>from the shell"] --> B["Build LLM request<br/>+ tool menu"]
    B --> C["LLM picks a tool<br/>structured tool call"]
    C --> D{"Tool in registry?"}
    D -- "no / declined" --> R["Graceful refusal<br/>log the miss"]
    D -- "yes" --> E["Resolve arguments<br/>look up in memory"]
    E --> F{"Args complete<br/>&amp; concrete?"}
    F -- "no" --> Q["Ask user / refuse"]
    F -- "yes" --> G{"Risk tier?"}
    G -- "safe / reversible" --> I["Run tool handler"]
    G -- "caution" --> N["Narrate first<br/>then run"]
    G -- "dangerous" --> H["Confirm first"]
    N --> I
    H -- "approved" --> I
    H -- "cancelled" --> X["Abort + log"]
    I --> J["Record in action log<br/>show result"]
```

**The one rule that matters:** the LLM *proposes*, the planner *disposes*. The
registry check, the validation, and the risk gates are deterministic code — the
model never gets to invent a capability or fire a dangerous action unchecked.

**The four tiers (M10, `core/risk.ts`).** A boolean `irreversible` was enough while every
action was either an undoable local transform or one Slack POST. Acting inside another app's
GUI broke that — most GUI actions have no undo — so the question split in two: *is it
recoverable* and *how much does it cost when it is wrong*.

| Tier | Example | What happens |
|------|---------|--------------|
| `safe` | read the open email | run |
| `reversible` | copy to clipboard, open a tab, version a fact | run |
| `caution` | open the reply box, insert a draft | run, **after saying so** |
| `dangerous` | Slack post, Gmail Send | **confirm first**, always |

Narration is what stands in for the undo that does not exist: by the time the reply box is
open there is nothing to roll back, so being told while it happens is the protection.

---

## 4. Request lifecycle — a concrete trace

"Send these meeting notes to the team." This sequence shows every hop, including the
memory lookup and the confirm gate.

```mermaid
sequenceDiagram
    actor You
    participant Shell
    participant Planner
    participant LLM
    participant Memory
    participant Slack

    You->>Shell: hotkey + "send these to the team"
    Shell->>Shell: capture context (clipboard notes)
    Shell->>Planner: instruction + context
    Planner->>LLM: instruction + context + tool menu
    LLM-->>Planner: tool: sendMessage<br/>{channel:"the team", text: formatted}
    Planner->>Planner: registry check — sendMessage exists ✓
    Planner->>Memory: resolve("the team")
    Memory-->>Planner: "#design-team" (confidence 0.9)
    Planner->>Shell: confirm("Send to #design-team?")
    Shell-->>Planner: approved
    Planner->>Slack: POST webhook (formatted notes)
    Slack-->>Planner: 200 OK
    Planner->>Memory: log action
    Planner->>Shell: showResult("Sent to #design-team")
```

**Correction follow-up ("no, I meant the design channel"):** the planner routes this
to the `remember` tool, which versions the old `team` fact inactive and writes a new
one. The *next* send resolves to the corrected channel. That behavior — a correction
that sticks — is the thing a plain prompt can't fake, and it's the flagship demo.

---

## 4a. Voice input — one hotkey, explicit state

Dictation is a *second way to produce the instruction string*, nothing more. **One** hotkey
opens the command bar and starts listening at the same moment, so you choose between
speaking and typing *after* the bar is up. `Enter` submits either way.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> recording: hotkey opens the bar
    recording --> transcribing: Enter (nothing typed)
    recording --> stopped: 90s cap - mic released, audio held
    stopped --> transcribing: Enter
    recording --> idle: you start typing (silent)
    recording --> idle: Esc / click away (silent)
    stopped --> idle: Esc / click away
    transcribing --> idle: transcript returned to main.ts
```

Four properties are what make one hotkey safe rather than fiddly:

- **Typing silently cancels the recording.** No message, no stray transcript arriving behind
  the text you typed. Typing is not an error, so it must not produce output.
- **The 90-second cap releases the microphone but transcribes nothing.** Holding the mic open
  is the real harm; whisper work on audio you may never submit is waste. The bar says it
  stopped, and `Enter` still runs what you said.
- **Nothing ever fires on its own.** Every path to the planner goes through your `Enter`.
- **Every failure returns to `idle`** — blocked mic, whisper crash, blank transcript, clip
  too short. The hotkey is never left dead.

```mermaid
sequenceDiagram
    actor You
    participant Main as main.ts
    participant Session as VoiceSession
    participant Shell as WindowsShell + renderer
    participant Whisper as whisper.cpp (local)
    participant Planner

    You->>Main: hotkey
    Main->>Shell: showInput()
    Main->>Session: begin()
    Session->>Shell: startRecording()
    Shell-->>You: bar open, "Listening…"
    You->>Shell: Enter (nothing typed)
    Shell-->>Main: showInput() resolves ""
    Main->>Session: finish()
    Session->>Whisper: transcribe(clip)
    Whisper-->>Session: "send these notes to the team"
    Session-->>Main: the transcript
    Main->>Planner: runInstruction(...) - THE one call site
```

The load-bearing detail is that `VoiceSession` never calls the planner. `main.ts` **pulls** a
transcript and feeds it to the same `runInstruction` a typed instruction uses, so there is
exactly one planner call site and a dictated instruction is indistinguishable from a typed
one in the action log.

**One capture at a time.** `showInput()` keeps its resolver on the shell instance rather than
registering a listener per call, and every way of hiding the bar ends that capture. An
earlier design registered per-call IPC listeners that only a submit or an Escape could
remove, so clicking the bar away stranded one — and every stranded listener fired on the
next submit, running the planner once per abandoned opening. Measured at six concurrent runs
(twelve LLM calls) from a single keystroke before the fix.

---

## 4b. The Gmail reply flow (M10)

Read the open email, draft a reply in your tone, put it in the box, tweak it, send only on an
explicit yes. Two `caution` steps run on their own after announcing themselves; the one
`dangerous` step cannot.

```mermaid
sequenceDiagram
    actor You
    participant Shell
    participant Planner
    participant Tool as draftReply / reviseDraft / sendReply
    participant Gmail as Gmail tab (via CDP)

    You->>Shell: hotkey + "reply: can't make Tuesday, propose Thursday"
    Shell->>Planner: instruction + context
    Planner->>Planner: tool = draftReply, risk = caution
    Planner->>Shell: notify("Reading the open email and drafting a reply…")
    Planner->>Tool: run
    Tool->>Gmail: readOpenEmail (SAFE)
    Tool->>Tool: composeReply(instruction + email + stored tone)
    Tool->>Gmail: openReplyBox → setComposeText (CAUTION)
    Note over Tool,Gmail: the draft is written BEFORE the box is opened —<br/>a model failure leaves Gmail untouched

    You->>Shell: "make it shorter"
    Planner->>Tool: reviseDraft (caution)
    Tool->>Gmail: readComposeText — the LIVE box, so hand-edits survive
    Tool->>Gmail: setComposeText (no second reply box)

    You->>Shell: "send it"
    Planner->>Planner: tool = sendReply, risk = DANGEROUS
    Planner->>Gmail: read recipients + whole draft (SAFE, to describe it)
    Planner->>Shell: confirm("Send this reply to alex@…?" + the full text)
    Shell-->>Planner: approved
    Planner->>Tool: run
    Tool->>Gmail: clickSend
```

**Where the refusals are.** Every arrow into Gmail can end in an honest "no": no message open,
no reply box, more than one Gmail tab matching, a control that cannot be found, a control that
matches more than once. None of them fall back to guessing, which is what makes a Gmail redesign
show up as a refusal rather than a wrong click.

---

## 4c. The Notion page-writing flow (M11)

Read the open page, write a note in your tone, add it to the end. One `caution` step,
not three — Notion has no staging area and no send button to build the other two around.

The mechanism differs from Gmail in one load-bearing way: Gmail's compose box is an ordinary
browser-native `contenteditable`, so `gmailScript.ts` acts on it with plain JS
(`el.focus()`, `document.execCommand()`) run inside the page. Notion's editor was found, live,
to ignore those calls — they report success but save nothing. So `notionScript.ts` only
**finds** the append target (jsdom-testable, like Gmail's script); `ChromeNotion.ts` does the
**acting**, through real CDP-level mouse and keyboard input — the same signal a physical
device produces, issued from the outer session rather than from inside the page.

```mermaid
sequenceDiagram
    actor You
    participant Shell
    participant Planner
    participant Tool as addToPage
    participant Script as notionScript (finds)
    participant CDP as ChromeNotion (acts, via real input)

    You->>Shell: hotkey + "note that the launch moved to Friday"
    Shell->>Planner: instruction + context
    Planner->>Planner: tool = addToPage, risk = caution
    Planner->>CDP: readOpenPage (SAFE, to name the page)
    Planner->>Shell: notify("Adding a note to \"Launch plan\"…")
    Planner->>Tool: run
    Tool->>CDP: readOpenPage (SAFE)
    Tool->>Tool: composeNote(instruction + page + stored tone)
    Note over Tool,CDP: composed BEFORE anything is touched —<br/>a model failure leaves the page untouched
    Tool->>CDP: appendToPage(text)
    CDP->>Script: locateAppendTarget (SAFE — last data-block-id, never the page's own wrapper)
    CDP->>CDP: real click, real "End" keypress<br/>(never select-all — append-only invariant)
    loop each line of the note
        CDP->>CDP: real Enter keypress, then Input.insertText
    end
    Note over CDP: a single insertText with an embedded \n<br/>silently dropped everything after the first line — proven live
    CDP->>Script: readOpenPage again — VERIFY the text actually landed
    Note over CDP: Notion can report success on an operation<br/>that saved nothing, so success is confirmed, not trusted
```

**Where the refusals are.** No Notion tab open, more than one qualifying tab (narrowed to the
foreground one first — nearly every open Notion tab "has an editable page", unlike Gmail's
narrower "a message is open"), no real content block to anchor an append after, and — the one
new failure mode — a successful-looking write that the read-back can't confirm actually
happened.

---

## 4d. Voice output — the same moment, said and shown (M14)

The app speaks its narration, its confirm questions, and its results. Two things make that more
than "call a TTS API".

**Two representations, one source.** The screen keeps exactly the text it always showed; the
spoken line is *derived* from it by pure code. Nobody authors the same message twice, so the two
cannot drift when a tool's output changes.

Why not one unified string: the confirm dialog settles it. That text is deliberately
*exhaustive* — the whole draft, every attendee by name, never "and 2 others" — because it is the
last thing between an instruction and something irreversible. Terseness there would be a safety
regression, so speech gets its own shorter derivation and the dialog keeps its long one.

```mermaid
flowchart LR
    Tool["Tool result<br/>narration · confirm · answer"]
    Screen["Screen<br/>full text, unchanged"]
    Derive["core/speech.ts<br/>flatten · strip markup · say dates<br/>and times as words · cap"]
    Queue["SpeechSession<br/>one at a time"]
    Engine["Piper<br/>text → WAV"]
    Player["Renderer<br/>&lt;audio&gt;"]
    Held["SpeechStore<br/>what was held back"]

    Tool --> Screen
    Tool --> Derive
    Derive --> Queue
    Derive -. "the rest" .-> Held
    Queue --> Engine --> Player
    Held -. "'read them out'" .-> Tool
```

**Speech is an ACTION the core requests**, not a method on `OSShell` — the same shape narration
already had. A shell with no synthesizer accepts it and does nothing, so `/core` never learns
whether there is a speaker, exactly as it never learns whether there is a microphone (§4a). The
payoff: the whole speech *policy* is provable under `MockShell` with no audio device.

**What the engine actually needs, all measured rather than assumed** (`scripts/tts-recon.mjs`):
it mis-decodes non-ASCII unless spawned with `PYTHONUTF8=1`; it applies no time normalisation of
its own, reading "3:00" as "three zero zero" and dropping a dash between times silently; it takes
about five seconds to start because it reloads its voice every invocation. Every spoken date,
time and range is therefore built by us, not by it.

**Silence is a state, not a failure.** Nothing is lost when speech is cut off, because the full
text is on screen — which is what makes barge-in safe rather than destructive. So:

- either hotkey, or **Escape**, stops it instantly; the queue is dropped and work already in
  flight is invalidated, so audio synthesized just before an interruption cannot arrive just
  after it;
- the microphone is never open while the app is talking, enforced in the shell's
  `startRecording()` — the one chokepoint every path to the mic passes through — because
  otherwise whisper transcribes the app's own voice into the user's instruction;
- an utterance queued more than 8s ago is **dropped rather than said**: speech describes a
  moment, and a queue that always drains eventually will happily announce one that has passed;
- while a confirm dialog waits, **both hotkeys are blocked and say so** rather than starting a
  second run over the top of an undecided one.

---

## 4e. Pointing — a guess a person checks (M15)

Every other surface this app acts through resolves its target *structurally*: Gmail by role and
accessible name, Notion by `data-block-id` and document order, the calendar by event id. That is
what makes them refusable — a control that can't be identified is never touched.

Pixels offer nothing equivalent, so M15 changes what the answer is allowed to *do* instead of
pretending the identification is as good. It draws a marker. A person clicks.

```
"where's the send button?"
        │
        ▼
   planner picks pointAt { target: "the send button" }
        │
        ├─ narrate ─────────► "Looking at your screen to find the send button…"
        │                      (caution tier — said BEFORE the capture, not after)
        ▼
   screen.capture()          1568px long edge · our own windows excluded from it
        │
        ▼
   vision.locate()           one bounded question: WHERE is this?
        │                    the model never chooses an action
        ▼
   checkLocation()  ──────►  refuse: not on screen / several match / off the frame /
        │                            half the screen / too small / off-schema
        ▼                            (and `screen.point` is never called)
   toScreenRect()            image px → screen DIP
        │
        ▼
   screen.point()            click-through overlay · never takes focus · self-dismisses
        │
        ▼
   "Pointing at \"Send\" — the top right of your screen."
```

**The tier is about the capture, not the marker.** `clearPointer()` un-draws the highlight
completely, which would make it `reversible` — but a screenshot that has left the machine is not
recoverable, and the tier has to describe the worse half. Hence `caution`, and hence the
narration, which for this one capability is the *point* of the tier rather than a cost of it.

**Three pixel spaces are live at once** — 1280×720 DIP, a 1920×1080 native capture, a 1568×882
downscale — and only `display.width / shot.width` spans the two that matter. At native resolution
that ratio equals `1 / scaleFactor`, which is what makes the wrong version so tempting; it is
correct right up until the downscale every real request goes through. `Screenshot.display`
carries no `scaleFactor` field so the wrong version cannot be written.

---

## 5. Memory data model

Two tables. `facts` carries the epistemic metadata (confidence, version, active) so
corrections and contradictions are first-class, not overwrites. `action_log` doubles
as the "missing tool" backlog.

```mermaid
erDiagram
    FACTS {
        int id PK
        string subject "team, tone, target:upwork"
        string value "#design-team"
        real confidence
        string source
        int version
        int active "0 when superseded"
        string created_at
        string updated_at
    }
    ACTION_LOG {
        int id PK
        string ts
        string instruction
        string tool "null when no tool matched"
        string arguments "JSON"
        string result
        string status "ok|refused|no_tool|error|cancelled"
    }
```

**Why versioning instead of overwrite:** when you correct a fact, the old row is
kept with `active = 0` and a new row is written at `version + 1`. That's what turns
"personalization" from a static profile into a memory that evolves and can explain
itself — and it's the seam where this app plugs into the larger personal-OS engine.

---

## 6. What makes this reliable (design invariants)

- **Closed world.** The app can only do the registered tools — six always on, plus Gmail's
  three and Notion's one when a debug Chrome is configured. "Not on the menu" → honest
  refusal, never a wrong action. This is what makes it demoable.
- **Thin shell.** All OS-specific code sits behind `OSShell` (and `VoiceShell` for
  microphone capture). The core imports no `electron`. Porting = reimplementing those
  interfaces, nothing else.
- **Input is interchangeable.** Typed and spoken instructions converge on one call site
  before the planner ever runs, so voice cannot become a way around the confirm gate.
- **Propose vs dispose.** The LLM's output is a *proposal* the planner validates
  before anything runs. `dangerous` actions always pass a confirm gate; `caution` actions
  always announce themselves first (§3).
- **Default-deny on anything unidentified.** A GUI control that resolves to zero elements —
  or to more than one — is never touched. "I can see three things that look like Reply" is a
  refusal, not a coin flip. This is the rule that keeps a UI change from becoming a wrong click.
- **Testable core.** A `MockShell` lets the whole brain + memory run headless, so
  the eval suite runs in CI without a desktop.
- **Misses are signal.** Every unregistered request is logged — a ranked backlog of
  the next tools to build, drawn from real usage.

---

## 7. Where v1+ goes (not built in v0)

- ~~Voice / speech-to-text on the front of the loop (whisper.cpp, local).~~ **Built in
  M7** — see §4a.
- ~~Generalize the single Slack action into MCP connectors (Teams, mail, calendar).~~ **Calendar
  landed in M13** as a direct API rather than MCP — same reasoning as Slack's webhook.
- ~~A clipboard-only `compose` tool built on `core/compose.ts` being app-agnostic.~~
  **Refined by M11:** `compose.ts` itself stayed reply-shaped (a greeting and sign-off are
  wrong for most other targets); what's actually app-agnostic moved to
  `composeShared.ts`. A future clipboard-only tool builds a third `composeXxx.ts` on that
  shared base, the way `composeNote.ts` did — not by calling `compose.ts` directly.
- More apps behind `GmailSurface`/`NotionSurface`'s pattern (Outlook web, Slack, Linear) —
  each needs its own live verification, and M11 found the *identification strategy* doesn't
  automatically transfer even though the *safety rule* does: Gmail resolves controls by role
  + accessible name, Notion (no roles on body content, confirmed live) by `data-block-id` and
  document order. Expect each new app to need its own recon pass, not a copy-paste.
- Mac and Linux shells behind the same `OSShell` + `VoiceShell` interfaces.
- ~~Screenshot-driven interaction with any app.~~ **Half of it built in M15** — the app points,
  the user clicks (§4e). The other half, auto-clicking what the vision model identifies, is not a
  next step on this path: it is the thing M15 is the alternative to. Building it would need a
  fail-closed design for "the model was confidently wrong", which pointing sidesteps entirely by
  keeping a person as the executor.
- Multi-step plans and a real agent loop (the closed→open world jump).
- Point the memory engine at the Postgres/Neon personal OS instead of local SQLite.
