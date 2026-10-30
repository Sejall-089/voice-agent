# M34 — live verification checklist

> **RUN 2026-10-30, by a person (H1-H3). 3 ticked, 0 open.** A ticked box means **a person at the
> keyboard saw or heard it** — no test, eval or script earns a tick here. An open box means *not
> seen by a person*, not *failing*.
>
> M34 stops junk FIRST writes to memory and records whether an instruction was typed or spoken.
> `spec.md` §5b ("A first write nobody named") and §9 (M34) have the design and the known limits.
> - **Rule B:** a first write is refused unless every word of its subject is a word of the
>   instruction (one leading `target:` set aside; `name` and `tone` exempt): *I did not save that.
>   Say what to remember and what it is called, for example "remember the team is #social".*
> - **Rule D:** any write whose value has a line break or is over 500 characters is refused: *That
>   is too long to remember as a fact. Nothing was saved.*
> - **The marker:** each job's record says `typed` or `spoken` (`jobs.input`); action-log rows
>   join to it by `job_id`. The planner is never told.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw, heard or did it.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here writes anything new to your real memory, files an issue or posts a message.**
> H2 repeats the value memory already holds (a refresh: no new version, but the fact's "updated"
> time and confidence are refreshed, as in M33's H2). H3 is either a no-op or a dialog you
> **Cancel**. H1 runs no app and no memory.

Run `npm run dev` (clear `ELECTRON_RUN_AS_NODE` first). Restart it after pulling: the main process
is built once at startup, and the `jobs.input` column is added on that start. Before H2, check
what the app holds: "what do you remember about the team" should say `#social`.

## Human-only

- [x] **H1** *(Passed, Sejal, 2026-10-30. She ran `--first-write-refusal` with sound on and
      reported "all three passed", with no further detail.)* Hear rule B's refusal as the app
      says it. Run, with sound on:

      npx vite-node scripts/m30-say-refusal.ts --first-write-refusal

      Expect: *"I did not save that. Say what to remember and what it is called, for example
      remember the team is social."* (The speech cleaner drops the quotes and the "#", as it does
      for every tool.) It must be clear and natural. It runs no app, no model and no memory.
      *(Script-verified only: run with `--no-play` on 2026-10-30, it printed that sentence and
      Piper wrote a 299,564-byte WAV. Not heard at that point.)*
- [x] **H2** *(Passed, Sejal, 2026-10-30. She typed "remember the team is #social" with `#social`
      stored and reported "all three passed", with no further detail.)* **Type** "remember the
      team is #social" into the bar, with `#social` stored.
      **Expect:** *Remembered: team = #social*, no dialog (the same-value refresh). Say which input
      you used (typed, keyboard). If the bar shows anything else, note it, and what the terminal's
      `[main]` line says.
- [x] **H3** *(Passed, Sejal, 2026-10-30. She said "remember the team is hash social" by voice and
      reported "all three passed", with no further detail; what the bar's Heard: line showed was
      not recorded.)* **Say aloud** "remember the team is hash social" (press the hotkey, speak, press
      Enter). Note exactly what the bar's *Heard:* line showed. **Expect** one of:
      - *Already remembered "team" as #social.* or *Remembered: team = #social* — no dialog (the
        transcript said "social" or "#social");
      - a dialog *Change what I remember for "team" from #social to hash social?* (the transcript
        said "hash social") — press **Cancel**.
      Then "what do you remember about the team" must still say `#social` (`v1`).

