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

## Known gaps, so nobody mistakes them for failures while testing

- A remainder survives any number of answers in between, for up to 5 minutes; "read the rest"
  always means the most recent answer that was cut short, introduced as earlier if anything was
  said since.
