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
The model never invents a capability, and nothing irreversible runs unconfirmed.

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

Anything else → an honest refusal, logged as a miss (a ranked backlog of what to build next).
It never guesses.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill in the keys below
npm run dev               # press Ctrl+Shift+Space anywhere
```

**Two hotkeys, one destination.**

| Key | Does |
|---|---|
| **Ctrl+Shift+Space** | Opens the command bar. Type the instruction, Enter to run. |
| **Ctrl+Alt+Space** | **Tap once to start dictating, tap again to stop.** Same key both ways. |

Global shortcuts are first-come-first-served across the whole OS, and `Ctrl+Alt+Space` is taken on
some Windows installs (the Microsoft IME claims it). So the app tries `Ctrl+Alt+Space` →
`Ctrl+Alt+M` → `Ctrl+Shift+M` → `Alt+Shift+Space` and uses the first the OS grants, printing which
one won on startup — the recording indicator names the real key too. Pin your own with
`VOICE_HOTKEY` in `.env`.

**Workflow:** select text → **Ctrl+C** → hotkey → type *or* speak your instruction.

While recording, the bar shows a pulsing red **● Recording…** so a toggle you left running is
impossible to miss; **Esc** discards the take, and it auto-stops after **90 seconds** regardless.
The transcript is handed to the planner on exactly the path typed text takes — same registry
check, same memory resolution, same confirm gate.

**`.env` keys**

| Key | Needed for |
|---|---|
| `LLM_PROVIDER` | Which client `createLLMClient()` builds — `anthropic` or `openai`. Required; an unset or unrecognized value fails loudly at startup rather than guessing. |
| `ANTHROPIC_API_KEY` | Only if `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | Only if `LLM_PROVIDER=openai` |
| `SLACK_WEBHOOK_URL` | Task 5 only (`sendMessage`) |
| `WHISPER_EXE_PATH` · `WHISPER_MODEL_PATH` · `WHISPER_LANGUAGE` | Voice only. Optional — leave them blank and typed commands work exactly as before; the first voice attempt then tells you what to set. |
| `VOICE_HOTKEY` | Optional. Pins the dictation combo instead of letting the app pick the first free one. |

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

> **Native-module note.** `better-sqlite3` needs a different binary for Node (tests) than for
> Electron (the app). The `pretest` / `predev` scripts rebuild it automatically, so switching
> between `npm test` and `npm run dev` costs one short rebuild. Nothing to do manually.

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

`npm test` runs everything (87 tests): the planner, each tool, the memory engine, the confirm gate,
the LLM-provider factory, the voice state machine, and both eval suites. All headless against
`MockShell` — **no API key, no network, no real Slack, no microphone, no whisper model.**

---

## Status — what's proved, and what isn't

**Verified deterministically (87 tests):** tool routing, the registry guard against hallucinated
tools, memory resolution, version-on-conflict, decay, the correction loop end to end, the confirm
gate (**"no" provably sends nothing** — the fake sender is asserted to have received zero calls),
failure-after-confirm, graceful refusal, and `LLM_PROVIDER` selection/error handling.

**Voice (M7) — mechanism verified, speech not.** Every toggle transition is asserted directly,
including the decided edge cases: a press *while transcribing* is ignored (it would race the
transcript in flight), the 90 s cap runs the *same* stop path rather than discarding the take, and
every failure — blocked mic, whisper crash, blank transcript, sub-300 ms clip — returns to `idle`
with the hotkey still live. The load-bearing test is that a dictated instruction produces an
`action_log` row **indistinguishable from a typed one**, and that a dictated irreversible action
still stops at the confirm gate.

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

---

## Scope

v0 is deliberately small: one instruction → one plan → one action. **Voice was added in M7**, after
v0 was complete — deliberately in that order, because voice is only a second way to produce the
instruction string, and it was worth building only once the string reliably produced the right
action. It changed nothing in `/core`.

**Still not built:** computer-use, multi-step agent loops, more than one external connector,
macOS/Linux. Those are architected for (behind `OSShell` / `VoiceShell` and the tool registry) but
not built.
