---
name: milestone-closeout
description: Close out a milestone in this repo — tests and typecheck, the mutation pass, the live checklist, a stop for a person's live results, then the spec / README / context / CLAUDE.md updates. Use when the user asks to close, finish or wrap up a milestone (e.g. "/milestone-closeout M23").
disable-model-invocation: true
---

# Milestone close-out

Closes milestone `$ARGUMENTS` (if none was given, ask which). Two phases with a hard stop
between them: everything a machine can establish, then what only a person at the keyboard can.

CLAUDE.md's testing-discipline section is the reason for most steps here. This file is the
order to do them in; it does not replace those rules.

## Rules that hold throughout

- **Report what actually happened.** Paste real counts from real output. A step that was not
  run is reported as not run.
- **Real-model evals are never run** (`tests/eval/` with an opt-in flag set) unless the user
  asks for one in the current message. Otherwise write "eval skipped (not run against the real
  model)". Plain `npm test` is fine: the evals skip themselves there.
- **Nothing automated creates, posts or sends for real.** No script or test creates a real
  issue, posts a real message or sends a real email. Recon scripts stay read-only. The only
  real writes are the ones a person makes by hand from the checklist.
- **A tick means a person watched it.** No test, eval, recon script or log line earns `[x]`.
- **Change only what the close-out needs.** A bug found here is reported first; fixing it is
  its own piece of work, with its root cause found before any edit.
- **No `Co-Authored-By` line** in any commit message, whatever a template suggests.

## Phase A — before the live pass

1. **Establish the state.** `git status`, `git log --oneline -15`, and the milestone's entry
   and build order in `spec.md` §9. Check every item in the build order was built — including
   anything agreed *after* the build order was written (CLAUDE.md, "Scope added
   mid-milestone"). Anything missing: stop and say so.

2. **Typecheck and tests.** `npm run typecheck`, then `npm test`. Record tests passed, files,
   and skipped. If anything fails, stop and report it with the output.

3. **Mutation pass**, for each rule this milestone added or changed (a gate, a classifier, a
   check, a wording that depends on a condition). If the user did not ask for a mutation pass
   in this request, say first that auto mode may block it and ask how they want it run.
   One rule at a time:
   1. Break the rule with the **Edit tool** — never `sed` or a heredoc, which can silently
      match nothing.
   2. Confirm the break landed: `git diff --stat` shows that file.
   3. Run the focused files: `npx vitest run <files>`.
   4. Record which test failed. **If none did, the mutation survived**: that rule has no test.
   5. Revert: `git checkout -- <file>`. Confirm `git diff --stat` no longer shows it.

   If a run is denied or interrupted while a mutation is applied, **revert first, then
   report**. After the last one, `git status` must show no mutation left in the tree, and
   `npm test` must be green again. Every survivor gets a test (written, then proven by
   repeating its mutation) or is listed as a known gap. Keep the table of
   rule → mutation → test that caught it for the spec.

   Also re-justify existing tests for any rule that *changed*: does the test distinguish the
   new rule from the old one, or would it pass under both?

4. **Write the live checklist** — `docs/M<N>-live-checklist.md` (capital M), from
   [live-checklist-template.md](live-checklist-template.md), **before** the live pass. Each
   box names what could actually be wrong and what to expect. Where a script or test has
   exercised a path, the box stays `[ ]` and says what the script showed. Include anything
   carried over unwatched from earlier checklists that this milestone touches.

5. **Stop.** Give the user: the test and typecheck results, the mutation table, the eval
   status, and the checklist path. Then wait. **Do not tick anything, do not tick the
   milestone in `spec.md`, and do not write a "live results" section** until the user reports
   what they saw.

## Phase B — after the user reports live results

6. **Record exactly what was reported.** Tick only the boxes the user says they watched, with
   the date. Leave the rest open, split into "covered by script or test only" and "not run".
   Update the banner at the top (ticked / open counts). Write each finding under **Findings**:
   what was seen, the cause if known, whether it is fixed and whether the fix was re-watched.
   If a result is unclear, ask — do not infer a pass.

7. **Live bugs.** Treat the reported cause as a hypothesis and the symptom as the fact:
   reproduce before editing. A fix is new work — tests, a mutation for it, and a re-watch box.

8. **Update the record**, in the same pass:
   - `spec.md` §9: the milestone's entry (tick it only if the user says it is closed; name the
     gaps it is ticked with), test count, a "proven vs. live-only" account, the mutation
     table, open limits. `spec.md` §2 if scope moved. Any section whose decision changed.
   - `README.md`: status, test count, `.env` keys, setup, the checklist link.
   - `ARCHITECTURE.md` if a component, flow or invariant changed.
   - `.env.example` if a variable was added — any value that can start with `#` shown quoted.

9. **Re-check the standing instructions — every close-out, even when nothing seems to have
   changed:**
   - `CLAUDE.md`, "How to work here" and "Non-negotiables": is the milestone range still
     right? Does the out-of-scope summary still match `spec.md` §2? Does any rule name
     something this milestone renamed or removed?
   - `CLAUDE.md`, testing discipline: if a live finding taught something no existing lesson
     covers, add it, in the existing form (the rule in bold, the milestone, what it cost).
   - `docs/context/README.md`: the "Current status" paragraph (milestones shipped, date, test
     count), the list of checklists and their ticked / open counts, and the read order.
     Writing a new `PROJECT_CONTEXT_UPDATE_<n>.md` is the user's call — ask, do not assume.

10. **Verify and hand over.** `npm run typecheck` and `npm test` once more; report the numbers.
    Check the diff holds no secret (key, token, webhook URL) and no leftover mutation.
    Search README.md, spec.md, ARCHITECTURE.md and docs/ for the previous test count (and
    file count) and any other hard-coded counts, and update or confirm each one. A count
    written as 'at M<N> close' is a historical record and stays as written. Show the
    user the full diff and **wait for approval before committing**. Never force-push.

## Final report

- Tests: passed / files / skipped. Typecheck: clean or not.
- Eval: run (only if asked) or "eval skipped".
- Mutation pass: rules broken, which test caught each, survivors and what was done.
- Live: boxes human-verified, boxes covered by script or test only, boxes not run.
- Findings, and which are fixed and re-watched.
- What the next milestone needs.
