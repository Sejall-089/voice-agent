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

**Explicitly OUT of scope for v0 (do not build, do not scaffold):**
- Voice / speech-to-text.
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
| Planner LLM        | **Anthropic SDK** (`@anthropic-ai/sdk`)  | Tool-calling. Model `claude-sonnet-4-6` for planning. |
| External action    | **Slack Incoming Webhook** (via `fetch`) | The only connector in v0. |
| Active window      | `active-win` (optional)                  | If it complicates the build, skip; context still works from clipboard. |
| Config / secrets   | `.env` (dotenv), never committed         | `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`. |

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
    llm.ts         Anthropic client + tool-call request/parse
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
  registerHotkey(combo: string, onTrigger: () => void): void;
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

## 5. The planner loop (core/planner.ts)

Given the user's instruction and captured context, run exactly this sequence:

1. **Assemble request** — build the LLM call: the instruction + context + the tool
   schemas from the registry (§6).
2. **LLM picks a tool** — call Anthropic with tool-calling. Expect a `tool_use`
   block: `{ name, input }`. The model may also decline (return only text).
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

**v0 status: complete.** 57 tests green against `MockShell` (`npm test`). The eval
harness (`npm run eval`, `tests/eval/`) runs the memory story as one continuous
scenario — cold memory refuses → teaching fixes it → a correction versions it →
recall reveals it — plus the seven demo tasks and the closed-world refusal.

**The one open item:** no live run has been done. Every LLM call and the Slack POST
are proved only against fakes, because no `ANTHROPIC_API_KEY` / `SLACK_WEBHOOK_URL`
has been available. In particular, whether the model reliably *routes* a correction
("no, I meant…") to `remember` rests on its judgment, not on deterministic code — the
tests prove the mechanism, not the routing. If it mis-routes, the fix is the
`remember` **description**, not the planner.

---

## 10. Conventions

- TypeScript strict. No `any` in core.
- `/core` must not import `electron` — it only knows the `OSShell` interface.
- Every tool handler is pure w.r.t. the shell/memory it's given (pass dependencies
  in; don't reach for globals) so it's testable against MockShell.
- Secrets only from `.env`. Never log the API key or webhook URL.
- Small commits per milestone; keep this spec updated if a decision changes.
