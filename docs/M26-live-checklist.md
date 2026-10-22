# M26 — live verification checklist (by hand)

> **RUN 2026-10-22, by a person; M26 CLOSED the same day with the gaps below.** 3 boxes
> ticked, 0 open. A ticked box means a person saw it in the running app.
>
> Three live findings about the status pill, none a regression of M26 and none fixed here; all
> are planned for M27 (see **Findings** at the end).
>
> M26 keeps a finished background job in the status pill until it has been
> seen (`spec.md` §9, M26; §5c, "How long a job stays"). Everything a test can show is already
> shown by tests — the timings on a fake clock, a restart on SQLite, the count label, failed and
> expired jobs unchanged. What is left needs a person at the real pill.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including everything only a test or script has shown.

## 1. A done job waits to be seen

- [x] **1.1** Copy a few paragraphs and ask for a summary. While it is thinking, click outside
      the bar (another window). The job moves to the pill. Wait well over 30 seconds after it
      finishes, without touching the pill: it is **still there, green, "1 done"**. Nothing was
      spoken and no chime played when it finished. *(2026-10-22.)*
- [x] **1.2** Now click the pill. The list opens with the job's row, and the row shows the
      summary. Read it. About a minute after the list was opened, the job **clears** from the
      pill (and the pill hides if nothing else is in it). *(2026-10-22.)*
- [x] **1.3** Repeat 1.1 to get another done job in the pill. Open the list and press
      **Dismiss** on its row: it is **gone at once**. *(2026-10-22.)*

## Known gaps

- A done job nobody has seen is brought back after a restart however old it is, as a failed
  one already was (decided in M26). Tests cover it; not watched live.
- The minute after seeing (`DONE_SEEN_CLEAR_MS`) is a first guess; it is named so it can be
  tuned after this run.

## Findings (2026-10-22)

Found by a person during this run. Each was investigated without code changes; each comes from
a rule M23 chose deliberately, which M26 made matter more by letting done jobs stay and pile up.
**None is fixed in M26; all three are planned for M27.**

1. **Dismiss on one of several done jobs closes the list**, so the pill has to be reopened for
   each job. Cause: every row button that takes effect closes the list
   (`PillController.onAction`, added 2026-10-13 so the list gets out of the way of the dialog
   Review… opens); Dismiss and Cancel inherited it. Pinned by `pill.collapse.test.ts`, "Dismiss
   closes it". Since opening the list marks every listed done job seen, the ones left also clear
   on their own a minute later.
2. **With the list open, clicking elsewhere on screen does not close it.** Cause: the pill is
   `focusable: false` and shown inactive so it never takes the keyboard (M23, measured), so it
   never blurs and no event reports an outside click. The list closes only 10 s after the
   pointer leaves (the idle timer).
3. **With done jobs in the pill and another job running, the label shows only "1 running"** and
   the done jobs are mentioned nowhere until the list is opened. Cause: the pill shows one mode
   at a time — needs-you, then didn't finish, then running, then done — and the label counts
   only that group (`pillView`). Before M26 a done job left after 8 s, so this hid it briefly at
   most; now it can hide it indefinitely.
