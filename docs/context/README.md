# Context file index

Read `PROJECT_CONTEXT.md` first for the project's foundational decisions,
philosophy, and design principles — those are still accurate and don't go
stale. Everything else is a dated log; later files supersede earlier ones
for *status*, not for reasoning or philosophy.

**Current status (as of 2026-10-22): M0-M25 shipped; M25 closed 2026-10-22, with named gaps.**
There is no context file past `PROJECT_CONTEXT_UPDATE_9.md`, which is current **through M19
only**. For M20 to M25 the status lives in `spec.md` (§9's entry for each, and §6e / §6f / §5c /
§4d for the design) and in each milestone's live checklist:

- **M20 - GitHub issues, the second connector.** `docs/M20-live-checklist.md`: 15 boxes
  ticked, 12 open.
- **M21 - references checked before a chain starts; ask instead of refuse.**
  `docs/M21-live-checklist.md`: 25 ticked, 6 open.
- **M22 - Slack bot-token mode.** Closed 2026-10-13 after a live run by a person.
  `docs/m22-live-checklist.md`: 32 ticked, 6 open. 2206 tests passed across 95 files at the
  close, and 2242 across 98 after the follow-ups after it (a model-error log row, the webhook
  timeout, the 429 tests).
- **M23 - background jobs, the status pill, the needs-you chime.** Closed 2026-10-22 after a
  live run by a person, with named gaps. `docs/M23-live-checklist.md`: 12 ticked, 30 open (25 of those covered by a
  scripted run against the real app or by tests). 2824 tests passed across 124 files at the
  close, 95 skipped.
- **M24 - speech longer than 15 s plays to its end.** Closed 2026-10-22 after a live run by a
  person and a loopback-recorded scripted run against the real app, with named gaps.
  `docs/M24-live-checklist.md`: 3 ticked, 11 open (9 of those machine-verified from what reached
  the speakers, 2 not run). Four live findings, none a regression, became M25. 2870 tests passed
  across 127 files at the close, 96 skipped.
- **M25 - "read the rest" after a short answer, a short time answer, Escape and an outside click
  on a running instruction, detach log lines.** Closed 2026-10-22 after a live run by a person
  and a loopback-recorded scripted run, with named gaps. `docs/M25-live-checklist.md`: 4 ticked,
  15 open (3 covered by the script, 12 by tests only). One live finding, investigated: a
  finished background job leaves the pill after about 10 s (M23's deliberate 8 s fade), and its
  result is unreadable after that; the fix is decided for M26 (keep a done job until seen). `npm test` now passes
  2922 across 132 files, 96 skipped (the opt-in real-model evals and real-Piper check).

An open box in a checklist means *not seen by a person*, not *failing*; each checklist says
which. `docs/M19-live-checklist.md` and `docs/M18-live-checklist.md` also still have open items.

M19 (MCP support, with Linear as the first connector) was run live and ticked on 2026-10-09
**with named gaps**: the Gmail -> Linear -> Slack chain, the confirm dialogs and one run of the
plan-choice fix were seen by a person; the decline/failure cases, the long-email dialog, the
injected-instruction email and the `functions.` prefix rule are covered by tests only. Plan
choice with a non-empty clipboard was improved after the close (verb-keyed wording, a confirm
label, a log line) and that fix's live re-run passed on 2026-10-09; it still cannot be made
certain.

This index is re-checked at every milestone close-out (`.claude/skills/milestone-closeout/`).

## Read order for a fresh session
1. `PROJECT_CONTEXT.md` — philosophy, still current
2. `PROJECT_CONTEXT_UPDATE_9.md` — status through M19
3. `spec.md` §9 (M20, M21, M22, M23, M24, M25) and the six checklists above — status since
4. Only if you need the history of *how* we got here: `PROJECT_CONTEXT_UPDATE.md`
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
