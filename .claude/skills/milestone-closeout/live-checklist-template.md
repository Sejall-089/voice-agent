# M<N> — live verification checklist (by hand)

> **NOT YET RUN.** A ticked box means **a person at the keyboard watched it happen in the
> running app** — no test, eval or recon script earns a tick here. An open box means *not seen
> by a person*, not *failing*.
>
> <!-- After the live pass, replace the line above with: **LIVE RUN DONE / PARTLY RUN, <date>,
> by a person.** N boxes ticked, M open — then three short lists: Human-verified; Covered by
> script or test only (boxes left open); Not run / not testable by hand, and why. -->
>
> M<N> <one or two sentences: what this milestone adds or fixes>. `spec.md` §<section> has the
> design and the known limits.
>
> Written before the live pass: each item names what could actually be wrong. Every milestone
> since M10 has produced at least one live bug no fixture caught. Budget for it.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified** — a person saw it in the running app.
> - `[ ]` **Not yet watched** — including everything that only a test, an eval or a recon
>   script has shown. A log line proves what the app decided, not what the user saw
>   (CLAUDE.md), so script-verified items stay open and say what the script did show.
>
> **Nothing automated ever creates a real issue, posts a real message or sends a real email.**
> The real creates and posts in this list are the ones done by hand. <Say where they land and
> how to clean up afterwards.>

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

**Before you start**

- <`.env` variables this run needs, by NAME only — quoted if a value can start with `#`.>
- <Accounts, channels, tabs, test repositories or fixtures to prepare.>
- <How to reset state between runs, e.g. deactivating a fact in
  `%APPDATA%\voice-agent\memory.db`.>

---

## 0. Before anything: the regression check

- [ ] **0.1** <One thing from an earlier milestone that this one could have broken.>
      **Expect:** <what a person should see.>

## 1. <The first thing this milestone does>

<The exact instruction to say or type, in bold, and what must be true beforehand.>

- [ ] **1.1** <What to do.>
      **Expect:** <what a person should see — the dialog's exact wording, where the result
      lands.> <What could actually be wrong here.>
- [ ] **1.2** <A path a script or test has exercised.>
      **Expect:** <…> *(Script-verified only: `<script or test file>` showed <what>. Not
      watched.)*

## 2. <Declines, failures and refusals>

- [ ] **2.1** <Cancel at the dialog.> **Expect:** nothing is created or sent, and the app says
      so.
- [ ] **2.2** <A failure, and whether its message says the right phase: "nothing was sent"
      before a send, "it may or may not have gone through" only after one.>

## 3. Carried over — still not watched

- [ ] <An open box from an earlier checklist that this milestone touches, with its source.>

---

## Known gaps, so nobody mistakes them for failures while testing

- <A limit carried deliberately, and where `spec.md` records it.>

---

**Findings**

<!-- Filled in only from what the person who ran it reports. One entry per finding: what was
seen, the cause if known, whether it is fixed, and whether the fix was re-watched live. -->
