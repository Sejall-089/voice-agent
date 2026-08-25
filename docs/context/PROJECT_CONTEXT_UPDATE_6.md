# Project Context — Update 6 (M14 Voice Output: built, live-tested, shipped)

Read alongside `PROJECT_CONTEXT.md`, `PROJECT_CONTEXT_UPDATE.md` through
`_UPDATE_5.md`, `future_scope_post_m14.md`, `spec.md`, `ARCHITECTURE.md`,
`CLAUDE.md`. Update 5 was written mid-M14-build (right after the Plan Mode
prompt was confirmed) and predates the entire build — this update covers
everything that happened since, and supersedes Update 5 for M14 status.
Update 5's M13 (Calendar) content is still accurate and doesn't need
re-reading.

## Status

M14 is complete. Eleven commits, plan to shipped. 493/493 tests green,
typecheck clean on both configs, build succeeds. The app speaks narration,
confirms, and results; barge-in works; Escape silences speech; the §8
confirm-gate holds under live testing.

## What got built (recap)

Local TTS via Piper (not cloud), chosen to match the same local-first
principle already set for voice input (whisper.cpp). Three seams:
`SpeechSynthesizer`/`PiperSynthesizer`+`FakeSynthesizer` (synthesis),
`SpeechShell`/`SpeechSession` (playback + the queue/barge-in state machine),
`core/speech.ts` (pure derivation of spoken text from display text).
Representation is deliberately parallel, not unified — the screen keeps full
content (every attendee named, the whole draft), speech gets a terser
derived version, because forcing one string to serve both would have been a
safety regression on the exact dialogs where completeness matters most.
Long-result handling: a spoken-item cap, a `SpeechStore` holding the
truncated remainder, and a new `elaborate` tool to read it on request.
Barge-in stops speech immediately via both hotkeys and Escape.

## The §8 near-miss — a distinct process lesson, not a code bug

The pending-confirm guard was designed and explicitly approved, then never
actually implemented across build steps 1–6, because it was added to the
plan *after* the 7-step build order was written, and the build order — not
the full plan — was what got executed from. Nothing could have caught it in
tests: the affected code lived inside `main.ts`, which boots Electron and is
untestable by construction. Found live, via a direct repro (confirm dialog
left open, hotkey pressed, ran as a completely fresh instruction instead of
being blocked). Fixed properly rather than patched: `instructionHotkey.ts`
extracted out of `main.ts` (same reasoning as prior extractions),
`confirmPending` set synchronously before the dialog opens, both hotkeys
guarded, the block spoken aloud rather than silent. **Standing lesson,
worth writing into `CLAUDE.md`:** approving a plan section is not the same
as verifying it's folded into the actual build order.

## Real bugs found via live testing, in the order they surfaced

1. **En-dash/arrow mispronunciation.** Piper reads unspaced dashes and a
   literal U+2192 arrow (found in `remember.ts`'s own output) as garbled
   non-English sounds, not silence or a pause. Fixed via explicit word
   conversion (dash → "to") in `speech.ts`.
2. **Windows console encoding (mojibake), a separate defect from #1.**
   Confirmed via a measured recon probe (comparing synthesis duration with
   and without the fix, not by ear) that this was a real encoding fault.
   Fixed by `PiperSynthesizer` setting `PYTHONUTF8`/`PYTHONIOENCODING`
   itself — placed in the wrapper, not composition, since it's a
   correctness requirement for the engine to work at all, not a choice.
3. **No time normalisation at all.** Piper reads "3:00" as disconnected
   digits ("three zero zero"), confirmed live after the encoding fix ruled
   out mojibake as the cause. Fixed: colon dropped on the hour, minutes
   read as a separate number otherwise, leading zero read as "oh."
4. **Date/month abbreviations ("Mon", "Aug") not expanded**, still broken
   after the first attempted fix. Root cause: Node's ICU and Electron's ICU
   format dates differently (`Wed 26 Aug` vs. `Wed, 26 Aug`), so the
   original expansion rule only matched one shape and silently did nothing
   on the runtime that actually matters — every test had been passing
   because tests run under Node's ICU. Fixed with comma normalisation plus
   two independently-anchored rules, and tests now use literal strings for
   both ICU forms rather than letting the runtime generate its own input.
5. **Speech queue staleness**, reframed from a latency problem to a
   correctness problem: speech can describe a moment that has already
   passed (e.g. announcing a confirm was cancelled, seconds after it was
   already resolved and the user moved on). Fixed: utterances queued more
   than 8 seconds ago are dropped rather than spoken; answering a confirm
   silences anything still queued about it. The ~5s cold-start latency
   itself was left alone — see "deliberately left open" below.
6. **Stopping speech had an awkward side effect** — the only interrupt was
   the hotkey, which also opened the listening bar, needing a separate
   Escape press afterward if a new instruction wasn't actually wanted.
   Fixed: Escape now also stops speech, reusing the existing "never mind"
   gesture rather than adding a new binding.

## Testing-discipline lessons (M13's two, plus one new)

- Recon-before-code applies to any external engine, not just web APIs —
  Piper's real behaviour (UTF-8 requirement, zero time normalisation, ~5s
  cold start, empty-input exit code) was entirely discovered by running it,
  not inferred from documentation.
- A fake must be written independently of the transform it checks, not
  derived from it — `FakeSynthesizer`'s independently-authored strict rules
  caught the real U+2192 arrow bug before any live run; a lenient fake
  would have hidden it.
- **New:** test runtime and production runtime can silently disagree on
  locale-formatted output (Node's ICU vs. Electron's ICU here). Any test
  asserting on `Intl`/date-formatting output should be treated with
  suspicion about whether it actually matches the real app's runtime.

## Deliberately left open

The ~5 second cold-start latency per utterance (Piper reloads its model on
every invocation). The fix is a persistent Piper process or its HTTP server
mode — already named as the escape hatch in the original M14 plan, not
built now because it needs its own live measurement and would have
extended M14 rather than closed it. The queue-staleness fix (#5 above)
means this no longer causes wrong behaviour, only a slow one.

## Extensive side discussion — captured in full in `future_scope_post_m14.md`

A long comparison against HeyClicky happened during live testing, covering
why the experience felt less seamless (push-to-talk + deep conversational
memory + no duplicated on-screen transcript, vs. this app's tap+Enter,
single-previous-turn memory, and screen-as-source-of-truth model) and
whether to adopt Clicky's approach directly (concluded no — different
platform, funded by paid cloud APIs, and Clicky's own team disables risky
capabilities like autonomous email-sending by default rather than solving
the confirm-gate problem this project chose to solve properly). One
alternative TTS engine was researched and rejected (Picovoice Orca — fast,
but requires an account and internet license validation, directly
contradicting the project's own local-first, no-network-call principle).
Three ideas were deferred to future scope with full reasoning already
written up: deeper conversation memory (last N exchanges, not just
"previous turn"), a possible future architecture reversal making the
screen secondary to voice rather than derived from it, and a proposed
bounded auto-listen window for natural follow-ups without re-pressing the
hotkey. **Read `future_scope_post_m14.md` directly before revisiting any of
these — don't re-research Orca, it's a settled no.**

## Carry forward into next chat

- **Immediate decision, not yet made:** fix the cold-start latency and
  record a demo (recommended — this is a portfolio piece, and three solid
  integrations plus working two-way voice is a strong showable state) vs.
  start the next feature milestone (vision-guidance point-not-click mode,
  next on the standing priority list). Resolve this first.
- `future_scope_post_m14.md` holds four researched ideas — consult it
  before any of them gets picked up, rather than re-deriving the reasoning.
