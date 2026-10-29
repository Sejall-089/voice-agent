# M33 — live verification checklist

> **NOT YET RUN by a person.** `spec.md` §9 (M33): `remember` asks before it replaces a value you
> taught it, with *Change what I remember for "team" from #social to social?* and a **Change it**
> button; a new fact and the same value said again are saved with no dialog. Spoken, a value's
> leading "#" is said as "hash" ("from hash social to social"); the written dialog is unchanged.
> 0 ticked, 4 open (H4 optional).
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw, heard or did it.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here files an issue, posts a message or changes a fact you taught it.** Every dialog
> is answered **Cancel**. H2 is a value memory already holds: no new version, though the fact's
> "updated" time is refreshed. **H4 is the one box that may write.** In the scripted run, the
> correction it uses saved a NEW fact with no dialog in 5 of 27 tries (`channel` = #social,
> `channel:fun` = social). New facts are never asked about. H4 says what to look for.

Run `npm run dev` (clear `ELECTRON_RUN_AS_NODE` first). Restart it after pulling: the main process
is built once at startup. Before H1, check what the app holds: "what do you remember about the
team" should say `#social`.

## Human-only

- [ ] **H1** In the real app, say "remember the team is #fun" (the team is stored as `#social`). A
      dialog *Change what I remember for "team" from #social to #fun?* appears, with a **Change
      it** button. Press **Cancel**. Then ask "what do you remember about the team": it must still
      say `#social` (`v1`).
- [ ] **H2** Say "remember that team is #social". Expect: **no dialog**, and *Remembered: team =
      #social*.
- [ ] **H3** With sound on, run `npx vite-node scripts/m30-say-refusal.ts --remember-change` and
      listen to the overwrite dialog as the app says it: *"Change what I remember for team from
      hash social to social?"* "Hash" must be audible, and the sentence clear. It runs no app, no
      model and no memory.
- [ ] **H4** *(Optional; may not reproduce: 0 of 24 scripted tries planned the overwrite.)* Ask
      "create a linear issue and post in fun" with some text copied, and press **Cancel** at the
      first dialog. Then, within a minute, say "actually, post it in social instead".
      - **If the model plans a `remember` that would change the team:** a dialog *Change what I
        remember for "team" from #social to …?* appears. Press **Cancel**. "What do you remember
        about the team" must still say `#social`.
      - **If it plans a send instead:** note what the preview or dialog showed, and press
        **Cancel**.
      - **If the result says "Remembered: …"** with no dialog, it saved a new fact, as in 5 of 27
        scripted tries. Note its name (for example `channel`). It does not change the team. Since
        "forget" is not built, it can only be removed by hand.
      - Either way, the terminal's `[main]` line and the action log's last row say which tool ran.

## Script-verified (live model, faked connectors)

