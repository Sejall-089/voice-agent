# CLAUDE.md — working rules for this repo

Read `spec.md` and `ARCHITECTURE.md` before writing code. `spec.md` is the source of
truth for scope, stack, and decisions.

## How to work here
- **Use Plan Mode for anything structural** (new module, interface change, data model
  edit). Propose the plan, wait for approval, then implement.
- **Build milestone by milestone** (M0 → M6 in spec.md §9). Do not jump ahead. Each
  milestone must run and be committable before starting the next.
- **Respect the scope guardrails** (spec.md §2). If a task seems to need anything in
  the OUT-of-scope list (voice, computer-use, extra connectors, Mac/Linux, multi-step
  loops), stop and ask — don't scaffold it "just in case".
- **MockShell first.** Build and test the core against `MockShell` before wiring the
  real `WindowsShell`. `/core` must never import `electron`.

## Non-negotiables
- TypeScript strict; no `any` in `/core`.
- The LLM proposes, the planner disposes: registry check + validation + confirm gate
  are deterministic and must never be bypassed.
- Irreversible tools (`sendMessage`) always pass through `shell.confirm()`.
- Secrets only from `.env`; never log the API key or webhook URL.
- Unregistered requests → graceful refusal + `logMiss()`. Never invent a tool.

## Testing discipline (learned the expensive way, M10-M14)

Every milestone from M10 on has produced at least one live bug no fixture caught. These are the
patterns behind them — each cost a real debugging session.

- **"Only a live run can prove it" excuses request SHAPING, not error CLASSIFICATION.**
  `GoogleCalendar.ts` shipped untested on that argument, and both bugs the first live run found
  were in the half that was ordinary branching — the half deciding what a person gets *told* when
  something breaks. Split the file's testable logic from its transport and test the logic.
- **A fake must never be more lenient than the real thing.** `FakeCalendar` matched substrings
  where Google ANDs its terms, so the bug it existed to catch was invisible under it. Write the
  fake's rules INDEPENDENTLY of the code under test — checking a transform with the transform
  only proves it agrees with itself. (M14's did this and caught a real bug before any live run.)
- **The tests run under node; the app runs under electron. Their ICU differs.** node formats
  `Wed 26 Aug`, electron formats `Wed, 26 Aug`. A rule anchored on the node shape silently did
  nothing in the app while every test passed. Never let a test ask the runtime to produce its own
  input — use literal strings covering every form the app might actually see.
- **Anything living in `main.ts` has no test that could fail**, because importing it boots
  electron. Extract handlers (`instructionHotkey.ts`, `dictate.ts`, `runInstruction.ts`) — a
  guard that was designed, approved and then never built shipped missing precisely because it
  lived where nothing could check for it.
- **An operation reporting success is not proof it did anything.** Notion saved nothing and said
  it worked; a synthesizer can exit 0 and produce an empty file. Verify by reading back.
- **Recon before fixtures.** Interrogate the real thing — DOM, API, binary — and transcribe what
  it does. `scripts/notion-recon.mjs` and `scripts/tts-recon.mjs` exist because a fixture written
  from an assumption passes every test and matches nothing.
- **A fake's FAILURE shape drifts out of sync with the real one, silently.** A test that
  exercises an error path can pass forever while validating the fake rather than the system.
  M16.7's chooser-failure test threw a bare `Error` because the fake did — but the real
  `ModelElementChooser` classifies a network failure into a `ChooserError` first, so the test was
  asserting on something the running app can never produce. Nothing failed; it was caught only by
  going and reading what the real implementation throws. Happy-path fakes get corrected the first
  time someone runs the app; failure-path fakes are rarely exercised for real, so they rot
  quietly. **Whenever a fake raises an error, check it raises the same TYPE the real
  implementation would** — and re-check at the step where the real thing first runs.
- **A fake that is synchronous where the real thing is async cannot test ordering — only
  call-sequence, a different and weaker property.** M16.9's snapshot-before-focus test used a
  fake `snapshotPointTarget()` that recorded its call and returned instantly. That proved the
  call happened before `showInput()`, which was true and worthless: the real implementation
  reads a window handle over an async PowerShell round trip, so what mattered was whether the
  *read* landed before focus moved, not whether the *call* did. `showInput()` ran synchronously
  in the same tick, the read always resolved after, and the shipped app answered every question
  about its own command bar — a bug the test was green through the whole time. Found only by a
  human at the keyboard (M16.11). **When the real implementation of something a test fakes is
  async, the fake must be too**, with its own artificial delay, or an ordering test against it
  proves nothing about ordering.
- **A log line proves what the app decided, not what the user saw.** M16.11's second live bug (a
  marker showing the *previous* answer, not the current one) was invisible to every check that
  read `[main]`-style outcome logs — the planner had computed the right answer every time; only
  the render was stale. Any code path ending in something drawn, played, or otherwise rendered
  needs a check that inspects the rendered thing itself (the live DOM, a screenshot, a person's
  eyes), not a log of the decision that produced it.
