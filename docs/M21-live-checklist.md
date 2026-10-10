# M21 — live verification checklist (by hand)

> **PARTLY RUN, 2026-10-10 and 2026-10-11.** 15 boxes ticked, 14 open. A ticked box means **a person at the
> keyboard watched it happen in the running app** — nothing else earns a tick here. Every open
> box says "not yet watched": that means *not seen by a person*, not *failing*.
>
> M21 closes the orphaned-issue gap from M19 and M20 (a chain created a real issue and only then
> found it did not know the Slack channel) and fixes six things the live runs found on the way.
> `spec.md` §9, "M21", has the causes, the fixes and the known gaps.
>
> **How results are marked** (same convention as `docs/M19-live-checklist.md` and
> `docs/M20-live-checklist.md`):
>
> - `[x]` **Human-verified** — a person saw it in the running app.
> - `[ ]` **Not yet watched** — including everything that only a test, an eval or a recon
>   script has shown. A log line proves what the app decided, not what the user saw
>   (CLAUDE.md), so script-verified items stay open and say what the script did show.
>
> **The rule from M19 and M20 still holds: nothing automated ever creates a real issue or posts
> a real message.** The real creates and posts in this list are the ones done by hand.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

To make the app forget a channel between runs, deactivate the fact in
`%APPDATA%\voice-agent\memory.db` (`UPDATE facts SET active = 0 WHERE subject = 'bugs channel'`).
The app has no "forget" tool; saying "forget the bugs channel" is routed to `remember` and
fails.

---

## 1. The question — asked before anything happens

With an email open in Gmail and nothing known as "the bugs channel", say **"File this email as
a bug on GitHub and post it in the bugs channel"**.

- [x] **The question appears before any dialog, and is readable.** "Before I start: which
      channel do you mean by 'the bugs channel'?" above the input, with the placeholder "Type
      your answer…". No "Create this GitHub issue?" dialog has appeared yet.
- [x] **A valid answer is saved and the chain completes.** Typing a channel shows
      "Saved: the bugs channel = …", then the plan, the two dialogs, and the result.
- [x] **A second run does not ask.** The same instruction again goes straight to the plan.
- [x] **Escape cancels, and no issue is created.** The refusal names the reference and step 3;
      nothing new appears on GitHub.
- [x] **Pressing the instruction hotkey during a question keeps the question and its text.**
      The half-typed answer is still in the box; no fresh bar opens.
      *(An earlier report that this failed is spec §9 M21, finding 1: what was on screen that
      time was the model's own prose, not a question.)*
- [x] **The question stays up when switching to another app.** It also stays **on top** of
      that app — by design, and a known gap: it can cover what you switched to look at.
- [x] **Two bad answers stop the chain.** An empty line, or an answer starting with "my"/"the",
      is asked about once more; a second one ends it with nothing created.
- [x] **Answering with a different real channel, and seeing where the message lands.**
      **Answered #help; dialog said Send to #social via your Slack webhook (asked for help);
      message landed in #social. Watched by me, Oct 11 2026.**
      As expected, and a known gap rather than a bug: the dialog reports the answer as what
      was asked for, and the message still goes to the webhook's own channel.
- [ ] **The question cancels itself after 60 seconds.** *Not yet watched* (unit-tested with a
      fake clock only).

## 2. Where the message goes — the webhook, honestly

- [x] **The message landed in the webhook's channel**, not the channel that was asked for.
      (`#help` was taught; Slack showed it in `#social`.)
- [x] **The dialog names `#social` via the webhook once the quoted setting is used.** With
      `SLACK_WEBHOOK_CHANNEL="#social"` in `.env` — **with the quotes** — the dialog reads
      "Send to #social via your Slack webhook?" and, for another asked channel, "(You asked
      for …; the webhook posts to its own channel.)".
- [x] **The startup warning for a blank value** — **terminal only.** Watched in the
      `npm run dev` terminal: the one `[main] SLACK_WEBHOOK_CHANNEL is set but blank…` line
      appears at startup. Nothing shows in the app window. (To see it: leave the value blank,
      or write `#social` without quotes, and restart.)

## 3. A lone send — what is approved is what is sent

