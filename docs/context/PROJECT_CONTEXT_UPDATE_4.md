# Project Context — Update 4 (M10, M11, M12 shipped and live-verified)

Read alongside `PROJECT_CONTEXT.md`, `PROJECT_CONTEXT_UPDATE.md`, `PROJECT_CONTEXT_UPDATE_2.md`,
`PROJECT_CONTEXT_UPDATE_3.md`, `spec.md`, `ARCHITECTURE.md`. This closes out a long session that
took the project from "M10 decided but unbuilt" through three fully shipped, live-tested
milestones. Nothing here changed a plan mid-flight — every milestone below went through the
same rhythm: Plan Mode (Opus, high effort) for the design, mechanical implementation (Sonnet,
standard) against the approved plan, then live testing on the real target, which found at
least one real bug in every single milestone that no fixture had caught.

## Core architecture (unchanged, for orientation)

Electron + React + TypeScript. A tool-calling planner (`core/planner.ts`) lets an LLM pick one
tool per instruction from a registry, gated by a risk tier (`core/risk.ts`: `safe`/`reversible`
run silently, `caution` runs but narrates first via the `notify` shell action, `dangerous`
requires `shell.confirm()`). SQLite-backed memory with fact versioning and corrections
(`remember` supersedes rather than overwrites). Every tool is a pure function of
`(input, ToolDeps)`, tested headlessly against fake implementations of each external surface
(`GmailSurface`, `NotionSurface`, `InputInjector`, etc.) — nothing in `/core` imports electron.

## M10 — Gmail reply (commit `44b18a3`, shipped; follow-up fixes on top, latest commit
current as of this doc)

Three tools gated behind `CHROME_DEBUG_URL`: `draftReply` (caution), `reviseDraft` (caution),
`sendReply` (dangerous, behind the confirm gate). DOM/accessibility-tree automation via a
hand-rolled CDP client (`core/browser/CdpClient.ts`, no puppeteer) — deliberately not
vision-based; full auto-click stays deferred, not abandoned, as a later generalization.

**Live-testing bugs found and fixed:**
- Gmail's real Reply control is `role="link"`, not `role="button"` — the original
  `gmailScript.ts` fixture had guessed wrong and was never validated against a live page
  before the first live run.
- `setComposeText`'s original two-step focus-then-`insertText` raced with Gmail's own
  React re-render, appending instead of replacing. Fixed by making focus+select+
  `execCommand('insertText', ...)` one atomic in-page call.
- `planner.ts`'s `refuse()` was discarding the model's real declined-text behind a hardcoded
  generic message. This mattered a lot: what looked like two unrelated bugs (a vague
  instruction reusing old content one time, and "I don't have a tool for that" another time)
  turned out to be the same root cause — the model was often genuinely asking a clarifying
  question that was being silently thrown away. Fixed to surface `choice.text` when present.
- Decided (after a real, worked-through debate, not just a rule copy-paste): content invention
  should depend on whether the *instruction* gave real content, not on which app it's for.
  Real content given → write exactly that, in either app. No content given → Gmail gives a
  safe, neutral acknowledgment (a real person is waiting on a reply); a note-taking app should
  refuse/write nothing (nobody is waiting on a note). Implemented by tightening
  `composeShared.ts`'s `noInventionClause` to also forbid unrequested elaboration/advice, not
  just factual invention — a vague Gmail/Notion instruction was fabricating whole paragraphs of
  unrequested content before this fix.
- Added real-name personalization: the sender's actual display name (captured in
  `gmailScript.ts`'s `readOpenEmail`, via the `name` attribute or text-content fallback on the
  same `span[email]` element) and the user's own stored name (new `storedName()` in
  `replySupport.ts`, reading memory subject `"name"`) both flow into `compose.ts`, so a reply
  can open "Hello Vikram Rajput," and sign off "Sejal" instead of a neutral fallback.
  Confirmed working end-to-end on a real thread.

## M11 — Notion (commit `1f9778f`, shipped)

