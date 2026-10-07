# M18 — live verification checklist (by hand)

> **OPEN — and it has already earned its keep twice.** The live pass has found two real bugs the
> whole suite was green through:
>
> 1. **A units bug in `systemVolume`** — the model said percent, the code read key presses, so
>    "turn it up by 10" moved the volume 20%. Fixed; see section 4.
> 2. **The input host swallowed its first command** — intermittent "did not respond in time" on
>    media keys, caused by the `-Command -` invocation, and silently affecting dictation's first
>    take too. Fixed; see section 0b.
>
> Neither was reachable by any fixture. The first was a disagreement about units at the boundary
> where a human meets the tool; the second lived in a spawned process. Sections 0b and 4 are the
> first things to confirm.
>
> Written *before* the live pass rather than after it, and each item says what could actually be
> wrong — a checklist of specific doubts, not a lap of the feature. See spec.md §9's
> "M18 — proven vs. live-only" for the same split from the other side.
>
> **Progress (2026-10-07):** sections 0, 1, 3, 4, 5 and 6 have been run by hand and their
> results are recorded in place. Section 0b is one of three done. Section 2 is script-verified
> only, and so are the parts of sections 7 and 9 that have results. Section 8 has nothing
> recorded yet.
>
> **How results are marked.** Every recorded result says which kind it is:
>
> - `[x]` **Human-verified** — a person at the keyboard saw it in the running app.
> - `[ ]` **Script-verified** — a script exercised the real code path and the box stays open,
>   because that is a weaker claim (CLAUDE.md: a log line proves what the app decided, not what
>   the user saw). It still needs a person.
>
> A third bug came out of section 1 (the raw `0x483` text) and two observations are still
> unexplained — see "Live results" at the bottom.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.)

---

## 0. THE REGRESSION CHECK — do this one first

**Dictation still types.** `HOST_SCRIPT` in `WindowsInputInjector.ts` gained a `KEY` command.
The `TYPE` path was not touched, but both share one PowerShell host, and that file carries its
own KNOWN ISSUE note (M16.8) about the fragility of its `-Command -` invocation.

- [x] Open Notepad, press the dictation hotkey, say a sentence, press Enter. It types.
      **Human-verified.** Dictation still types.
- [x] Do it again with a longer sentence (20+ words). No repeated characters ("mmmmmm"), no
      dropped words. **Human-verified:** the original 20-word sentence works, and so does a long
      dictation of 150+ words — which the old flat 20 s `TYPE` budget could not have finished.
      *One exception, on a different sentence: see open observation 2 ("aame").*

**If this fails, stop and revert the HOST_SCRIPT change before anything else.** A broken
dictation path is worse than a missing volume key.

*Symptom to watch for: the bar narrates "Dictating into —" and then types nothing, with no
error — a `TYPE` that never gets a reply and times out.*

---

## 0b. THE FIRST-COMMAND CHECKS — a FRESH LAUNCH before each one

> **Why this section exists.** Live testing found "The input host did not respond in time."
> intermittently on media keys. The cause was not latency and not staleness: with
> `-Command -`, PowerShell treated **stdin as the script source** and swallowed the host's
> **first command**, exactly once per host. Measured — spawn→READY in 739 ms against a 10 s
> budget, command #1 getting *no reply at all* for its full budget with the child still alive,
> then #2 onwards at 1–3 ms forever. Waiting did not help (0/50/250/1000 ms after READY all
> identical); `-File` answered in 5–8 ms at every delay.
>
> **It was never a media-key bug.** The host is shared, so dictation's first `FG` after a launch
> was being swallowed too — it just looked like one odd "couldn't tell which window" that worked
> on the retry. These checks each need a **cold start**, because "first command per host" is the
> only state in which the old bug appeared.
>
> After the fix: **request #1 replies in 73 ms** (cold path 827 ms including spawn), then 1 ms.
> 59/59 commands clean across back-to-back, 10 s and 60 s idle.

