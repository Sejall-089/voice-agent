# M27 — live verification checklist (by hand)

> **RUN 2026-10-23, by a person; M27 CLOSED the same day with the gaps below.** 10 boxes ticked,
> 16 open. A ticked box means a person saw it in the running app. Every open box is covered by a
> test or a script against the real windows (each section says which) — none is ticked for that.
> Parts no script ran either: in 4.6, the dictation hotkey and Escape with the list open.
>
> Two findings (see **Findings** at the end): one from this milestone's own live use, fixed in
> M27 and re-watched (5.1, 5.3, 5.5); one about plan choice, **not fixed in M27, under
> investigation**.
>
> Sections: 1 is fix C (the label), 2 fix A (Dismiss keeps the list open, "Dismiss all"), 3 the
> Cancelling row, 4 fix B (a click outside the pill closes the list), 5 how a cancelled job ends
> (a follow-up from a live finding).
>
> M27 fixes the three status-pill findings from M26's live run (`spec.md` §9, M27; §5c, "The
> status pill"). Everything a test or script can show is already shown and listed under
> **Machine-verified** — not ticked, because no person watched it. What is left needs real
> clicks and eyes on the real pill.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including everything only a test or script has shown.

## 1. The label counts every group (fix C)

To get jobs into the pill: give an instruction (a summary of copied text is easiest) and click
outside the bar while it is thinking, so it detaches. A send to Slack detached the same way
stops at its confirm and gives a "needs you" job. Do not open the list until a step says to:
opening it marks done jobs seen.

- [x] **1.1** Get two done jobs into the pill, then a third that is still running (detach it
      while it thinks, then look before it finishes). The label reads **"1 running · 2 done"**,
      in one line, nothing cut off, and the dot is **blue** (running's colour, not done's
      green). When the third finishes it reads **"3 done"** and the dot turns green.
      *(2026-10-23.)*
- [x] **1.2** With done jobs in the pill, add a job that needs you (a Slack send, detached). The
      label leads with **"1 needs you · …"**, the pill turns **amber** and pulses once, and the
      done jobs are still counted after it. *(2026-10-23.)*
- [ ] **1.3** Watch the pill as the label gets longer and shorter (1.1 and 1.2): it **widens to
      fit** and narrows again, keeping its bottom-right corner, and does not visibly jump or
      flash a cut-off label on the way. Open the list: the pill itself stays where it was.
- [ ] **1.4** Cancel a running or waiting job from the list: it is **not counted** anywhere in
      the label afterwards.

**Machine-verified, not watched (fix C):**

- The rule — every group in order, colour from the top group for all fifteen combinations,
  cancelled never counted, the cap and "+N more", stale measurements dropped —
  `tests/pill.label.test.ts`, `tests/pill.test.ts`.
- The page measures each form and draws the pill at main's width — `render.test.ts` (jsdom).
- In a real window with the built page (`scripts/pill-label-recon.cjs`, 2026-10-22): every form
  drawn whole with no ellipsis; four groups with single-digit counts fit at 330 px; "+N more"
  shown only past the cap ("123 need you · 456 didn't finish · +889 more" at 313 px). A person
  is unlikely to reach "+N more" for real — it needs double- or triple-digit counts.

## 2. Dismiss keeps the list open; Dismiss all (fix A)

Get four or more finished jobs into the pill (as in section 1), plus one still running, then
click the pill to open the list.

- [x] **2.1** Press **Dismiss** on one done job: that row goes and **the list stays open**.
      Dismiss the next, and the next — each time the list stays open, no reopening needed.
      *(2026-10-23.)*
- [ ] **2.2** Dismiss down to the **last** row (cancel the running one too, or let it finish and
      dismiss it): when the last row goes, the list closes and the pill disappears. Give a new
      instruction and detach it: the pill comes back **closed**.
- [ ] **2.3** With several rows listed, press **Review…** on a job that needs your OK: the list
      **closes** and the confirm dialog opens in front, readable and clickable. Cancel the
      dialog. (Resume on a job that needs the screen also closes the list — check it if one is
      to hand.)
- [x] **2.4** With done and failed jobs **and** a running job listed, press **Dismiss all** —
      at the top of the list, next to the chime toggle: every done and failed row goes at once;
      the running one **stays**, still running, and **finishes normally** afterwards (it was not
      cancelled). The chime setting is unchanged. The list stays open while the running row is
      in it. *(2026-10-23.)*
