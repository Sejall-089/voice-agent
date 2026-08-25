# Future Scope — Post-M14 Ideas

Captured during M14 live testing (step 7). None of these are in scope for M14 —
each is flagged here specifically so it isn't lost, and isn't re-researched
from scratch later. Revisit after M14's outstanding bugs are closed.

## 1. TTS engine: Picovoice Orca — researched and rejected, don't re-litigate

Orca claims ~106ms time-to-first-speech vs. Piper's ~1,720ms — a real,
dramatic latency advantage if the claim holds. **Disqualified anyway**: Orca
requires a Picovoice account and a valid AccessKey, and needs internet
connectivity to validate that key against Picovoice's license servers on
use, even though synthesis itself runs offline. It's also usage-capped on
the free tier. This directly contradicts the principle already stated in
`spec.md` for M14's engine choice: a feature whose whole premise is local,
nothing-leaves-the-machine must not make a network call at all, let alone
on every session. Piper has no equivalent requirement — no account, no key,
no license check, no cap. **Verdict: stay on Piper.** Only reopen this if a
fully keyless, fully offline fast local engine surfaces later — Orca
specifically is a closed question.

## 2. Deeper conversation memory (last N exchanges, not just "previous turn")

**What it would enable**: natural follow-ups ("what about the other one",
"go on") without needing a dedicated `elaborate` tool call for every case —
closer to how Clicky passes its last several exchanges alongside each new
request so the model can reference what was already said.

**Why it's not a quick add**: `prompt.ts` is read by every tool in the
registry — M13 and M14 both treated changes to that file as needing an
explicit, named decision (the clock addition), not a casual edit. This
would need the same treatment, plus its own new design surface: a bounded
history store (same shape as `DraftStore`/`SpeechStore` — how many
exchanges, what counts as one, a TTL) and a real privacy decision this
project has a sharper version of than Clicky does — this app's history
would include real calendar events and real email content sitting in
active memory across turns, not just "what button did you ask about."

**Recommendation**: worth doing, deserves its own Plan Mode session once
M14 is stable — not a fold-in to any current milestone.

## 3. Screen becomes secondary to voice (architecture reversal)

**Current state**: the screen shows the complete content (full attendee
lists, full schedules, full drafts) and speech is a derived, shortened
companion to it — `core/speech.ts` produces the spoken version *from* the
display text. The screen is the source of truth.

**The reversal being proposed**: speech carries the actual conversation,
and the screen becomes a lightweight supporting glance — closer to Clicky's
cursor-pointer model than a persistent parallel transcript — rather than a
full duplicate of every answer.

**Why it's deferred, not declined**: this isn't a feature, it's flipping
which channel is primary across the entire app. Every existing tool's
output (Gmail, Notion, Calendar, not just the ones M14 touched) would
eventually need rethinking under this model, not just new tools going
forward. Worth pursuing as its own dedicated planning pass once there's
real usage data from M14 showing whether the current duplicate-display
approach is actually a problem in ongoing use, not just in one testing
session.

## 4. Auto-listen reply window (bounded, not always-on)

**The idea**: after the app finishes speaking an answer, keep the mic open
for a short window (roughly 3-4 seconds). Speaking within that window is
treated as a natural follow-up, no hotkey needed. Staying silent closes it
automatically and returns to idle.

**Why this shape specifically, not general always-on listening**: it
doesn't reopen the always-listening privacy concern this project has
deliberately avoided since the voice-input design was first decided (no
wake-word, mic blinks per explicit press) — the window only opens right
after the app itself just spoke, a narrow and predictable trigger, not
persistent listening. It targets specifically "I want to reply to what was
just said" without touching how a fresh, unrelated instruction gets
started, which should keep the deliberate tap-then-speak gesture as-is.

**Why it's still future scope, not a step-7 fix**: it's a real new
interaction design — a timing window, a decision about what counts as
"this was meant as a reply" vs. background noise or talking to someone
else in the room, and its own small state machine. Deserves the same
explicit Plan Mode treatment barge-in and "off is a state" got in M14,
not a quiet addition alongside bug fixes.

## When to revisit

After M14's outstanding issues (date-abbreviation pronunciation, speech
queue staleness, stop-speech/hotkey overlap) are resolved and the milestone
is closed. Any of items 2-4 could become the next milestone's Plan Mode
topic — they don't have to happen in this order, and none of them block
each other.
