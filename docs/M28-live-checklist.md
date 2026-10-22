# M28 — live verification checklist (by hand)

> **RUN 2026-10-23, by a person; M28 CLOSED the same day with the plan-choice finding still
> open.** 2 boxes ticked, 0 open. A ticked box means a person saw it in the running app.
>
> Two findings from the run, neither fixed in M28 (see **Findings** at the end): with a long
> clipboard, one plan's first step was **`rewrite`** under the model's label "Capture the selected
> text unchanged…", which rewrote the text and replaced the clipboard; and with nothing copied,
> the "question" asking for the text was the model's prose, with nothing waiting for an answer.
>
> M28 adds one deterministic check: the planner refuses a plan or a call whose arguments hold a
> placeholder nothing fills, like `{selected_text}` (`spec.md` §5b, "A blank nothing fills").
> It also adds the eval set for M27's plan-choice finding. **That finding stays open**: two
> wordings were measured and reverted, so the app plans exactly as it did at M27 (`spec.md` §9,
> M28). Two boxes below, because only these need a person: everything else is machine-verified
> and listed at the end.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified** — a person saw it in the running app.
> - `[ ]` **Not yet watched** — including everything that only a test, an eval or a recon
>   script has shown.
>
> **Nothing automated ever creates a real issue or posts a real message.** Both boxes reach a
> Linear confirm dialog at most: press **Cancel** there and nothing is filed or sent. If you
> press Create by mistake, the issue lands in the `defaultTeam` from `connectors.json`; delete
> it in Linear.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

**Before you start**

- Linear connected (`LINEAR_API_KEY`, Linear enabled in `connectors.json` with a
  `defaultTeam`), and a Slack channel the app knows as "fun" and "#bugs" (or accept that the
  send step asks or refuses — neither box gets that far if you Cancel at the create).
- **No email open in Gmail** for either box (close the message, or leave Chrome without the
  debug port): with one open, the app tells the model "An email is open in Gmail" and the plan
  changes.

---

## 1. Nothing selected: nothing is filed

Empty the clipboard first. In a terminal: `cmd /c "echo off | clip"` (the app reads an empty
clipboard as nothing selected). Then type **"log this as an issue and let #bugs know"**.

- [x] **1.1** *(2026-10-23. Nothing was filed. The app showed a reply asking for the text and
      offering to re-log SEJ-21. Action log row 647: `no_tool`, so that reply was the model's
      prose — finding 2.)* **Expect: no Linear issue is filed, and no create dialog offers one with no
      description, a made-up one, or the characters `{selected_text}`.** Any of these is a
      pass:
      - refused before anything runs, with *"I didn't file that issue. Nothing in my plan
        reads what you pointed at…"* (a create with no description) or *"I didn't start that.
        My plan had a blank in curly braces that nothing would fill in…"* (M28's new check);
      - or a plan whose first step is a summary, which then stops because there was nothing to
        summarize. This is the most likely outcome: the eval saw `summarize > create > send`
        in 3 of 3 trials for this phrase with nothing on screen.

      **A failure** is a Create dialog for an issue whose description is empty, invented, or a
      brace placeholder. Note what the plan preview listed and what the dialog said, then press
      Cancel.

## 2. The original finding, still open: the summarize step is shown

Copy this text (all of it), so the clipboard holds a long, bug-shaped block — the case where the
extra step appears (4 of 6 eval trials before any fix; 0 of 6 with a one-line clipboard):

```
Tried the migration again on staging this morning and it still falls over about two thirds of the way through. It gets past the users table fine, then dies on orders. I restarted the worker twice and cleared the queue, same result both times.

I think it's the batch size — the job loads every row for a customer into memory before it writes anything, and a couple of the bigger accounts have six-figure order counts. Dropping the batch to 500 got further but then hit a timeout instead.

Error: Connection terminated unexpectedly
    at Connection.<anonymous> (/srv/app/node_modules/pg/lib/client.js:132:73)
    at Object.onceWrapper (node:events:632:28)
    at Connection.emit (node:events:518:28)
    at Socket.<anonymous> (/srv/app/node_modules/pg/lib/connection.js:63:12)
    at migrateOrders (/srv/app/dist/jobs/migrate.js:214:19)
    at async runBatch (/srv/app/dist/jobs/migrate.js:88:5)
    at async Worker.process (/srv/app/dist/worker.js:41:9)

Going to leave it for now and pick it up after lunch. If anyone has seen pg drop the connection mid-transaction like this before, shout — I'd rather not bisect the whole job.
```

Then type **"create a linear issue and send to fun"**. Up to three tries; the step does not
appear every time.

