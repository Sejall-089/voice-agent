# M20 — live verification checklist (by hand)

> **PARTLY RUN, 2026-10-10.** A person ran sections 0, 1 and 2 and M20's box in `spec.md` §9 is
> ticked on that basis: the reads work, and the first real create worked — the form handoff did
> not fire. **Sections 3 and 5 have not been run** (the chain, the failure wording). Section 4
> (the choice between two trackers) is half run: one of its two boxes was seen — "Live results
> 2". Four boxes in sections 0-2 are still open. 11 boxes ticked, 16 open; the results
> at the bottom say exactly which. An open box here means *not seen by a person*, not *failing*.
>
> The two paragraphs below were written before the pass and are kept as written.
>
> M20 is tested headless, and `scripts/github-recon.mjs` has exercised the real GitHub MCP
> server **read-only**. No test and no script has ever created, edited or closed a real issue,
> so everything about a real *create* is unobserved: the result's shape is taken from the
> server's source, not from a capture.
>
> Written before the live pass: each item names what could actually be wrong. Every milestone
> since M10 has produced at least one live bug no fixture caught. Budget for it.
>
> **How results are marked** (same convention as `docs/M19-live-checklist.md`):
>
> - `[x]` **Human-verified** — a person at the keyboard saw it in the running app.
> - `[ ]` **Script-verified** — a script ran the real code path; the box stays open, because a
>   log line proves what the app decided, not what the user saw (CLAUDE.md).
>
> **The rule for this milestone: nothing automated ever creates a real GitHub issue.** The only
> real creates are the ones you do by hand in sections 2 and 3. GitHub's MCP server cannot
> delete an issue; clean up in the browser afterwards.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.)

---

## 0. Before anything

- [ ] `.env` has `GITHUB_TOKEN` (fine-grained, **Only select repositories** → the throwaway
      repo, **Issues: Read and write**, Metadata read).
- [ ] `connectors.json` → `github.settings` names that repo's `owner` and `repo`.
- [x] The console shows
      `[main] connector tools: linear__create_issue, linear__search_issues, linear__get_issue, github__create_issue, github__list_issues, github__get_issue`.
- [ ] `npm run github:recon` finishes, prints `fixed list args accepted`, and creates nothing.
- [x] **Regression:** one instruction from before M20 still works ("summarize this", and
      "find the login issue in Linear"). M20 changed the adapter every connector call passes
      through (a stricter drift check; a startup refusal for shared keys).

## 1. Reads (nothing is created)

Needs at least one issue in the repo. **Recon listed 0 issues in `throwaway_repo` on every
run** — if you created two by hand, check they are in the repo the token is scoped to.

- [x] **"what's open on GitHub"** → up to 5 issues, newest first, each `#N: title (open)` with
      a link on the next line. No confirm dialog.
      *Could be wrong:* the links are built by this app from `owner`/`repo` (a list item has
      none) — click one and check it opens the right issue.
- [x] **"what does GitHub issue N say"** → the title, state, link and whole body. No dialog.
- [x] **"what does GitHub issue 999999 say"** → *"GitHub said no: I couldn't find issue #999999
      in owner/repo."* — and **no URL, no ID** anywhere in the message.
- [ ] Listing the closed ones ("what's closed on GitHub") works and says `(closed)`.

## 2. The first real create — and the form-handoff question

Say **"open a GitHub issue called M20 live test"**.

- [x] A confirm dialog appears **before anything is created**, reading
      `Create this GitHub issue in owner/repo?`, then `Title: M20 live test`, then
      `(no description)`. The repo named is the throwaway one.
      *Known cosmetic issue, not fixed:* the approve button says **"Send"**.
- [x] Press Cancel first → nothing is created (check the repo in the browser).
- [x] Repeat and approve. **Record exactly what the app says.** One of three things happens:
  - [x] **(a) Expected:** `Created #N: M20 live test` and a link on the next line. The link
        opens the new issue, in the throwaway repo, with that title.
  - [ ] **(b) The form handoff fired:** *"GitHub said no: it showed a form instead of creating
        the issue. Nothing was created."* → check the repo: there must be **no** new issue.
        This is the case the server's source says cannot happen for this app. If it does,
        M20's create does not work against the hosted server and needs a decision.
  - [ ] **(c) Created, but reported as unreadable:** *"GitHub reported success but I couldn't
        read what it sent back … Check GitHub before trying again."* → check the repo: if the
        issue **is** there, the real result is not the `{id,url}` the source describes. Do not
        retry (it would create a second one); note the words in the brackets and stop. (This
        case is NOT logged to the console — only an `isError` answer is.)
