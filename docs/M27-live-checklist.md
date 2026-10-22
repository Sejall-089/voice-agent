# M27 — live verification checklist (by hand)

> **NOT RUN YET.** Written before the live pass. This file grows one section per fix as each is
> built: section 1 is fix C (the label), section 2 fix A (Dismiss keeps the list open, "Dismiss
> all"). The section for fix B (an outside click closes the list) is added with that fix.
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

- [ ] **1.1** Get two done jobs into the pill, then a third that is still running (detach it
      while it thinks, then look before it finishes). The label reads **"1 running · 2 done"**,
      in one line, nothing cut off, and the dot is **blue** (running's colour, not done's
      green). When the third finishes it reads **"3 done"** and the dot turns green.
- [ ] **1.2** With done jobs in the pill, add a job that needs you (a Slack send, detached). The
      label leads with **"1 needs you · …"**, the pill turns **amber** and pulses once, and the
      done jobs are still counted after it.
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

- [ ] **2.1** Press **Dismiss** on one done job: that row goes and **the list stays open**.
      Dismiss the next, and the next — each time the list stays open, no reopening needed.
- [ ] **2.2** Dismiss down to the **last** row (cancel the running one too, or let it finish and
      dismiss it): when the last row goes, the list closes and the pill disappears. Give a new
      instruction and detach it: the pill comes back **closed**.
- [ ] **2.3** With several rows listed, press **Review…** on a job that needs your OK: the list
      **closes** and the confirm dialog opens in front, readable and clickable. Cancel the
      dialog. (Resume on a job that needs the screen also closes the list — check it if one is
      to hand.)
- [ ] **2.4** With done and failed jobs **and** a running job listed, press **Dismiss all** —
      at the top of the list, next to the chime toggle: every done and failed row goes at once;
      the running one **stays**, still running, and **finishes normally** afterwards (it was not
      cancelled). The chime setting is unchanged. The list stays open while the running row is
      in it.
- [ ] **2.5** With five or more rows, so the list scrolls: scroll to the bottom. The top row —
      "Background jobs", **Dismiss all** and the chime toggle — **stays in view**, rows scroll
      underneath it without showing through, and Dismiss all can still be clicked.
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
