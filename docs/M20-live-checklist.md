# M20 — live verification checklist (by hand)

> **PARTLY RUN, 2026-10-10.** A person ran sections 0, 1 and 2 and M20's box in `spec.md` §9 is
> ticked on that basis: the reads work, and the first real create worked — the form handoff did
> not fire. **Section 3, the chain, has since been run** (Live results 3): it works end to
> end, and it found that a chain creates the issue before it discovers the Slack channel is
> unknown (Finding 3). Its two declines were not run. **Section 5 has not been run** (the
> failure wording). Section 4 (the choice between two trackers) is half run — "Live results
> 2". Four boxes in sections 0-2 are still open. 15 boxes ticked, 12 open; the results
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

- [x] The plan preview shows three steps: read the email, file it on GitHub, tell the channel.
      *Could be wrong:* with Linear also on the menu, the model may pick `linear__create_issue`,
      or skip the read (M19's finding). The dialog in the next box is what catches either.
- [x] `Step 2 of 3: Create this GitHub issue in owner/repo?` shows the **whole email**, and the
      dialog is fully visible (not under the instruction bar — M19's first live bug).
- [x] `Step 3 of 3: Send to #bugs?` shows `New bug filed: Created #N: …` and the link — the
      exact text that is then posted.
- [x] The issue exists with the email as its body; Slack got the message once.
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
checklist stood at 11 ticked, 16 open; with "Live results 3" it stands at **15 ticked, 12 open**.

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

> **RESOLVED IN CODE BY M21 (2026-10-10) — NOT YET LIVE-TESTED.** GitHub and Linear issue
> links in the result bar are now clickable and open in the default browser; everything else
> stays plain text. Only `https` URLs whose host is exactly `github.com` or `linear.app` are
> links, and main checks the URL again before opening it (`spec.md` §4, "Result links").
> Verified by unit tests, a jsdom test of the rendered bar, and
> `node scripts/ask-recon/run.mjs result-links` on a real Electron window — which records what
> would be opened rather than opening a browser. **What nobody has done yet is click a real
> link in the running app and watch the browser open.** To check: file or read an issue, then
> click the link (and try Tab + Enter). Tick this when you have:
>
> - [ ] clicked a `Created #N` link in the live app and the right issue opened in the browser
> - [ ] the Linear link, the same way
>
> The original finding is kept below as it was written.

**Not an M20 bug; a UI follow-up for the result bar. Not fixed** (at the time of writing — see
the note above). The link in a result
(`Created #3: …`, and each line of a list) is shown as text: it cannot be clicked. It had to be
copied and pasted into a browser. **The links themselves are correct** — the pasted one opened
the right issue.

It was seen on GitHub results only. It likely applies to Linear's too (`Created ENG-5: …` and
its link); not checked. A connector hands back a string and the right one, so the fix belongs
to the result bar, not to `core/mcp/`. The result bar's code was not read for this note.
Recorded in `spec.md` §9 with the other follow-ups.

**Addendum (Live results 3) — where a link is and is not clickable. Only the result bar needs
the fix.**

| Where the link appears | Clickable? | Anything to do? |
|---|---|---|
| The result bar | No (at M20). **Yes since M21, in code — not live-tested** | Done in M21; see the note at the top of this finding. |
| The step 3 confirm dialog (`Send to #social?` with the link in the message) | No | No. It is a native Windows message box and cannot be made clickable. |
| The message in Slack | Yes | No. Slack linkifies it itself. |

**Not run at all** (as of Live results 1; section 4 has since been half run — Live results 2 —
and section 3 run apart from its declines — Live results 3):
section 3 (the Gmail → GitHub → Slack chain, and both declines), section 4 (which tracker a
model picks when two are on the menu), section 5 (a wrong repository, a broken token, a
read-only token, and the console line for an unrecognised failure).

**Known, cosmetic, not fixed:** the approve button on the create dialog says "Send".

**Left behind:** issue #3, "M20 live test", in `Sejall-089/throwaway_repo`. GitHub's MCP server
cannot delete it. (Live results 3 left three more — the full list is at the end of this file.)

### Live results 2 — section 4, one box, by hand (recorded 2026-10-10)

Reported by the person who ran it. 1 box ticked; the checklist then stood at 11 ticked, 16 open.

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

### Live results 3 — section 3, the chain, by hand (runs 2026-10-10)

Reported by the person who ran it. Three runs of the chain. 4 boxes ticked (first recorded as
3; the fourth was confirmed afterwards and is marked below); the checklist stands at
**15 ticked, 12 open**.

**Seen, and ticked:**

- **The plan preview showed three steps** — read the email, create a GitHub issue, notify the
  channel — **and picked GitHub, not Linear.** Both things the box warns about did not happen:
  the model did not choose `linear__create_issue`, and it did not skip the read.
- **The step 2 dialog** named `Sejall-089/throwaway_repo`, showed the **whole email** as the
  body, and was fully visible. **Finding 2 did not recur with an email open**: the body was
  the email, not the instruction.
- **The step 3 dialog shows exactly what is then posted** (run 3). It read:

  ```
  Step 3 of 3: Send to #social?
  Filed a bug on GitHub: Created #6: Bug report from email
  https://github.com/Sejall-089/throwaway_repo/issues/6
  ```

  It was approved, and Slack `#social` received a message for #6 with the same text and link.
  (The box's own wording, `New bug filed: …`, was this file's guess at the model's phrasing.
  The model wrote `Filed a bug on GitHub: …`. What the box checks — that the dialog's text is
  the text posted — is what was seen.)
- **The issue exists with the email as its body, and Slack got the message once** (confirmed
  afterwards). Issue #5 was opened on github.com: its body is the email — `From: Sejal Gupta`,
  `Subject: Bug: login button does nothing on mobile`, then the full message text. Slack
  `#social` received exactly one message for #5.

**The three runs:**

| Run | What happened | Issue | Slack `#social` |
|---|---|---|---|
| 1 | Steps 1 and 2 ran. **Step 3 did not**: *"I don't know which channel 'the bugs channel' means … I'd already done steps 1 and 2 of 3, but step 3 didn't run."* | **#4** "Bug reported via email" — created, and nobody was told | nothing posted |
| 2 | After teaching the channel: completed. Result bar: `Sent to bugs channel.` and `Filed a bug on GitHub: Created #5: Bug report from email` with a link. | **#5**, seen on github.com | exactly one message (7:10 PM), same text and link |
| 3 | Completed; the step 3 dialog was read before approving (above). | **#6** | a second message, for #6, same text and link |

The #5 and #6 messages appear consecutively in the channel, from Project Notifications.
Nothing was ever posted for #4.

**Still open in section 3:**

- *Decline step 2* and *decline step 3*: **not run.** The chain's declines rest on tests.

### Finding 3 — the chain created the issue before finding out it could not announce it

**Not an M20 bug: a known M19 follow-up, seen again. Not fixed.** In run 1 the chain ran its
irreversible step — creating issue #4 — and only then discovered that step 3's channel, "the
bugs channel", did not resolve to anything. Step 3 stopped. The issue stayed. Running the
instruction again after teaching the channel created #5, so the same email is now filed twice:
#4, which nobody was told about, and #5.

- **It is on M19's follow-up list already**, in the same shape: *"A chain stops AFTER the
  issue is created when the Slack channel is unknown, orphaning the issue"* (`spec.md` §9;
  there it left SEJ-7 and SEJ-8 in Linear). That entry says it is not designed. This is the
  first time it has been seen with GitHub; nothing about it is specific to either connector.
