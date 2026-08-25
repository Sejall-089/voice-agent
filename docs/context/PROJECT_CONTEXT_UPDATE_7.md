# Project Context — Update 7 (M15 vision grounding: built, tested, found insufficient; M16 decided)

Read alongside all prior context files, `spec.md`, `ARCHITECTURE.md`, `CLAUDE.md`.
Supersedes Update 6's "next milestone" pointer — vision-guidance was attempted,
tested honestly, and its grounding approach is being replaced, not iterated on.

## M15 (vision-guidance, pointAt) — built, live-tested, grounding approach rejected

Built: pointAt as a registry tool (not a planner bypass), screenshot capture with
setContentProtection(true) self-exclusion (verified: 98.4% visible unprotected,
0.0% protected), DPI/scale-factor geometry handled across three pixel spaces,
overlay + click-through (verified via window enumeration, since content
protection blinds the app's own screenshot tools to its own overlay).

Live testing on real Notepad/Explorer found the model frequently localizes the
*wrong control entirely* on dense native UI — not imprecise, wrong. Measured
against UI Automation ground truth: one tab over on a tab label, ~208px onto
neighbouring icons on a toolbar button.

A SMALL_TARGET_PX size gate was added to catch low-confidence cases, then
investigated further: it was catching wrong answers by accident, not
imprecision. Two candidate fixes were tried and rejected with data — asking for
the full clickable area made accuracy worse (6/9 → 2/9 on-target); padding
before the size check can't distinguish "small and correct" from "small and
wrong" (would wave through the real mis-localizations, and the original
small-icon case too).

**Conclusion: this is GUI grounding, a known unsolved research problem, not an
implementation bug.** Published 2026 benchmarks: strongest vision models ~31%
strict point-in-box accuracy vs. ~97% human, worst on small/dense elements. No
amount of prompt or threshold tuning closes that gap — don't attempt either
again on vision-only grounding.

## M16 (decided, Plan Mode prompt written, not yet started)

**The architectural fix:** vision was both proposing (which control) and
disposing (where exactly) — the one place in the codebase where "model
proposes, code disposes" was broken. New design: UI Automation enumerates a
window's interactive elements with exact rects; the model only picks a
candidate number (semantic matching, not spatial localization); code resolves
the chosen candidate's UIA rect. Coordinates never come from the model.

Vision demoted to fallback for windows with no usable UIA tree (games, canvas
apps). Known risk flagged for deliberate recon: Electron/Chromium apps can
return empty accessibility trees (per Screenpipe's documented issue with this
exact problem) — Chrome 138+ now enables native UIA by default, which may
have closed much of the gap, but this needs live verification, not assumption.

Overlay, screen capture, DPI geometry, and the pointAt registry entry all
carry over unchanged. SMALL_TARGET_PX is expected to be removed entirely, not
retuned — a UIA rect has no size-based confidence problem.

**Not yet started.** Plan Mode prompt is written and ready; needs a session
with full budget (recon-heavy: enumeration performance, candidate filtering
rule, one Electron app tested deliberately, not just easy native ones).

## Other decisions this session

- Piper cold-start latency: fixed and closed (persistent warm process, ~30x
  improvement, separate from M15/M16 — see commit history).
- Anthropic API billing blocked by a payment-processing issue on their end
  (mandate registers, charge fails — consistent with an RBI e-mandate
  integration gap on cards issued in India). Logged as a product bug via
  support, no ETA. Not a blocker — M15's vision probe and all its testing ran
  on OpenAI vision instead.
- These PROJECT_CONTEXT files moved into the repo at `docs/context/`, indexed
  by `docs/context/README.md`, instead of re-uploading each session.

## Carry forward into next chat

- Start M16's Plan Mode session fresh (not a continuation of M15's session) —
  full budget needed for the recon.
- The three M15 live-failure cases (File menu, Advice.txt tab, New button)
  are the explicit regression targets M16 must pass.
