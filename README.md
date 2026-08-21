# Voice-Action Agent — v0

A desktop assistant that turns a short instruction — typed, or **spoken** — plus what's on your
screen, plus what it remembers about you, into **exactly one concrete action**.

```
"send these notes to the team"   →   sendMessage(channel: "#design-team", text: "...")
```

The interesting part isn't the actions — it's the **memory**. Tell it *"no, I meant the design
channel"* and the old fact is **versioned, not overwritten**; every future request resolves to the
corrected value. That's the thing a plain prompt can't fake, and it's what this repo is built to
demonstrate.

---

## How it's put together

Three layers, one rule.

- **Shell** (`src/main/`) — the only OS-aware code. Hotkey, clipboard, open URL, dialogs. Lives
  behind the six-method `OSShell` interface, so porting means reimplementing one file.
- **Core** (`src/core/`) — the brain. A **tool registry** (the menu of what it can do) and a
  **planner** (the loop that turns an instruction into one validated tool call). Imports no
  `electron`, reads no globals — it runs headless in tests.
- **Memory** (`src/core/memory/`) — local SQLite. Facts carry **confidence, version, and an active
  flag**, so corrections and contradictions are first-class rather than overwrites.

**The one rule: the LLM proposes, the planner disposes.** The model's tool call is a *proposal*.
The registry check, argument resolution, validation, and the confirm gate are deterministic code.
The model never invents a capability, and nothing `dangerous` runs unconfirmed.

Since **M10** that gate is four tiers rather than a boolean (`src/core/risk.ts`), because the app
can now act *inside* another app, where most actions have no undo at all: `safe` and `reversible`
run; `caution` runs but **says what it is about to do first**; `dangerous` stops for an explicit
yes, every time.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for diagrams and [`spec.md`](spec.md) for the decisions.

---

## The seven demo tasks

| # | Say this | It does |
|---|---|---|
| 1 | "summarize this" | Summarizes your copied text |
| 2 | "rewrite this in my tone" | Rewrites it using your **stored** tone → clipboard |
| 3 | "open my dashboard" | Resolves the name → opens the URL |
| 4 | "remember my dashboard is …" | Stores the fact |
| 5 | "send these notes to the team" | Formats + posts to Slack — **after you confirm** |
| 6 | "no, I meant the design channel" | **Corrects** the fact: old row retired, new version active |
| 7 | "what do you know about the team?" | Recalls it — with confidence, version, recency |

…and three more in **M10**, with a Gmail message open in Chrome:

| # | Say this | It does |
|---|---|---|
| 8 | "reply and say I can't make Tuesday, propose Thursday" | Reads the open email, drafts a reply **in your tone**, opens the reply box, puts it in |
| 9 | "make it shorter" | Rewrites **that same draft** — including any edits you made by hand |
| 10 | "send it" | Shows the real recipient and the **whole** draft, and sends only if you say yes |

…and one more in **M11**, with a Notion page open in the same Chrome:

| # | Say this | It does |
|---|---|---|
| 11 | "note that the launch moved to Friday" | Reads the open page, writes a note **in your tone**, adds it to the end |

