# Context file index

Read `PROJECT_CONTEXT.md` first for the project's foundational decisions,
philosophy, and design principles — those are still accurate and don't go
stale. Everything else is a dated log; later files supersede earlier ones
for *status*, not for reasoning or philosophy.

**Current status (as of 2026-10-30): M0-M34 shipped; M34 closed 2026-10-30 after a live run by a
person, with seven open findings (see M34 below).**
There is no context file past `PROJECT_CONTEXT_UPDATE_9.md`, which is current **through M19
only**. For M20 to M34 the status lives in `spec.md` (§9's entry for each, and §6e / §6f / §5c /
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
  result is unreadable after that; the fix is decided for M26 (keep a done job until seen). 2922
  tests passed across 132 files at the close, 96 skipped.
- **M26 - a finished background job stays in the pill until seen.** Closed 2026-10-22 after a
  live run by a person, with named gaps. `docs/M26-live-checklist.md`: 3 ticked, 0 open. Three
  live findings about the pill, none fixed, all planned for M27: Dismiss closes the list; an
  outside click does not; and the label shows only the most urgent group ("1 running" hides
  done jobs). 2934 tests passed across 132 files at the close, 96 skipped.
- **M27 - three pill fixes from M26's findings, and what grew from them.** Closed 2026-10-23
  after a live run by a person, with named gaps. `docs/M27-live-checklist.md`: 10 ticked, 16 open
  (all 16 covered by tests or scripts against real windows; the dictation hotkey and Escape with
  the list open not run). The label counts every group; Dismiss keeps the list open and Dismiss
  all sits beside the chime toggle; a click outside the pill closes its list (a PowerShell helper
  polls the mouse buttons while the list is open); a mid-step cancel says Cancelling, a too-late
  one says so, and a job cancelled after a step ran stays with its message. One finding **not
  fixed**, under investigation: with clipboard text selected, "create a linear issue and send to
  fun" planned an extra "summarize the clipboard" step. 3021 tests passed across 136 files at
  the close, 96 skipped.
- **M28 - refuse unfilled placeholders in plan arguments; the plan-choice eval set.** Closed
  2026-10-23 after a live run by a person; M27's plan-choice finding **still open**.
  `docs/M28-live-checklist.md`: 2 ticked, 0 open. Two live findings, not fixed: a step the
  preview called "Capture the selected text unchanged" was `rewrite`, which reworded the text
  and replaced the clipboard (preview lines are the model's own `describe`); and a prose reply
  asking for the text, with nothing waiting. The finding was reproduced and measured with a new eval set
  (gpt-5-mini, 3 trials a case): the extra summarize step comes with a long clipboard. Two
  wordings fixed it and each broke a control, so both were reverted; the baseline and the two
  runs are in `spec.md` §9 (M28). Shipped: the planner refuses a plan whose arguments hold a
  placeholder nothing fills (`{selected_text}`). `npm test` passed 3039 across 137 files, 96
  skipped, at M28's close (the opt-in real-model evals and real-Piper check).
- **M29 - `rewrite` leaves the clipboard alone inside a chain; fixed preview phrases.** Closed
  2026-10-23 after a live run by a person. `docs/M29-live-checklist.md`: 9 ticked, 0 open. Both
  fixes are for M28's first finding:
  - **Fix 1.** Inside a chain, `rewrite` returns only the rewritten text, with no clipboard
    write and no header line. `MockShell` now holds a clipboard that the next capture reads,
    as Windows does.
  - **Fix 2.** Each preview line, shown and spoken, is the tool's own `planPhrase`, never the
    model's `describe`; the `[main]` line names each step's tool beside it. The planning prompt
    is unchanged.

  The live rewrite step was reached with the fallback phrase "rewrite this and file it in
  Linear, then tell fun". Two carried-over findings were seen again and are not fixed: M27's
  plan-choice finding (an unrequested summarize step, or the text condensed inside the create)
  and M28's prose question with nothing waiting. `npm test`: 3195 across 138 files, 96 skipped,
  at M29's close.
- **M30 - refuse a summarize or rewrite step nobody asked for, before a create.** Closed
  2026-10-23 on replay, test and scripted evidence. `docs/M30-live-checklist.md`: 0 ticked, 6
  open. For M27's plan-choice finding:
  - **The check.** `checkUnaskedSteps` (`core/chain.ts`) refuses a plan with a step of a tool
    declaring the new `Tool.askedForBy` (only `summarize` and `rewrite`, each with its own word
    list) before a create, unless the instruction says one of that tool's words. Two fixed
    wordings, by whether anything was copied. Kept out of the next previous turn. No lone-call
    call site. The `[main]` line also says where each create's description came from.
  - **New files.** `tests/unaskedSteps.test.ts`, `tests/planner.unaskedSteps.test.ts`,
    `tests/fixtures/unaskedSteps/replay.ts` (M28's eval table and 8 live runs),
    `tests/fixtures/planChoice/clipboards.ts` (the M28 eval's clipboards, moved),
    `scripts/m30-say-refusal.ts` (speaks the refusal through real Piper, for box 1.2).
  - **Evidence.** The replay refuses 30 of 30 unasked steps and runs 5 of 5 asked-for ones. In 12
    scripted live trials with faked connectors the model planned no unasked step, so the refusal
    was **not** seen against a real plan; "summarize this and file it" passed 5 of 5.
  - **Known gaps.** "file a one-line issue from this" and "sum the whole thing up" are wrongly
    refused; inflected forms; a listed word inside the bug lets the step through.
  - **M31 candidate.** In 4 of those 12 trials the planner made a lone create and dropped the
    send. Not fixed.

  `npm test`: 3292 across 140 files, 96 skipped (3291 plus the guard test for the new script).

- **M31 - refuse a create plan that drops a requested send.** Closed 2026-10-23 after a live run
  by a person. `docs/M31-live-checklist.md`: 2 ticked, 0 open (H1: the refusal heard through
  Piper, natural, no slash; H2: "create a linear issue and send to fun" in the real app planned
  create then send, cancelled, nothing filed). For M30's open finding:
  - **The check.** `checkDroppedSends` (`core/chain.ts`) refuses a plan or lone call holding a
    create and no step of a tool declaring the new `Tool.askedWithCreateBy` (only `sendMessage`),
    when the instruction says one of its words with a destination memory knows (a `#name`, a
    phrase memory resolves to a `#channel`, or a bare name whose `#channel` memory holds). On the
    lone-call path and the plan path; kept out of the next previous turn.
  - **New files.** `tests/droppedSends.test.ts`, `tests/planner.droppedSends.test.ts`,
    `tests/fixtures/sendDropped/drops.ts` (the 5 drops on record). `scripts/m30-say-refusal.ts`
    gained `--dropped-send`.
  - **Evidence.** Recon: fresh-log trials dropped 3 of 6, shared-log 0 of 6, all lone tool calls.
    Scripted live with faked connectors (36 calls): 4 drops refused, 9 create > send plans ran to
    the dialog, the control never refused, and M30's refusal fired against a real plan 5 times.
  - **Known gaps.** Only sends; a channel never taught to memory; more than three words between
    "send" and "to"; a known channel inside the bug text.
  - **Candidates.** Re-ask the model once on either refusal (9 of 18 send requests refused); the
    bot-mode channel list (a network call, needs a design decision); other dropped steps (row
    559's Notion step); the fresh-log effect; a live prose reply that read the chat page on
    screen as context.

  `npm test`: 3350 across 142 files, 96 skipped (run with a scratch SQLite build; the dev app
  held the real one).
- **M32 - small items.** Closed 2026-10-30 after a live run by a person.
  `docs/M32-live-checklist.md`: 6 ticked, 0 open (H1-H6, including the decision that Escape does
  not close the pill list).
  - **The changes.**
    - A second instruction-hotkey press during voice capture is ignored; `VoiceLike` gained
      `getState()`.
    - A previous turn older than `PREVIOUS_TURN_MAX_AGE_MS` (10 minutes) is not sent to the
      model, by an injected clock (the `Planner`'s new last parameter, `now`).
    - A reply in the model's own words is shown and spoken after `PROSE_LEAD` ("Nothing ran. The
      model said: ") through `toSpokenWithLead`, and `[main]` says `[reply: model prose]` or
      `[reply: fixed refusal]`.
    - `tellTime` takes `what: "both"`.
    - New tests for Escape with the pill list open; no behaviour change.
  - **The cause of M31's live prose reply** was row 666's rewrite, through the previous turn and
    the clipboard, not the screen: the app captures only the clipboard.
  - **New files.** `tests/previousTurnAndProse.test.ts`. `scripts/m30-say-refusal.ts` gained
    `--framed-prose` and `--date-time`.
  - **Evidence.** Scripted live with faked connectors, 33 calls: the prose reply 0 of 6 before and
    after the change, so A and B are proven by tests and the two log rows, not live; the combined
    time phrasings picked "both" 4 of 4 with no control regressed.
  - **Open findings.**
    - A correction can plan a `remember` that overwrites a fact (`team` = `#social` to "social");
      the first item of the next investigation.
    - A scripted channel refusal was a test-setup artefact.
    - A and B are unproven live.
    - Left out on purpose: "what did that job say?" (its decisions open) and fixes C/D/E (need an
      eval).
    - M31's refusal rate (about half of send requests) is still open.
    - From M31: an untaught Slack channel; row 559's Notion step.
    - The spend gate's process-ID reuse.

  `npm test`: 3384 across 143 files, 96 skipped (run with a scratch SQLite build; an electron
  instance held the real one).
- **M33 - confirm before `remember` replaces a different value.** Closed 2026-10-30 after a live
  run by a person. `docs/M33-live-checklist.md`: 3 ticked, 1 open (H4, optional, not run: it
  could write a junk fact to the real memory).
  - **The changes.**
    - `remember`'s tier depends on its arguments. It is `dangerous` when an active fact with
      exactly this subject holds a different value: *Change what I remember for "team" from
      #social to #fun?*, with the button "Change it".
    - `prepare` settles the saved value: the bot-mode channel check moved there from the
      handler, and `PrepareDeps` gained `senderMode: "bot"`, present only in bot mode.
    - **The same-channel rule** (`sameName` and `judge`): values match ignoring one leading
      "#", case and spaces.
      - "social" for a stored #social writes nothing (*Already remembered "team" as #social.*).
      - "#social" over a stored "social" is a silent upgrade to v2.
    - A new `Tool.speakConfirm` field: `remember` says a leading "#" as "hash" in the spoken
      dialog only.
  - **New files.**
    - `tests/remember.overwrite.test.ts`;
    - `tests/fixtures/rememberCalls/` (the replay of every recorded `remember` call);
    - `scripts/m33-live.ts`, the live harness, committed this time: faked connectors, a real
      in-memory SQLite that keeps writes, fake checks before any model call, and `--scripted`
      for the dry run.
    - `scripts/m30-say-refusal.ts` gained `--remember-change`.
  - **Evidence.**
    - Scripted live with faked connectors, 42 calls: the hazard 0 of 24 correction trials, and
      no seeded fact changed. One control ("no, I meant the design channel") planned `team` =
      "the design channel", and the dialog caught it.
    - 14 mutations, all caught.
    - Her real-app H1-H3.
  - **Open findings (M34 candidates).**
    - A "#" missing from instructions as logged (rows 672 and 674), cause unknown.
    - New facts are never asked about (5 of 27 junk writes).
    - The unknown-channel gap (a cache-only directory method; Plan Mode; seven decisions).
    - "forget" unbuilt; the "samurai" clipboard fact left in place; bare facts invisible to M31.
    - `remember`'s "do NOT re-run" description line (not editable, M28).
    - A same-value `remember` refreshes confidence and the updated time.
    - The log does not record typed or spoken.
    - The older queue: re-ask on refusal, "what did that job say?", a third connector, screen
      Q&A, the demo recording.

  `npm test`: 3482 across 144 files, 96 skipped (plain `npm test`; nothing held the SQLite binary).
- **M34 - stop junk first writes; record typed vs spoken.** Closed 2026-10-30 after a live run
  by a person. `docs/M34-live-checklist.md`: 2 ticked, 1 not run (H3, the spoken check, skipped
  by choice).
  - **The changes.**
    - **The marker:** `jobs.input` = `typed` | `spoken`, NULL (unknown) before M34, added by the
      guarded migration. `JobManager.submit` and the job runner take it, and the instruction
      hotkey sets it from the same test that picks typed text over the transcript. Action-log
      rows join to it by `job_id`. The planner is never told.
    - `PrepareDeps.memory` is `resolve` + `query` (both reads). `remember`'s tier, `prepare` and
      handler share one `writeJudgement`.
    - **Rule B** (`subjectInInstruction`, `UNNAMED_FACT`): a FIRST write is refused unless every
      word of its subject is a word of the instruction. Plurals match. `name` and `tone` are
      exempt. A replacement is never judged (it asks, M33). Bot mode refuses before Slack is asked.
    - **The `target:` decision:** one leading `target:` is set aside before judging, since it is
      the app's URL prefix and nobody says it. Only at the start, and a bare `target:` names
      nothing.
    - **Rule D** (`FACT_VALUE_MAX` = 500, `TOO_LONG_FACT`): any write whose value has a line break
      or is over 500 characters is refused.
    - `WhisperCppTranscriber` gained an `argsPrefix` test seam; main.ts never sets it.
  - **New files.**
    - `tests/instructionInput.test.ts`;
    - `tests/remember.firstWrite.test.ts`;
    - `tests/remember.longValue.test.ts`;
    - `tests/fixtures/fakeWhisper.mjs`.
    - The replay (`tests/fixtures/rememberCalls/replay.ts`) grew to 34 calls and gained
      `ROW_591_SHAPE`.
    - `scripts/m33-live.ts` gained three cases and `--first-writes`.
    - `scripts/m30-say-refusal.ts` gained `--first-write-refusal`.
  - **Evidence.**
    - The replay: 5 junk first writes refused, 13 genuine ones pass.
    - 13 mutations, all caught.
    - Scripted live with faked connectors, 27 calls: 0 junk writes, 9 of 9 controls. The live
      model never reached B or D.
    - Her real-app H1-H2. The log check found H2's row 680 marked `typed` with its "#", and no
      new fact.
  - **Open findings (M35 candidates).**
    - "forget" unbuilt; stored junk left as is (bare `help` channel facts, `samurai`, the
      duplicate `channel:social`).
    - The unknown-channel gap (a cache-only directory method; Plan Mode; seven decisions).
    - Paraphrased first writes refused (three pinned cases).
    - B cannot see "Samurai is this."-shaped writes.
    - Win+H voice typing is marked `typed`.
    - The missing "#" in rows 672 and 674, cause still unknown.
    - The older queue.

  `npm test`: 3555 across 147 files, 96 skipped (plain `npm test`; nothing held the SQLite binary).

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
3. `spec.md` §9 (M20, M21, M22, M23, M24, M25, M26, M27, M28, M29, M30, M31, M32, M33, M34) and the fifteen checklists above — status since
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
