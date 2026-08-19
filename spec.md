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

**Explicitly OUT of scope for v0 (do not build, do not scaffold):**
- ~~Voice / speech-to-text.~~ **Moved into scope in M7**, after v0 was complete and
  live-verified. It was out of v0 deliberately — voice is a second way to produce the
  instruction string, and it was only worth building once the string reliably produced
  the right action. It changes nothing downstream: the planner, registry, tools, and
  memory are untouched by M7.
- GUI computer-use / screenshot-driven automation.
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
| Config / secrets   | `.env` (dotenv), never committed         | `LLM_PROVIDER`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (whichever matches), `SLACK_WEBHOOK_URL`, and (M7, optional) `WHISPER_EXE_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE`. |

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

## 5. The planner loop (core/planner.ts)

Given the user's instruction and captured context, run exactly this sequence:

1. **Assemble request** — build the LLM call: the instruction + context + the tool
   schemas from the registry (§6), plus one turn of state: the single most recently
   logged action (`ActionLog.getLast()`), scoped strictly to resolving a correction or
   pronoun in the CURRENT instruction ("no, I meant..."). This is not conversation
   history — it's one bounded fact, and it's still exactly one tool call per
   instruction; the planner never chains actions on its own.
2. **LLM picks a tool** — call the configured provider (§3, `LLM_PROVIDER`) with
   tool-calling. Expect a `tool_call`:
   `{ name, input }`. The model may also decline (return only text).
3. **Guard: registry check** — if `name` is not in the registry (hallucinated tool)
   OR the model declined, DO NOT act. Fall to graceful refusal (§8) and log a miss.
4. **Resolve arguments** — for each argument that looks like a vague reference
   (e.g. "the team", "my dashboard", "the usual tone"), call `memory.resolve()`
   (§7) to replace it with a concrete value. If a required reference can't be
   resolved, ask the user (via showInput) or refuse gracefully.
5. **Validate** — all required args present and concrete? Is the tool marked
   `irreversible`?
6. **Confirm if needed** — if `irreversible`, call `shell.confirm(summary)`. Abort
   on "no".
7. **Execute** — run the tool's handler. Handlers may call the LLM, memory, or the
   shell.
8. **Record** — write an `action_log` row (instruction, tool, args, result,
   status). Show the result via `shell.showResult()`.

Key rule: **the LLM proposes, the planner disposes.** Nothing irreversible runs
without the registry check + validation + confirm gate. This separation is the most
important design decision in the app.

---

## 6. Tool registry (core/registry.ts) — seven demo tasks, six tools

Each tool = `{ name, description, inputSchema, irreversible, handler }`. The
`description` and `inputSchema` are what the LLM sees (they double as the prompt).

| Tool          | Task(s) it serves                    | Reads memory? | Irreversible | Handler does |
|---------------|--------------------------------------|---------------|--------------|--------------|
| `summarize`   | 1. Summarize selection               | no            | no           | LLM summarizes `context.selectedText`; showResult |
| `rewrite`     | 2. Rewrite selection in my tone      | yes (tone)    | no           | LLM rewrites using stored tone; copyToClipboard |
| `openTarget`  | 3. Open a named target               | yes (targets) | no           | resolve name→URL, `openUrl` |
| `remember`    | 4. Remember X · 6. Correction sticks | writes        | no           | `memory.write()` (versions old fact on conflict) |
| `sendMessage` | 5. Format notes and send             | yes (channel) | **yes**      | LLM formats notes → Slack webhook POST |
| `recall`      | 7. What do you remember about…       | reads         | no           | `memory.query()` → showResult with metadata |

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

### `confirmSummary` (added in M5)

An irreversible tool should also define `confirmSummary(args): string`. The planner calls it
with the **resolved** arguments (step 4 runs before step 6), so the confirm dialog always
describes the *concrete* action — "Send to #design-team?" — and never the vague phrasing the
user typed ("send to the team"). Showing the unresolved version would be a trust bug: the
user must approve what will actually happen. Tools without it fall back to a generic
`Run <tool>?`.

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
- [x] **M9 — Make both fixes hold.** Binds capture cleanup to the window's own events so
      the leak cannot return silently (§4a), pins it with `tests/WindowsShell.capture.test.ts`,
      and turns a truncated `chooseTool` response into an explicit outcome instead of a
      misreported refusal (§3a).

**v0 status: complete.** 87 tests green against `MockShell` (`npm test`) — 63 for v0,
24 added by M7. The eval
harness (`npm run eval`, `tests/eval/`) runs the memory story as one continuous
scenario — cold memory refuses → teaching fixes it → a correction versions it →
recall reveals it — plus the seven demo tasks and the closed-world refusal.

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
