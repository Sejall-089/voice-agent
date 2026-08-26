# Project Context — Update 8 (M16: vision replaced with UI Automation, built and live-verified)

Read alongside `PROJECT_CONTEXT_UPDATE_7.md` (M15's failure and the decision to rebuild),
`spec.md` (§6d, and the M16 sections of §9), `ARCHITECTURE.md` §4e, and `CLAUDE.md`. Supersedes
Update 7's "M16 decided, not yet started" — M16 is built, deleted its own predecessor's code, and
has been live-verified through the real app by a human at the keyboard, including bugs that
verification found and this session fixed.

## Status

M16 is complete. All twelve build steps (M16.1 through M16.12) are done. 675 tests pass, both
typechecks clean. The live-verification checklist (M16.11) closed with all nine items confirmed
by hand, one honest gap held rather than chased (below).

## What M16 actually is

Vision grounding (M15) is fully replaced, not extended. UI Automation enumerates a target
window's interactive elements with exact rects; the model's only job is to pick a candidate
number from a text list — semantic matching, never spatial localization; code resolves that
candidate's real rect. Coordinates never come from the model. This closes the exact gap M15
failed on: vision was both proposing *which* control and disposing *where* it is, the one place
in the codebase where "the model proposes, the planner disposes" was broken.

**No screenshot is ever sent.** This fell out of recon, not the original plan — 26–97 named
candidates fit as text in a prompt, so the entire coordinate-space problem class from M15 (frame
policy, provider rescaling, three simultaneous pixel spaces) is deleted by construction. All
vision code is gone from the tree (`src/core/vision/`, ~2,900 lines) — not retained as a
fallback. The original framing (vision as fallback for windows with no usable UIA tree) was
superseded during planning: refuse instead, since the fallback's trigger condition is exactly the
condition vision measured worst under.

## What building it found

**Settle detection** (M16.3b) exists because "is this app supported?" isn't an answerable
question — Claude desktop's own accessibility tree was measured flat for 9.4 seconds, then fully
populated an hour later in the same process. Two independent triggers (window class, cheap; and
chrome-only content, needs a full read) fire at different points because a magnitude-only check
would have missed both a Chromium window mid-load (VS Code: 13 elements, then 613 a second later)
and a genuinely sparse-but-real dialog.

**Identical-twin candidates** at the same rect (VS Code's activity-bar icons, exposed as both a
`TabItem` and a `Group`) needed tree-order tiebreaking — proven to only ever affect *which label*
shows, never *where* the marker points, since a tie only occurs between rects that are already
equal.

**The ambiguity gate was too blunt on its first pass**, refusing whenever two candidates shared a
name even when control type or position told them apart. `scripts/choose-recon.ts` produced the
counterexample live: asked for "the column header for when things were last changed", the model
correctly picked Explorer's `Date modified` SplitButton, and the gate refused it because Explorer
also has a `Date modified` filter Edit. Narrowed to "indistinguishable across every field the
model was shown."

**A DPI trap of M15's exact shape**: the native origin is not `x * scaleFactor` — correct on this
single-display machine, would silently diverge the moment a second monitor has a different scale
factor. Fixed via `screen.dipToScreenPoint` rather than arithmetic. `ScreenRect` is now
phantom-branded so a raw native rect cannot compile as a screen rect — M15's same mitigation
(giving it a different type name) was documentation only, defeated by TypeScript's structural
typing.

**Real-host findings** (M16.8, first contact with real UIA): PowerShell's `-Command -` invocation
does not reliably deliver commands over stdin — the host printed `READY` and then answered
nothing, reproduced against `WindowsInputInjector`'s own unmodified script. M16's host uses
`-File` instead; M12 was left alone (shipped dictation works, runs under Electron's spawn, where
the behaviour may differ), with a note filed in that file for what to watch for if it ever
misbehaves. Full-tree enumeration cost 9.5s on a real VS Code window; narrowing the query at the
source cut that to 826ms with a proven byte-for-byte zero loss of real candidates. And the settle
budget was originally charging only the sleep delay, not the full probe round trip — a real probe
costs 60–370ms depending on tree size, not the smaller number a synthetic bench first suggested,
so the budget now charges wall-clock time for the whole round.

## M16.11 — live verification, closed

Two real bugs were found through the real hotkey that no fixture, host-level test, or log-only
check could have caught, and both are now standing lessons in `CLAUDE.md`.

**Bug 1 — the foreground snapshot always captured the app's own command bar.** Not a race, a
guarantee: `snapshotPointTarget()` was fire-and-forget, `showInput()` ran synchronously in the
same tick and took focus before the async read resolved, so the read always landed after and
always reported the bar. First live repro: "where is the File menu" in Notepad answered that it
could not read the controls in "Voice-Action Agent". The existing ordering test was green
throughout, because its fake was synchronous — it could prove the *call* happened before
`showInput()`, not whether the *read* did, which is a different and weaker property. Fixed by
awaiting the snapshot (pre-warming the reader at startup so the await is ~15ms, not the ~918ms
cold-start cost), bounding it at 250ms, and — defence in depth — having the reader refuse to name
one of the app's own window handles even if asked.

**Bug 2 — the marker always showed the *previous* question's answer.** Worse than bug 1: not
always-wrong but always-wrong-then-right-on-an-exact-repeat, which is more dangerous in practice,
since a first answer looks authoritative and nothing on screen suggests it's stale. Cause: the
marker's position travelled in the URL hash, and a hash-only change is a same-document navigation
in Chromium — the overlay's script, which reads its position once at load, never re-ran. A
comment in `overlay.html` had asserted the opposite as a fact, unverified. Invisible to every
log-based check, including the one added for bug 1: the planner computed the right answer every
time, only the render was stale. Verified by reading the overlay's live computed CSS under
Electron, both pre-fix (deliberately reproduced, to confirm the check would have caught it) and
post-fix. Fixed by moving the position to the query string (forces a real navigation) plus a
monotonic nonce (so even an identical repeated question is a distinct URL). Both fixes forced a
re-grading of earlier "passing" checks: the three that ended in a refusal were unaffected; the
three that ended in a marker needed re-verification with eyes on the actual screen, which followed
and confirmed correct.

**Three refusal-wording fixes**, each from a live finding: a raw COM exception
(`Exception calling "FindAll"...: "Unrecognized error."`) was reaching the user verbatim through
the `unreadable` path — the host now returns classified codes, never engine text, and retries a
`FindAll` fault once; a disabled control was being filtered out of the candidate list entirely,
collapsing "present but unusable" into "not found" — disabled controls are now kept, shown to the
model marked as disabled, and refused with their own wording; and ambiguity refusals on a
five-column Explorer window named candidates by left-to-right ordinal ("3rd from the left"), which
technically worked but made the reader count columns — candidates inside a labelled container
(a column header) are now named by it, ordinals kept as the fallback when no clean landmark
exists.

**One honest gap, held rather than chased.** The `unreadable` refusal's live *wording* was never
provoked — every cold-Electron-launch attempt found the target's tree had already populated by
the time the hotkey landed. Not blocking: the refusal path is proven deterministically and its
sibling paths (`unsettled`, `disabled`, `stale`, `ambiguous`) all fired live. The reason it
resists forcing is the same populate-then-go-bare timing that is *why* the message is worded in
the present tense rather than as a permanent claim about an app.

**Two design questions raised during live verification, both now decided (2026-08-27), neither
acted on.**

- **The overlay's 10s auto-dismiss stays as-is.** It does not shorten if the user switches away
  from the target window before it elapses, so a stale (but correct-when-drawn) marker can sit
  over whatever app the user switched to for up to that long. A recommendation to shorten it to
  ~5s was on record after M16.11; on reflection, kept at 10s. Focus-loss detection (polling
  `GetForegroundWindow` through the UIA host) was considered and rejected outright, not just left
  undone — it would add a background loop to a milestone that already produced four live bugs,
  and risks dismissing a marker mid-use when a notification steals focus transiently, which is a
  worse failure than the one it would fix.
- **The Chromium settle delay stays as measured.** Checklist item 4's subjective judgement —
  whether the ~1.5–2s wait on a real VS Code window (one 350ms settle plus the read) feels
  acceptable — is confirmed yes. `SETTLE_MS` in `core/screen/settle.ts` was not revisited.

Both are recorded in `spec.md` §4e and the M16 known-limitations list.

## Two standing lessons (now in `CLAUDE.md`)

- **A fake that is synchronous where the real thing is async cannot test ordering — only
  call-sequence.** If the real implementation of something under test is async, the fake must be
  too, with its own artificial delay, or an ordering assertion against it proves nothing.
- **A log line proves what the app decided, not what the user saw.** Anything ending in something
  drawn, played, or otherwise rendered needs a check on the rendered thing itself — not a log of
  the decision that produced it.

## Carry forward into next chat

- M16 is closed, including both design questions above. The next milestone is whatever comes
  after it — nothing here blocks starting it.
- The multi-monitor gap (native→DIP arithmetic unit-tested including the specific wrong answer a
  bad formula would produce, never run against real hardware) and the `unreadable` live-wording
  gap are both named honestly in `spec.md`'s M16 sections — check there before re-deriving either.