**2026-10-30.** Not a tick. The real planner through the real call site (`createRunInstruction`),
real planning calls (gpt-5-mini, low effort, through `tests/eval/realModel.ts`'s spend gate), a
fresh action log per trial. The harness is committed this time: `scripts/m33-live.ts`. Everything
that could reach a real service was faked:
- **Linear:** `SdkMcpConnection` over `FakeMcpServer`'s in-memory transport, with a dummy key.
- **GitHub:** `UnavailableConnection`, which rejects every call.
- **Slack:** a bot-mode `FakeSender`, with a `FakeChannelDirectory` listing help, social, fun and
  general.
- **Memory:** a real `SqliteMemory(":memory:")` that keeps its writes, seeded with `team` = #social,
  `social channel` = #social, `third channel` = #fun and a placeholder name, and read back after
  every trial.
- **Previous turn:** for the correction cases, a cancelled "create a linear issue and post in fun",
  40 seconds old.
- **Context:** M28's long trace on the clipboard (1,130 characters), no email open.
- **Network:** `fetch` limited to api.openai.com.
- **Answers:** Cancel at every dialog. The model's `complete` half (the Slack formatter) is a
  fixed fake, so only planning calls are real.

Before any model call, the fakes were checked with scripted answers and no model. All five checks
passed:
- a Linear create reached the fake server only, and Cancel filed nothing;
- GitHub was rejected;
- a bot-mode send reached the fake directory and the fake sender, and Cancel sent nothing;
- memory kept a write;
- a request to slack.com was refused.

**T1: recon, before the confirm** (12 calls). "actually, post it in social instead", with
`team` = #social stored:

| Planned | Trials |
|---|---|
| **`remember` replacing a different value (the hazard)** | **0** |
| `remember` writing a new fact: `channel:fun` = social | 2 |
| lone `sendMessage` to "social", dialog, cancelled | 9 |
| plan: `linear__search_issues` > `sendMessage`, dialog, cancelled | 1 |
| `team` read back as #social (v1) | 12 of 12 |

**After the confirm** (30 calls):

| Setup | Trials | What was planned | Ended | Facts afterwards |
|---|---|---|---|---|
| T2: the T1 setup again | 12 | 10 lone sends to social; 1 create > send; 1 `remember channel = social` (new) | 11 at a send/create dialog, cancelled; 1 saved with no dialog | `team` = #social (v1) 12 of 12 |
| T3: the same, `team` not stored | 3 | 1 `remember channel`; 1 lone send; 1 plan `remember channel` > send | #1 saved; #2 send cancelled; #3 saved, then its send cancelled | `channel` = #social added (no dialog: a first write) |
| C1: "remember that team is #social", `team` empty | 3 | `remember team = #social` ×3 | saved, no dialog | `team` = #social (v1) |
| C2: the same, #social already stored | 3 | `remember team = #social` ×3 | no dialog | `team` = #social (v1) |
| C3: "my name is Sam Placeholder", no name stored | 3 | `remember name` ×3 | saved, no dialog | name (v1) |
| C4: "remember the team is #fun", `team` = #social | 3 | `remember team = #fun` ×3 | the dialog ×3, cancelled | `team` = #social (v1) |
| C5: "no, I meant the design channel" after a cancelled send to the team | 3 | send to "the design channel"; send to "design channel"; **`remember team = "the design channel"`** | 2 refused (unknown channel); **1 dialog, cancelled** | `team` = #social (v1) |

C5's third trial is the hazard seen against the real model. The dialog read *Change what I
remember for "team" from #social to the design channel?*, and Cancel kept #social. No trial
filed an issue, sent a message, reached a blocked host or changed a seeded fact.

**Dry run, scripted (no model):** `npx vite-node scripts/m33-live.ts --scripted`, which scripts
`remember team = social` with #social stored.
- **Dialog:** *Change what I remember for "team" from #social to social?*, with the button
  **Change it**.
- **Cancel:** no result. The log row is `remember` with `{"subject":"team","value":"social"}`,
  status `cancelled`. `team` = #social, v1, active.
- **Approve:** *Updated "team": #social → social (v2).* v1 is inactive and v2 is active.

**Total: 42 real planning calls of the 45 allowed, est. ~$0.056.**

## Machine-verified, not watched

- **The rule** (`tests/remember.overwrite.test.ts`):
  - an empty store, the same value and a different value;
  - a weaker form (#social → social) asks;
  - the subject matches exactly, not by LIKE;
  - Cancel leaves the facts table unchanged (rows read back), and Approve writes v2 with v1
    inactive;
  - in bot mode the dialog shows Slack's settled name, and Slack is asked once, in `prepare`;
  - a failed memory read escalates to a dialog;
  - a chain's step prefix, and a detached job waiting at the pill;
  - the 200-character cap, and the spoken form.
- **The phrasing set:** 4 corrections and 4 real remembers, each in two memory states. A dialog
  appears in exactly the 8 cases with a different value stored.
- **The replay** (`tests/fixtures/rememberCalls/replay.ts`, 22 calls): the 12 real `remember` rows,
  with the memory as it stood before each, M32's row and 9 scripted eval answers.
  - A dialog on exactly rows 323, 389 and 435, M32's row and the six flagship/eval corrections.
  - Cancelled, each of those leaves the facts unchanged; approved, it reproduces the recorded
    result.
  - The other 12 reproduce their recorded result with no dialog.
- **Row 475's refusal**, from `prepare`: the same text, `refused`, nothing written, no dialog
  (`tests/remember.bot.test.ts`).
- **Mutations:** eight, each caught the first time (`spec.md` §9, M33):
  - the resolver always reversible (34);
  - a LIKE match (1);
  - comparing the typed value (4);
  - the dialog showing the typed value (3);
  - the handler re-asking Slack (1);
  - Cancel still writing (24);
  - the same value counted as a change (2);
  - the cap removed (1).
- **The dialog as spoken** (follow-up, `31aa8d0`), through the planner, heard and written.
  - The value pairs: #social → social is heard "from hash social to social"; social → #social;
    #social → #fun; and values with no "#".
  - Only a leading "#" is said, and only after the 200-character cut. The unread and nothing
    forms, and the chain prefix, are spoken too.
  - The written dialog is unchanged, and `remember` is the only tool with a spoken variant.
  - A bot-mode send, a webhook send and a Linear create are still spoken as before.
  - Two more mutations: the spoken form unchanged (caught by 4); "hash" in the written dialog
    too (caught by 22).
- **3459 tests passed across 144 files, 96 skipped; both typechecks clean.**
