# Project Context — Update 3 (decision locked, ready to build)

Read alongside `PROJECT_CONTEXT.md`, `PROJECT_CONTEXT_UPDATE.md`,
`PROJECT_CONTEXT_UPDATE_2.md`, `spec.md`, `ARCHITECTURE.md`. This closes out
the research phase from Update 2 with a final decision and next action.

## Decision: locked

**Building the instruction-driven email reply feature, scoped to Gmail-in-Chrome,
using DOM/accessibility-based browser automation — not vision/screenshot-based
clicking.**

Full auto-click (vision-based, works on any app) remains explicitly deferred,
not abandoned. Reasoning below.

## Why this approach, summarized

- Reading a webpage's real structure (the actual "Reply" button, by name) beats
  guessing from a screenshot: no resize/scaling bugs, no fragile pixel-matching,
  and it's testable the same disciplined way as every other milestone.
- Confirmed independently by three separate sources during research: Anthropic's
  own best-practices guide (most of it is about fixing vision-click accuracy
  problems), `clacky`'s safety code (treats "can't identify what I'm about to
  click" as automatically dangerous), and Screenpipe (a funded, unrelated
  project) also chose accessibility-tree-first, vision/OCR only as fallback.
- Vision-based computer-use remains real and possible (verified via actual code,
  not just claims) but is genuinely more engineering, and even the best
  reference found (`clacky`) has its core acting loop unimplemented
  (`NotImplementedError`, "Phase 2") — concrete evidence it's harder than it
  looks, not a reason to avoid it forever.

## Why Gmail first, not a general "works everywhere" version

Two parts to this feature, split cleanly:
- **The thinking/writing part is already app-agnostic** — it's a generalization
  of the existing `rewrite` tool (read text, follow instruction, write in
  stored tone). Works via clipboard already; no per-app work needed here ever.
- **The "find Reply, put draft in the box" part is genuinely per-app** — Gmail,
  Outlook, and Slack lay things out differently. This part needs real
  verification per app, though far less rework than starting over each time
  (the "find by real name/role" approach tends to transfer reasonably well
  across similarly-structured sites, but isn't guaranteed reliable without
  checking).
- Starting narrow (one app, proven) before generalizing matches every prior
  milestone's discipline — avoids the "does anything, so nothing reliably"
  trap flagged at the very start of this project.
- Noted alternative for later: for apps with a real API (Gmail and Outlook both
  have one), building against the API directly (like the existing Slack
  integration) would be more "build once, stays working" than UI automation —
  but doesn't give a live, visible, editable draft in the compose box the way
  the user wants. Worth remembering as a simpler option if the "must appear
  live for tweaking" requirement ever relaxes.

## Screenpipe research (new since Update 2, don't re-research)

Investigated because user recalled it as vision-based; **turned out not to be**
— worth knowing so this isn't re-litigated. Screenpipe is primarily a
background context/memory capture tool (continuous local recording, searchable
by AI agents), not a clicking tool. Two takeaways:

- Its capture method is accessibility-tree-first, OCR/vision only as fallback —
  third independent confirmation of the approach chosen above.
- Its "pipes" (how it takes actions) use a real coding agent with real tool/API
  access given a plain-English instruction — the same LLM-plus-real-tools
  pattern this project already uses, not vision-clicking. Triggered by passive
  events instead of a hotkey, but structurally the same idea.
- **One idea worth borrowing later**: their permission system has three
  independent layers — (1) disallowed capabilities are removed from what the
  AI can even see/choose, not just refused after the fact, (2) a second check
  before any code executes, (3) a hard server-side enforcement as backstop.
  Stronger than a single gate. Worth considering once this project has more
  tools/integrations, not needed for the Gmail milestone specifically.
- Screenpipe is more relevant to the separate personal-OS/memory-engine project
  as a possible reference than to this voice-agent's acting question — noted,
  not pursued further here.

## Next action

The Plan Mode prompt for this milestone was already written in the prior chat
(Gmail-in-Chrome reply-draft tool, DOM-based, adapting `clacky`'s 4-tier risk
model for the confirm gate, iterative-tweak draft state, tests against
mocked/fake browser interaction). Reuse it as-is in the new chat — the decision
and reasoning above haven't changed anything about that plan, they only
confirm it.

Model/effort for this milestone: Plan Mode — Opus, high effort (new design
surface: browser automation, risk-tier adaptation, draft-state handling).
Implementation once approved — Sonnet, standard for most of it; Opus
specifically for whatever wires up the Send confirm gate.
