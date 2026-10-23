# M29 — live verification checklist (by hand)

> **NOT YET RUN.** Both fixes (`spec.md` §9, M29). Fix 1: `rewrite` leaves the clipboard alone
> inside a chain (boxes 1 and 2). Fix 2: each line of a plan's preview is the tool's own phrase,
> shown and spoken, and the console's `[main]` line names each step's tool beside it (box 3).
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here files an issue or posts a message.** Box 1 reaches a Linear confirm dialog at
> most: press **Cancel** there. If you press Create by mistake, the issue lands in the
> `defaultTeam` from `connectors.json`; delete it in Linear.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

**How to tell which tools a plan ran.** Since fix 2 the preview says it: a `rewrite` step reads
"Reword the text you copied". The terminal running `npm run dev` also prints the `[main]` line
with each tool's name, e.g. `[plan: rewrite "reword the text you copied" > …]`. The action log
is the third witness, independent of both. It is read-only, and the app can stay running:

```
python -c "import sqlite3,os; c=sqlite3.connect('file:'+os.path.join(os.environ['APPDATA'],'voice-agent','memory.db')+'?mode=ro',uri=True); [print(r) for r in c.execute('select id, ts, tool, status, substr(arguments,1,80) from action_log order by id desc limit 6')]"
```

A row with tool `rewrite` is the step this checklist is about.

## 1. A rewrite step in a chain leaves the clipboard alone

Copy this text (all of it). It is M28's long clipboard, the case where the rewrite step appeared
live (once in three tries):

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

Type **"create a linear issue and send to fun"**. Read the preview, then at the Linear dialog
read the description and press **Cancel**. Repeat (re-copying the text is not needed) until a
preview starts "1. Reword the text you copied", up to five tries. The model does not plan the step
every time. Box 3 is about that same preview.

- [ ] **1.1** In the try with a `rewrite` row: the Linear dialog's description does **not**
      start with "Rewritten (clear, natural, and concise) and copied to clipboard." (It will
      probably be reworded; that is expected, and the dialog is where you see it.)
- [ ] **1.2** After cancelling that try, paste into Notepad: the clipboard still holds the
      text above exactly, starting "Tried the migration again on staging". Before M29 it held the
      rewrite, which began "Ran the migration on staging again".
- [ ] **1.3** On the try after that one, the dialog's description is the original text (or a
      rewording of it), not a rewording of a rewording.

If no try in five has a rewrite step, write that here and leave boxes 1 and 3.1–3.3 open. The
replay tests in `tests/planner.mcp.test.ts` ("rewrite inside a chain leaves the clipboard
alone") cover them against `MockShell`, but only a person can say what the real clipboard did
and what the real preview looked and sounded like.

## 2. A plain rewrite still replaces the clipboard

Copy **"hey can u send me that file when u get a sec"**. Type **"rewrite this politely"**.

- [ ] **2.1** The result starts "Rewritten (politely) and copied to clipboard." (or a tone
      close to it), followed by the rewrite.
- [ ] **2.2** Paste into Notepad: the clipboard now holds the rewrite, not what you copied.

## 3. The preview names each step in the app's words

Use a try from box 1 that had a rewrite step: its preview is the one to read. Have the speaker on.

- [ ] **3.1** The preview reads, line for line:
      ```
      Three steps:
      1. Reword the text you copied
      2. Create a Linear issue
      3. Post a message to Slack
      ```
      (A plan without the send step shows two lines; write down what it showed.) Nothing on it
      says "unchanged" or "capture".
- [ ] **3.2** The spoken preview says the same words: "Three steps. First, reword the text you
      copied. Then, create a Linear issue. Then, post a message to Slack."
- [ ] **3.3** The terminal running `npm run dev` has a `[main]` line for that try containing
      `[plan: rewrite "reword the text you copied" > linear__create_issue "create a Linear issue"`.
- [ ] **3.4** One try **without** a rewrite step (any other preview from box 1): its lines are
      the phrases for the tools the action log shows, and nothing else.

## Machine-verified, not watched

- No clipboard write and no header line in a chain; a lone call and a one-step plan still write
  it and keep it (`tests/tools.test.ts`, `tests/planner.mcp.test.ts`, 5 tests, four mutations
  caught — `spec.md` §9, M29).
- `MockShell` now reads its clipboard back as the next capture, as Windows does.
- Every tool's phrase, word for word and against each rule; the model is never sent one; the
  screen, speech and console use the phrase, never the model's `describe`, the fallback
  included (`tests/planPhrase.test.ts`, `tests/chain.test.ts`, `tests/planner.mcp.test.ts`,
  `tests/mcpAdapter.test.ts`, `tests/contextHints.test.ts`; seven mutations caught, one only
  after a test was added — `spec.md` §9, M29).