- [x] **A lone send with nothing selected is refused before any dialog.** "There's nothing to
      send. Copy the notes first…". Nothing reaches Slack.
      *(Before the fix this posted "Please paste the rough notes you want formatted for the
      #bugs channel." — action-log rows 417 and 418.)*
- [x] **A lone send with selected text shows the formatted text in the dialog, and Slack shows
      the same text.** The dialog's body is the whole formatted message; what arrives is
      identical.
- [x] **Cancel posts nothing.**

## 4. The confirm button's label

*None of these has been watched.* Each is the word on the dialog's first button; Cancel must
still be the second button, the default, and what Escape does.

- [ ] **GitHub create says "Create issue"** — not "Send". *Not yet watched.*
- [ ] **Linear create says "Create issue".** *Not yet watched.*
- [ ] **A Slack send says "Send".** *Not yet watched.*
- [ ] **Sending a Gmail reply says "Send reply".** *Not yet watched.*
- [ ] **Creating a calendar event with guests says "Create event".** *Not yet watched.*
- [ ] **Moving a calendar event that has guests says "Move event".** *Not yet watched.*

## 5. Links in the result bar

- [x] **A GitHub issue link in the result bar was clicked and opened** in the default browser.
      (This also closes `docs/M20-live-checklist.md`, Finding 1, for GitHub.)
- [ ] **A Linear issue link, clicked.** *Not yet watched.*
      Script-verified only: `node scripts/ask-recon/run.mjs result-links` shows a real click
      and a real Enter on a real window reaching main as the right URL, with the browser call
      replaced by a recorder.

## 6. Connecting

- [ ] **"Connecting to GitHub…" appears on the status line** for the first connector use of a
      session. *Not yet watched.* Typical connects are 1.5–7 s, so it may only flash.
- [ ] **The connect-timeout wording**: "GitHub didn't answer while I was connecting, so nothing
      was sent. It is safe to try again." *Not yet watched, and hard to provoke* — it needs
      the server not to answer `initialize` for 30 s. The original live case (row 413) showed
      the OLD wording. Pulling the network cable shows the sibling message instead ("I
      couldn't reach GitHub while I was connecting (…), so nothing was sent…").

## 7. Carried over from M20 — still not watched

These are open boxes in `docs/M20-live-checklist.md`; they are listed here so they are not
lost, and are ticked there when done.

- [ ] **The chain, declined at step 2** (the create): nothing is created and step 3 does not
      run. *Not yet watched.*
- [ ] **The chain, declined at step 3** (the send): the issue exists, nothing is posted, and
      the message says steps 1 and 2 ran. *Not yet watched.*
- [ ] **"File this bug in Linear"** on the current build, end to end. *Not yet watched.*
- [ ] **The wording when a read-only token tries a create.** *Not yet watched* — the
      permission sentence was written from a stand-in, not from a real refused create.

---

## What the recon scripts showed (not a substitute for the boxes above)

They run the real code on a real Electron window, which a unit test cannot, and they are how
finding 1 was diagnosed. **They send keystrokes and flash a window** — read each header first.

| Script | What it showed |
|---|---|
| `node scripts/ask-recon/run.mjs hotkey-during-question typed` (and `dictated`) | A hotkey press during a real question refocuses it; the half-typed answer survives; no second capture opens. |
| `node scripts/ask-recon/run.mjs dismissed-then-again` | Dismiss one question, give the instruction again: before the fix the second attempt was the model's prose; after it, a real question. Two real planning calls; runs no tool. |
| `node scripts/ask-recon/run.mjs result-links` | Only the two allowed hosts are drawn as links; a click and Enter open the right URL once; `window.open`, `location.href` and a middle click go nowhere. Opens no browser. |

## Known gaps, so nobody mistakes them for failures while testing

- A channel that comes from a `{stepN}` placeholder cannot be checked before the chain starts.
- `#typo` is accepted and remembered as typed; nothing checks that a channel exists.
- A Slack failure after the issue is created still leaves an issue nobody was told about.
- One webhook posts to one channel. Channel names start to matter with one webhook per channel
  — the next milestone.
- A prose reply from the model can still look like a question nothing is waiting on.
- The question window stays on top of other apps for up to 60 seconds.
- Connectors are not warmed at startup; a late answer after a timeout is never shown.
- Esc, pressed to stop speech, also cancels a pending confirm (M19 follow-up).
- A remembered channel is shown as typed — "help", with no "#".