- [x] Exactly **one** new issue exists, and no existing issue was edited or closed.

## 3. The chain: Gmail → GitHub → Slack

With a bug email open in Gmail and nothing important on the clipboard, say
**"file this bug on GitHub and tell the bugs channel"**.

- [ ] The plan preview shows three steps: read the email, file it on GitHub, tell the channel.
      *Could be wrong:* with Linear also on the menu, the model may pick `linear__create_issue`,
      or skip the read (M19's finding). The dialog in the next box is what catches either.
- [ ] `Step 2 of 3: Create this GitHub issue in owner/repo?` shows the **whole email**, and the
      dialog is fully visible (not under the instruction bar — M19's first live bug).
- [ ] `Step 3 of 3: Send to #bugs?` shows `New bug filed: Created #N: …` and the link — the
      exact text that is then posted.
- [ ] The issue exists with the email as its body; Slack got the message once.
- [ ] Decline step 2 → no issue, no message. Decline step 3 → the issue exists, no message,
      and the app says so.

## 4. Which tracker? (two connectors on one menu — unmeasured)

- [ ] **"file this bug in Linear"** → the dialog says **Linear**, not GitHub.
- [x] **"file this bug"** (no tracker named) → note which one it picks. The GitHub tool's
      description tells the model to use it only when GitHub is named; whether a real model
      obeys is a live-only fact, and the plan eval was not re-run for M20.

## 5. Failures (optional, each is covered by tests only until run)

- [ ] Put a wrong `repo` in `connectors.json`, restart, "what's open on GitHub" → *"I couldn't
      find owner/wrong — check connectors.json, and that GITHUB_TOKEN can see it."* Restore it.
- [ ] Break `GITHUB_TOKEN`, restart, any GitHub instruction → *"GitHub rejected my access —
      check GITHUB_TOKEN in .env and restart me."* Restore it.
- [ ] A token with Issues **read-only**, then a create → record the exact message. **This shape
      has never been measured.** If the app says only "GitHub said no.", that is the designed
      fallback for a failure it does not recognise. GitHub's own text is then in the console
      and nowhere else: copy the line that starts
      `[main] github__create_issue failed and I did not recognise why. GitHub said:` so the
      wording can be written from what GitHub really sent.
- [ ] While that line is on the console, check the app's result and what it **spoke** contain
      none of it — no URL, no ID.

---

## Live results

### Live results 1 — Saturday 10 October 2026, by hand (sections 0, 1, 2)

Reported by the person who ran it. 10 boxes ticked in this pass. (First recorded as 8; two
more were confirmed afterwards, the same day, and are marked below.) With "Live results 2" the
checklist stands at **11 ticked, 16 open**.

**Seen, and ticked:**

- **Section 0.** The console listed all six connector tools. An instruction from before M20
  still works — the Linear one. ("summarize this", which the same box also names, was not
  reported either way.)
- **Section 1.** The reads worked: the list, an issue by its number, and the not-found case.
  Both of the things those boxes warn about were looked at: a link from the list — which this
  app builds, GitHub sends none — opened the right issue, and the not-found reply had no URL
  and no ID in it.
- **Section 2.** The confirm dialog appeared before the create and named
  `Sejall-089/throwaway_repo`. Approving gave **`Created #3: M20 live test`** with a link that
  works. That is outcome **(a)**.
  - **The form handoff did NOT fire.** Outcome (b) did not happen, so the reading of the
    server's source — that it is sent only to a client advertising the
    `io.modelcontextprotocol/ui` extension — held for this client, once.
  - **The create result matched `{id, url}`.** Outcome (c) did not happen either: the
    formatter read the number out of the link and accepted the link as being in the pinned
    repository. The result's shape had been taken from the server's source and never captured;
    this is the first evidence from the real server that it is right. (It is still not a
    capture — the raw result was not saved, so the fixture remains "from source".)
  - **Cancel first → nothing created** (confirmed afterwards). Cancelling the dialog created
    nothing. This is the decline path of the real dialog, seen by a person.
  - **Exactly one new issue, nothing else edited or closed** (confirmed afterwards). Seen on
    github.com: Open 2 / Closed 1, with #1, #2 and #3 in the expected states — #1 open, #2
    closed, #3 the new one, open. (A read-only recon run had listed the same three; that was a
    script, and this box was ticked on the person's look, not on it.)

**Not reported, so left open in sections 0-2** — none of these is known to fail:

- 0: the token's exact permissions, and the `connectors.json` entry. (The create landing in the
  named repository implies both are right; nobody stated them, so they are not ticked.)
- 0: `npm run github:recon`. Script-verified only: it has been run several times, finishes,
  prints `fixed list args accepted`, and calls nothing but reads.
- 1: listing the **closed** issues.
- 2: outcomes (b) and (c) are unticked because they did not happen.

### Finding 1 — links in the result bar are plain text, not clickable

**Not an M20 bug; a UI follow-up for the result bar. Not fixed.** The link in a result
(`Created #3: …`, and each line of a list) is shown as text: it cannot be clicked. It had to be
copied and pasted into a browser. **The links themselves are correct** — the pasted one opened
the right issue.

It was seen on GitHub results only. It likely applies to Linear's too (`Created ENG-5: …` and
its link); not checked. A connector hands back a string and the right one, so the fix belongs
to the result bar, not to `core/mcp/`. The result bar's code was not read for this note.
Recorded in `spec.md` §9 with the other follow-ups.

