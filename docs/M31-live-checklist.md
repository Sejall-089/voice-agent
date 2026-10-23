# M31 — live verification checklist

> **RUN 2026-10-23, by a person (H1, H2).** `spec.md` §9 (M31): a plan or lone call that creates
> a Linear or GitHub issue with no send step is refused when the instruction asked for a send to a
> channel the app knows (`checkDroppedSends`, `spec.md` §5b, "A send the instruction asked for,
> missing from the answer"). 2 ticked, 0 open.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw or heard it.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here files an issue or posts a message.** H2 reaches a Linear confirm dialog at most:
> press **Cancel** there. If you press Create by mistake, the issue lands in the `defaultTeam` from
> `connectors.json`; delete it in Linear.

## Human-only

- [x] **H1** *(Heard by Sejal 2026-10-23: natural, no slash.)* Listen to the refusal through the real speech engine:
      `npx vite-node scripts/m30-say-refusal.ts --dropped-send` (it plays audio; `--no-play` only
      writes the WAV). It should say, whole: "You asked me to send it too, but my plan had no send
      step, so nothing was filed. Ask again, or file it and send it as two requests." There is no
      slash in it; confirm it sounds natural, and write down anything that does not.
- [x] **H2** In the real app (`npm run dev`; clear `ELECTRON_RUN_AS_NODE` first), with any text
      copied and no email open, say or type **"create a linear issue and send to fun"**.
      Normally: a preview listing "Create a Linear issue" then "Post a message to Slack"; press
      **Cancel** at the Linear dialog; nothing is filed and nothing is posted. **If it is refused
      instead**, write down what the bar showed and the terminal's `[main] refused …, as sent:`
      line (a lone create is this check; a summarize step first is M30's).
      *(Seen by Sejal 2026-10-23: 'create a linear issue and send to fun' with text copied showed
      Step 1 of 2 (create, then send); cancelled, nothing filed in Linear. Separate earlier try,
      'create a linear issue and post in fun': the model replied in prose asking for a 'close-out
      prompt' text and which channel 'Claude Code' is (it read the chat page on screen as
      context); no tool ran, nothing filed. Recorded as a finding for the small-items milestone,
      not an M31 failure.)*

## Script-verified (live model, faked connectors)

**2026-10-23.** Not a tick. The real planner through the real call site (`createRunInstruction`),
real planning calls (gpt-5-mini, low effort, through `tests/eval/realModel.ts`'s spend gate),
M28's long clipboard (`tests/fixtures/planChoice/clipboards.ts`), no email open. Everything that
could reach a real service was faked:
- **Linear:** `SdkMcpConnection` over `FakeMcpServer`'s in-memory transport, with a dummy key.
- **GitHub:** `UnavailableConnection`, which rejects every call.
- **Slack:** `FakeSender`.
- **Action log:** `InMemoryActionLog`; memory an in-memory copy holding "third channel" = "#fun".
- **Network:** `fetch` wrapped to allow only `api.openai.com`; nothing was blocked.

Every dialog was answered Cancel. The summarize step's own text (`llm.complete`) was a fixed fake.
The harness is a scratch script, not committed.

**Recon, before the check was built** (12 calls), "create a linear issue and send to fun":

| Log | Trials | Dropped the send | Kind of every drop |
|---|---|---|---|
| fresh per trial | 6 | 3 | lone tool call (3 of 3) |
| shared across trials | 6 | 0 | — |

**With the check built in** (24 calls), fresh log per trial:

| Instruction | Trials | Refused by M31 | Ran: create > send, cancelled | Other | Creates / sends at the fakes |
|---|---|---|---|---|---|
| "create a linear issue and send to fun" | 12 | 3 (lone tool calls) | 6 | 3: summarize > create > send, refused by M30 | 0 / 0 |
| "create a linear issue and post in fun" | 6 | 1 (lone tool call) | 3 | 2: summarize > create > send, refused by M30 | 0 / 0 |
| "create a linear issue" (control) | 6 | 0 | — (6 lone creates to the dialog, cancelled) | 0 | 0 / 0 |

- **The five "other" trials** fall outside the two endings the plan allowed. Each was M30's check
  refusing an unasked summarize step with its exact wording, before any preview or dialog, with
  nothing at the fakes. That is the first time M30's refusal was seen against a real model plan;
  it does not tick any M30 box.
- **Dry run, scripted (no model):** a lone create and a one-step plan for "create a linear issue
  and send to fun" were both refused with the exact wording, no preview, no dialog, nothing filed.
- **Total:** 36 real planning calls, est. ~$0.058.

## Machine-verified, not watched

- The rule against every drop on record and every kept send, no model calls: 5 drops refused
  (`tests/fixtures/sendDropped/drops.ts`); none of the 77 recorded answers refused; of M28's eval,
  only the "create only" trial refused and the 32 asking-and-kept not (`tests/droppedSends.test.ts`).
- The phrasing set: 7 of 7 asking phrasings ask (including "ping the team", which resolves through
  "team"); 7 of 7 content phrasings do not.
- Refused on the lone-call path and the plan path, after the multi-call retry, and for a detached
  job; one `refused` row with the tool names, no miss, kept out of the next previous turn; the
  clipboard never judged; `sendReply` never the send; a real Linear create over a fake MCP server
  sends nothing (`tests/planner.droppedSends.test.ts`).
- Six mutations, all caught (`spec.md` §9, M31).
