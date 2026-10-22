# M25 — live verification checklist (by hand)

> **RUN 2026-10-22, by a person and by a loopback-recorded script; M25 CLOSED the same day with
> the gaps below.** 4 boxes ticked, 15 open. A ticked box means a person saw or heard it in the
> running app; no script earns a tick.
>
> - **Human-verified (4):** 1.1, 2.1, 4.1, 5.1.
> - **Covered by script (3, boxes left open):** 4.2, 5.2 (in part), 5.5 — machine-verified by a
>   scripted run against the real app (dev build of HEAD, real Piper, a scratch profile, a fake
>   model and a fake Slack webhook on localhost), with what reached the speakers recorded by
>   WASAPI loopback and transcribed by the app's own whisper. The same run also covered 1.1,
>   2.1, 4.1 and 5.1 before a person did.
> - **Covered by tests only (12, boxes left open):** 1.2, 1.3, 2.2, 2.3, 3.1, 3.2, 3.3, 4.3,
>   4.4, 5.3, 5.4, 5.6 — each box names the test.
>
> One live finding, investigated; its fix is decided for M26 (see **Findings** at the end).
>
> M25 fixes three findings from M24's live testing, and adds what Escape and an outside click do
> to an instruction that is still running. `spec.md` §9 (M25) has the build order and what each
> claim rests on.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person heard or saw it in the running app.
> - `[ ]` **Not yet watched**, including everything only a test or script has shown.

## 1. "Read the rest" after a short answer in between

- [x] **1.1** Ask for something with a long answer (a summary of copied text, a busy schedule).
      While it is being read, press the instruction hotkey and ask "what's the time". When that
      answer is done, say **"read the rest"**. **Expect:** the rest of the *summary* is read,
      starting with "From the earlier answer:". Pre-M25: "There's nothing more to read out."
      *(2026-10-22: heard by a person. Script: the bar showed "From the earlier answer: The copy
      for the pricing page…"; a 34.19 s clip played to its end; whisper on its first 6 s heard
      "From the earlier answer, the copy for the pricing page still needs legal sign-off…".)*
- [ ] **1.2** The same, but say "read the rest" straight after the summary (nothing in between).
      **Expect:** the rest, with **no** "From the earlier answer:". *(Tests only:
      `readTheRest.test.ts`, `speechTools.test.ts`.)*
- [ ] **1.3** Say "read the rest" a second time. **Expect:** "There's nothing more to read out."
      *(Tests only: `readTheRest.test.ts`.)*

## 2. The time and the date

- [x] **2.1** Ask **"what's the time?"** (typed and spoken). **Expect:** one sentence, the time
      only — "It's 2:51 PM." — shown and said ("two fifty-one PM"). Pre-M25: a long sentence
      with the date and zone, worded differently each time. *(2026-10-22: seen and heard by a
      person. Script: "It's 6:08 PM." shown, matching the clock; a 2.08 s clip; whisper heard
      "It's 6.08 PM.")*
- [ ] **2.2** Ask **"what's the date?"** / "what day is it?". **Expect:** "It's Thursday, 22
      October." — the date only. *(Tests only: `tellTime.test.ts`.)*
