# M30 — live verification checklist (by hand)

> **NOT YET RUN.** `spec.md` §9 (M30): a plan with a summarize or rewrite step before a Linear or
> GitHub create is refused unless the instruction asks for that step (`checkUnaskedSteps`,
> `spec.md` §5b, "A step nobody asked for, before a create").
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here files an issue or posts a message.** Every try either is refused before anything
> runs or reaches a Linear confirm dialog: press **Cancel** there. If you press Create by mistake,
> the issue lands in the `defaultTeam` from `connectors.json`; delete it in Linear.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.) Restart it after pulling: the main process is built once at startup.

**How to tell what the model planned.** A refused plan shows **no preview**: the refusal is the
only thing on screen. What the model sent is on the terminal running `npm run dev`, as
`[main] refused (chain 0/N) …` followed by `[main] refused plan, as sent: [...]`, which lists each
step's `"tool"`. A plan that runs shows its preview, and its `[main]` line has `[plan: …]` and,
since M30, `[description: …]`. The action log is the third witness, read-only, with the app
running:

```
python -c "import sqlite3,os; c=sqlite3.connect('file:'+os.path.join(os.environ['APPDATA'],'voice-agent','memory.db')+'?mode=ro',uri=True); [print(r) for r in c.execute('select id, ts, tool, status, substr(arguments,1,80) from action_log order by id desc limit 6')]"
```

A refused row has tool `None` and arguments like `{"plan": ["summarize", "linear__create_issue", "sendMessage"]}`.

Copy this text (all of it) before box 1, and leave it on the clipboard for both boxes. It is
M28's long clipboard, the case where the unasked step appears:

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

## 1. An unasked summarize step is refused, and nothing is filed

Type **"create a linear issue and send to fun"**. If a preview appears, the model planned no
summarize step this time: read the Linear dialog, press **Cancel**, and try again. Repeat until a
try is refused, up to eight tries (the step came 1 to 3 times in 3 to 6 tries in M28 and M29).
Have the speaker on. For each try, write down the `[main]` line's `[description: …]` item if it
has one: it records whether the model put the copied text in the create as it is.

- [ ] **1.1** The refused try shows no preview and no dialog, and the bar shows exactly: *"I won't
      summarize/reword it unless you ask. Ask again to file it as it is, or say 'summarize' /
      'rewrite' if you want that."*
- [ ] **1.2** The spoken message says the same sentence, whole. Write down how "summarize/reword"
      and "'summarize' / 'rewrite'" sounded.
- [ ] **1.3** The terminal's `[main] refused plan, as sent:` line for that try lists
      `"tool":"summarize"` before `"tool":"linear__create_issue"`.
- [ ] **1.4** Nothing was filed: no new issue in Linear's `defaultTeam`, and no message in fun.

If no try in eight is refused, write that here and leave boxes 1.1–1.4 open. The replay tests
cover the refusal against `MockShell` (`tests/unaskedSteps.test.ts`,
`tests/planner.unaskedSteps.test.ts`), but only a person can say what the real bar showed, what
the real speech engine said, and that nothing reached Linear.

## 2. A summarize step the person asked for still runs

Same clipboard. Type **"summarize this and file it in Linear"**.

- [ ] **2.1** A preview appears and lists "Summarize the text you copied" then "Create a Linear
      issue". No refusal.
- [ ] **2.2** The Linear dialog's description is a summary of the text above, not the text
      itself. Press **Cancel**. The `[main]` line has `[description: from an earlier step]`.

## Script-verified (live model, faked connectors)

**2026-10-23.** Not a tick: no box above is ticked by this. The real planner through the real
call site (`createRunInstruction`), with real planning calls (gpt-5-mini, low effort, through
`tests/eval/realModel.ts`'s spend gate), on the long clipboard above (`LONG_TRACE`,
`tests/fixtures/planChoice/clipboards.ts`), no email open. Everything that could reach a real
service was faked:
- **Linear:** `SdkMcpConnection` over `FakeMcpServer`'s in-memory transport, with a dummy key.
- **GitHub:** `UnavailableConnection`, which rejects every call.
- **Slack:** `FakeSender`.
- **Action log:** `InMemoryActionLog`; the real `memory.db` was only read, read-only, for the
  "third channel" = "#fun" fact.