Task 11 is one-shot, not three like 8-10: Notion has no staging area and no send button, so
there's nothing to draft-then-send. A follow-up like "make that note shorter" is an honest
miss, not a silent edit — see [Scope](#scope).

Anything else → an honest refusal, logged as a miss (a ranked backlog of what to build next).
It never guesses.

---

## System-wide dictation (M12)

Not one of the tasks above — it never touches the planner, the registry, or memory. Hold
nothing: tap the **dictation hotkey** (separate from the instruction hotkey) to start
listening, tap it again to stop and **type the raw transcript at the cursor of whatever
window currently has focus, in any app** — a terminal, Notepad, a browser text field, Word.
No tool selection, no confirm gate, because there's no plan to confirm: it's the literal
"type what I said" primitive.

It narrates *before* it types (naming the window it captured focus on, so you know where
text is about to land before you speak), and it refuses rather than guesses: if focus moved
between speaking and typing, or the OS reports fewer keystrokes accepted than sent (most
often an unelevated app trying to type into an elevated one), nothing is typed and the
transcript you spoke is shown back to you instead. See [Setting up dictation](#setting-up-dictation-optional)
below and `spec.md` §4c for the full design.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill in the keys below
npm run dev               # press Ctrl+Shift+Space anywhere
```

**One hotkey: `Ctrl+Shift+Space`.** It opens the command bar *and* starts listening, so you
decide whether to speak or type after the bar is up.

| You do | It does |
|---|---|
| **Speak**, then **Enter** | Stops, transcribes, runs it |
| **Start typing** | Silently cancels the recording — no stray transcript |
| Type, then **Enter** | Runs the typed text |
| **Esc** (works even while unfocused — e.g. mid-dictation), or click away | Discards everything. Nothing runs |
| Wait **90 s** | Mic released, audio kept — **Enter** still runs it, however long you leave it |

**Workflow:** select text → **Ctrl+C** → **Ctrl+Shift+Space** → speak or type.

Global shortcuts are first-come-first-served across the whole OS (`Ctrl+Alt+Space` is claimed by
the Microsoft IME on some installs), so the app takes the first free combo from
`Ctrl+Shift+Space` → `Ctrl+Alt+Space` → `Ctrl+Alt+M` → `Alt+Shift+Space` and prints which one won.
Pin your own with `HOTKEY` in `.env`.

Whichever way you produce it, the instruction goes to the planner on the same path — same registry
check, same memory resolution, same confirm gate. Nothing ever runs without your **Enter**.

**`.env` keys**

| Key | Needed for |
|---|---|
| `LLM_PROVIDER` | Which client `createLLMClient()` builds — `anthropic` or `openai`. Required; an unset or unrecognized value fails loudly at startup rather than guessing. |
| `ANTHROPIC_API_KEY` | Only if `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | Only if `LLM_PROVIDER=openai` |
| `SLACK_WEBHOOK_URL` | Task 5 only (`sendMessage`) |
| `WHISPER_EXE_PATH` · `WHISPER_MODEL_PATH` · `WHISPER_LANGUAGE` | Voice **and** dictation (M12). Optional — leave them blank and neither the bar's microphone nor the dictation hotkey ever activate; typed commands work exactly as before. |
| `HOTKEY` | Optional. Pins the instruction-bar combo instead of letting the app pick the first free one. |
| `DICTATE_HOTKEY` | Optional. Pins the **dictation** combo (M12) — separate from `HOTKEY` above. Needs `WHISPER_*` set too, or there's no transcriber to dictate with. |
| `CHROME_DEBUG_URL` | Tasks 8-11 (the Gmail reply tools **and** the Notion tool — one debug Chrome, both). Optional — leave it blank and none of those four tools are ever offered at all. |

### Setting up the Gmail reply tools (optional)

DOM-based, not screenshot-based: the app finds the real **Reply** button by its role and
accessible name, and refuses if it can't identify it. No pixel clicking anywhere.

1. **Start Chrome with remote debugging and its own profile.** Since Chrome 136 the debugging
   port is refused on your default profile, so the second flag isn't optional:

   ```
   chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\voice-agent-chrome"
   ```

2. **Sign in to Gmail in that window.** Use a **throwaway/test account first** — task 10 really
   does send email.
3. **Set `CHROME_DEBUG_URL=http://127.0.0.1:9222`** in `.env`. Leave it blank and the three
   Gmail tools are never even offered to the model — a capability the app can't exercise
   shouldn't be on the menu it chooses from.

Scoped to **Gmail in Chrome, English UI**, with one message open. Anything else — another app,
another language, no message open, two matching Gmail tabs — is an honest refusal, never a guess.

### Setting up the Notion tool (optional)

Same debug Chrome as Gmail above — no second setup, just a Notion tab open in it. Set
`CHROME_DEBUG_URL` once and both work.

Notion's page content carries no ARIA roles at all (unlike Gmail), so the app targets the last
block on the page by structure (`data-block-id`, document order) instead. It also can't act
through ordinary JS calls the way Gmail's tools do — Notion's editor was found, live, to
silently ignore `.click()`/`.focus()`/`execCommand()` (they report success but save nothing),
so this tool drives real mouse and keyboard input at the CDP level instead. One visible
consequence: **using it will bring that Chrome window to the foreground**, unlike the Gmail
tools, which never need to.

Scoped to **one open page, append only** — content lands after everything already there, and
nothing existing is ever edited, reordered, or removed. There's no revision tool: a follow-up
("make that note shorter") is a miss, not a silent edit, on purpose — undoing what was just
written would mean deleting real content from a live document with no staging area. Two or
more Notion tabs open at once is narrowed to whichever is the foreground tab; still ambiguous
after that, or no page open at all, is an honest refusal.

**Known limits:** Chrome tab only — the Notion **desktop app** is a different, unverified
transport and isn't supported.

### Setting up voice (optional)

Transcription is **local** — audio never leaves the machine and there's no STT API key.

1. **Binary** — download a prebuilt Windows release from
   [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unzip it, and point
   `WHISPER_EXE_PATH` at `whisper-cli.exe`.
2. **Model** — download a ggml model (`ggml-base.en.bin` is a good starting point) from
   [the model repo](https://huggingface.co/ggerganov/whisper.cpp/tree/main) and point
   `WHISPER_MODEL_PATH` at it.
3. **Microphone permission** — Windows Settings → Privacy & security → Microphone → allow
   desktop apps.

Both paths absolute. Audio is captured in the renderer via Web Audio, downsampled to the 16 kHz
mono 16-bit WAV whisper.cpp expects, and passed to the binary as a temp file that's deleted
immediately after.

The provider lives behind the same `LLMClient` interface either way (`src/core/llm/` —
`anthropic.ts` / `openai.ts` / shared `prompt.ts` / `factory.ts`), so switching is a one-line
`.env` change, not a code change.

### Setting up dictation (optional)

No extra setup beyond voice above — dictation shares the exact same `WHISPER_EXE_PATH` /
`WHISPER_MODEL_PATH` transcriber, so if voice already works, dictation does too, on its own
**separate** hotkey.

| You do | It does |
|---|---|
| Tap the dictation hotkey | Starts listening — narrates which window it will type into |
| Tap it again | Stops, transcribes, and types the transcript at that window's cursor |
| **Esc**, or click away | Discards the recording. Nothing is typed |
| Wait **30 s** | Mic released, audio kept — the next tap still types it. (A safety ceiling for a forgotten stop-tap, not a normal session — the usual way to finish is the second tap.) |

The app claims the first free combo from `Ctrl+Shift+Alt+D` → `Ctrl+Alt+D` → `Ctrl+Alt+J` and
logs which one won — pin your own with `DICTATE_HOTKEY` in `.env`. `Ctrl+Alt+V` (Excel's Paste
Special) and `Alt+Shift+D` (Word's insert-date field) are deliberately not on that list at all.

It's a **separate** hotkey rather than reusing the instruction bar's one (M8), because the two
want opposite focus behaviour: the instruction bar steals focus on purpose (you're talking to
the agent); dictation must never steal focus (you're talking to whatever app you're already
in). They can't run at the same time either — both need the one microphone — so triggering one
while the other is mid-capture is a logged no-op, not a silent failure.

If focus moves to a different window between when you finish speaking and when it's about to
type, or Windows blocks the keystrokes outright (typically an unelevated app trying to type
into an elevated one — an admin terminal, say), nothing gets typed. You'll see the transcript
you spoke instead of losing it silently.

> **Native-module note.** `better-sqlite3` needs a different binary for Node (tests) than for
> Electron (the app). The `pretest` / `predev` scripts rebuild it automatically, so switching
> between `npm test` and `npm run dev` costs one short rebuild. Nothing to do manually — except
> **quit the app before running `npm test`**: a running Electron holds `better_sqlite3.node` open,
> and the rebuild fails with `EBUSY` / `EPERM` rather than anything that names the real cause.

---

## Watching the memory story

```bash
npm run eval
```

The eval harness in [`tests/eval/`](tests/eval/) is the demo, as an asserted scenario. It is **one
continuous thread of state** — not six isolated tests — and prints as a narrative:

```
Step 1 — cold memory: "open my dashboard" cannot resolve, and NOTHING fires
      ❌ refused: I don't know what "my dashboard" refers to yet…
Step 2 — teach it                                    ✅ target:dashboard = https://old… (v1)
Step 3 — the SAME task now works                     ✅ opened https://old.example.com
Step 4 — correct it: "no, I meant the new one"       ✏️  v1 retired (active=0), v2 active
Step 5 — the same task uses the CORRECTED value      ✅ opened https://new.example.com
Step 6 — recall reveals it        🧠 target:dashboard → https://new… (confidence 0.80, v2, today)
```

`npm test` runs everything (231 tests): the planner, each tool, the memory engine, the risk gates,
the LLM-provider factory, the voice state machine, the dictation state machine, the Gmail reply
flow, the Notion page-writing flow, and both eval suites. All headless against `MockShell`, a
`MockInputInjector` standing in for real `SendInput`, fake Gmail/Notion tabs, and jsdom
fixtures — **no API key, no network, no real Slack, no microphone, no whisper model, no browser,
no inbox, no Notion account, and no OS keystroke actually sent.**

---

## Status — what's proved, and what isn't

**Verified deterministically (165 tests):** tool routing, the registry guard against hallucinated
tools, memory resolution, version-on-conflict, decay, the correction loop end to end, the confirm
gate (**"no" provably sends nothing** — the fake sender is asserted to have received zero calls),
failure-after-confirm, graceful refusal, and `LLM_PROVIDER` selection/error handling.

**Voice — mechanism verified, speech not.** Every state transition is asserted directly,
including the decided edge cases: typing cancels the recording **silently** (no message, no stray
transcript), the 90 s cap releases the mic without transcribing while `Enter` still runs what you
said, a second `Enter` during transcription never starts a second run, and every failure — blocked
mic, whisper crash, blank transcript, sub-300 ms clip — returns to `idle` with the hotkey still
live. The load-bearing test is that a dictated instruction produces an `action_log` row
**indistinguishable from a typed one**, and that a dictated irreversible action still stops at the
confirm gate.

**One measured bug, found and fixed.** Live use felt slow, and typed input was affected too —
which pointed at the shared path, not at voice. `showInput()` was registering a fresh IPC listener
per call and only removing it on submit or Escape, so clicking the bar away stranded one. Measured:
five abandoned openings left five stranded listeners, and the next single keystroke fired **six
concurrent planner runs — twelve LLM calls, six `action_log` rows, and six executions of the
chosen tool.** (Had it routed to `sendMessage`: six confirm dialogs, six Slack posts.) The resolver
now lives on the shell instance behind one persistent listener, and every way of hiding the bar
ends the capture. Re-measured after the fix: **one run, flat listener count.** Details and the
before/after table are in [`spec.md`](spec.md).

That fix is now **pinned by a test rather than by care**. Cleanup is bound to the window's own
`hide`/`closed` events instead of to one method, so a future direct `window.hide()` cannot quietly
reintroduce it, and `tests/WindowsShell.capture.test.ts` opens and hides the bar 20 times across
all five hide paths asserting the listener count never moves. Both failure shapes were verified to
actually turn it red.

**A silent failure that no longer is.** `chooseTool` asked for 1024 tokens, but on a reasoning
model the reasoning is spent from the same allowance the tool call must fit in — so a long think
could return no tool call, and the app reported that as *"I don't have a tool for that"* and filed
it in the miss backlog as a missing capability. Both wrong, and invisible. The budget is now 4096,
and truncation is its own outcome (`{ kind: "incomplete" }`) that surfaces the real reason and
stays out of the build-next backlog.

While the planner works, the bar shows **Thinking…** — a 6–13 s wait that shows work reads
very differently from one that looks frozen. It makes nothing faster; it makes the time legible.

**Baseline latency is the model, not the app.** Measured end-to-end: `chooseTool` 3.4–8.8 s,
`complete` 2.5–6.1 s, whole instruction 6.5–12.7 s — while hotkey → bar visible is 5–40 ms. `gpt-5`
is a reasoning model and dominates every run; if instructions need to feel faster, that is the
lever, not the shell.

**Not verified: anything requiring a real microphone or model** — transcription accuracy and CPU
latency, Windows 11 mic permission, the 48 kHz→16 kHz resample against a real device, and whether
tap-to-toggle *feels* right in practice. The fakes prove the machinery, not the speech.

**Live-verified: OpenAI / `gpt-5`.** A real run surfaced a genuine gap and it's now fixed: a
correction that names its subject ("no, my dashboard is actually `<url>`") always routed to
`remember` correctly, but a *bare* correction ("no I meant this `<url>`") was inconsistent —
`chooseTool` had no memory of the previous instruction, so the model sometimes declined,
sometimes mis-fired `openTarget`. Fixed by giving the planner one turn of state: `ActionLog.getLast()`
is now passed into every `chooseTool` call, scoped strictly to resolving a correction/pronoun in
the current instruction (`src/core/planner.ts`, `src/core/llm/prompt.ts`). Re-verified 3/3
consistent after the fix. Slack send (confirm gate → format → real webhook POST) also confirmed
working live.

**Not yet live-tested: Anthropic / `claude-sonnet-4-6`.** It's implemented against the exact same
`LLMClient` interface and typechecks, but nobody has run it against a real Anthropic key yet — flip
`LLM_PROVIDER=anthropic` in `.env` to try it. Until that happens, treat it as
implemented-but-unverified, not proven.

If correction-routing ever misfires again, the fix belongs in the **`remember` tool's description**
(`src/core/tools/remember.ts`) or the previous-turn framing in `src/core/llm/prompt.ts` — **not**
in the planner's control flow.

**M11, live-verified against a real Notion page.** The mechanism this milestone rests on was
tested directly before being shipped: JS-level `.click()`/`.focus()`/`document.execCommand()`
calls report success on Notion's editor but save nothing — confirmed across several distinct
approaches — while real CDP-level mouse and keyboard input works. A single multi-line
`insertText` call also silently dropped everything after its first newline; a real Enter
keypress between separately-typed lines does not. The **shipped** `ChromeNotion` class (not a
throwaway script) then appended real, verifiable text to the live page end to end, and a live
Gmail regression confirmed the `core/browser/` extraction broke nothing. Not yet proven by
anything short of more live use: behavior on a locked/read-only page (none was available to
test against — `appendToPage` verifies success by reading the page back rather than
pre-checking for one), and whether `Page.bringToFront`'s visible tab-switch is an acceptable
cost in daily use.

**M12 — mechanism verified once, manually; the full state machine proven, real keystrokes
not.** `SendInput` + `KEYEVENTF_UNICODE`'s exact P/Invoke shape (the nested-type array
construction, `Marshal.SizeOf`, the struct layout) was checked by hand outside the test suite
before being shipped — deliberately via a **zero-length** `SendInput` call plus a read-only
foreground-window query, so the verification step itself could never inject a keystroke
anywhere. `DictationSession`'s state machine is pinned the same way `VoiceSession`'s is: the
begin → recording → transcribing → inserting → idle order; a focus change between speaking
and typing refusing outright with the transcript preserved, never guessing it's still safe to
type; a short/blocked write becoming a thrown refusal rather than a silent partial type; the
30 s cap releasing the mic without acting; and — the specific regression this milestone's own
`WindowsShell` change was for — Escape, a direct `window.hide()`, and the window closing all
correctly cancel a dictation session that never called `showInput()` at all, something the
pre-M12 code had no way to do since its only guard was "is a typed-text capture pending".
**Not yet proven, and only a live run can prove it:** that real keystrokes land correctly in
real targets (a terminal, an IDE with its own autocomplete, Word/Excel specifically, since the
hotkey list was chosen around avoiding exactly those apps' own shortcuts), that the
elevated-window refusal fires the way the design assumes, and whether the 30 s cap is the
right length in practice.

---

## Scope

v0 is deliberately small: one instruction → one plan → one action. **Voice was added in M7**, after
v0 was complete — deliberately in that order, because voice is only a second way to produce the
instruction string, and it was worth building only once the string reliably produced the right
action. It changed nothing in `/core`.

**M10 added acting inside one app** — Gmail in Chrome, via the DevTools Protocol, finding
controls by role and accessible name. Deliberately one app: the writing half
(`src/core/compose.ts`) is app-agnostic and free to reuse, but the finding half needs real
verification per app, and "works everywhere, reliably nowhere" is the failure this project has
been avoiding since day one.

**M11 added a second app — Notion in Chrome, one page, append only** — specifically to test
whether that split was real. It mostly was: the generic browser transport
(`src/core/browser/`) and a genuinely shared writing core (`src/core/composeShared.ts`) both
came out of it clean and reusable. What did NOT transfer: `compose.ts`'s reply-shaped rules
(a note needs no greeting or sign-off), the three-tool draft/revise/send shape (Notion has no
staging area to build the other two around), and — the biggest surprise — the *mechanism*
itself. Gmail's compose box takes ordinary JS calls; Notion's editor silently ignores them and
needs real CDP-level input instead. Even the safety RULE ("resolve every target structurally,
refuse on ambiguity") only partly transferred: Notion exposes no ARIA roles on page content at
all, so the identification strategy had to become `data-block-id` + document order rather than
role + accessible name.

**M12 added acting outside any browser at all — system-wide dictation.** Deliberately the
narrowest possible slice of "act on the OS": one operation (insert text at the caret),
triggered by a hotkey the model never sees and never chooses, so none of the tool-choosing
machinery M10/M11 needed even applies. It's the generalization the Gmail/Notion CDP work
always implied — real device-level input beats JS calls a target can silently ignore — played
on the one surface Chrome's DevTools Protocol can't reach: everything that isn't Chrome.

**Still not built:** screenshot/vision-driven clicking anywhere on screen, multi-step agent loops,
more than one external connector, macOS/Linux, any email app but Gmail-in-Chrome, any page editor
but Notion-in-Chrome (and only the Chrome tab, not the Notion desktop app), search/navigation
within either app, and any dictation cleanup/rewrite pass (raw transcript only — see `spec.md`
§4c for the seam left for a later milestone). Those are architected for (behind `OSShell` /
`VoiceShell` / `InputInjector` / `GmailSurface` / `NotionSurface` and the tool registry) but not
built.
