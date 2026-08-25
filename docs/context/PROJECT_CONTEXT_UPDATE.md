# Project Context — Update (since original PROJECT_CONTEXT.md)

Read alongside the original `PROJECT_CONTEXT.md`, `spec.md`, `ARCHITECTURE.md`,
`README.md`. This covers everything that happened after v0 (M0–M6) was complete.

## Status
v0's "never run live" caveat is now closed for the OpenAI path. Real LLM calls,
real memory round-trip, real Slack delivery — all confirmed working live.
Anthropic path still untested live (deferred, not urgent).

Voice input is built and hardened (multiple real bugs found via live testing +
fixed, each verified by reverting the fix and confirming the test fails red
first). Latest commit: `7af6594` region, most recent fix `c4857fa`.

## What changed since the original context file

**Provider is now selectable**, not pinned to Anthropic — `LLM_PROVIDER` env var
picks `AnthropicLLMClient` or `OpenAILLMClient`, both behind the same interface.
Currently running on OpenAI (gpt-5).

**Voice input (tap-to-toggle, then simplified to one hotkey):**
- One hotkey (`Ctrl+Shift+Space`) opens the bar AND starts listening.
- Enter stops + submits (works for both typed and spoken input).
- Typing instead of speaking silently cancels the recording, bar stays open.
- 90s auto-cap on recording length; capped-but-unsubmitted audio is held, never
  auto-discarded — only closes on explicit user action (Enter/Escape/click-away).
- Local whisper.cpp, no cloud STT. `WHISPER_EXE_PATH` / `WHISPER_MODEL_PATH` in `.env`.

**Real bugs found via live use + fixed (all with regression tests, all verified
by reverting and confirming red-then-green):**
- Hotkey collision (a combo already bound elsewhere on the test machine) →
  now falls back through an ordered list of combos, tells the UI which one won.
- Stranded event listeners on non-submit hide paths (click-away, blur) → each
  extra stray listener caused the *same instruction to run multiple times* on
  next submit (measured: 6 concurrent planner runs from 1 keystroke). Real
  correctness bug, not just slowness — could have meant repeated Slack sends.
  Fixed by binding cleanup to the window's own hide/close events, not to one
  code path.
- Silent tool-choice failure: a reasoning model's token budget could be consumed
  entirely by reasoning, returning no tool call — appeared as nothing happening,
  not an error. Fixed: raised budget, and made truncation a distinct, logged
  outcome instead of silence.
- 90s-cap could auto-discard an unsubmitted recording if the bar lost focus
  with a stale auto-hide timer pending — fixed, confirmed by manual test
  (blur + tab-switch + wait past 90s, box stayed open).
- Escape didn't work unless the bar had OS focus — but voice recording
  deliberately opens the bar *without* stealing focus (so you can keep talking
  into another app), meaning Escape silently did nothing during the primary
  voice flow. Fixed via a global shortcut scoped to bar-visible time, with care
  taken not to conflict with the confirm dialog's own Escape-as-cancel.
- Typing during active recording cleared the whole command bar (lost whatever
  was typed) instead of just cancelling the voice capture. Root cause: a
  cleanup method meant only for "silence the mic" was also unconditionally
  hiding the window; two unrelated dismissal paths shared one function. Fixed
  by separating "stop the mic" from "close the window" — the caller decides
  which it wants.

**Decisions made (manually verified live, not just discussed):**
- Latency (6.5–12.7s per instruction, mostly reasoning-model `chooseTool` time):
  **left as-is.** Explicitly prioritizing accuracy over speed — a faster/lower-
  reasoning setting was measured as available but risks degrading the
  correction-routing behavior (already flagged as fragile). Not pursuing unless
  it becomes a real problem later.
- Microphone indicator (blinks every hotkey press, including when typing was
  intended): **left as-is.** Measured cost (~162ms warm, ~683ms cold `getUserMedia`)
  is below the perceptible-lag threshold, so it's a pure privacy/UX preference,
  not a performance issue — decided the honest per-press blink is fine over an
  always-on mic stream.
- A "thinking" indicator was added (free, no latency cost) so the multi-second
  wait reads as working rather than frozen.

## Open feature under discussion: instruction-driven reply/compose

The next real feature (from the original roadmap's Phase 1): "select an email
[or any text], speak how to respond, get a drafted reply in my tone."

**Clarified scope, not yet built:**
- Confirmed as buildable now, low-risk: draft-in-tone from selected text +
  voice instruction (generalizes the existing `rewrite` tool), plus iterative
  voice-driven tweaks to the same draft (new small capability — needs the
  planner/tool to reference the previous draft, not start fresh each time).
- **User's ideal flow** goes further: skip manual select/copy (auto-grab email
  content), auto-paste directly into an already-open reply box, and optionally
  voice-triggered send.
- **Flagged as higher-risk / bigger scope, needs explicit decision:**
  - Auto-select without user copying first = simulating "select all" in
    whatever app has focus — fragile, can grab the wrong content depending on
    where focus actually is in a given app.
  - Auto-clicking "Reply" to open the compose box before pasting = genuine
    app-specific GUI automation — exactly the computer-use territory the whole
    project has deliberately deferred to a later phase.
  - Voice-triggered send = needs a real email account integration (Gmail/Outlook
    API), not a small add-on like the Slack webhook was.
- **Proposed middle ground (pending user confirmation):** user manually clicks
  "Reply" and manually hits final "Send" — everything in between (draft,
  auto-paste into the now-open/focused box, voice-driven tweaks) is automated.
  Avoids both fragile auto-select and app-specific click-automation while still
  delivering most of the desired experience.

## Carry forward into next chat
- Confirm with the user whether the "middle ground" scope above is accepted,
  or whether they want to push toward full auto-click automation despite the
  fragility/scope-creep tradeoff.
- Once scoped, this is a new milestone: needs a Plan Mode prompt, likely
  Opus-high-effort for planning (new tool + paste-back primitive + draft-memory
  session state are all new design surface), Sonnet-standard for the mechanical
  implementation once approved.
