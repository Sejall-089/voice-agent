# M18 — live verification checklist (by hand)

> **OPEN. Nothing below has been run yet.** The code is complete and 944 tests pass, but every
> milestone from M10 on produced at least one live bug no fixture caught, and M18 touches the
> shared PowerShell input host that dictation depends on.
>
> Written *before* the live pass rather than after it, and each item says what could actually be
> wrong — a checklist of specific doubts, not a lap of the feature. See spec.md §9's
> "M18 — proven vs. live-only" for the same split from the other side.

Run `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it first or the app boots
as plain node.)

---

## 0. THE REGRESSION CHECK — do this one first

**Dictation still types.** `HOST_SCRIPT` in `WindowsInputInjector.ts` gained a `KEY` command.
The `TYPE` path was not touched, but both share one PowerShell host, and that file carries its
own KNOWN ISSUE note (M16.8) about the fragility of its `-Command -` invocation.

- [ ] Open Notepad, press the dictation hotkey, say a sentence, press Enter. It types.
- [ ] Do it again with a longer sentence (20+ words). No repeated characters ("mmmmmm"), no
      dropped words.

**If this fails, stop and revert the HOST_SCRIPT change before anything else.** A broken
dictation path is worse than a missing volume key.

*Symptom to watch for (from the M16.8 note): the bar narrates "Dictating into —" and then types
nothing, with no error — a `TYPE` that never gets a reply and times out.*

---

## 1. Opening the built-in apps

- [ ] "open Notepad" → Notepad opens.
- [ ] "open calc" → Calculator opens (the alias path).
- [ ] "open files" → File Explorer opens (the alias path).
- [ ] "open Spotify" → Spotify opens, via its `spotify:` protocol handler.

**What to look for if Spotify is not installed:** Windows may show a "how do you want to open
this?" system dialog instead of failing. `openExternal` would then report success, and the app
would say "Opened Spotify" for a launch nobody saw. Note what actually happens — if it reports
success wrongly, that is a real finding and the honest fix is in the message, not the launcher.

- [ ] "open Photoshop" (or anything not installed) → refused, and the refusal lists
      *Spotify, Notepad, Calculator and File Explorer*.
- [ ] "open spotifyy" (one typo) → refused, not approximated.

## 2. `APPS_EXTRA`

Set in `.env`, then restart (it is read once, at startup):

```
APPS_EXTRA=VLC=C:\Program Files\VideoLAN\VLC\vlc.exe|Bad=notepad.exe /A
```

- [ ] The console shows `[main] APPS_EXTRA added: VLC`.
- [ ] The console shows `[main] I ignored the APPS_EXTRA app "Bad" — "notepad.exe /A" has
      arguments, and I only launch a bare command.`
- [ ] "open VLC" works.
- [ ] "open Bad" is refused and **nothing launches** — the malformed entry is never in the
      catalog, only in the report.

## 3. Opening an app that is already running

- [ ] With Notepad already open, "open Notepad" again. Record what happens: a second window, a
      focus switch, or nothing. All three are plausible and the app currently claims only
      "Opened Notepad", which is true in every case — but if it starts a second copy every
      time, that is worth knowing.

## 4. Volume

Open the Windows volume indicator so the level is visible while testing.

- [ ] "turn the volume up" → the level rises. **Measure roughly how much.** The default is 5
      presses on the assumption that one press is about 2%, i.e. ~10%. If it is closer to 50%,
      the default is wrong and `DEFAULT_PRESSES` in `core/media.ts` needs changing.
- [ ] "turn the volume down" → it **falls**. (If it rises, the virtual-key table is transposed —
      0xAE/0xAF are adjacent, which is exactly why there is a test for it.)
- [ ] "mute" → mutes. Say it again → unmutes. One press, every time.
- [ ] From 0: "turn the volume up" works and does not wrap round.
- [ ] From 100: "turn the volume up" is a no-op, not an error.
- [ ] "turn the volume up by 15" → 15 presses. **Watch for a stuck or auto-repeating key.** The
      40 ms inter-press gap is inherited from M12.1's measurement of `KEYEVENTF_UNICODE` events,
      which carry `wVk = 0`; a real virtual key is a different signal to Windows' key-repeat
      handling, so that number is borrowed rather than verified for this case. If it misbehaves,
      `CHUNK_DELAY_MS` is the knob.
- [ ] The result reads "Sent volume up 5 times" and **never** states a resulting level.

## 5. Media keys, and which app answers

The app deliberately claims only "sent", because it cannot know which application owns the media
session. Find out once and write it down here.

- [ ] With **Spotify playing**: "pause" → which stops?
- [ ] With **only a YouTube tab playing**: "pause" → which stops?
- [ ] With **both playing**: "pause" → which stops? (Expected: whichever started most recently,
      but confirm.)
- [ ] With **nothing playing**: "pause" → does it start something? `playPause` is a toggle with
      no readable state, and the tool's description warns about exactly this.
- [ ] "next track" → skips one track, not several.

**Findings:**

| Situation | What responded |
|---|---|
| Spotify playing | |
| YouTube only | |
| Both | |
| Nothing playing | |

## 6. Spotify search

- [ ] "play Bohemian Rhapsody on Spotify" → a Spotify **search** opens in the browser. The
      result says it opened a search and does **not** say anything is playing.
- [ ] A title with punctuation: "search Spotify for AC/DC Back in Black". The `/` must land in
      the search terms, not create a new URL path.
- [ ] A non-English title (e.g. 坂本龍一, or Björk). The right search opens — not a mangled one.
- [ ] **The experiment:** paste `spotify:search:bohemian%20rhapsody` into Win+R and compare
      against the web URL. Is the desktop app's search clearly better? Adopt it only if so, and
      only built from the same fixed template (scheme and path fixed, query encoded) — never a
      model-supplied URI.

## 7. The chain, and the model's judgement

- [ ] "open Spotify then play Bohemian Rhapsody" → the plan preview lists both steps, Spotify
      opens, then the search opens. Nothing asks for confirmation.
- [ ] **Which tool gets picked.** No test in the repo can speak to this, because every test
      drives tool choice through `FakeLLM`. Try each and record what it chose:

| Said | Expected tool | Actually chose |
|---|---|---|
| "open Spotify" | `openApp` | |
| "open the Spotify web player" | `openTarget` | |
| "play X on Spotify" | `searchSpotify` | |
| "turn it up" | `systemVolume` | |
| "pause" | `mediaControl` | |
| "open my dashboard" | `openTarget` (via memory) | |

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

---

## Live results

*(fill in as you go — and if something here turns out to be wrong, the finding belongs in
spec.md §9 as well as fixed in code, the way M16.11's did)*