- **Where the check is today** (read from the code, not changed): an unresolved reference is
  found only when its own step runs, never when the plan is checked.
  - `validatePlan` (`core/chain.ts`) checks that each tool exists, the step count, and the
    `{stepN}` placeholders. It does not look at memory.
  - Memory resolution happens inside `runStep` (`core/planner.ts`), per step, as that step
    starts. A reference it cannot resolve is left as it was, silently.
  - The refusal itself is in `sendMessage`'s **handler** (`isUnresolved`), which runs after
    that step's confirm gate. So by the code's order, step 3's dialog — "Send to the bugs
    channel?" — would be shown, and the refusal would come after approving it. Whether the
    dialog appeared in run 1 was not reported; this is from reading the order, not from a run.
- **It was knowable before step 1.** The channel is a literal in the plan — no `{stepN}` in
  it — and looking it up in memory needs nothing an earlier step produces.

**Also noted: the issue titles were written by the model, not taken from the email.** "Bug
reported via email" (#4) and "Bug report from email" (#5, #6) — none is the email's subject.
That is the design, and its known cost: the model plans once, before the email is read, and
is told only that an email is open, never its subject (`core/contextHints.ts`: "the model
still cannot write a specific issue title"). The body is the email; the title is generic.

### Leftover throwaway issues

In `Sejall-089/throwaway_repo`: **#3, #4, #5, #6.** (#1 and #2 are the fixture issues the
tests' captures were taken from — keep those.) GitHub's MCP server cannot delete an issue, and
this app cannot close one; close them by hand.
