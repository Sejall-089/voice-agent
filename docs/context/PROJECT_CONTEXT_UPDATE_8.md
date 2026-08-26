# Project Context — Update 8 (M16 built through M16.10, live human verification in progress)

Read alongside `PROJECT_CONTEXT_UPDATE_7.md` (M15's failure and the decision to
rebuild on UI Automation), `spec.md`, `ARCHITECTURE.md`, `CLAUDE.md`, and
`docs/M16-plan.md`. This covers the entire M16 build session — recon through
M16.10 — plus the M16.11 live human verification pass, which found and fixed
two real bugs and surfaced two more still being investigated.

## Status

M16.2 through M16.10 are built and committed on branch `m16-uia-grounding`.
667 tests pass (after the two live-testing bug fixes below), both typechecks
clean throughout. **M16.11 (live verification via actual hotkey/keypress) is
in progress, not done.** Two real bugs were found live and fixed. Two more
were just found and reported to Claude Code, not yet fixed. M16.12 (final
docs) still waits on the checklist closing out clean.

## What M16 actually is

Vision grounding (M15) is fully replaced. UI Automation enumerates a target
window's interactive elements with exact rects; the model's only job is to
pick a candidate number from a text list (semantic matching); code resolves
that candidate's real rect. Coordinates never come from the model — this
closes the exact gap M15 failed on (vision was both proposing *and* disposing
coordinates, the one place "model proposes, code disposes" was broken).

**No screenshot is ever sent.** This fell out of recon, not the original
plan — 26–97 named candidates fit as text in a prompt, so the entire
coordinate-space problem class from M15 (frame policy, provider rescaling,
three pixel spaces) is deleted by construction, not fixed.

**No vision fallback.** The original framing (vision as fallback for windows
with no usable UIA tree) was superseded during planning. Decision: refuse
instead, since the fallback's trigger condition (no accessibility tree) is
exactly the condition vision measured worst under. All vision code is
deleted (`src/core/vision/`, ~2,900 lines), not retained as a fallback path.

## Key findings from the build (M16.2–M16.10), summarized

Full detail lives in the build commit history; the essentials:

- **Settle detection** (M16.3b): two independent triggers — window class
  (cheap, off the probe) and chrome-only content (needs a full enumerate) —
  fire at different points, driven by the discovery that "is this app
  supported" isn't answerable, only "is it settled right now."
- **Real bugs found only by building/measuring:** identical-twin candidates
  at the same rect (fixed via tree-order tiebreaking, proven to only ever
  affect *which label* shows, never *where* the marker points); a control
  name that was an entire 10,973-character source file (added
  `MAX_NAME_CHARS`); an ambiguity gate too blunt on first pass — refused
  whenever two candidates shared a name, even when type or position told
  them apart — narrowed to "indistinguishable across every field the model
  was shown"; a DPI trap where native origin isn't simply
  `x * scaleFactor` (agrees with the correct formula on this single-display
  machine, would silently diverge on a second monitor) — fixed via
  `screen.dipToScreenPoint`, and `ScreenRect` is now phantom-branded so a
  raw native rect can't compile as a screen rect (M15's same mitigation, a
  different type name, was documentation only under TypeScript's structural
  typing).
- **The `stale` refusal** (M16.9): if the foreground window changes between
  snapshot and overlay draw, the tool refuses rather than drawing —
  explicitly recognized as **M15's exact failure mode reappearing through a
  different door** (a technically-correct rect drawn over the now-wrong
  foreground app, via an always-on-top overlay, is exactly as misleading as
  a wrong rect in the right window).
- **Real-host findings** (M16.8, first real UIA on Windows): a PowerShell
  `-Command -` invocation pattern doesn't reliably deliver commands via
  stdin (filed as a note, not treated as proof shipped dictation is
  broken); full-tree enumeration cost 9.5s on a real window, cut to 826ms
  via the narrowing condition already used for the cheap probe, with
  proven zero data loss; the settle budget was charging only the sleep
  delay, not the full round trip, which could have authorized far more
  real wall-clock time than intended.

## M16.11 — live verification, in progress

**Two real bugs found live and already fixed:**