- **When a RULE changes, re-justify its existing tests — do not just re-run them.** A test can
  keep passing after a rule changes for a reason that has nothing to do with the new rule being
  correct. M16.5 narrowed the ambiguity gate from "any shared name refuses" to "refuse only when
  two entries are identical in every field the model saw". The four-`Filter dropdown` test stayed
  green throughout — but it asserted only *that four exist and one refuses*, never that they were
  identical on type and position, so it could not distinguish "the new rule fired" from "the old
  rule would have fired anyway". Its title still described the deleted rule. Ask what a test
  actually **distinguishes**, not whether it is green; a test that cannot fail under the wrong
  implementation is not testing that implementation. The fix is usually to assert the new rule's
  *precondition* alongside its outcome, and to add a case that the old rule would have failed.

- **A remote tool's NAME is not its capability (M19).** Linear's docs list no tools; the
  third-party directories that do said `create_issue`. The live server has `save_issue`, which
  creates when `id` is absent and *edits any issue* when it is present. An allowlist written
  from those directories would have shipped "edit anything" under the name "create", and every
  test would have passed against a fake built from the same wrong list. Two rules came out of it:
  **ask the real server what it offers before pinning anything** (`scripts/linear-recon.mjs`),
  and **define what a connector tool can do by a closed argument schema, never by which remote
  tool it calls** — then have the fake implement the dangerous half on purpose, so "it cannot
  reach it" is a test that could fail rather than an assumption.
- **A mutation that survives is a test that does not exist yet.** M19's adapter tests were
  green on the first run, which proves nothing. Breaking seven rules one at a time found that
  six were pinned and one — "code-fixed arguments beat the model's" — was not: Linear's schemas
  reject the key before the merge is reached, so no test with the real definition could tell
  which side won. It needed a definition written to *allow* the key. When a suite passes first
  time, break the code and check the suite notices. And do the breaking with the Edit tool — two "surviving" mutations in
  M19 were `sed`/heredoc edits that silently matched nothing, which is the same failure one
  level up: a check that reported nothing wrong because it never ran.
- **Recon the failure shapes, not just the happy path.** Linear reports every failure as a
  normal result with `isError: true` and throws nothing; a rejected key is the one thing that
  does throw, as a different type, at a different moment. A wrapper written from the happy-path
  capture alone would have reported a failed create as done.

- **A property that holds by SIDE EFFECT holds only on the path that produces the side effect
  (M19).** The confirm dialog was never covered by the always-on-top bar for fourteen
  milestones — not because anything arranged that, but because the dialog took focus, the bar
  blurred, and the blur handler hid it. A chain's step result re-shows the bar *unfocused*, an
  unfocused window never blurs, and step 3's dialog opened underneath it with both buttons
  hidden. Nothing was changed to break it; a new path simply did not pass through the accident.
  When something that must always be true (the gate is readable and clickable) turns out to be
  true only because of an unrelated handler, make it true ON PURPOSE at the one place it matters
  — and remember the test for it can only assert the decision. Which window is in front is done
  by the OS with real windows: measure it (`scripts/confirm-zorder-recon.cjs`) and have a person
  look.

- **Fixing a refusal can remove the only thing standing in front of a worse bug (M19).** A live
  run was refused for naming `functions.linear__create_issue`. The obvious fix — forgive the
  prefix — was correct, and shipping it alone would have been a regression: re-running the case
  showed the plan under the prefix skipped `readEmail` and filed the *clipboard* as the bug
  (0 of 3). The refusal was accidentally the gate. Before loosening any check, reproduce the
  whole failing case and look at what the now-accepted input goes on to DO.
- **An eval must see what the app sees, and one trial is an anecdote.** The first plan eval gave
  the model a Gmail window title the app never sends, and passed; the live-failing phrase then
  passed its first single trial having failed twice live. What moved the result was a variable
  nobody had recorded — what was on the clipboard. Build the eval's context from the app's own
  context code path, run each case several times, and when a live failure will not reproduce,
  ask what the live run had that the eval does not.

### M21 — seven more, each from a live finding

