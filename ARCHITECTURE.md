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
    Chrome["Chrome (Gmail tab)<br/>DevTools Protocol · find by role + name<br/>never by pixel"]
    LLM["LLM (selectable: Anthropic/OpenAI)<br/>reasoning / tool choice"]
    Slack["Slack webhook<br/>the one external action"]
    OS["OS &amp; target apps<br/>browser, clipboard"]

    User --> Shell
    Shell <--> OS
    Shell <--> Whisper
    Core <--> LLM
    Core --> Slack
    Core <--> Chrome
```

**Where voice sits:** entirely in the shell. It converts speech into the same string the
command bar would have returned, and hands it to the same call site. The core never
learns it exists — which is why voice changed no file in `/core` except adding one interface.

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
- **Gmail surface (M10)** — the one app the brain can act *inside*. Behind the `GmailSurface`
  interface like everything else external, so tests run against a fake tab. It finds controls by
  their real role and accessible name over the DevTools Protocol; it never clicks a coordinate,
  and it refuses outright when a control is missing or ambiguous.
- **LLM / Slack / Chrome / OS** — rented reasoning, the external actions, and the things
  the shell's hands touch.

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

- **Closed world.** The app can only do the six registered tools. "Not on the menu"
  → honest refusal, never a wrong action. This is what makes it demoable.
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
- Generalize the single Slack action into MCP connectors (Teams, mail, calendar).
- A clipboard-only `compose` tool: `core/compose.ts` is already app-agnostic, so an
  instruction-driven draft that works in any app is a tool file, not a new subsystem.
- More apps behind `GmailSurface`'s pattern (Outlook web, Slack) — each needs its own live
  verification, but the finding-by-role-and-name approach transfers.
- Mac and Linux shells behind the same `OSShell` + `VoiceShell` interfaces.
- Multi-step plans and a real agent loop (the closed→open world jump).
- Point the memory engine at the Postgres/Neon personal OS instead of local SQLite.