**Bug 1 — foreground snapshot captured the app's own window, every single
press, on every call.** Not a race — a guarantee. `snapshotPointTarget()`
started an async read; `showInput()` ran synchronously in the same tick and
stole focus before the read resolved. The read always landed after the bar
had taken focus, so it always reported the bar itself. First live repro:
asking Notepad "where is the File menu" returned a refusal naming
"Voice-Action Agent" (the app's own window), not Notepad.

*Why the existing ordering test missed it:* the fake was synchronous
(`snapshotPointTarget: () => events.push(...)`), so it could record *that*
the call happened before `showInput()`, but not *whether the read itself*
resolved first — a fake that's synchronous where the real thing is async
cannot test ordering at all. This is now a named lesson: when a fake
replaces something async, the fake must be async too, or ordering tests
against it prove nothing.

*Fix:* `snapshotPointTarget()` now returns a Promise the hotkey awaits
before `showInput()`. The host is pre-warmed at startup so the await is a
~15ms round trip, not the ~918ms first-call cold start. Bounded at 250ms.
Defense in depth: the foreground read walks past this app's own window
handles in the Z-order, so the bug is now structurally inexpressible, not
just fixed. Also added: one `[main] <status>: <result>` log line per
instruction — this bug produced a perfectly plausible-looking wrong
refusal, and nothing had recorded which window was actually read.

**Bug 2 — the marker always showed the *previous* question's answer, every
new/changed question, correcting only on an exact repeat.** Worse than bug
1: not always-wrong, but *always-wrong-then-right-on-retry*, which is more
dangerous in practice since a user who doesn't know to distrust the first
result and repeat their question would consistently be pointed at the
wrong control with no indication anything was off.

Exact reproduced pattern: ask A → correct; ask B → shows A (previous); ask
B again → correct; ask A → shows B (previous); ask A again → correct.

*Cause:* the marker's position traveled in the URL hash. `overlay.html`'s
script was an IIFE reading the hash once at document load. A hash-only URL
change is a same-document navigation in Chromium — the script never re-ran,
so the marker kept the previous question's rectangle. A comment in
`overlay.html` had stated the opposite as a fact ("each `point()` is a
fresh navigation, so the window cannot end up displaying a stale
position") — an assumption stated as a guarantee, never checked.

*Why nothing caught it, and why it matters more broadly:* invisible to
every log-based verification method, including the one added for bug 1 —
a log line proves what the app *decided*, not what the user *saw*. Verified
via live DOM inspection (reading the overlay's actual computed CSS under
Electron) rather than trusting the main process's log.

*Fix:* position now travels in the query string (a real document load) plus
a monotonic nonce, so even an identical repeated question is also a
distinct URL. Verified pre-fix (deliberately reproduced to confirm the
probe catches it) and post-fix (all renders matched what was sent).
Permanent regression test added asserting no two calls produce the same
query string, over the exact alternating sequence that broke it.

*Re-assessment this forced:* the 6 checks previously reported as "passing"
via log output needed re-grading. The 3 that ended in a refusal (drew
nothing) were unaffected and stand. The 3 that ended in a marker (decision
was correct, but *display* was unverified) had to be re-run visually.

**Visual re-verification, confirmed by hand:** File menu (Notepad), the
alternating File/Advice.txt pattern (specifically re-run several times
since that pattern is what broke it originally), and New button on a
File Explorer Desktop tab — all confirmed correct with eyes on the marker,
after both fixes above landed.

**Two more issues found live, reported to Claude Code, not yet fixed:**

**Issue 3 — intermittent raw UIA exception leaks to the user.** One attempt
at "where is the New button" (Explorer, Home tab) returned an unhandled,
untranslated error directly in the UI: `Exception calling "FindAll" with
"2" argument(s): "Unrecognized error."` Did not reproduce on immediate
retry. Regardless of reproducibility, this is a gap: every other failure
mode in this milestone (`unreadable`, `unsettled`, `stale`, `not-found`,
ambiguity) surfaces as a designed sentence; a raw exception string should
never reach the user.

**Issue 4 — misleading wording when a matched control is disabled.**
Same Explorer window, retried: "I couldn't find 'the New button' among the
70 controls I can see" — but the New button was visibly greyed out and
manually unclickable at the time (the window showed "Account disconnected,"
likely OneDrive-related). **Confirmed, not just suspected**: the identical
instruction on a different Explorer window (Desktop tab, New enabled)
correctly resolved and pointed at it. So candidate filtering is very likely
excluding disabled controls deliberately (reasonable — pointing at a
disabled button is unhelpful) — but the refusal wording ("couldn't find...
among the controls") implies absence, when the real fact is "present but
excluded because disabled." Same category of imprecision already fixed
once for `unreadable` vs. `unsettled`. Both issues reported to Claude Code
together, not yet resolved.

## What's still needed to close M16.11

- Claude Code's response to issues 3 and 4 above.
- The Chromium settle-delay subjective judgment (~1.5–2s on VS Code) — not
  yet explicitly confirmed as acceptable or not.
- `unreadable` refusal still never seen live (not blocking, but noted as
  unexercised).
- Multi-monitor stays out of scope, hardware-blocked, unchanged.

## Carry forward into next chat

- Ask what Claude Code's response to issues 3 and 4 was, if not already
  known, before doing anything else on this milestone.
- Once those are resolved and re-verified live (same visual-check standard
  as bugs 1 and 2 — do not accept a log-only "fixed" claim for anything
  that produces a marker), the settle-delay judgment call is the last
  subjective item, then M16.12 (docs) can start.
- **Standing lesson from this session, worth being in `CLAUDE.md` if it
  isn't already**: a fake that is synchronous where the real thing is
  async cannot test ordering, only call-sequence — a different and weaker
  property. And: log-based verification proves what the app decided, not
  what the user saw — anything producing a visible marker needs an actual
  human eye on the actual screen, not just a clean log line.
