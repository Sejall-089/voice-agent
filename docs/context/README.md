# Context file index

Read `PROJECT_CONTEXT.md` first for the project's foundational decisions,
philosophy, and design principles — those are still accurate and don't go
stale. Everything else is a dated log; later files supersede earlier ones
for *status*, not for reasoning or philosophy.

**Current status: see `PROJECT_CONTEXT_UPDATE_9.md`.** M0-M19 shipped. M19 (MCP support,
with Linear as the first connector) was run live and ticked on 2026-10-09 **with named
gaps**: the Gmail -> Linear -> Slack chain, the confirm dialogs and the plan-choice fix were
seen by a person; the decline/failure cases, the long-email dialog, the injected-instruction
email and the `functions.` prefix rule are covered by tests only. 1184 tests pass.
`docs/M19-live-checklist.md` and `docs/M18-live-checklist.md` both still have open items,
and say which.

## Read order for a fresh session
1. `PROJECT_CONTEXT.md` — philosophy, still current
2. `PROJECT_CONTEXT_UPDATE_9.md` — current status
3. Only if you need the history of *how* we got here: `PROJECT_CONTEXT_UPDATE.md`
   through `PROJECT_CONTEXT_UPDATE_8.md` in numeric order, plus
   `future_scope_post_m14.md`

## What's superseded (don't treat these as current status)
- `PROJECT_CONTEXT_UPDATE.md`, `PROJECT_CONTEXT_UPDATE_2.md`: reply/compose
  feature scoping — resolved, see `PROJECT_CONTEXT_UPDATE_3.md`
- `PROJECT_CONTEXT_UPDATE_3.md`: Gmail decision locked (DOM-based, not
  vision) — shipped as M10, see `PROJECT_CONTEXT_UPDATE_7.md`
- `PROJECT_CONTEXT_UPDATE_4.md`: Gmail (M10) build going live, likely Notion
  (M11) too — *verify this description against the actual file, noted with
  lower confidence than the rest of this index* — superseded, see
  `PROJECT_CONTEXT_UPDATE_7.md`
- `PROJECT_CONTEXT_UPDATE_5.md`: carry-forward ("TTS then vision-guidance
  next") — both happened, see `PROJECT_CONTEXT_UPDATE_6.md` and `_7.md`
- `PROJECT_CONTEXT_UPDATE_6.md`: carry-forward (latency fix vs. next
  milestone) — resolved, see `PROJECT_CONTEXT_UPDATE_7.md`.
  `future_scope_post_m14.md`'s items are now unblocked (M14's issues it was
  waiting on are fixed) but still not started.
- `PROJECT_CONTEXT_UPDATE_7.md`: M15's failure and the decision to rebuild
  on UI Automation — reasoning still holds and is worth reading for *why*,
  but its "M16 decided, not yet started" status line is superseded by
  `PROJECT_CONTEXT_UPDATE_8.md`, which covers the actual build.
- `PROJECT_CONTEXT_UPDATE_8.md`: M16 built and live-verified - still accurate about M16, but
  it stops there. M17 (chained plans), M18 (apps and media keys) and M19 (MCP, Linear) are
  covered by `PROJECT_CONTEXT_UPDATE_9.md`.
