# M25 — live verification checklist (by hand)

> **DRAFT, 2026-10-22. Not run.** Written as M25 is built, one section per fix, before any live
> pass (the close-out procedure). M24 must be closed before M25 is committed.
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

- [ ] **1.1** Ask for something with a long answer (a summary of copied text, a busy schedule).
      While it is being read, press the instruction hotkey and ask "what's the time". When that
      answer is done, say **"read the rest"**. **Expect:** the rest of the *summary* is read,
      starting with "From the earlier answer:". Pre-M25: "There's nothing more to read out."
- [ ] **1.2** The same, but say "read the rest" straight after the summary (nothing in between).
      **Expect:** the rest, with **no** "From the earlier answer:".
- [ ] **1.3** Say "read the rest" a second time. **Expect:** "There's nothing more to read out."

## 2. The time and the date

- [ ] **2.1** Ask **"what's the time?"** (typed and spoken). **Expect:** one sentence, the time
      only — "It's 2:51 PM." — shown and said ("two fifty-one PM"). Pre-M25: a long sentence
      with the date and zone, worded differently each time.
- [ ] **2.2** Ask **"what's the date?"** / "what day is it?". **Expect:** "It's Thursday, 22
      October." — the date only.
- [ ] **2.3** Ask it while a job is running in the pill. **Expect:** answered at once, and no new
      row appears in the pill.

## 3. The detach log

- [ ] **3.1** With the dev console visible, start a slow instruction and press the instruction
      hotkey while it is still working. **Expect:** `[main] instruction hotkey accepted`, then
      `[main] job <id> detached by hotkey ("<the instruction>", running, step …)`, and the job
      in the pill.
- [ ] **3.2** The same with the dictation hotkey. **Expect:** `[dictate] hotkey accepted` and
      `detached by dictation`.
- [ ] **3.3** Press the instruction hotkey while a confirm dialog is up. **Expect:** the existing
      "ignored - a confirmation is waiting" line, and **no** "accepted" line.

## 4. Escape on a running instruction

- [ ] **4.1** Give an instruction with a slow answer (a summary). While the bar says
      "Thinking…", press **Escape**. **Expect:** the bar closes and stays closed; nothing is
      said; no row in the pill. Pre-M25: the answer popped the bar back up and was spoken.
- [ ] **4.2** Ask for something `dangerous` (a Slack send to the test channel) and press Escape
      while it is still thinking. **Expect:** no confirm dialog ever opens; nothing is sent.
- [ ] **4.3** Speak an instruction, press Enter, and press Escape while it is still being
      transcribed. **Expect:** nothing runs.
- [ ] **4.4** Start something that takes a while *after* it has started (a long chain), and press
      Escape mid-way. **Expect:** it moves to the pill, finishes quietly, and the console says
      `detached by escape`.

## 5. Clicking outside a thinking bar

- [ ] **5.1** Give an instruction with a slow answer. While the bar says "Thinking…", **click
      another window**. **Expect:** the bar closes, the job appears in the pill and finishes
      there without being spoken, and the console says `detached by outside-click`.
- [ ] **5.2** The same with **Alt+Tab** instead of a click. **Expect:** the same.
- [ ] **5.3** Click outside while a **finished** answer is showing. **Expect:** the bar just
      closes; nothing in the pill.
- [ ] **5.4** Click outside while **recording**. **Expect:** as before — the bar stays, the
      recording goes on.
- [ ] **5.5** Click outside while the app is still **speaking** an earlier answer and a new
      instruction is thinking. **Expect:** the speech carries on to its end.
- [ ] **5.6** Ask for something `dangerous`; when the confirm dialog opens, click into it.
      **Expect:** nothing is detached; the dialog stays, and answering it works as before.

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
