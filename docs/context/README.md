# Context file index

Read `PROJECT_CONTEXT.md` first for the project's foundational decisions,
philosophy, and design principles — those are still accurate and don't go
stale. Everything else is a dated log; later files supersede earlier ones
for _status_, not for reasoning or philosophy.

**Current status: see `PROJECT_CONTEXT_UPDATE_7.md`.** M0–M14 shipped and
live-tested (memory, voice in/out, Gmail, Notion, Calendar, dictation). M15
(vision-guidance) was built and honestly tested to failure — see Update 7
for why. M16 (UI Automation-based redesign) is decided, planned, not yet built.

## Read order for a fresh session

1. `PROJECT_CONTEXT.md` — philosophy, still current
2. `PROJECT_CONTEXT_UPDATE_7.md` — current status and the one open decision
3. Only if you need the history of _how_ we got here: `PROJECT_CONTEXT_UPDATE.md`
   through `PROJECT_CONTEXT_UPDATE_6.md` in numeric order, plus
   `future_scope_post_m14.md`

## What's superseded (don't treat these as current status)

- `PROJECT_CONTEXT_UPDATE.md`, `PROJECT_CONTEXT_UPDATE_2.md`: reply/compose
  feature scoping — resolved, see `PROJECT_CONTEXT_UPDATE_3.md`
- `PROJECT_CONTEXT_UPDATE_3.md`: Gmail decision locked (DOM-based, not
  vision) — shipped as M10, see `PROJECT_CONTEXT_UPDATE_7.md`
- `PROJECT_CONTEXT_UPDATE_4.md`: Gmail (M10) build going live, likely Notion
  (M11) too — _verify this description against the actual file, noted with
  lower confidence than the rest of this index_ — superseded, see
  `PROJECT_CONTEXT_UPDATE_7.md`
- `PROJECT_CONTEXT_UPDATE_5.md`: carry-forward ("TTS then vision-guidance
  next") — both happened, see `PROJECT_CONTEXT_UPDATE_6.md` and `_7.md`
- `PROJECT_CONTEXT_UPDATE_6.md`: carry-forward (latency fix vs. next
  milestone) — resolved, see `PROJECT_CONTEXT_UPDATE_7.md`.
  `future_scope_post_m14.md`'s items are now unblocked (M14's issues it was
  waiting on are fixed) but still not started.