**Not run at all** (as of Live results 1; section 4 has since been half run — Live results 2):
section 3 (the Gmail → GitHub → Slack chain, and both declines), section 4 (which tracker a
model picks when two are on the menu), section 5 (a wrong repository, a broken token, a
read-only token, and the console line for an unrecognised failure).

**Known, cosmetic, not fixed:** the approve button on the create dialog says "Send".

**Left behind:** issue #3, "M20 live test", in `Sejall-089/throwaway_repo`. GitHub's MCP server
cannot delete it.

### Live results 2 — section 4, one box, by hand (recorded 2026-10-10)

Reported by the person who ran it. 1 box ticked; the checklist stands at 11 ticked, 16 open.

**Seen, and ticked:**

- **"file this bug", with no tracker named, picked Linear.** The dialog read
  `Create this Linear issue in Sejal Gupta?`, with Title `Bug` and body `file this bug`. It was
  cancelled, and nothing was created.
  This is the outcome the GitHub tool's description asks for ("Use this ONLY when the user
  asks for GitHub by name"). It is one run: it shows what happened once, not a rate.

**Still open in section 4:** "file this bug in Linear" → the dialog says Linear. That phrase
was not run; the run above named no tracker.

### Finding 2 — with no email open, the issue's body was the instruction itself

**Not an M20 bug. Related to M19's finding; not fixed.** No email was open, so there was no
bug content for "this bug" to mean. The model did not refuse or ask: it proposed an issue
titled `Bug` whose body was the instruction text, `file this bug` — a ticket about nothing.

- **It is M19's finding again, in a different spelling.** M19's live pass found a plan that
  skipped `readEmail` and filled the description with text the model made up
  (`spec.md` §9, "M19 — proven vs. live-only"). The `linear__create_issue` description tells
  the model never to fill the description with a note about the instruction, and to leave it
  out when there is nothing to put there. Here it put the instruction there.
- **The dialog showed it, so it was catchable** — and it was caught: the whole body was on
  screen before anything was created, and the create was cancelled. The gate held; the plan
  did not. That is the same division of labour M19 recorded.
- **Why it is not M20's:** the tool chosen was Linear's, its description is unchanged by M20,
  and `plan.ts` was not touched. What M20 changed about this run is only that a second
  tracker was on the menu, and the model did not pick it.
- **Not known:** whether it happens with an email open, how often it happens at all, and
  whether the GitHub tool does the same when it is the one chosen (its description carries
  the same rule). One run, one phrase.
