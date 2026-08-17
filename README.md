# Voice-Action Agent — v0

A desktop assistant that turns a short typed instruction, plus what's on your screen, plus what it
remembers about you, into **exactly one concrete action**.

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

**Workflow:** select text → **Ctrl+C** → **Ctrl+Shift+Space** → type your instruction.

**`.env` keys**

| Key | Needed for |
|---|---|
| `OPENAI_API_KEY` | Everything — tool choice, summarizing, rewriting, formatting |
| `SLACK_WEBHOOK_URL` | Task 5 only (`sendMessage`) |

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

`npm test` runs everything (57 tests): the planner, each tool, the memory engine, the confirm gate,
and both eval suites. All headless against `MockShell` — **no API key, no network, no real Slack.**

---

## Status — what's proved, and what isn't

**Verified deterministically (57 tests):** tool routing, the registry guard against hallucinated
tools, memory resolution, version-on-conflict, decay, the correction loop end to end, the confirm
gate (**"no" provably sends nothing** — the fake sender is asserted to have received zero calls),
failure-after-confirm, and graceful refusal.

**Not verified — the one open item:** **no live run has ever happened.** No API key has been
available, so every LLM call and the Slack POST are proved only against fakes. Specifically:

- Whether the model reliably **routes a correction** ("no, I meant…") to `remember` rather than
  retrying the last action rests on *its judgment*, not on deterministic code. The tests prove the
  mechanism works once `remember` is chosen — not that it gets chosen.
- Prompt phrasing, summary/rewrite quality, and the real Slack HTTP call are all unexercised.

If correction-routing ever misfires, the fix belongs in the **`remember` tool's description**
(`src/core/tools/remember.ts`) — that's where the prompt lives, deliberately — **not** in the planner.

---

## Scope

v0 is deliberately small: one instruction → one plan → one action. **Not** in v0: voice,
computer-use, multi-step agent loops, more than one external connector, macOS/Linux. Those are
architected for (behind `OSShell` and the tool registry) but not built.