Quit the app completely before **each** of the three, so each one really is a first command:

- [ ] **Fresh launch → "pause" as the very first thing.** It must work on the first try. (Before
      the fix this is the command that failed.)
- [ ] **Fresh launch → dictation as the very first action**, into Notepad. The first take must
      type. This is the half nobody noticed was broken.
- [x] **Fresh launch → "turn the volume up by 10" as the very first command.** Works first try,
      and moves the volume ~10% (see section 4 for the units fix). **Human-verified.**
- [ ] Then run section 0's dictation checks again on that same launch, to confirm the host still
      serves `TYPE` after a `KEY` has used it.

*Not yet recorded: "pause" as the first command, dictation as the first action, and the
same-launch `TYPE`-after-`KEY` check. The long-dictation and 20-word results are recorded under
section 0; it was not noted whether they followed a `KEY` on the same launch.*

If any of these still fails, the two recon scripts reproduce it without the app:

```
INPUT_HOST_DEBUG=1 npx vite-node scripts/input-host-bench.ts     # cold start, 50 back-to-back, idle phases
node scripts/ps-stdin-probe.mjs                                  # isolates -Command - vs -File
```

`input-host-bench.ts` presses an **inert** virtual key (0x07) by default, so it will not move
the volume or toggle anyone's music; pass `--real` for audible volume up/down pairs. Both print
verbs only — never a keycode or a dictated-text payload. `INPUT_HOST_DEBUG=1` works on the app
itself too (`INPUT_HOST_DEBUG=1 npm run dev`).

---

## 1. Opening the built-in apps

- [x] "open Notepad" → Notepad opens. **Human-verified.**
- [x] "open calc" → Calculator opens (the alias path). **Human-verified** — but see open
      observation 1: once, "open calc" came back as chat text and ran no tool.
- [x] "open files" → File Explorer opens (the alias path). **Human-verified.**
- [x] "open Spotify" → Spotify opens, via its `spotify:` protocol handler. **Human-verified,
      with Spotify installed — on the SECOND attempt.** The first attempt ran no tool and
      returned chat text instead; see open observation 1. (The `0x483` run below was without
      Spotify installed.)

**What to look for if Spotify is not installed:** Windows may show a "how do you want to open
this?" system dialog instead of failing. `openExternal` would then report success, and the app
would say "Opened Spotify" for a launch nobody saw. Note what actually happens — if it reports
success wrongly, that is a real finding and the honest fix is in the message, not the launcher.

> **RESULT — human-verified, and it was a finding, though not the one predicted.** With Spotify
> not installed there was no system dialog and no false success. The launch **failed**, and the
> app showed the raw text:
>
> `Failed to open: No application is associated with the specified file for this operation. (0x483)`
>
> Honest, and unreadable. `0x483` is Win32 `ERROR_NO_ASSOCIATION`: nothing is registered for
> the `spotify:` protocol. **Fixed:** `appLaunch.ts` now maps exactly that case to
> *"Spotify doesn't seem to be installed."* and keeps the raw reason out of the text; every
> other launch failure still shows its own reason. **The fix is script-verified only**
> (`tests/appLaunch.test.ts`, with the real error text above as a literal — the test it replaced
> used an invented sentence the OS never says).
>
> - [ ] Re-check by hand: with Spotify not installed, "open Spotify" says *"Spotify doesn't seem
>       to be installed."*

- [x] "open Photoshop" (or anything not installed) → refused, and the refusal lists
      *Spotify, Notepad, Calculator and File Explorer*. **Human-verified:** unlisted names are
      refused with the four-app list.
- [x] "open spotifyy" (one typo) → refused, not approximated. **Human-verified:** refused, not
      guessed.

## 2. `APPS_EXTRA`

Set in `.env`, then restart (it is read once, at startup):