**Key design decisions from Plan Mode:**
- `compose.ts` stayed *split*, not generalized — measured the actual coupling first and found
  nearly all of `compose.ts`'s content (greeting, sign-off, "no subject line") is
  email-specific. Extracted only the genuinely shared bits (`voiceLine`, `noInventionClause`,
  `requireNonEmpty`) into `composeShared.ts`; Notion got its own `composeNote.ts` with its own
  rules (no greeting/sign-off — a note appended to a page never had one to begin with).
- One tool, `caution` risk tier — not three tools mirroring Gmail's shape, and explicitly not
  `reversible`: Notion's own page history is another company's feature on a plan tier this app
  can't verify exists, so claiming `reversible` would be a safety claim with no backing.
- Scope stays "whatever's open," with a two-stage visibility refinement — most Notion tabs
  satisfy "has an editable page," so the flat zero-or-many refusal pattern from Gmail would fire
  constantly without narrowing by `visibilityState === "visible"` first.
- No Notion-side draft/scratch store — Gmail's `DraftStore` exists because a reply has a
  staging area with a real lifetime; Notion has neither, so there's nothing to hold.
- A recon script (`scripts/notion-recon.mjs`, plain ESM, uncommitted until it landed with the
  rest of the milestone) inspects Notion's real DOM *before* any selector gets written —
  learned directly from M10's initial guessing mistake.