- **Network:** `fetch` wrapped to allow only `api.openai.com`. Nothing was blocked: every request
  went to OpenAI.

`MockShell` answered Cancel at every dialog. One log was shared across a box's trials, as one app
session shares it. The summarize step's own text (`llm.complete`) was a fixed fake, so the budget
counts planning calls only; box 2 therefore shows that the description came from step 1, not
what a real summary reads like. The harness was a scratch script, not committed.

| Box | Trials | Result | Deviations | Model calls |
|---|---|---|---|---|
| 1 — "create a linear issue and send to fun" | 12 (cap reached, no early stop) | **Not reached: 0 of 12 refused.** The model planned no summarize or rewrite step in any trial, so 1.1–1.4 were never exercised against a real refusal. Every trial that ran had no step before the create (12 of 12). | 8 trials were create > send and 4 were a lone create with no send (a separate, older finding). All 12 reached the Linear dialog, cancelled, with `[description: equals clipboard]`. The fakes saw 0 creates and 0 sends. | 12 planning |
| 2 — "summarize this and file it in Linear" | 5 | **Pass, 5 of 5.** None refused; the preview was "1. Summarize the text you copied / 2. Create a Linear issue"; `[description: from an earlier step]`; the dialog body was step 1's output (the fake summary), not the clipboard; the fakes saw 0 creates. | 4 of 5 plans named the tools with the provider's `functions.` prefix; canonicalised and judged correctly. | 5 planning |
| UI (optional) | — | Not run: no Playwright, Spectron, Puppeteer or WebDriver in the repo. | — | 0 |

Total: 17 real planning calls, est. ~$0.024. What this does not show:
- **Box 1's refusal with a real model.** The refusal path itself is covered by the replay and
  planner tests, and by the harness's dry run with M27's plan scripted (refused, bar and speech
  text exactly the wording, no preview or dialog, the `refused plan, as sent` line listing
  summarize before the create, 0 creates and 0 sends).
- **1.2's sound.** It still needs a person: only the string handed to speech was compared.

## Machine-verified, not watched

- The rule against every plan on record, no model calls: all 30 unasked steps refused (16 of the
  77 recorded answers, 8 in M28's eval table, 6 live), all 5 asked-for steps run (3 eval, 2 live),
  and the 24 email-open and nothing-on-screen control trials untouched
  (`tests/unaskedSteps.test.ts`).
- Per-tool lists: "polish this and file it" with a summarize step refused; "summarize this and
  file it" with a summarize step runs, with a rewrite step refused (`tests/unaskedSteps.test.ts`,
  `tests/planner.unaskedSteps.test.ts`).
- The copy-the-text wording with nothing copied (all 16 recorded refusals had nothing copied);
  both wordings plain ASCII and under the spoken cap.
- Refused before any preview, dialog, narration or step; one `refused` row with the tool names;
  no miss; kept out of the next planning call's previous turn; judged after the multi-call retry;
  a detached job refused before admission; a real Linear create over a fake MCP server sends
  nothing (`tests/planner.unaskedSteps.test.ts`).
- The instruction is judged, never the clipboard; a step after the create, a plan with no create
  and a lone call are not looked at.
- The phrasing set: 1 of 22 asking phrasings wrongly refused ("file a one-line issue from
  this"; "tldr this and file it" runs since the review pass), 4 of 4 verb-in-the-bug phrasings
  let through. Known gaps, `spec.md` §5b. "tl;dr", "tldr" and "tl dr" all ask for a summary.
- The `[main]` line's `[description: equals clipboard | differs from clipboard | from an earlier
  step]` format (`tests/contextHints.test.ts`) and the planner's values for it.
- M29's rule under an asked-for rewrite (`tests/planner.mcp.test.ts`, re-justified).
- Eleven mutations, ten caught (one after a test fix), one not applicable; the M29 rule's
  mutation is caught by 3 of the 5 re-justified replay tests (`spec.md` §9, M30).
