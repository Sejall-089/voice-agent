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

## Scope added mid-milestone

If something is added to a milestone's plan AFTER its build order is written, **fold it into the
build order**. M14's confirm-gate guard was designed, explicitly approved, and never built — the
build order was what got executed from, and the addendum had no route into the work. It shipped
missing and a live test found it.

## When you finish a milestone
- Run the test suite against MockShell.
- Update `spec.md` if any decision changed.
- Summarize what changed and what the next milestone needs.