```
APPS_EXTRA=VLC=C:\Program Files\VideoLAN\VLC\vlc.exe|Bad=notepad.exe /A
```

The two console lines appear **in this order** — problems are printed first, then what was
added (`main.ts` loops over `problems` before it reports `entries`):

- [ ] The console shows `[main] I ignored the APPS_EXTRA app "Bad" — "notepad.exe /A" has
      arguments, and I only launch a bare command.`
- [ ] The console shows `[main] APPS_EXTRA added: VLC`.
- [ ] "open VLC" works.
- [ ] "open Bad" is refused and **nothing launches** — the malformed entry is never in the
      catalog, only in the report.

> **Script-verified only (2026-10-07), all four — none seen in the running app.** The real
> `parseExtraApps` and `createAppLauncher` were run on the exact `APPS_EXTRA` value above, with
> `main.ts`'s three lines of wiring replayed by the script and the two launch functions
> replaced by recorders:
>
> - Both console lines came out word for word, "I ignored" first.
> - "open VLC" handed `C:\Program Files\VideoLAN\VLC\vlc.exe` to `spawn`. That is the launcher
>   choosing the right command, **not** VLC opening.
> - "open Bad" was refused with *"I can't open Bad — I can only open: Spotify, Notepad,
>   Calculator, File Explorer and VLC."* and nothing reached `spawn` or `openExternal`.
>
> What this cannot show: that `main.ts` itself prints them (nothing can import it), and that
> VLC starts.

## 3. Opening an app that is already running

- [x] With Notepad already open, "open Notepad" again. Record what happens: a second window, a
      focus switch, or nothing. All three are plausible and the app currently claims only
      "Opened Notepad", which is true in every case — but if it starts a second copy every
      time, that is worth knowing.

> **RESULT — human-verified:** it starts a **second window every time**. No focus switch to the
> existing one. "Opened Notepad" is still true, so nothing is wrong in the text; whether to
> focus an existing window instead is a product decision, not a bug, and is not decided here.

## 4. Volume

> ### ⚠ A UNITS BUG WAS FOUND HERE AND FIXED — re-test this whole section
>
> **Measured:** one press of the volume key moves the system volume **2%** on this machine. The
> default 5 presses moved it **28 → 38** and **14 → 24** — 10%, consistent in both directions.
>
> **The bug that measurement exposed.** `systemVolume`'s argument used to be `presses`, so
> *"turn the volume up by 10"* had the model pass `10` and the volume moved **20%**. Neither
> side was wrong on its own terms — **they disagreed about the unit.** A press count is an
> implementation detail that had no business being in the model's vocabulary; nobody says "turn
> it up by ten key presses". People mean percent.
>
> **The fix.** The argument is now `percent`, and `core/media.ts`'s `pressesForPercent` converts:
> `presses = round(percent / 2)`, minimum 1, still capped at 15 presses — which is **30%**, and
> the description now states the cap in percent. The default is unchanged at 5 presses (10%)
> when no amount is given.
>
> **The result text changed afterwards, for the same reason.** It used to read "Sent volume up 5
> times" — a press count again, on the way out. It now reports the change in percent:
> *"Volume up about 10%"*. The number is presses × 2 (what was actually **sent**, so "by 5"
> reads "about 6%"), always with "about" because the 2% step is a measurement, and a capped
> request says so: *"Volume up about 30% (my limit per request, you asked for 80%)"*. It still
> never states a resulting level ("now at 40%", "to 50%"), because nothing can read the volume
> back. Mute still reads "Sent mute".
>
> **Why this was invisible to the whole test suite.** Every test asserted that a given argument
> produced a given number of presses, and they all passed — they were *correct about the
> conversion that existed*. No test could question whether the unit was the one a person means,
> because the fixture supplied the argument. This is the same shape as M16.9's ordering bug:
> internally consistent, green, and wrong at the boundary where a human meets it.
>
> **Not a universal constant.** 2% per press is the Windows default *as measured on this
> machine*. It is a registry/driver detail and some audio drivers and keyboards do their own
> thing. `PERCENT_PER_PRESS` in `core/media.ts` is the single place to change it, and a test
> pins it at 2 with its provenance so a change has to be deliberate.
>
> **What to re-check now:** that "by 10" moves it ~10% and not ~20%, and that "by 5" moves it
> ~6% (it rounds half **up** — 2.5 presses becomes 3, because a small request that
> under-delivers reads as the app having ignored it, while 1% over is inaudible).

