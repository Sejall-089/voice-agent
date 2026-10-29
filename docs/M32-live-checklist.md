# M32 — live verification checklist

> **RUN 2026-10-29/30, by a person (H1-H6).** `spec.md` §9 (M32): a second instruction-hotkey press during voice
> capture is ignored; a previous turn over ten minutes old is not sent to the model, and a reply in
> the model's own words is framed ("Nothing ran. The model said: …"); "what's the date and time"
> gets one combined answer; Escape with the pill list open is unchanged and now tested. 6 ticked,
> 0 open.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person saw, heard or did it.
> - `[ ]` **Not yet watched**, including everything that only a test or a script has shown.
>
> **Nothing here files an issue or posts a message.** If a try reaches a Linear or Slack dialog,
> press **Cancel**.

Run `npm run dev` (clear `ELECTRON_RUN_AS_NODE` first). Restart it after pulling: the main process
is built once at startup. To hear the new wording without the app:
`npx vite-node scripts/m30-say-refusal.ts --framed-prose` and `… --date-time` (both play audio;
`--no-play` only writes the WAV).

## Human-only

- [x] **H1** *(Passed, Sejal, 2026-10-29.)* Press the instruction hotkey and start speaking. While the microphone is still
      recording, press the hotkey again; then press Enter, and while it is transcribing press the
      hotkey once more. Expect: no job is detached (the pill does not gain a job), nothing
      half-said runs, and the first capture finishes normally and runs once. The terminal shows
      `[main] instruction hotkey ignored - voice is recording` (and `… transcribing`).
- [x] **H2** *(Passed, Sejal, 2026-10-29: the framed wording heard through Piper.)* Hear a framed prose reply, and judge whether "Nothing ran. The model said:" reads and
      sounds natural. Provoke one if you can (an instruction the model is likely to answer with a
      question); if none comes, skip this box and say so. The terminal's `[main]` line should
      show `[reply: model prose]`. Without the app:
      `npx vite-node scripts/m30-say-refusal.ts --framed-prose`.
- [x] **H3** *(Passed, Sejal, 2026-10-29: heard one combined answer.)* Ask "what's the date and time" and hear one short combined answer ("It's Friday, 23
      October, 5:41 PM."). Also: `npx vite-node scripts/m30-say-refusal.ts --date-time`.
- [x] **H4** *(Passed, Sejal, 2026-10-29: with the list open and another app in front (Win+R),
      Escape reached that app and the list stayed open. Her decision: that is the behaviour she
      wants, so Escape does NOT close the list; no change needed.)* Open the pill's job list, then with another app in front (Notepad, say) press Escape.
      Expect: Escape reaches that app, and the list stays open. **Decision for Sejal:** should
      Escape close the list instead?
- [x] **H5** *(Passed, Sejal, 2026-10-29: text landed at the caret. One Ctrl+Z removed the
      dictated sentence together with the 3-4 blank lines typed just before it; a sentence typed
      by hand after 3-4 Enters undid the same way, so this is Word's own typing-run grouping, not
      the app.)* Dictate into Word. Expect: the text lands at the caret and nowhere else; the Enter
      that finishes dictation adds no paragraph; no autocorrect surprises (capitals, smart
      quotes); no repeated letters on a long sentence. Note how many Ctrl+Z presses undo one
      dictation. Switching windows mid-dictation gives the focus refusal, not text in the wrong
      place.
- [x] **H6** *(Passed, Sejal, 2026-10-30: reported "h6 passes", no further detail.)* Dictate into Windows Terminal and into classic PowerShell. Expect: the text appears
      at the prompt and **nothing executes on its own** (no Enter or newline reaches the shell);
      quotes, `$` and other special characters arrive as typed; an elevated (administrator)
      terminal gives a clear error with no partial text.

## Script-verified (live model, faked connectors)

**2026-10-23.** Not a tick. The real planner through the real call site (`createRunInstruction`),
real planning calls (gpt-5-mini, low effort, through `tests/eval/realModel.ts`'s spend gate), a
fresh action log per trial. Everything that could reach a real service was faked:
- **Linear:** `SdkMcpConnection` over `FakeMcpServer`'s in-memory transport, with a dummy key.
- **GitHub:** `UnavailableConnection`.
- **Slack:** `FakeSender`.
- **Memory:** in memory, holding "third channel" = "#fun".
- **Network:** `fetch` allowed only to `api.openai.com`; nothing was blocked.

Every dialog was answered Cancel. The harness is a scratch script, not committed.

**Row 667's setup**: a "rewrite this politely" turn 152 minutes old whose result asks to send
Claude Code a close-out prompt (neutral wording), that sentence on the clipboard, and "create a
linear issue and post in fun".

| When | Trials | Prose | Ran to the dialog, cancelled | M30/M31 refusal | Previous turn sent |
|---|---|---|---|---|---|
| Before the change | 6 | **0** | 6 (create > send) | 0 | 6 of 6 |
| After the change | 6 | 0 | 5 (create > send) | 1 (M30) | 0 of 6 |

The prose reply did **not** reproduce before the change; the two live cases (rows 647, 667) are
the evidence for it.

**Corrections inside the window, after the change** (a cancelled create 40 s earlier, one call
each):

| Follow-up | Planned | Ended | Previous turn sent |
|---|---|---|---|
| "no, make it a bug report" | lone create | dialog, cancelled | yes |
| "actually, post it in social instead" | `remember` team = social | **ran** (no dialog; finding) | yes |
| "no, I meant the social channel" | `sendMessage` to "the social channel" | refused by its reference check (harness memory lacks #social) | yes |
| "no, title it migration fails on orders" | lone create | dialog, cancelled | yes |
| "actually send it to help" | `sendMessage` | dialog, cancelled | yes |
| "no, make the title shorter" | lone create | dialog, cancelled | yes |

**The date and time** (nothing copied, no email):

| Phrase | Before | After |
|---|---|---|
| "what's the time" | `time` (1/1) | `time` (1/1) |
| "what's the date" | `date` (1/1) | `date` (1/1) |
| "what's the date and time" | `time` only (1/1) | `both` (2/2) |
| "what day and time is it" | two steps, only the time shown (1/1) | `both` (2/2) |
| "remind me at 3 pm tomorrow" (control) | `createEvent` (2/2) | `createEvent` (3/3) |

**Total: 33 real planning calls, est. ~$0.032.**

## Machine-verified, not watched

- The second-press guard in every busy state, with an async fake voice and with the real
  `VoiceSession` and a slow transcriber; idle still starts over (`tests/instructionHotkey.test.ts`).
- The ten-minute cutoff at, and one second past, the edge; corrections and "send it" inside it;
  the framed prose on the bar, in speech (the lead whole under the cap) and on the `[main]` line;
  the fixed refusal unframed; M30 and M31 refusals untouched (`tests/previousTurnAndProse.test.ts`).
- `formatTimeAnswer("both")` in two zones and from hostile ICU parts; the schema; the planner
  (`tests/tellTime.test.ts`).
- With the bar hidden the app holds no Escape; Escape on the attached job leaves an open list open;
  the dictation hotkey still collapses it (`tests/WindowsShell.capture.test.ts`,
  `tests/pill.collapse.test.ts`).
- Mutations, all caught (`spec.md` §9, M32).
