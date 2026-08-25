# Project Context — Voice-Action Agent

Use this alongside `spec.md`, `ARCHITECTURE.md`, and `README.md` in the repo.
Those hold the technical detail — this file holds the *decisions* and *direction*
that aren't written down anywhere else yet.

## What this is
A hotkey-triggered desktop assistant. Voice/text instruction + on-screen context +
governed local memory → one concrete action. The memory (versioned facts,
corrections that stick) is the actual differentiator, not the interface.

## Why it exists
Portfolio piece to demonstrate engineering ability for a pivot into AI/LLM
engineering. Not primarily meant to compete commercially — meant to be a
provable, well-architected artifact.

## Status (as of last session)
v0 is fully built: M0 through M6 complete, 57 tests passing. Everything is
proven against fakes (MockShell, fake LLM, fake message sender) — **no real
LLM call and no real external send has ever executed.** That's the top open
item, not a nice-to-have.

## Immediate next step (do this before anything else)
1. Add `ANTHROPIC_API_KEY`, run the app live.
2. The one real unknown: does a natural correction ("no, I meant the design
   channel") actually route to the `remember` tool, or does the model retry
   instead? If it misfires, fix the `remember` tool's *description* — not the
   planner.
3. Add `SLACK_WEBHOOK_URL`, send one real message. Check whether Slack's
   webhook actually respects the `channel` field or ignores it (may make the
   confirm dialog's promise inaccurate — verify against actual Slack settings).
4. Record a short demo from the eval harness (`tests/eval/story.eval.test.ts`)
   — cold memory refuses → teach a fact → task succeeds → correct it → task
   adapts → `recall` shows the version history. This scenario *is* the demo
   script.

## Confirmed direction (five decisions locked in)
- **Portfolio piece**, not a startup bet.
- **Voice is core**, not optional — add it in Phase 1, local whisper.cpp.
- **Memory stays local** (SQLite) — not merged into the separate personal-OS /
  Neon-Postgres project. Two separate things for now.
- **Cross-platform is a real goal**, Windows-first (only OS currently owned).
- **Wants a genuinely working product**, not just a demo — open question
  whether that means "polished for me" or "usable by others"; ask if unclear.

## The capability question — resolved
Original ask sounded like open-world "do anything" (closed-world tool list vs.
full computer-use). Resolved as: **most of what's wanted is achievable with
generic, content-operating tools, not app-specific automation.**

Concrete example that drove this: "select an email, speak a reply instruction,
get it back in my tone, pasted in." This does NOT require knowing it's Gmail —
it only needs selected text + a spoken instruction + stored tone → generate →
paste back. It's a generalization of the existing `rewrite` tool (instruction-
driven instead of fixed-tone), plus one new shell primitive: paste-into-focused-
field (shell currently only has copy-to-clipboard).

**Keep these two capability tracks named separately, don't blur them:**
- Generic instruction-driven content transforms (selected text + voice
  instruction + memory) — buildable now, high value, low risk, works across
  any app for free because it never needs to know which app it's in.
- True screen-vision / clicking-specific-UI-elements / autonomous background
  agents (the Heyclicky model: screenshot the whole screen, vision model reads
  it, can act without asking) — genuinely harder, more expensive, less
  reliable. Explicitly Phase 2, not sooner. Don't let scope drift here.

## Competitive note (Heyclicky, researched Aug 2026)
Mac-only, Swift-native, screenshot-per-hotkey + vision (not text extraction),
voice via AssemblyAI/GPT-Realtime + ElevenLabs, spawns autonomous background
agents, integrates Gmail/Notion/Reminders. YC-backed, $10.1M raised. One
analyst take worth remembering: "no real moat — thin client over commodity
model APIs." Screen-vision-plus-voice is becoming table stakes; governed,
versioned memory is not — that's still the actual edge to lean on.

## Cross-platform testing without owning a Mac
Core logic (planner/tools/memory) is already OS-agnostic and fully tested via
MockShell — cross-platform confidence on the *brain* is basically free. Only
the thin per-OS shell needs a real OS. Linux: cheap, test via a free VM
(VirtualBox / WSL2 with WSLg). Mac: no way around eventually needing real
hardware (borrow, rent via MacinCloud/MacStadium, or buy used) before claiming
real Mac support — CI can build it, but can't verify real permission dialogs.

## Design philosophy to preserve in every future milestone
- **Closed world**: fixed, tested tool registry. Never let the model invent a
  capability. Unregistered request → honest refusal + logged miss, never a
  guess.
- **Model proposes, code disposes**: the LLM picks a tool; deterministic code
  (registry check, validation, confirm gate) decides whether it actually runs.
- **Everything behind interfaces**: LLM client, shell, memory, message sender —
  all interfaces. Real implementation injected in production, fake injected in
  tests. This is *the* recurring pattern — apply it to any new external
  dependency.
- **`/core` never imports `electron`** (or any concrete OS/vendor SDK) — keeps
  it headless-testable and portable. This is enforced by convention; check it
  on every new file in `/core`.
- **Prefer generic capability over app-specific hacks**: a tool that operates
  on "whatever is selected" beats ten tools that each know about one app.
- **Build against seams, not shortcuts**: if a tool wants something a future
  milestone will provide (like memory), route it through the interface and
  fail gracefully now — don't hardcode a stand-in you'll have to rip out.
- **Milestone discipline**: one milestone at a time, Plan Mode first, build
  against mocks before the real thing, don't scaffold ahead of need.
- **Report honestly**: name every test that changed and why, state plainly
  what's proven vs. only proven-against-fakes, never dress up a deterministic
  pass as a live verification.

## Known, accepted weaknesses (don't let these get glossed over later)
- Nothing has run against a real LLM or real network yet.
- Memory resolution is deterministic string-matching (normalize + lookup), not
  semantic — "the board I use for work" won't match "dashboard." Acceptable
  for v0, a real limitation, candidate for Phase 1 depth work.
- Every architectural decision so far has had one reviewer (Claude, in chat).
  Worth a second real opinion eventually.
- Built mostly by directing Claude Code milestone-by-milestone rather than
  hand-writing — comprehension of the codebase was a genuine gap, actively
  being closed by reading the code with guided explanations. For future new
  concepts, hand-build the first instance of a new pattern before delegating
  the rest, to avoid the gap re-forming.

## How to work with me in this project
- Keep answers short and plain — long technical explanations lose attention.
  One idea at a time.
- For any new milestone: propose a plan (Plan Mode style), confirm scope
  before building, build against mocks before the real shell/LLM/network.
- Point to the repo's `spec.md` / `ARCHITECTURE.md` for technical detail
  instead of re-explaining architecture from scratch each time.
- When judging a decision, be honest about trade-offs and weak points, not
  just encouraging — that's been the useful mode throughout this project.