- [x] **2.1** *(2026-10-23. No summarize step in any try; cancelled at every Linear dialog. Try
      1 was three steps, "Capture the selected text unchanged to use as the issue description",
      create, post to fun — step 1 was `rewrite` (finding 1). Two later tries were two steps:
      create with the clipboard as the description, then post. So the case this box was written
      for, a summary step shown in the preview, did not occur.)* **Expect: when the plan includes a summary, the plan preview names that step
      before anything runs** (a step like "Summarize the selected clipboard text"), and the
      Linear dialog then shows the summary as the description, not the text you copied. This is
      the finding as it stands: an extra step nobody asked for, but one a person can see in the
      preview and decline at the dialog. **Press Cancel at the Linear dialog.** Note how many
      tries showed the summary step, and whether any plan dropped the send or the description.
      **A failure** is a summary step that the preview does not show, or a dialog that does not
      show what would be filed.

---

## Machine-verified (no box: no person needed)

- **A `{selected_text}` placeholder is refused, not filed.** `tests/unfilledBlanks.test.ts`
  (18 tests): a plan, a one-step plan and a lone call holding `{selected_text}` or
  `{clipboard}` are refused with the fixed message before any preview, dialog or step; one
  `refused` row, no miss; the row is kept out of the next instruction's previous turn. A valid
  `{step1}` still runs, and the clipboard as given still runs with braces in it (JSON, a
  template's `{name}`). Mutation-checked four ways (`spec.md` §9, M28). The eval recorded this
  placeholder once in 45 trials of the reverted first wording; the reverted app has not been
  seen to produce it, which is why it has no live box.
- **What the eval measured** (gpt-5-mini, low effort, 3 trials a case): `spec.md` §9, M28. Not a
  live result.

## Known gaps, so nobody mistakes them for failures while testing

- **Plan choice with a long clipboard is not fixed.** "create a linear issue and send to fun"
  with a long clipboard still often adds a summarize step; that is box 2.1's expected outcome,
  not a regression.
- With nothing on screen, "log this as an issue and let #bugs know" has never planned what its
  M19 recorded expectation says (readEmail first) on gpt-5-mini. Recorded as a separate
  finding, not tuned for.

---

**Findings**

Both from the live run of 2026-10-23, established from the action log (`action_log` in
`%APPDATA%\voice-agent\memory.db`, read read-only, rows 647–652) and the code. Neither is fixed;
no code was changed for either.

1. **"Capture the selected text unchanged" was `rewrite`: it changed the text and replaced the
   clipboard.** Box 2.1, try 1 (rows 648–649, one job). The plan was `rewrite` (`{"tone": ""}`) >
   `linear__create_issue` (description `{step1}`) > `sendMessage`.
   - **Which tool.** There is no tool that returns the clipboard as it is. Step 1 was the
     `rewrite` tool. An empty `tone` falls back to "clear, natural, and concise". It sent the
     text to the model to be reworded, and **copied the rewrite onto the clipboard**, replacing
     what the person had copied. It is a `reversible` tool, so it ran with no narration and no
     confirm.
   - **What reached the dialog.** Its whole result became the issue description: the rewritten
     text, after the tool's own first line, "Rewritten (clear, natural, and concise) and copied
     to clipboard." The person cancelled there, so nothing was filed or sent.
   - **It spread to the later tries.** The two-step plans that followed (rows 651, 652) used the
     clipboard as given, and by then the clipboard held the rewrite: both descriptions begin "Ran
     the migration on staging again this morning", which is the rewrite's wording, not the text
     copied ("Tried the migration again…").
   - **Who wrote the label.** The model. A plan step's line in the preview is the step's
     `describe`, a phrase the model writes for each step (`PLAN_TOOL`, `core/llm/plan.ts`), shown
     as written (`previewPlan`, `core/chain.ts`). The tool's name is used only when that phrase is
     empty, and the preview never names the tool otherwise. So the preview said "unchanged" over a
     step that changed the text and the clipboard, and nothing on screen contradicted it until
     the Linear dialog.
   - **Status.** Not fixed in M28. This is the same family as M27's finding (an extra step before
     the create), with a different tool: the eval only ever saw `summarize` there.

2. **With nothing copied, the request for the text was the model's prose, not an app question.**
   Box 1.1, row 647: `no_tool`, no result stored. The reply asked for the text and offered to
   re-log SEJ-21. The SEJ-21 came from the previous turn the model was shown: `getLast()` skips
   detached rows, and the last attached one was row 642, the cancelled post "New issue filed:
   Created SEJ-21…". Nothing in the app was waiting for an answer: it was M21's case of model
   prose looking like a prompt. Nothing was filed, which is what the box checks. Not fixed.