- [x] **2.5** With five or more rows, so the list scrolls: scroll to the bottom. The top row —
      "Background jobs", **Dismiss all** and the chime toggle — **stays in view**, rows scroll
      underneath it without showing through, and Dismiss all can still be clicked.
      *(2026-10-23.)*
- [ ] **2.6** If an *interrupted* job is in the pill (quit the app while a detached job runs, and
      start it again): Dismiss all leaves it; only its own Dismiss removes it.

**Machine-verified, not watched (fix A):**

- Dismiss/Cancel stay open while anything is listed and close on the last row; Review… and
  Resume close with rows left; dropped and refused presses change nothing; Dismiss all touches
  only done, failed and expired rows actually listed (not past the cap of ten), requests no
  cancel of anything, is dropped when closed or with nothing ended — `tests/pill.dismiss.test.ts`,
  `tests/pill.collapse.test.ts`.
- The button is drawn only when offered, beside the chime toggle, with a fixed label, and its
  press sends nothing; the header is sticky and opaque in `pill.html`'s stylesheet —
  `render.test.ts` (jsdom).
- On the built page in a real window (`scripts/pill-dismiss-all-recon.cjs`, 2026-10-22, a DOM
  click, no pointer): with six rows the list scrolls (592 px against 440); at the top and
  scrolled 152 px to the bottom, Dismiss all and the chime toggle are visible and are what a
  click at their centre hits — PASS. With the header unpinned (a deliberate mutation) the same
  check reported FAIL. The press reaches main as `pill:dismiss-all` with no arguments.

## 3. A cancelled job says Cancelling until its step ends

Something with a step that takes a few seconds works best: a summary of a long copied text, or a
two-step chain ("summarize this and post it to Slack"), detached by clicking outside the bar.

- [x] **3.1** Open the list while it is running and press **Cancel**. The row changes at once to
      **"Cancelling — finishing step 1 of 2"** (or "… of 1"), and has **no Cancel button** any
      more. The pill's label still counts it as running; any other rows are unchanged.
      *(2026-10-23.)*
- [ ] **3.2** Wait: when the step finishes, nothing after it runs (no Slack confirm appears), and
      the row becomes one of section 5's — it does **not** simply vanish once a step has run
      (changed after a live finding; see section 5).
- [ ] **3.3** Press Cancel on a job **waiting for your OK** instead: it goes at once and is never
      shown as Cancelling.

**Machine-verified, not watched:** the wording for mid-step and still-planning, no second
Cancel, a second press dropped, label and other rows unchanged, the next step refused, a waiting
job never drawn as Cancelling — `tests/pill.dismiss.test.ts` against the real job manager and
pill controller. Mutations: the field dropped from the view (3 failed); the second Cancel kept
(3 failed).

## 4. A click outside the pill closes the open list (fix B)

Get a job or two into the pill and click the pill to open the list before each item. Use a
real mouse; then repeat 4.1 and 4.5 on a **touchpad** with **taps**, not presses.

- [x] **4.1** Click on the **desktop**: the list closes at once (well under a second). The pill
      itself stays. *(2026-10-23, with a real mouse and a touchpad.)*
- [ ] **4.2** Click in **another app's window** (a browser, VS Code): the list closes, and that
      click still does what it would have done in that app.
- [ ] **4.3** Open the bar with the hotkey, then click the **bar**: the list closes, and the bar
      takes the click as usual.
- [ ] **4.4** Click **inside** the list — a row's text, the heading, the chime toggle, Dismiss
      on one row: it stays open (Dismiss removes that row as before).
- [ ] **4.5** The click that **opens** the list does not close it — try a quick click and a
      slow one.
- [ ] **4.6** With the list open, press the dictation hotkey or Escape, or let a confirm dialog
      open from Review…: none of them is treated as a click elsewhere (the hotkey and Review…
      close the list by their own rules, as before; Escape alone leaves it open).
- [ ] **4.7** Right-click and middle-click outside also close it.
- [ ] **4.8** With the list **closed**, clicking around changes nothing about the pill.

**Live caveats — what a person has to judge, because no script can:**

- **Physical clicks and touchpad taps.** Every measurement so far used synthetic clicks. A real
  mouse holds a click ~60-120 ms; a touchpad tap can be far shorter.
- **Taps shorter than about 15 ms.** At the 50 ms poll they are seen only through Windows's
  "pressed since the last check" bit (the "down now" bit caught a quarter of 5-15 ms taps in the
  recon). If a quick tap outside sometimes leaves the list open, note which device and how often.