Open the Windows volume indicator so the level is visible while testing.

- [x] "turn the volume up" → the level rises by ~10%. **Human-verified. MEASURED: 28 → 38 and
      14 → 24.** One press is about 2%, the default of 5 presses is 10%. `DEFAULT_PRESSES` stands.
- [x] **"turn the volume up by 10" moves it ~10%, not ~20%** — the units-bug regression. This is
      the one to check first in this section. **Human-verified.**
- [x] "turn it up by 5" moves it ~6% (rounds half up, 2.5 presses → 3). **Human-verified.**
- [ ] "set the volume to 50%" is refused or redirected, not silently treated as a relative
      change. The description tells the model this is impossible; worth seeing what it does.
- [x] "turn the volume down" → it **falls**. (If it rises, the virtual-key table is transposed —
      0xAE/0xAF are adjacent, which is exactly why there is a test for it.)
      **Human-verified:** it falls by 10.
- [x] "mute" → mutes. Say it again → unmutes. One press, every time. **Human-verified.**
- [x] From 0: "turn the volume up" works and does not wrap round. **Human-verified.**
- [x] From 100: "turn the volume up" is a no-op, not an error. **Human-verified.**
- [ ] "turn the volume up by 30" → the cap: 15 presses. **Watch for a stuck or auto-repeating
      key.** The 40 ms inter-press gap is inherited from M12.1's measurement of
      `KEYEVENTF_UNICODE` events, which carry `wVk = 0`; a real virtual key is a different
      signal to Windows' key-repeat handling, so that number is borrowed rather than verified
      for this case. If it misbehaves, `CHUNK_DELAY_MS` is the knob.
- [x] "turn it up by 80" → still only moves ~30% (the cap), and says so by sending 15 presses
      rather than refusing. **Human-verified: 10 → 40.** Exactly 30% from 15 presses, so that
      run showed no stuck or repeating key either — but "by 30" itself, the item above, was not
      run as its own check.
- [ ] The result reads *"Volume up about 10%"* — and for "by 80",
      *"Volume up about 30% (my limit per request, you asked for 80%)"* — and **never** states a
      resulting level. **Script-verified only**: the wording changed after the runs above, so
      nobody has seen or heard the new sentences in the app yet. Listen to it too: Piper's
      phonemizer returns the same phonemes for "10%" as for "10 percent", so it should say
      "percent".

## 5. Media keys, and which app answers

The app deliberately claims only "sent", because it cannot know which application owns the media
session. Find out once and write it down here.

- [x] With **Spotify playing**: "pause" → which stops?
- [x] With **only a YouTube tab playing**: "pause" → which stops?
- [x] With **both playing**: "pause" → which stops? (Expected: whichever started most recently,
      but confirm.)
- [x] With **nothing playing**: "pause" → does it start something? `playPause` is a toggle with
      no readable state, and the tool's description warns about exactly this.
- [x] "next track" → skips one track, not several. **Human-verified:** skips one.

**Findings (all human-verified):**

| Situation | What responded |
|---|---|
| Spotify playing | Spotify stopped |
| YouTube only | YouTube stopped |
| Both | YouTube stopped; Spotify did **not** |
| Nothing playing | Spotify **started** |

