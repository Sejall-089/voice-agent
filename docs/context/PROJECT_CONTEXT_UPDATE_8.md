# Project Context — Update 8 (M16 built through M16.10, live human verification pending)

Read alongside `PROJECT_CONTEXT_UPDATE_7.md` (M15's failure and the decision to
rebuild on UI Automation), `spec.md`, `ARCHITECTURE.md`, `CLAUDE.md`, and
`docs/M16-plan.md`. This covers the entire M16 build session — recon through
M16.10 — and hands off the one thing still open: M16.11's live human pass.

## Status

M16.2 through M16.10 are built and committed on branch `m16-uia-grounding`.
737 tests passed before the vision-code deletion in M16.10; 662 pass after
(~2,900 lines deleted, drop is expected and accounted for). Both typechecks
clean throughout. **M16.11 (live verification via actual hotkey/keypress) is
not done — it requires a human at the keyboard and cannot be completed by
Claude Code alone.** M16.12 (final docs, `spec.md`/`README.md` updates)
deliberately waits on M16.11's results.

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
instead. Reasoning — the fallback's trigger condition (no accessibility tree:
canvas apps, bare Electron windows) is exactly the condition vision measured
worst under. Falling back there would mean falling back into the failure mode
this whole redesign exists to avoid. All vision code is deleted, not
retained as a fallback path (`src/core/vision/` entirely gone, ~2,900 lines,
confirmed via `find -iname "*vision*"` returning nothing except historical
comments explicitly marked as referring to deleted/superseded code).

## Key findings from the build, in order

**Recon (before any code):** Electron/Chromium apps can have empty or slowly-
populating accessibility trees. VS Code's tree grew 13 → 613 elements over
~1.5s (recoverable, just slow). Claude desktop's tree was flat at 14 for
9.4 seconds, then — discovered later, same process, no restart — had grown to
306 raw / 98 usable elements within the hour. **"Is this app supported?" is
not a question a bounded live check can answer; only "is it settled right
now?" is.** This reframing drove the entire settle-detection design.

**The settle logic (M16.3b):** two independent triggers, evaluated at
different points because they read different data — trigger A (window class,
e.g. `Chrome_WidgetWin_1`) fires off the cheap `probe()` call before any full
enumeration; trigger B (chrome-only content — nothing but Minimize/Restore/
Close) fires off the first `enumerate()`, since it needs element names. A
native window (Notepad, Explorer) fires neither and pays zero settle cost.
The settle decision is a pure function `(counts, trigger) => "settled" |
"growing" | "unsettled"`, deliberately extracted so a timing-dependent
decision with no live symptom when wrong is fully testable without a real
clock — a real M14-style lesson applied proactively this time.

**Real bugs found only by building/measuring, not by reasoning in advance:**
- Identical-twin candidates: VS Code exposed the same control 2–3× at the
  same rect under different types. Dedup originally required strict
  size superiority and caught none of them — fixed with tree-order
  tiebreaking, proven to only ever affect *which label* is shown, never
  *where* the marker points (ties only occur between equal rects).
- A control's `Name` can be an entire source file's contents (10,973 chars
  measured) — added `MAX_NAME_CHARS` truncation.
- The control-type-allowlist rejection reasoning in the original plan was
  wrong (claimed it would drop VS Code's activity-bar icons; measured, they
  have `TabItem` twins and survive fine) — corrected in the plan itself
  rather than left as stale-but-harmless reasoning.
- DPI: native origin is not simply `bounds.x * scaleFactor` — this agrees
  with the correct formula on a single display at the origin (this
  machine) and would silently diverge on a second monitor. Fixed via
  `screen.dipToScreenPoint` rather than multiplication. `ScreenRect` is now
  branded with a phantom type so a raw native rect can't compile as a
  screen rect — M15's same mitigation (a different type name) was
  documentation only, since TypeScript's structural typing didn't actually
  enforce it.
- Ambiguity gate (M16.4) was initially too blunt — refused whenever two
  candidates shared a name, even when control type or position told them
  apart unambiguously (e.g. Explorer's "Date modified" SplitButton vs. its
  "Date modified" filter Edit box). Narrowed to: refuse only when
  indistinguishable across *every* field the model was shown (name, type,
  position). Caught via the live model-choice recon in M16.5, not
  reasoning — the original blunter rule was deliberately considered and
  rejected at M16.4 on an asymmetry argument that turned out sound but
  incomplete.