**Live recon found two real, expensive-to-discover facts, now saved here so they never need
rediscovering:**
- Notion's editor silently no-ops on JS-dispatched `.click()`, `.focus()`, and
  `document.execCommand()` — they report success and save nothing. Confirmed across five
  independent live attempts before finding what actually works: real CDP-level input
  (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`), not the `execCommand` approach that
  worked fine for Gmail.
- A single `insertText` call with an embedded `\n` silently drops everything after the first
  line — multi-line notes need a real Enter keypress between each line, not a literal newline
  character in one call.
- Architecture consequence: `notionScript.ts` only *finds* (jsdom-testable, mirrors
  `gmailScript.ts`'s discipline); `ChromeNotion.ts` does the *acting*, since real device input
  can't be issued from inside an injected script the way `execCommand` could. `appendToPage`
  verifies success by reading the page back afterward, rather than trusting that the input
  calls worked — because Notion can report success on an operation that did nothing.

## M12 — System-wide dictation (commit `56ffd50`, shipped; two live-testing rounds of fixes
on top)

**What this is, in one sentence:** hold nothing, tap a hotkey to start, speak, press Enter to
type the transcript into whatever OS window currently has focus — in *any* app, not just this
one. Deliberately never touches the planner: no tool selection, no risk-tier gate, because
there's no model *choice* for a gate to constrain.

**Key design decisions from Plan Mode:**
- Insertion via a persistent PowerShell child process hosting one P/Invoke declaration
  (`SendInput` + `GetForegroundWindow`), using `KEYEVENTF_UNICODE` — chosen over UI Automation
  (which has no insert-at-caret API at all; `ValuePattern.SetValue` *replaces* the entire
  control's value, and rich editors like Word/VS Code/Notion/Slack only expose the read-only
  `TextPattern`, not `ValuePattern`) and over clipboard+paste (would race the app's own
  clipboard-based context-capture channel, `WindowsShell.getContext()`).
- `SendInput`'s return value (count of events actually accepted) is the real success signal,
  never downgraded to a boolean, never swallowed — a short return + `GetLastError()` becomes a
  thrown error. This is the direct, explicit lesson from M11's `execCommand()` lying about
  success.
- Raw transcript only for v1, no cleanup/rewrite pass — preserves latency as the feature's
  entire value proposition (a planner round trip is 6–13s per spec §3b; dictation's whole
  point is immediacy), and avoids running unreviewed generated text straight into a live
  document with no draft/confirm step to catch a bad rewrite.
- No new risk tier — `risk.ts` is metadata the planner consumes *after* a model has chosen a
  tool; dictation never reaches the planner, so there's nothing for a gate to gate. The
  `caution` *behavior* (narrate first, verify after, refuse rather than guess) is achieved
  without the formal machinery: names the target window before typing, keeps the transcript
  visible after, and refuses (types nothing) if focus changed between trigger and insertion.
- Originally shipped as a same-hotkey toggle (tap to start, tap again to stop); switched to
  tap-to-start / **Enter**-to-finish after live use showed people reflexively reach for Enter
  (same mental model as the instruction bar's own M8 flow). Enter is registered as a global
  shortcut scoped to exactly one recording's lifetime, same precedent as the existing global
  Escape handling.

**Live-testing bugs found and fixed, across two separate rounds:**
- **Character-repetition corruption** on longer dictations ("mmmmmm", "IIIIIIII" appearing
  mid-sentence, permanent, not lag). Two wrong theories were tested and ruled out first
  (burst size — dropping `CHUNK_SIZE_CHARS` to 1 didn't fix it; a `finish()` double-fire race —
  plausible from the code but the evidence didn't actually support it once examined closely).
  Root cause: `CHUNK_DELAY_MS = 8` between `SendInput` chunks was fast enough to trip Windows'
  own key-repeat handling — `KEYEVENTF_UNICODE` events carry `wVk = 0` (no real virtual-key
  code), and a rapid-enough stream of them was observed to cause genuine OS-level character
  auto-repeat, not an app-rendering lag. Fixed by raising `CHUNK_DELAY_MS` to `40`. Confirmed
  clean afterward on a previously-corrupted long sentence.
- The 30-second auto-stop cap was a real safety-ceiling *design* decision (not a session-length
  target — normal ending is pressing Enter) — but live use showed speaking past 30s silently
  cut off mid-sentence with *no warning beforehand*. Fixed two ways: raised
  `DEFAULT_MAX_RECORDING_MS` to `90_000` (matching the instruction bar's own cap) after
  confirming this was genuinely needed via testing; added a spoken warning ~10 seconds before
  whatever the cap is, via a second, separately-cleared timer in `DictationSession.ts`.
- The dictation hotkey shipped as a 4-key combo (`Ctrl+Shift+Alt+D` → `Ctrl+Alt+D` →
  `Ctrl+Alt+J`, deliberately excluding `Ctrl+Alt+V`/`Alt+Shift+D` since those are real
  Excel/Word shortcut conflicts) and was found too slow to reach for repeatedly in real use.
  Researched HeyClicky's own hotkeys for comparison (`Fn+Control` for dictation, `Control+Option`
  for its agent mode — both 2-key *holds*) — confirmed hold-vs-tap genuinely isn't available on
  Windows the way it is on macOS (Electron's `globalShortcut` has no key-up event without a
  much heavier `WH_KEYBOARD_LL` hook), so tap-to-start/Enter-to-finish stays correct. Shortened
  the *tap* combo instead: `Ctrl+M` now tried first in the fallback list, ahead of the original
  longer options, after checking it against known Chrome/VS Code/Word/Excel bindings.

**Cross-app live verification, ongoing:** confirmed clean (correct transcript, no corruption)
in Notepad, Chrome's address/search bar, and VS Code (the one most expected to react badly to
synthetic keystrokes, given autocomplete/format-on-type — it didn't). **Still to test: Word,
a terminal.** Terminal specifically needs checking that a long dictated sentence sits as
unsubmitted text rather than accidentally running as a command, since dictation deliberately
never presses Enter itself.

## Parked for a real future milestone, not in scope now

True continuous "type as you speak" dictation (Google's live voice typing, HeyClicky's own
~450ms streaming) was seriously discussed and deliberately deferred, not just deprioritized.
It requires swapping Whisper's batch-transcription model for a genuine streaming ASR service,
and creates a real, currently-unsolved safety problem: streaming transcripts get *revised*
mid-sentence, but characters already sent via `SendInput` into someone else's live document are
real keystrokes with no way to read them back and safely correct — unlike Notion's own
`appendToPage`, there's no generic "reread what actually landed" move available for arbitrary
Windows apps. Current batch-then-type trades some perceived latency for staying simple, safe,
local (no API key), and free.

## Future scope discussed tonight, not yet built

Compared directly against HeyClicky's actual published feature set (verified via research,
not assumption) to figure out what "feature-complete" should actually mean for this project.
Six real capability gaps were identified; system-wide dictation (above) was the first one
closed. Sequenced by risk and dependency, not by ambition. Each item is marked as either a
directly confirmed HeyClicky feature or this project's own extrapolation, since that
distinction matters and shouldn't get lost:

1. **More named integrations** *(confirmed HeyClicky feature — Gmail/Notion/Calendar)*. Same
   reliable, tested pattern as Gmail/Notion — find real controls by role/accessible name,
   confirm-gate anything irreversible. Calendar is the next logical one (a real Windows
   equivalent exists via Outlook or Google Calendar's web UI). Highest leverage per hour of
   any remaining item, since the pattern and safety model are already proven twice.

2. **Voice output (TTS)** *(confirmed HeyClicky feature — ElevenLabs)*. HeyClicky speaks its
   answers; this project currently only shows text. A real, separate milestone — pick a TTS
   provider, wire it through the same risk-tier/narration path `notify` already uses. Not yet
   scoped in detail.

3. **Vision-based guidance mode — point, don't click** *(confirmed HeyClicky feature — their
   own screen-aware guidance mode)*. Screenshot → model → point a cursor at the right UI
   element, user clicks it themselves. This is the *safest* version of "works on any app, not
   just named integrations," and directly matches the `clacky`-prototype pattern from earlier
   research, which is real and provably safe (unlike item 4 below). A real design requirement
   carried over from HeyClicky's own privacy model, worth stating explicitly whenever this gets
   built: screen capture only on hotkey press, nothing stored.

4. **Full vision-based auto-click** *(this project's own extrapolation, not a literal
   HeyClicky feature)*. HeyClicky's own guidance mode has the user click; their autonomous
   "Clicky agent" mode for named integrations is almost certainly API-backed for those specific
   apps, not general screen-clicking. This item is reasoning about what genuinely *universal*
   coverage (any app, no DOM/accessibility tree, fully autonomous) would eventually require —
   not something HeyClicky has shown or claimed as its own feature. Deliberately sequenced
   last: the most credible open-source reference found in earlier research
   (`Raynan00/clacky`) has its actual acting loop unimplemented, which is real evidence this is
   harder than it looks. Also the one capability class that's structurally hard to test the
   disciplined, headless way everything else in this codebase is tested.

5. **Narrow multi-step autonomy** *(the capability is a confirmed HeyClicky feature — "Clicky
   agent" is genuinely autonomous multi-step execution; the specific scoping below is this
   project's own recommendation, not something HeyClicky has published)*. Not an open-ended
   agent loop — scoped as "chain 2–3 *known* steps for one well-defined task" (e.g., draft a
   reply *and* file the email into a label, as one instruction), the same discipline as
   choosing Gmail-only over "any app" for M10. This is a real philosophy change from the
   current one-instruction-one-tool-one-confirm model, not a bolt-on, and needs its own safety
   design (a whole-plan approval upfront, vs. today's per-step confirm) before it's built.

Also parked here for continuity: the streaming/"type-as-you-speak" dictation idea already has
its own write-up above *(confirmed HeyClicky feature — their dictation streams at ~450ms)* —
it's related to this list (it's the deferred, harder version of item 1's dictation work) but
kept separate since the reasoning for deferring it is dictation-specific, not part of this
broader six-item comparison.

## Carry forward into the next chat

- Finish M12's remaining live-app checks: Word, a terminal.
- Once that's closed out, M10/M11/M12 are all genuinely done — not just "looks done." Worth
  considering a README rewrite + short demo recording as the actual highest-leverage next
  move for the portfolio, rather than reflexively reaching for another milestone.
- If another milestone does come next: the three real directions discussed and left open are
  more named-app integrations (Calendar was the next logical one, same pattern as
  Gmail/Notion), narrow multi-step autonomy (chain 2–3 *known* steps for one task, not an
  open-ended agent loop), and vision-based/any-app clicking (the `clacky` research path,
  explicitly the hardest and highest-risk of the three, deliberately sequenced last).