Two things worth keeping from this. With both playing, one "pause" stops only one of them, so
the result "Sent play or pause" is the most that can honestly be said. And "pause" with nothing
playing *starts* music — the toggle the tool's description warns about, now observed.

## 6. Spotify search

- [x] "play Bohemian Rhapsody on Spotify" → a Spotify **search** opens in the browser. The
      result says it opened a search and does **not** say anything is playing.
      **Human-verified:** the search opens in the browser and nothing plays.
- [x] A title with punctuation: "search Spotify for AC/DC Back in Black". The `/` must land in
      the search terms, not create a new URL path. **Human-verified:** the `/` stays inside the
      query, as `%2F`.
- [x] A non-English title (e.g. 坂本龍一, or Björk). The right search opens — not a mangled one.
      **Human-verified:** Björk and 坂本龍一 both return the right artist.
- [x] **The experiment:** paste `spotify:search:bohemian%20rhapsody` into Win+R and compare
      against the web URL. Is the desktop app's search clearly better? Adopt it only if so, and
      only built from the same fixed template (scheme and path fixed, query encoded) — never a
      model-supplied URI. **Human-verified:** `spotify:search:` opened the Spotify app, and the
      user prefers it to the browser search. **Not adopted yet** — `searchSpotify` still opens
      the web URL. Adopting it is a behaviour change with its own failure case (section 1's
      `0x483` when the app is not installed) and needs its own plan.

## 7. The chain, and the model's judgement

- [ ] "open Spotify then play Bohemian Rhapsody" → the plan preview lists both steps, Spotify
      opens, then the search opens. Nothing asks for confirmation.
- [ ] **Which tool gets picked.** No fixture-driven test can speak to this, because every one
      drives tool choice through `FakeLLM`. Try each and record what it chose:

| Said | Expected tool | Actually chose |
|---|---|---|
| "open Spotify" | `openApp` | |
| "open the Spotify web player" | `openTarget` | |
| "play X on Spotify" | `searchSpotify` | |
| "turn it up" | `systemVolume` | |
| "pause" | `mediaControl` | |
| "open my dashboard" | `openTarget` (via memory) | |

> **Script-verified only — the table above is still to be filled in by hand.** The opt-in eval
> (`M18_TOOL_CHOICE_EVAL=1`, `tests/eval/toolChoice.eval.test.ts`) put ten phrases to the real
> model with the full 17-tool menu and a mock shell: **10 of 10 picked the expected tool.**
>
> **Caveat, and it is a large one: that run used an EMPTY clipboard.** It could not see what
> clipboard text does to the choice — and in the running app, three plain action instructions
> have been answered with chat text instead of a tool (open observation 1). So 10/10 is a
> statement about the tool descriptions with nothing selected, not about the app as used.

## 8. Memory, and the tools that must ignore it

- [ ] "remember my dashboard is <some URL>", then "open my dashboard" → the browser opens it.
- [ ] "remember the Spotify app is https://open.spotify.com", then "open the Spotify app" →
      **the application opens, not the URL.** `openApp` sets `resolvesReferences: false`
      precisely so a stored fact cannot rewrite an app name into a URL the catalog can't match.

## 9. Secrets

- [ ] `npm run spotify:connect` on this free account: does consent complete at all?
- [ ] If it does, `node scripts/spotify-recon.mjs closed` → `spotify-recon-out/closed/summary.md`
      shows `product: free` and captures the Premium-required response from the play and volume
      endpoints. **That capture is the fixture the parked Web API work needs** (spec.md §9).
- [ ] `grep -ri "<the first 8 chars of your refresh token>" .` finds nothing outside `.env`.
- [ ] No token appears in the console, in a result popup, or in any error message.
- [ ] `git status` shows `spotify-recon-out/` as ignored, not untracked.

