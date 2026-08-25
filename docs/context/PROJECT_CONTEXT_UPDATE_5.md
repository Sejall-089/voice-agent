# Project Context — Update 5 (M13 Calendar: built, live-tested, closed)

Read alongside the original `PROJECT_CONTEXT.md`, `PROJECT_CONTEXT_UPDATE.md`
through `_UPDATE_4.md`, `spec.md`, `ARCHITECTURE.md`, `CLAUDE.md`. This closes
out M13 end to end: Plan Mode, build, live OAuth setup, live testing, two bugs
found and fixed, and the milestone is now done.

## Status

M13 is complete. Three tools live and working: `readSchedule`, `createEvent`,
`moveEvent`. Full suite green at 345/345. Three commits landed the build
(`4e5e62e`, `b8dea76`, `18bdb48`), two more fixed live-testing bugs
(`ac49678`, `4b52f75`).

## What got built (recap from the Plan Mode confirmation)

Google Calendar, API-based (not DOM/CDP like Gmail/Notion) — calendar events
are structured data with no live draft box worth building. Two interfaces,
split at the seam the plan called for: `CalendarSurface` (what the tools
depend on) and `CalendarAuth` (a constructor argument of the real
`GoogleCalendar` only, never in `ToolDeps` — so `FakeCalendar` needs no fake
OAuth at all). Argument-dependent risk tiers landed as real infrastructure,
not a one-off: `createEvent`/`moveEvent` are `caution` with no attendees,
`dangerous` with attendees, since invites fire at creation/move with no
separate send step to gate. `resolveRisk` runs once per call, after
`deps` is built, and both narration and confirm read that one answer —
closing a real gate-hole risk (two independent resolutions could disagree).

A clock was added to the planner prompt (`prompt.ts`) as a same-commit
prerequisite — no tool anywhere had ever needed the model to know the current
date/time before, and every M13 tool takes an ISO instant the model has to
resolve from phrases like "tomorrow at 3."

## The OAuth setup saga (worth remembering, not repeating)

Getting a working Google Cloud OAuth app took most of a session, almost
entirely Google Console mechanics rather than app bugs:

- `response_type` missing from the first `calendar-connect.mjs` build —
  fixed before first use.
- `access_denied` on a Testing-status app for an account not on the test-user
  list — worked around by adding the account as a test user rather than
  fighting the "Publish app" button.
- "Publish app" stayed greyed out despite Branding being fully filled in,
  for reasons neither Claude Code nor I could pin down from the console UI
  alone (Data access/scopes declaration was the leading suspect, never
  confirmed). **Left unresolved** — worked around via test users instead.
  If this surfaces again, check the Verification Centre tab, which never
  got inspected this round.
- A leaked refresh token (pasted into chat) was rotated by revoking the
  app's access from the Google account's permissions page — which turned
  out to invalidate *every* token for the app, not just the one, and
  produced a `revoked` error on the very next fresh token. Worth knowing:
  revoking access at the account level is an all-tokens action, not a
  single-token action.

## Two real bugs, found only by live testing

**Bug 1 — wrong endpoint for the scope.** `calendarTimeZone()` called
`GET /calendars/primary`, which the `calendar.events` scope doesn't grant.
Since that call opened nearly every path (narration, confirm, `readSchedule`),
every calendar instruction failed while the token was completely valid — a
manual `curl`/`Invoke-RestMethod` token refresh against Google directly is
what proved the token was fine and the bug was in the app. Fixed by reading
the timezone off any `events.list` response's envelope instead of a separate
call — `readSchedule` is now down to one HTTP call in the common case.

**Bug 2 — `403 → revoked`, unconditionally.** This is what made bug 1
undiagnosable from the app's own error message: a missing scope, a disabled
API, and a rate limit all return 403, and only one of those means "access
was withdrawn." Telling the user to reconnect for a scope problem sends
them in a circle — reconnecting requests the same scope. Fixed by
classifying from the error envelope's `reason` field; a fourth
`CalendarAuthReason` (`insufficient-scope`) was added.

**Bug 3 — `moveEvent` search extraction.** The tool description told the
model to describe the event "as the user described it," which literally
instructed it to include filler words ("the," "meeting") in the search term.
Google's `q=` search then failed on completely natural phrasing like "move
the standup meeting" while working fine on the bare name. Fixed two ways at
once: the tool description no longer invites filler words, and
`resolveTargetEvent` now tries the exact phrase first and only strips filler
words on a retry if that finds nothing — safe specifically because `q=` ANDs
its terms, so stripping words can only ever widen a match, never redirect it
to a different event. Refusals now name every term actually tried.

## Two testing-discipline lessons worth keeping permanently

1. **"Thin transport, only a live run can prove it" is half right, and the
   dangerous half.** `GoogleCalendar.ts` was shipped untested on the same
   argument that justified `ChromeGmail`'s live-only testing. Both real bugs
   (timezone endpoint, revoked misclassification) lived in the half of that
   file that's ordinary branching logic, not network shaping — and that half
   is exactly the part that decides what a person gets told when something
   breaks. Split going forward: request/response *shaping* against a live
   API genuinely needs a live run; error *classification* is testable
   against captured fixtures and should be, every time.

2. **A fake more lenient than the real service can hide the exact bug it
   exists to catch.** `FakeCalendar.findEvent` matched on substrings, so
   `"the test one meeting"` and `"test one"` both failed against a
   real-looking fixture — for entirely different reasons that looked
   identical in the fake. The bug 3 fix could not have been test-driven
   under that fake; it had to be found live. `FakeCalendar` now requires
   every search term to appear, mirroring the actual property the tools
   depend on (`q=`'s AND semantics), so the next fake-vs-real mismatch like
   this one is at least structurally less likely.

Both lessons are worth writing into `CLAUDE.md` or `spec.md` directly, next
to the existing testing-discipline notes, rather than only living in this
file — carried forward below.

## Live test results (full list, for the record)

Passed: clock/time resolution, `readSchedule`, `createEvent` (no attendees:
narrates and creates; with attendees: confirms, names everyone, declines
correctly cancel, invite delivery confirmed), zero-match refusal on
`moveEvent`, multi-match disambiguation on `moveEvent` (exceeded spec — names
both candidates with their times and takes a follow-up answer, rather than a
flat refusal), and the extraction fix's generalization to the original
failing phrase after the fix landed.

Noted, not blocking: one intermittent miss where `createEvent` failed to
extract an attendee's email that was explicitly present in the instruction,
then succeeded on an identical retry. Not reproducible on demand — same
general class as the M10 `chooseTool` truncation issue (a reasoning model
occasionally not completing its intended output). Sent to Claude Code as a
flag, not a fix request.

## Carry forward into next chat

- Write the two testing-discipline lessons above into `CLAUDE.md`/`spec.md`
  directly — they're general, not calendar-specific, and worth being visible
  before the next integration's Plan Mode session rather than rediscovered.
- The "Publish app" greyed-out mystery is still unresolved; the project is
  running fine on test users instead (with the 7-day refresh-token
  expiry as a minor known cost). Revisit only if that expiry becomes
  actually annoying, not proactively.
- M13 is done. Next milestone, per the standing priority list benchmarked
  against HeyClicky's actual feature set: voice output (TTS), then
  vision-guidance point-not-click mode, then narrow multi-step autonomy,
  with full vision-based auto-click deliberately last. Calendar closes out
  the "named integrations" gap (Gmail, Notion, Calendar all shipped on the
  same pattern) — worth deciding at the top of the next session whether to
  proceed straight to TTS or revisit priorities now that three integrations
  share one proven shape.