- **A confirm dialog must describe what will actually happen, and show the exact text that will
  be sent (M21).** `sendMessage`'s dialog previewed the model's raw `notes` — or showed no body
  at all — and the formatter ran *after* Send was pressed. Slack received the formatter's own
  "Please paste the rough notes you want formatted for the #bugs channel.", twice. The same
  dialog named the channel that was asked for while a webhook posted somewhere else. Both were
  approvals of a description rather than of the act. **Settle the act before the dialog
  (`Tool.prepare`), show all of it, and have the handler do exactly that and nothing more** —
  no model call, no reformatting, no second lookup between an approval and the thing approved.
  If something cannot be shown truthfully (where a webhook posts), say what is known and no more.
- **A live failure can have a different cause than the one suspected — find the root cause
  before editing (M21).** "I pressed the hotkey during a question and the question vanished"
  pointed straight at the hotkey guard, and the guard was fine: what was on screen was the
  model's own prose, produced because the previous run's refusal had been fed to the next
  planning call. An hour of "fixing" the guard would have changed working code and left the bug.
  What found it was refusing to edit until the failure was reproduced: read the code path, read
  the action log (a `no_tool` row where a chain was expected), then reproduce on a real window.
  **When a report names a cause, treat the cause as a hypothesis and the symptom as the fact.**
- **Fakes and unit tests do not see real-window behaviour — keep `scripts/ask-recon` and run it
  (M21).** The hotkey guard had a unit test over the real shell with a fake window, and it was
  green. Whether a real `BrowserWindow`, the real renderer and a key press arriving through the
  OS behave the same is exactly what that test cannot say; `hotkey-during-question` could, and
  cleared the guard. `dismissed-then-again` then reproduced the real bug, and `result-links`
  showed a real click reaching main and `window.open` going nowhere. Same for the dev server:
  only `scripts/vite-fs-probe.mjs` could say whether a renderer import from `src/core` would be
  served. **For anything that ends in a window, a key press or a browser, a script against the
  real thing is part of the test, not an extra.** They send keystrokes and flash windows; each
  header says so. One of them also picked up the real clipboard on its first run and the bug
  vanished — hold fixed whatever a recon is not measuring.
- **`.env` treats an unquoted `#` as a comment (M21).** `SLACK_WEBHOOK_CHANNEL=#social` parses
  to the empty string. Nothing failed; the setting silently did nothing — and it was written
  that way on this repo's own advice. Any value that can start with `#` (a channel, a colour, a
  fragment) must be documented **with quotes**, and a variable that is present but blank
  deserves a startup warning, because "unset" and "set to nothing by accident" look identical
  from inside the app. Check a config example with the real parser before publishing it.
- **A failure message must say which phase failed — "it may have gone through" is only true
  after a send (M21).** A first GitHub connection timed out while *connecting*, before any
  dialog, and the user was told the create "may or may not have gone through". A connect timeout
  and a call timeout are the identical error object, so the wording cannot be derived from the
  error: **the code that catches it must say where it was caught** (`classifyMcpFailure`'s
  required `phase`). The general form: a warning about a side effect belongs only on the path
  where the side effect could have happened. Everywhere before that, say "nothing was sent".
- **A model's prose reply can look exactly like an app prompt — never rely on looks (M21).** The
  model's "What is 'the bugs channel'? Tell me…" was displayed as an ordinary result and read,
  to a person, as a question waiting for an answer. Nothing was waiting: no state, no guard, no
  place for the answer to go. A real question is a *state the app is in* (`isAskPending()`), set
  before it is drawn and read by both hotkeys. **If the app needs something from the user, it
  must ask through a mechanism it can hold itself to — and anything a model writes should be
  assumed capable of imitating one.** The same reasoning is why a confirm button's label is a
  fixed string in a tool's code and never text a model, an email or a server wrote.
- **Break a rule on purpose to prove a test can fail — especially a test that passed the first
  time it ran (M21).** Several M21 suites were written before the code and still went green on
  their first run, because the code was written before they were *run*. "Tests first" that was
  never seen red is not evidence. Each time, the rule was broken with the Edit tool and the
  suite re-run: a handler that re-formats (18 tests noticed), a classifier that treats a connect
  timeout as a call (8), a hostname matched loosely (10), a label taken from an argument (5). It
  also found what first-run green hides: the formatter eval showed a `NO_NOTES` instruction
  refusing a genuine one-line note, 0 of 2 — a fault no fixture could have. **If a test has
  never failed, make it fail once before trusting it, and record which mutation it caught.**

## Scope added mid-milestone

If something is added to a milestone's plan AFTER its build order is written, **fold it into the
build order**. M14's confirm-gate guard was designed, explicitly approved, and never built — the
build order was what got executed from, and the addendum had no route into the work. It shipped
missing and a live test found it.

## When you finish a milestone
- Run the test suite against MockShell.
- Update `spec.md` if any decision changed.
- Summarize what changed and what the next milestone needs.