- [ ] **2.3** Ask it while a job is running in the pill. **Expect:** answered at once, and no new
      row appears in the pill. *(Tests only: `tellTime` is status-only, pinned by
      `background.test.ts`; the no-slot admission is `jobManager.test.ts`'s.)*

## 3. The detach log

- [ ] **3.1** With the dev console visible, start a slow instruction and press the instruction
      hotkey while it is still working. **Expect:** `[main] instruction hotkey accepted`, then
      `[main] job <id> detached by hotkey ("<the instruction>", running, step …)`, and the job
      in the pill. *(Tests only: `detachLog.test.ts`. The scripted run logged "instruction hotkey
      accepted" on each of its six presses, but never detached a job by hotkey.)*
- [ ] **3.2** The same with the dictation hotkey. **Expect:** `[dictate] hotkey accepted` and
      `detached by dictation`. *(Tests only: `detachLog.test.ts`.)*
- [ ] **3.3** Press the instruction hotkey while a confirm dialog is up. **Expect:** the existing
      "ignored - a confirmation is waiting" line, and **no** "accepted" line. *(Tests only:
      `detachLog.test.ts`.)*

## 4. Escape on a running instruction

- [x] **4.1** Give an instruction with a slow answer (a summary). While the bar says
      "Thinking…", press **Escape**. **Expect:** the bar closes and stays closed; nothing is
      said; no row in the pill. Pre-M25: the answer popped the bar back up and was spoken.
      *(2026-10-22: watched by a person.)*
- [ ] **4.2** Ask for something `dangerous` (a Slack send to the test channel) and press Escape
      while it is still thinking. **Expect:** no confirm dialog ever opens; nothing is sent.
      *(Script only, to a fake Slack webhook: Escape 1 s into thinking; the model still answered
      afterwards, so the cancel took effect at admission; no dialog ever opened; no sound after
      Escape; the bar hidden; no pill row; nothing posted; no detach line.)*
- [ ] **4.3** Speak an instruction, press Enter, and press Escape while it is still being
      transcribed. **Expect:** nothing runs. *(Tests only: `escapeJob.test.ts`.)*
- [ ] **4.4** Start something that takes a while *after* it has started (a long chain), and press
      Escape mid-way. **Expect:** it moves to the pill, finishes quietly, and the console says
      `detached by escape`. *(Tests only: `escapeJob.test.ts`, `jobManager.test.ts`.)*

## 5. Clicking outside a thinking bar

- [x] **5.1** Give an instruction with a slow answer. While the bar says "Thinking…", **click
      another window**. **Expect:** the bar closes, the job appears in the pill and finishes
      there without being spoken, and the console says `detached by outside-click`.
      *(2026-10-22: watched by a person — the pill appeared, silent. Finding 1 came from what the
      pill did next.)*
- [ ] **5.2** The same with **Alt+Tab** instead of a click. **Expect:** the same. *(Script, in
      part: focus was moved to another window by SetForegroundWindow — neither a click nor
      Alt+Tab, but the same focus loss; `detached by outside-click` was logged and the job reached
      the pill.)*
- [ ] **5.3** Click outside while a **finished** answer is showing. **Expect:** the bar just
      closes; nothing in the pill. *(Tests only: `outsideClick.test.ts`.)*
- [ ] **5.4** Click outside while **recording**. **Expect:** as before — the bar stays, the
      recording goes on. *(Tests only: `outsideClick.test.ts`.)*
- [ ] **5.5** Click outside while the app is still **speaking** an earlier answer and a new
      instruction is thinking. **Expect:** the speech carries on to its end. *(Script only: the
      click came 3.02 s into a 17.32 s chain preview; the preview played to its end; the job was
      detached and waited in the pill.)*
- [ ] **5.6** Ask for something `dangerous`; when the confirm dialog opens, click into it.
      **Expect:** nothing is detached; the dialog stays, and answering it works as before.
      *(Tests only: `outsideClick.test.ts`; the blur a dialog causes measured by
      `scripts/blur-recon.cjs`.)*

## Known gaps, so nobody mistakes them for failures while testing

- Any focus loss counts as an outside click while a job is thinking — Alt+Tab, the Windows key,
  or another app taking focus on its own (a notification that grabs focus) — not only a mouse
  click.

- The renderer's own Escape (a fallback used only if the global Escape could not be
  registered) still just hides the bar.

- A second instruction-hotkey press while a voice recording or transcription is in progress is
  not blocked and detaches the attached job (addendum C; deliberately not fixed in M25).
- A remainder survives any number of answers in between, for up to 5 minutes; "read the rest"
  always means the most recent answer that was cut short, introduced as earlier if anything was
  said since.

---

**Findings**

1. **A done job disappears from the pill after about 10 s; investigation complete** (2026-10-22,
   live, after 5.1). A job detached by an outside click finished, turned green "Done", and was
   gone about ten seconds later. Cause: M23's deliberate 8 s fade (`DONE_FADE_MS`, spec §5c "How
   long a job stays in the pill") plus the pill's 1 s re-check. It matters now because M25's
   outside click detaches jobs whose result is the point, and a done detached job's result is
   stored (job record, action log) but unreadable once the pill clears. **Fix decided: M26 —
   keep a done job in the pill until it has been seen.** Not fixed in M25.
