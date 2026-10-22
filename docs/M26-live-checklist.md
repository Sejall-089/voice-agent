# M26 — live verification checklist (by hand)

> **NOT YET RUN.** M26 keeps a finished background job in the status pill until it has been
> seen (`spec.md` §9, M26; §5c, "How long a job stays"). Everything a test can show is already
> shown by tests — the timings on a fake clock, a restart on SQLite, the count label, failed and
> expired jobs unchanged. What is left needs a person at the real pill.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including everything only a test or script has shown.

## 1. A done job waits to be seen

- [ ] **1.1** Copy a few paragraphs and ask for a summary. While it is thinking, click outside
      the bar (another window). The job moves to the pill. Wait well over 30 seconds after it
      finishes, without touching the pill: it is **still there, green, "1 done"**. Nothing was
      spoken and no chime played when it finished.
- [ ] **1.2** Now click the pill. The list opens with the job's row, and the row shows the
      summary. Read it. About a minute after the list was opened, the job **clears** from the
      pill (and the pill hides if nothing else is in it).
- [ ] **1.3** Repeat 1.1 to get another done job in the pill. Open the list and press
      **Dismiss** on its row: it is **gone at once**.

## Known gaps

- A done job nobody has seen is brought back after a restart however old it is, as a failed
  one already was (decided in M26). Tests cover it; not watched live.
- The minute after seeing (`DONE_SEEN_CLEAR_MS`) is a first guess; it is named so it can be
  tuned after this run.
