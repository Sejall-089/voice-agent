# M23 — live verification checklist (by hand)

> **PARTLY RUN, 2026-10-22, by a person; M23 CLOSED the same day with the gaps below.** 12 boxes
> ticked, 30 open. A ticked box means **a
> person at the keyboard watched it happen in the running app** — no test, eval or recon script
> earns a tick here. An open box means *not seen by a person*, not *failing*.
>
> Before the live pass, everything that could be scripted was run against the real app
> (2026-10-21/22): real hotkeys, real clicks on the pill, real keys into the app's own dialogs,
> a scratch `--user-data-dir` for every instance, a fake OpenAI server and a fake Slack webhook
> injected through the child process's environment, and Linear, GitHub, Calendar and Chrome
> switched off. `.env` and real accounts were never touched. Open boxes say what that run showed.
>
> - **Human-verified (12):** 0.2a, 1.3, 2.2, 2.5, 2.11, 3.4a, 4.1, 4.2a, 5.1, 7.2, 7.3, 8.1.
> - **Covered by script or test only (boxes left open, 25):** 0.1, 0.2b, 0.3, 1.1, 1.2, 2.1,
>   2.3, 2.4, 2.6, 2.7, 2.8, 2.9, 2.10, 3.1, 3.2, 3.3, 3.4b, 3.5, 4.2b, 4.3, 6.1, 7.1, 7.4, 8.2,
>   9.1 — 9.1 run by a person through a script, real model, not in the app.
> - **Not run (5 boxes):** 0.4 with real Linear; 4.2c (speech — a known limit, below); 5.2; 9.2 (the
>   "I planned N steps" note was never seen live); 10 (M21's two Linear items); and, outside any
>   box, the 30-minute expiry, a second monitor or another display scale, and the
>   `checkUnreadContent` refusal path.
>
> Also watched, not a box: the Gmail → Linear → Slack chain reached its Linear dialog (not
> approved).
>
> M23 lets an instruction run without holding the command bar: pressing the hotkey while it is
> still working **detaches** it into a background job, shown in a **status pill** at the bottom
> right, which pauses before any confirm (or any tool that needs the screen) and plays a
> **needs-you chime**. `spec.md` §5c has the design; §9, "M23", the build order, what each claim
> rests on, the mutation table and the known limits.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified** — a person saw it in the running app.
> - `[ ]` **Not yet watched** — including everything that only a test, an eval or a recon
>   script has shown. A log line proves what the app decided, not what the user saw
>   (CLAUDE.md), so script-verified items stay open and say what the script did show.
>
> **Nothing automated ever creates a real issue, posts a real message or sends a real email.**
> The real posts and creates in this list are the ones done by hand: Slack messages to the
> channel you name (use a test channel such as #fun), and issues in your Linear / GitHub test
> project. Delete them afterwards; the app has no undo.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

**Before you start**

- The `.env` your normal runs use (an LLM key, Slack, and the Linear / GitHub connector). Box
  9.1 changes `LLM_PLANNING_MODEL` and `LLM_PLANNING_REASONING_EFFORT` — put them back after.
- Something on the clipboard you recognise (a few lines of notes), so a summary is obviously
  of the right thing.
- Jobs live in the `jobs` table of `%APPDATA%\voice-agent\memory.db`. Nothing needs resetting
  between runs: dismissing a job from the pill hides it and deletes nothing.
- A detached job is one you pressed the hotkey on **while it was still working**. Slow
  instructions make that easy: a summary, or a chain that ends in a Slack send.

---

## 0. Before anything: the regression check

An instruction you do not detach must behave exactly as it did through M22.

- [ ] **0.1** "summarize this" and wait. **Expect:** Thinking…, the summary in the bar, spoken.
      No pill appears (a job you watched finish is not news). *(Script-verified only: the
      summary in the bar, no pill, the job `done` with `background 0`.)*
- [x] **0.2a** "summarize this and send it to the fun channel": the dialog comes up in front of
      the bar, reads correctly, and both buttons work **with the mouse**. *(2026-10-22: a normal
      confirm and a Review… dialog, both with the mouse.)*
- [ ] **0.2b** Approve it. **Expect:** the post in Slack; no pill. *(Script-verified only: the
      bar hidden while the dialog was up, the fake Slack got the post, no pill.)*
- [ ] **0.3** With that dialog up, press the instruction hotkey. **Expect:** blocked, and the
      bar says a confirmation is waiting. *(Carried from `docs/M19-live-checklist.md`.
      Script-verified only: `[main] instruction hotkey ignored - a confirmation is waiting`, and
      still one dialog. The person-watched case was a detached dialog, in finding 1.)*
- [ ] **0.4** A chain declined at step 2, and one declined at step 3. **Expect:** declined at
      the create, nothing is created and step 3 does not run; declined at the send, the issue
      exists, nothing is posted, and the message says which steps ran. *(Carried from
      `docs/M20-live-checklist.md` via M21's list. Script-verified with a second Slack send in
      place of the create — Linear cannot be faked without a code change: "I'd already done step
      1 of 3, but steps 2 and 3 didn't run" / "steps 1 and 2 of 3, but step 3 didn't run". Not run
      with real Linear.)*

## 1. Detaching a job

- [ ] **1.1** "summarize this and send it to the fun channel"; while it is still thinking,
      press the instruction hotkey. **Expect:** the bar is free for a new instruction at once;
      the pill appears bottom right, "1 running", then amber "1 needs you" when the job reaches
      its confirm. *(Script-verified only: the bar open and empty, "1 running" then "1 needs
      you", nothing of the job's in the bar's page.)*
- [ ] **1.2** Type a second instruction in the freed bar ("what's on my calendar today").
      **Expect:** it runs normally in the bar while the first waits in the pill.
      *(Script-verified only.)*
- [x] **1.3** Press the hotkey during an attached job's **confirm dialog**, and during a step
      that needs the screen (e.g. "point at the save button"). **Expect:** both blocked, as
      before. *(2026-10-22: the foreground step watched; the dialog case was watched in
      finding 1's sequence.)*

## 2. A detached job waiting at a confirm

- [ ] **2.1** The pill when a job starts waiting. **Expect:** amber, "1 needs you", a pulse for
      about two seconds, then steady. The pill never takes the keyboard from what you are
      typing. *(Script-verified only: `mode-needs-you pulse`, then no pulse; the foreground never
      moved to the pill.)*
- [x] **2.2** Click the pill. **Expect:** the list opens; the waiting row has **Review…** and
      **Cancel**. Click **Review…**. **Expect:** the native confirm dialog, in front of
      everything, readable, both buttons clickable. *(2026-10-22, with the mouse.)*
- [ ] **2.3** Approve. **Expect:** the post lands in Slack; the pill shows "Done" for a few
      seconds and hides. *(Script-verified only.)*
- [ ] **2.4** Do it again and **Cancel** at the dialog; once more and press **Esc**.
      **Expect:** nothing is posted; the job ends without running the send. *(Script-verified
      only: 0 posts each, jobs `cancelled`.)*
- [x] **2.5** **Half-typed text in the bar**: open the bar, type "remind me to", click the pill,
      Review…, answer the dialog, then keep typing without clicking. **Expect:** your keys land
      after "remind me to"; nothing was selected or lost. *(2026-10-22, after 6705b69.)*
- [ ] **2.6** **In another app**: with a job waiting, click into Notepad, then the pill,
      Review…, answer. **Expect:** the bar does not open or take focus. *Known limit:* you have
      to click back into Notepad — Windows leaves the foreground on the pill (§9 open limit).
      *(Script-verified only: the foreground went to the pill, the bar stayed closed.)*
- [ ] **2.7** **Cancel from the pill** while a job waits. **Expect:** gone from the list at
      once; nothing sent. *(Script-verified only.)*
- [ ] **2.8** **A cancelled job's dialog.** The pill is disabled while its own dialog is up, so
      a detached dialog cannot be cancelled from the pill *while it is on screen*. The case
      that can happen: an **attached** job's dialog is up (the pill stays clickable), and a
      detached job's Review… is clicked — its dialog is **queued**. Cancel that job from the
      pill, answer the attached dialog, and approve the detached one when it opens (the queue
      cannot take it back). **Expect:** nothing is sent for the cancelled job. *(Script-verified
      only: its queued dialog still opened and was approved; only the attached job posted.)*
- [ ] **2.9** Two jobs waiting. **Expect:** "**2 need you**". Review… on the first opens its
      dialog; while it is up the pill is disabled (the dialog is modal to it), so the second
      Review… cannot be clicked until the first is answered — then it opens. *(Script-verified
      only: one dialog at a time.)*
- [ ] **2.10** A detached job reaching a tool that needs the screen ("read this email and
      draft a reply", detached). **Expect:** it waits with **Resume**; clicking Resume while you
      are typing in the bar says *"Finish what's open in the bar first, then resume this."*
      *(Script-verified only, with `openApp`.)*
- [x] **2.11** **Re-watch of finding 1** (fixed in 515b0a6): with a detached dialog up and the
      bar open, press the hotkey ("There's a confirmation waiting…"), then cancel the dialog.
      **Expect:** the line is gone; what you typed is still there. *(2026-10-22.)*

## 3. The pill's list

- [ ] **3.1** It starts collapsed every time — including after you opened it, it emptied, and
      a new job appeared. Nothing about a job opens it; only a click. *(Script-verified only.)*
- [ ] **3.2** It closes on: a second click, a row's button, an accepted hotkey press, ten
      seconds with the pointer off it, and the pill emptying. *(Script-verified only: hotkey,
      second click, still open at 8.5 s and closed by 11.5 s, emptying.)*
- [ ] **3.3** A long failure message is shown whole and wrapped, and the panel grows to fit
      (up to 440 px), bottom-right corner fixed. *(Script-verified only: 228 characters over 5
      lines, not cut.)*
- [x] **3.4a** A failed job is still shown, red, after a restart. *(2026-10-22.)*
- [ ] **3.4b** It stays until you have opened the list with it in it, then one hour;
      **Dismiss** removes it at once. A cancelled job is never shown. *(Script-verified only:
      Dismiss, and cancelled never listed. The one-hour clock: tests and `pill-collapse.ts` on a
      skewed clock.)*
- [ ] **3.5** The pill is left out of a screen capture. *(Script-verified only: a GDI
      full-screen capture with a job waiting showed what is behind the pill; an amber control
      window in the same capture was there.)*

## 4. The chime

- [x] **4.1** One short sound when a job starts waiting. **Expect:** audible, once.
      *(2026-10-22: heard, volume fine.)*
- [x] **4.2a** While **dictating**, let a detached job start waiting. **Expect:** no chime
      during the dictation; one afterwards, only if the job still waits. *(2026-10-22.)*
- [ ] **4.2b** The same while the bar is **recording** an instruction. *(Script-verified only:
      0 chimes during the recording, 1 after Esc.)*
- [ ] **4.2c** The same while the app is **speaking**. **Known limit, not fixed:** an
      utterance longer than 15 s is treated as finished at 15 s, so a held chime can play over
      its last moment (measured: 733 ms before the end) — §9. Not watched.
- [ ] **4.3** Mute it from the list, restart the app, let a job wait. **Expect:** silent — mute
      survived the restart. Unmute after. *(Script-verified only: "Chime off" after a restart,
      `chime.muted` = "1", 0 chimes.)*

## 5. `jobStatus`

- [x] **5.1** With one job waiting and one running, ask "are my agents done yet". **Expect:** a
      spoken sentence leading with what is waiting; on screen, one line per job; no model
      prose. It does not list itself. *(2026-10-22, against the pill.)*
- [ ] **5.2** "did that finish" right after a foreground action. *(Not measured by the eval:
      the phrasing most likely to mean something else.)* Not run.

## 6. The cap

- [ ] **6.1** Detach four slow jobs in a row. **Expect:** three run; the fourth says *"Three
      jobs are already running, so this one is queued. It starts when one of them finishes."*,
      and starts when one does. *(Script-verified only.)*

## 7. A restart

Kill the app from its terminal (Ctrl+C or close the window), then `npm run dev` again.

- [ ] **7.1** Killed with a **detached job waiting at its confirm**. **Expect:** after the
      restart, the pill shows it as interrupted: *"…before step N of M (sendMessage) ran.
      Nothing was sent by that step."* It is not resumed. **Dismiss** removes it.
      *(Script-verified only.)*
- [x] **7.2** Killed with an **attached** job **mid-step**. **Expect:** the pill shows it, with
      *"…was running. It may or may not have gone through. Check before trying again."*
      *(2026-10-22, a summarize. Script-verified also mid-SEND, with the fake Slack holding the
      request open.)*
- [x] **7.3** Killed with an attached job **still planning**. **Expect:** after the restart it
      shows nowhere. *(2026-10-22.)*
- [ ] **7.4** An interrupted job stays after opening the list and after another restart, until
      you dismiss it. *(Script-verified only.)*

## 8. One running instance

- [x] **8.1** With the app running, start `npm run dev` again in a second terminal.
      **Expect:** the second exits within a few seconds, and the running app's bar appears with
      *"I'm already running — press the hotkey to give me an instruction."* *(2026-10-22.)*
- [ ] **8.2** The same while `npm test` is running in a third terminal. **Expect:** `predev`
      stops with a sentence saying another program has the SQLite binary open — not a crash.
      *(Script-verified only.)*

## 9. The provider's parallel wrapper (fixed after the build)

- [ ] **9.1** **"summarize this and send to fun then create an issue in linear and write in
      notion"** on gpt-5-mini, low effort. Correct outcomes: a plan runs and its preview ends
      *"I planned N steps. If you asked for more, say the rest after."*; or *"That's more than 3
      steps. Say the first three, then the rest."* **Wrong:** *"used a tool I don't have
      ("multi_tool_use.parallel")"*. *(2026-10-22, run by a person through
      `wrapper-trials.mjs` — the real model, recording-only tools, not the app — 3 trials, 6
      calls: trials 1 and 2 the wrapper twice; trial 3 the wrapper, then a 4-step plan. Nothing
      ran. The retry text did not move gpt-5-mini low in 2 of 3. Since 76ad0c3 the wrapper twice
      also gets the over-cap sentence.)*
- [ ] **9.2** A plan that runs after the wrapper retry, showing the "I planned N steps" note.
      Not run: no runnable plan came back from the real model. Tests only.

## 10. Carried over — still not watched

- [ ] From `docs/M21-live-checklist.md`: "File this bug in Linear" on the current build, end to
      end; and the wording when a read-only token tries a create. Not run.

---

## Known gaps, so nobody mistakes them for failures while testing

- After a detached dialog closes while you are in **another app**, you click back into it
  yourself (§9 open limit; measured, decided not to build).
- A spoken result longer than **15 seconds** is treated as finished at 15 s: the queue moves
  on and a held chime can play over its end (§9 open limit; measured; out of M23).
- An app killed during a **read-only** step (reading an email, a long summary) shows "may or
  may not have gone through" for a step that could not have sent anything (§9 known limit).
- The `plan` tool still tells the model "At most 3 steps", and the retry did not move
  gpt-5-mini low in 2 of 3 trials (§9). The "I planned N steps" line is what makes a dropped
  action visible.
- `pointAt`'s target window and the one-slot draft are app-wide, not per job: a detached
  `pointAt` or `sendReply` resumed later uses the most recent press's window / draft.
- While any dialog is open, an attached job's question is told it could not be asked.
- Resuming a confirm is not held back while you are typing: the dialog takes the keyboard for
  its duration (the bar and your text are left intact).
- The pill is on the primary display only. Nothing is resumed after a restart, by design.

---

**Findings**

1. **A stale "There's a confirmation waiting" line** (2026-10-22, live). With a detached dialog
   up and the bar open, the hotkey was blocked and the bar said so; after the dialog was
   cancelled the line stayed, with nothing waiting. Cause: a status line was only ever replaced,
   never taken down, and closing a dialog in a bar it never hid replaced nothing. **Fixed in
   515b0a6**, with `scripts/ask-recon/confirm-waiting-line.ts` (failed before, passes after).
   **Re-watched: pass** (2.11). The "Thinking…" seen alongside it was a real run: the typed
   instruction had been submitted after the cancel.
2. **A spoken result longer than 15 s** (2026-10-22, found by the scripted run, reproduced
   twice). The shell stops waiting for playback at the 15 s renderer-reply timeout, so
   "speaking" ends early and a held chime plays over the end (an utterance of 15 831 ms; the
   chime 733 ms before it ended; logged `playback did not report back: The recorder didn't
   respond.`). Pre-dates M23. **Not fixed: out of M23**, recorded in §9 as an open limit.
3. **The parallel wrapper, live** (2026-10-22, 9.1): the wrapper both times in 2 trials of 3,
   then a 4-step plan in the third. **Changed in 76ad0c3:** the wrapper twice now gets the
   over-cap sentence. Not re-watched in the app.
4. **Three checklist wordings were wrong** (found by the scripted run; fixed in this file): 2.8
   described a cancel the pill cannot take while its own dialog is up; 2.9 said "2 needs you"
   (it is "2 need you") and a second Review… that cannot be clicked; 4.2 covered dictation
   only.