**At close-out, Claude Code reads a READ-ONLY copy** of `%APPDATA%\voice-agent\memory.db` and
reports, for the rows H2 and H3 wrote: the instruction text, whether its "#" survived, and the
job's `input` (`SELECT a.id, a.instruction, j.input FROM action_log a JOIN jobs j ON j.id =
a.job_id ORDER BY a.id DESC LIMIT 5`). Expected: H2's row `typed` with its "#"; H3's row `spoken`.
This is the first evidence for M33's finding 1 (a "#" missing from rows 672 and 674).

## Script-verified (no tick)

**2026-10-30.** None of this was watched by a person.

**Tests** (`npm test`, against `MockShell`, no model): **3549 passed, 96 skipped**; both typechecks
clean. New: `tests/instructionInput.test.ts` (the marker, E3), `tests/remember.firstWrite.test.ts`
(rule B), `tests/remember.longValue.test.ts` (rule D), two cases in `CommandBar.test.tsx` (E2), and
the extended replay in `tests/remember.overwrite.test.ts`.

**Replay** (`tests/fixtures/rememberCalls/replay.ts`, 34 calls: 17 action-log rows, M32's row, 7
from M33's harness, 9 scripted evals). Every first write on record:

| First write | Calls | Rule B |
|---|---|---|
| Junk: `channel:fun` = social (M33 T1) | 2 | refused, nothing written |
| Junk: `channel` = #social (M33 T2, T3 ×2) | 3 | refused, nothing written |
| Genuine: rows 14, 21, 81, 350, 354, 388, 475, 591; M33 C1, C3; demoTasks #4; story step 2; remember.test's new fact | 13 | all pass (row 475 is then refused by Slack, as recorded) |

Every other replay call reproduces its recorded result; the dialog appears on exactly the same
10 calls as at M33.

**Mutations** (each made and undone with the Edit tool):

| Rule | Mutation | Caught by |
|---|---|---|
| Typed/spoken is recorded | the two swapped | 4 |
| The marker reaches the database | written as NULL | 2 |
| B refuses junk first writes | B removed | 18 |
| B never judges a replacement | B applied to overwrites | 15 |
| Only the instruction's words count | the previous turn's words counted | 2 |
| B comes before Slack | B moved after the Slack lookup | 2 |
| Plurals match | plural tolerance removed | 2 |
| A first write is judged by its exact subject | judged with `resolve` | 1 |
| `name` and `tone` are exempt | exemption removed | 3 |
| D refuses a line break | newline rule removed | 3 |
| D's cap is 500 | `>=` for `>` (500 refused) | 1 |

**Dry run, no model** (`npx vite-node scripts/m33-live.ts --first-writes`), after the five fake
checks passed:
- `channel:fun` = social and `channel` = #social under "actually, post it in social instead":
  refused by B, the channel directory never asked, nothing written.
- `samurai` = a 1,481-character, 25-line value under "Samurai is this.": refused by D, nothing
  written.
- `team` = #social (team empty) and `name` (name empty): saved as v1, no dialog.
- `team` = #fun against #social: the dialog *Change what I remember for "team" from #social to
  #fun?*; cancelled, #social kept at v1.

**Live model, faked connectors** (`scripts/m33-live.ts`, gpt-5-mini through the spend gate; Linear
over `FakeMcpServer`, GitHub rejected, a bot-mode `FakeSender` with a `FakeChannelDirectory`
listing help, social, fun and general; `fetch` to api.openai.com only; Cancel at every dialog; a
fresh action log per trial; a `SqliteMemory(":memory:")` that keeps its writes, seeded and read
back after every trial):

| Setup | Trials | Planned | Ended | New facts | Seeded facts |
|---|---|---|---|---|---|
| F1: "actually, post it in social instead", a cancelled create 40 s before, `team` not stored | 6 | lone `sendMessage` to social ×6 | send dialog, cancelled ×6 | none | unchanged |
| F2: the same, `team` = #social stored | 6 | lone send ×5; plan send > `remember channel = social` ×1 | send dialog, cancelled ×6 (the plan's step 2 never reached) | none | unchanged |
| C1: "remember the team is #social", team empty | 3 | `remember team = #social` ×3 | saved, no dialog | `team` = #social (v1) ×3 | unchanged |
| C2: "my name is Sam Placeholder", name empty | 3 | `remember name` ×3 | saved, no dialog | `name` (v1) ×3 | unchanged |
| C3: "remember my dashboard is https://dash.example.com" | 3 | `remember target:dashboard` ×3 | saved, no dialog | `target:dashboard` (v1) ×3 | unchanged |
| C4: "Samurai is this.", row 591's shape on the clipboard | 3 | prose question ×1; `rewrite` (tone "samurai") ×2 | no remember planned | none | unchanged |
| C5: "remember the team is #fun", #social stored | 3 | `remember team = #fun` ×3 | the dialog ×3, cancelled | none | `team` = #social (v1) |

Pass: **0 junk facts written** in the 12 correction trials; **9 of 9** control writes saved;
**3 of 3** dialogs; no seeded fact changed; nothing created, sent or blocked. **Rule B and rule D
were not reached by the live model** in these 27 trials: no correction planned a first-write
`remember` that ran (F2's one plan put it behind a cancelled send), and the samurai case never
planned `remember`. Their evidence is the replay, the dry run and the mutations. F2's plan shape
is replayed without a model, send approved: step 2 is refused and nothing is written.

**Total: 27 real planning calls of the 30 allowed, est. ~$0.027.**