- **Another program polling the mouse buttons** (some gaming overlays, macro tools, remote
  desktop software) can take that same bit first, Windows documents. With such a program running,
  short taps may be missed; a normal click should still close the list. Note anything running
  that might poll.

**Machine-verified, not watched (fix B):**

- The rule — outside closes, inside (edges included) does not, the bar counts, watched only while
  open and stopped by every way it closes, prepared when the pill appears and not at the click,
  a late press ignored, a failure logged once and the 10 s close still working —
  `tests/pill.outsideClick.test.ts` with an async fake. The helper's transport, mouse buttons
  only, failures as Errors — the same file, with the process faked.
- The design, on a prototype in real windows (`scripts/pill-outside-click-recon.cjs`,
  2026-10-22): 48/48 synthetic clicks seen held 0-120 ms; median 32 ms to notice at 50 ms; no
  measurable CPU; ~1.5 s start-up; no press from F24, a hide, a message box or a re-show.
- The shipped code in real windows (`scripts/ask-recon/pill-outside-click.ts`, 2026-10-22):
  PASS — opening click not counted; inside click, F24, hide/show and a message box leave it open;
  an outside click closes it and stops watching; closed, a click does nothing; works again after
  a reopen.

## 5. How a cancelled job ends (follow-up from a live finding)

Found by a person: Cancel on a running job, then the row turned to Dismiss and the pill to
"done" — the cancel had arrived during the job's last step, which finished. Use the same kinds of
job as section 3, detached, with the list open.

- [x] **5.1** **Too late — a one-step job** (a summary): Cancel while it runs. It says
      "Cancelling — finishing step 1 of 1", then ends **green, counted in "done", with Dismiss**,
      and the row reads **"Finished before it could be cancelled — "** followed by the summary.
      *(2026-10-23.)*
- [ ] **5.2** **Too late — the last step of two** ("summarize this and post it to Slack", approve
      the post, then Cancel while the post is being sent): the same — done, with the
      "Finished before it could be cancelled" wording on the last step's result. The post did go.
      (A post is quick; if Cancel cannot be caught during it, leave this open and say so — it is
      machine-verified below.)
- [x] **5.3** **Stopped partway — case B**: the same two-step chain, Cancel **during step 1**. When
      step 1 finishes, no Slack confirm appears; the row **stays**, counted in **"didn't
      finish"**, with Dismiss, and reads "You cancelled that, so I stopped there. I'd already done
      step 1 of 2, but step 2 didn't run." With the list open it clears about a minute later; with
      the list closed it stays until you open it (and survives quitting and restarting the app).
      *(2026-10-23.)*
- [ ] **5.4** Press **Dismiss all** with that row and a done one listed: both go.
- [x] **5.5** Cancel a job **waiting for your OK on its first step**: it goes at once, as before.
      *(2026-10-23.)*

**Machine-verified, not watched:** all five, against the real job manager, job runner, planner
and pill controller with a scripted model — `tests/pill.cancelled.test.ts` — plus the restart
on both stores (an unseen stopped-partway job restored ten days later with its message; one
cancelled before any step not restored; a seen one past its minute not restored). The
investigation that found it, read-only, produced the same row and pill sequences first.

## Findings (2026-10-22 / 2026-10-23)

1. **A Cancel during a job's last step ended it "done", with no word that the Cancel came too
   late; and a job cancelled after a step ran vanished from the pill.** Found by a person during
   this milestone (Cancel on a running job: "Cancelling — finishing step…", then Dismiss and
   "done"). Cause, investigated read-only first with the real manager, runner, planner and pill:
   a cancel takes effect only at the next step, so a last step finishes and the job is done —
   legitimately; and every cancelled job was hidden (M23), so one that had already done step 1 of
   2 never showed its message. **Fixed in M27** (commit c698d04): "Finished before it could be
   cancelled — <result>" on the done row; a job cancelled after a step ran shown in "didn't
   finish" with its own message. **Re-watched:** 5.1, 5.3 and 5.5 ticked 2026-10-23.
2. **Plan choice — NOT FIXED IN M27, under investigation.** "'create a linear issue and send to
   fun' with clipboard text selected planned three steps, including 'Summarize the selected
   clipboard text', which the instruction did not ask for. Under investigation." Not part of the
   pill work; no M27 change touches planning. Recorded here and in `spec.md` §9 (M27) so it is
   not lost. Cause not yet known — the next step is to reproduce it before anything is edited.