- The **`stale` refusal** (M16.9): if the foreground window changes between
  the initial snapshot and the overlay drawing (VS Code's ~1.9s warm latency
  makes this a real window, not theoretical), the tool now refuses rather
  than drawing. This was explicitly recognized as **M15's exact failure
  mode reappearing through a different door** — a technically-correct rect
  drawn over the wrong (now-foreground) application, via an always-on-top
  overlay, is just as misleading as a wrong rect in the right window.
  Rejected two alternatives: "ignore it" (rect is still correct for its
  original window, but the overlay doesn't care) and "re-snapshot"
  (answers a question about a window the user never asked about).

**Real-host findings (M16.8, first real UIA on Windows, not fakes):**
- A PowerShell `-Command -` invocation pattern doesn't reliably deliver
  commands via stdin (reproduced against M12's own unmodified script — filed
  as a note in `WindowsInputInjector.ts`, not treated as proof shipped
  dictation is broken, since Electron's spawn may behave differently).
- Full-tree enumeration (`TrueCondition`) cost 9.5 seconds on a real window;
  the narrowing condition already used for the cheap probe cut this to
  826ms with proven zero data loss (byte-identical candidate list).
- The settle budget was charging only the sleep delay, not the full round
  trip — real probe cost scales with tree size (60–370ms measured, not
  recon's 46–80ms), which could have authorized far more real wall-clock
  time than intended. Fixed to time the whole round.
- Host is warm, one process per app run, ~918ms startup paid once. No
  caching of results anywhere — every probe/enumerate re-reads the tree, so
  a stale host can't serve a stale answer. Crash handling follows M14's
  Piper lesson: outstanding calls reject immediately, next call respawns.

## What's proven live vs. what's still only proven against fakes/harness

**Proven with real UIA/host, not fakes (M16.8–M16.9):**
- All three original M15 regression targets resolve to exact correct rects
  through the real PowerShell/UIA host.
- The chooser (model) correctly picks from host-produced (not fixture)
  candidate lists, including a correct decline ("the send button" among 26
  real controls, refused).
- Geometry conversion ran end-to-end for the first time with a real
  `DisplayBounds` from the OS, producing a marker draw with no throw.

**NOT yet proven — this is the actual gap Update 8 hands off:**
Everything above was exercised via a bundled test harness or the PowerShell
host directly — **never through the real app via an actual hotkey press**.
M16.11 attempted this and hit two structural walls, correctly reported
rather than faked:
1. The overlay sets `setContentProtection(true)` (`WDA_EXCLUDEFROMCAPTURE`),
   which excludes it from *every* capture API on the machine — this is a
   deliberate M15 privacy property, not a bug, but it means **no screenshot
   or window enumeration can ever confirm where the marker visually
   landed. Only a human eye can verify this.**
2. The result/refusal text is renderer-only, not logged to any inspectable
   surface — attempting to read it via UIA on the app's own command bar
   returned exactly one bare `[Pane]` element, which is itself an
   accidental, independent live confirmation of the "can't target this
   app's own UI" limitation (a second instance of the same accessibility-
   tree gap this whole milestone is about, found by tripping over it
   rather than by testing for it).

What Claude Code *could* verify by itself: the app builds and boots with
M16 wiring; the global hotkey fires on a real `WM_HOTKEY` and brings the
command bar to the real foreground; a full `pointAt` call completes without
crashing (16s of stable post-call app life, no errors). This is real
progress but explicitly less than full live verification.

## The one thing that needs to happen next

**Run `docs/M16.11-live-checklist.md` by hand** — `npm run dev`, work through
each item (exact instruction to type, expected sentence, expected DIP rect
for each). Two things the checklist specifically flags as needing a human
judgment call, not more instrumentation:
- **Whether the Chromium settle delay (~1.5–2s on VS Code) feels
  acceptable in practice.** If not, `SETTLE_MS` is the number to revisit.
- **The `stale` refusal case is the single most important live check.**
  Trigger `pointAt`, alt-tab away before the marker draws (VS Code's ~1.9s
  window makes this achievable by hand), confirm it refuses rather than
  drawing on the wrong now-foreground app. If this fails live, it's M15's
  failure mode back in a new form, and the whole reasoning chain that led
  to building `stale` needs re-examination.

`POINTING_ENABLED=1` is already in `.env`; the app is stopped and ready.

**M16.12 (final docs — `spec.md`, `README.md`, closing `PROJECT_CONTEXT_UPDATE_9`
or similar) should not start until the checklist results are in hand.**
Whatever the human pass finds — especially if the stale check or the
settle-delay feel surfaces anything — belongs in those docs, not written
around in advance of knowing.

## Carry forward into next chat

- Ask what the M16.11 checklist found before doing anything else on this
  milestone. If it hasn't been run yet, that's the immediate next action —
  nothing else productive can happen on M16 until it has been.
- If the checklist passes clean: M16.12 (docs) is next, then M16 is closed
  and the standing priority list (per Update 6/7) resumes — narrow
  multi-step autonomy was the item after vision-guidance, though M16's
  results may be worth weighing against that fresh.
- If the checklist finds a real problem (especially on the `stale` check):
  treat it with the same seriousness as M14's §8 near-miss or M13's OAuth
  bugs — a real live-testing find, not a footnote to patch quietly.