> **Script-verified only, and NOT against the Spotify token.** `SPOTIFY_REFRESH_TOKEN` was not
> set, so there was no Spotify secret to look for. The leak check was run against
> `GOOGLE_REFRESH_TOKEN` instead:
>
> - found in **0 working-tree files** and **0 commits**;
> - `.env` and `spotify-recon-out/` are git-ignored, and `.env` is untracked.
>
> What that does and does not show: the ignore rules work and the one refresh token that exists
> has not leaked into the repo. It says nothing about the Spotify token (there is none yet), and
> nothing about the console, a result popup or an error message — that box needs a person. The
> first two boxes in this section (`spotify:connect`, the recon capture) have not been run.

---

## Live results

*(fill in as you go — and if something here turns out to be wrong, the finding belongs in
spec.md §9 as well as fixed in code, the way M16.11's did)*

Per-item results are recorded in their own sections above. What belongs here is what did not
fit a checkbox.

### Bugs found by the live pass

1. **Units bug in `systemVolume`** (section 4). Fixed; the fix is human-verified at 10, 5 and 80.
2. **The input host swallowed its first command** (section 0b). Fixed; human-verified for
   "volume up by 10" as a first command, the other two first-command checks still open.
3. **A raw Win32 error shown to the user** (section 1): "open Spotify" without Spotify
   installed. Fixed; the fix is script-verified only.
4. **The volume result spoke in key presses** (section 4). Reworded to percent; script-verified
   only.

### Open observations — unexplained, not fixed

**1. A tool request answered with chat text.** This has now happened **three times**: "open
calc", "pause" and "open Spotify" each returned model chat text instead of running a tool,
after Enter was pressed. **Human-observed.** The pattern so far: **always on the first try, and
the second try worked.** The "open Spotify" reply was *"Would you like me to summarize the
selected findings, or rewrite them into a concise status update?"* — it is talking about the
clipboard, not the instruction.

- An earlier attempt to reproduce it by hand — a short word, a long paragraph, a Claude Code
  response on the clipboard — did not.
- **Working hypothesis, not yet tested:** clipboard text (`CapturedContext.selectedText`) pulls
  the model toward `summarize` / `rewrite`. `core/llm/prompt.ts` sends the whole clipboard with
  every instruction and the system prompt never says when to use it. Section 7's 10/10 used an
  empty clipboard, so it could not have seen this.
- The action log will not show what the model said: a chat reply is logged as a miss with no
  result text, so each of these is a bare `no_tool` row.
- An eval for it is written and has **not been run** (`M18_SELECTION_EVAL=1`, 35 model calls).

Nothing has been changed for it; `prompt.ts` is untouched.

**2. Dictation typed "aame" for "name".** *"My name is Sejal, not Angel."* was typed as
*"My aame is Sejal, not Angel."* **Human-observed, once.** The transcription was correct (the
Heard line and the Typed log both had "name"), and it was **not** the first dictation after a
launch. Under investigation. What is known so far, all **script-verified**:

- **Not reproduced.** `scripts/typing-fidelity-probe.ts` typed that exact sentence through the
  real injector into Notepad and read the document back after every sentence: **0 mismatches in
  200** on the working tree (`-File`, request ids) and **0 in 200** on commit `3d7e36d`
  (`-Command -`), run from a separate git worktree. So it is neither shown to be a regression
  from the host change nor shown to be older.
- **The encoding is byte-exact.** `scripts/type-roundtrip-probe.ts` followed the sentence
  through the real `typeText()`, the real `HostChannel` and the shipped host script: the `n`
  reaches the `SendInput` call as `006E`, in order, followed by `0061`. The `TYPE` branch is
  identical in both versions apart from the reply's request-id prefix.
- **What that leaves.** The swap happened after correct events were handed to `SendInput`,
  under conditions the probe did not recreate: no Electron app or whisper running, sentences
  typed back to back, Notepad as the only target. 0 in 400 puts the rate under those conditions
  below roughly 1% per sentence, which does not rule out something rare.
- **Still needed:** which window was being dictated into, and what else was running.
