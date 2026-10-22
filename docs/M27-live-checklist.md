# M27 — live verification checklist (by hand)

> **NOT RUN YET.** Written before the live pass. This file grows one section per fix as each is
> built: section 1 is fix C (the label). Sections for fix A (Dismiss keeps the list open,
> "Dismiss all") and fix B (an outside click closes the list) are added with those fixes.
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
