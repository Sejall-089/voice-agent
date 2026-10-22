# M24 — live verification checklist (by hand)

> **RUN 2026-10-22, by a person and by a loopback-recorded script; M24 CLOSED the same day with
> the gaps below.** 3 boxes ticked, 11 open. A ticked box means a person heard it in the running
> app; no script earns a tick.
>
> - **Human-verified (3):** 1.1, 3.2, 5.1.
> - **Covered by script only (9, boxes left open):** 1.2, 1.3, 2.1, 2.2, 3.1, 3.3, 3.4, 4.2, 5.2
>   — machine-verified by a scripted run against the real app (dev build, real Piper, a scratch
>   `--user-data-dir`, a fake model and a fake Slack webhook on localhost) with what reached the
>   speakers recorded by WASAPI loopback. Each box says what the recording showed.
> - **Not run (2):** 2.3 (optional; arranging a detached job's spoken result mid-read-out by hand
>   is fiddly, and the tests cover the ordering), 4.1 (needs the audio output device disabled
>   mid-session).
>
> Four findings came out of the live use, none a regression of M24's own changes; all four are
> M25 (see **Findings** at the end).
>
> Written before the live pass, as the close-out procedure asks.
>
> M24 fixes speech longer than 15 s. `WindowsShell.play()` used to wait for the renderer's
> `speech:ended` under the 15 s bound meant for a renderer *reply*. At 15 s it gave up:
> `isSpeaking()` went false while the clip still played, a held chime played over it (M23,
> measured: 733 ms before the end), and the next utterance's `speech:play` stopped the clip
> mid-sentence. The wait is now the clip's own length (read from its WAV header) plus a 5 s grace
> (`src/main/shell/playbackLimit.ts`). Fixed alongside it, from the same root cause:
> `SpeechPlayer.stop()` now settles its `play()`, so a barge-in ends main's wait at once. Before,
> main waited out 15 s and a reply queued in that time could be dropped as stale. The renderer's
> playback errors now reach main's log: they used to arrive in the argument main never read.
>
> Two follow-up changes are in the same milestone. **Staleness counts waiting, not listening:**
> time spent behind a clip that is still playing no longer ages an utterance, so a "Sent." queued
> during a 30 s read-out is said after it rather than dropped. A synthesis backlog still drops
> what waited over 8 s. **A blocked microphone is reported:** the recorder's start reply had the
> same argument-order bug, so a denied mic looked like a recording that heard nothing.
>
> **How results are marked** (same convention as the earlier checklists in `docs/`):
>
> - `[x]` **Human-verified**: a person heard or saw it in the running app.
> - `[ ]` **Not yet watched**, including everything only a test or script has shown. A log line
>   proves what the app decided, not what the user heard (CLAUDE.md). Every item below ends in
>   sound, so only ears can tick it.
>
> **Already covered without a person** (2026-10-22). `tests/speechPlayback.test.ts` (26) runs
> the real shell, queue, player and preload against a fake speaker. `tests/playbackLimit.test.ts`
> (15) covers the WAV-length rules. `tests/SpeechSession.test.ts` (+2) covers the staleness rule
> on a fake clock, and `tests/micBlocked.test.ts` (3) covers the blocked microphone through the
> preload's real `api`. `tests/piperPlaybackLimit.live.test.ts` (opt-in, `M24_PIPER_LIVE=1`) ran
> real Piper: the 585-character `elaborate` remainder came out as 37.41 s of audio, with a
> computed limit of 42.41 s. The mutation pass broke eleven rules one at a time, and every one
> was caught (`spec.md` §9, M24). 2870 tests green across 127 files, 96 skipped.

**Setup.** `PIPER_EXE_PATH` / `PIPER_MODEL_PATH` set, speakers on, the dev console visible
(`npm run dev`; clear `ELECTRON_RUN_AS_NODE` first). For every item, also watch the console:
**none of them should print `playback did not finish or report back`**, and no speech path
should print `The recorder didn't respond.`

To get speech past 15 s, ask for something with a long answer, then say **"read the rest"**.
`elaborate` reads the remainder verbatim with no length cap. Two ways in: a busy schedule ("what's
on my calendar this week"), or a long email open in Gmail ("summarize this email"). Time it
roughly: anything over 20 s is enough.

## 1. A long clip plays to its end

- [x] **1.1** "Read the rest" on an answer whose remainder runs **over 30 s**. Don't touch
      anything. **Expect:** every word heard, to the last sentence. Pre-M24 it went quiet or
      stopped early around 15 s. *(2026-10-22: heard by a person. Script: a 33.13 s clip,
      32.94 s audible as one continuous stretch, last sound 0.09 s before the clip's end.)*
- [ ] **1.2** The same, but let the bar **auto-hide** while it is still talking (about 12 s after
      an unfocused result). **Expect:** the bar goes and the voice carries on to the end.
      *(Script only: a 32.66 s clip; the bar auto-hid 8.76 s into it; sound continued to 32.61 s,
      0.05 s before the end.)*
- [ ] **1.3** A long first answer on its own (a capped result plus "There's more. Want me to read
      the rest?", about 16–19 s). **Expect:** the offer at the end is heard in full. *(Script only:
      a 15.78 s clip — this voice is faster than the 16–19 s this box guessed, still over the old
      15 s bound; sound ran to 0.07 s before the end.)*

## 2. Nothing talks over it

- [ ] **2.1** **The chime (M23 4.2c, never watched).** Start a long "read the rest". While it
      plays, make a detached job reach a confirm: start a `dangerous` instruction, then press the
      hotkey to send it to the background. **Expect:** no chime during the speech; one chime after
      the last word. Pre-M24: the chime came up to a second before the end, over the speech.
      *(Script only: a 32.97 s read-out; the job reached its confirm 7.04 s into it; the chime's
      first sound came 410 ms after the last speech sample, measured at 10 ms resolution.)*
- [ ] **2.2** **Two things queued.** A `caution` action or a chain whose narration lands while a
      long clip is still playing, ideally more than 8 s before the clip ends. **Expect:** the long
      clip is **not cut**, the narration never plays over it, and it **is said after the clip**,
      however long it waited behind it. Pre-M24 the clip was cut at 15 s. Between the first and
      second M24 changes, the narration would have been dropped as stale. *(Script only: a
      three-step plan's 17.33 s preview played to its end; the confirm question was queued 15.93 s
      before the preview ended and heard 1.4 s after it, with no overlap; nothing posted.)*
- [ ] **2.3** **A read-out, then a send.** Start a long "read the rest". Before it finishes, in
      another window, trigger something that answers out loud on its own, such as a detached
      job's result as it reattaches. **Expect:** both are heard in full, one after the other.
      Optional: arranging it by hand is fiddly, and the tests cover the ordering. *(Not run.)*

## 3. Barge-in still stops it at once, and the next thing is heard

For each, start a long "read the rest" and interrupt it about 5 s in.

- [ ] **3.1** **Escape.** **Expect:** silence within a moment, and the bar closes. *(Script only:
      Escape at 5.03 s; last sound 0.07 s after the press; the bar hidden within 1.2 s.)*
- [x] **3.2** **The instruction hotkey.** **Expect:** silence at the press. Say a short
      instruction ("what time is it" or similar). **Expect:** its answer is **spoken** within a
      few seconds. Pre-M24, an answer arriving in the first ~7 s after the interrupted clip began
      could be silently dropped. *(2026-10-22: watched by a person — a long answer interrupted
      with the hotkey, something short asked, and answered out loud. Script: last sound 0.06 s
      after the press; the answer audible 0.60 s after it was submitted. Finding 1 came from the
      "read the rest" that followed.)*
- [ ] **3.3** **The dictation hotkey.** **Expect:** silence at the press, and nothing of the
      speech appears in the dictated text. *(Script only: last sound 0.09 s after the press.
      Whisper typed "Gordon to God that's it. He's the opponent." into the scratch Notepad — none
      of the app's words; room sound or whisper's own invention on near-silence.)*
- [ ] **3.4** **A confirm answered mid-question.** Ask for something `dangerous` (a Slack send to
      the test channel), and click **Send** while the app is **still reading the question out**.
      **Expect:** the question stops, the send happens, and the result ("Sent…") **is spoken**.
      Pre-M24, it could be lost. *(Script only, to a fake Slack webhook: Send pressed 1.28 s into
      the question; silent 0.17 s later; one post; "Sent…" audible 1.5 s after the approval.)*

## 4. Failures say what happened

- [ ] **4.1** **A renderer that cannot play.** Optional, needs a way to block audio (for example,
      disable the output device mid-session). **Expect:** a console line starting
      `[WindowsShell] playback failed:` with the browser's own reason, and the next utterance
      still tried. Pre-M24 nothing was logged. *(Not run.)*
- [ ] **4.2** **Reload the bar mid-clip** (Ctrl+R in its DevTools, dev only). **Expect:** the
      sound stops; within the clip's length + 5 s the console prints `playback did not finish or
      report back within …` once, and later speech works. This is the one place that line *should*
      appear: a reload is neither a crash nor a report. *(Script only: reload at 5.02 s; last sound
      0.05 s after; exactly one "did not finish or report back within 38.1 s for a 33.1 s clip",
      38.09 s after the clip was sent; later speech worked.)*

## 5. A blocked microphone

- [x] **5.1** Block the app's microphone: Windows **Settings → Privacy & security → Microphone**,
      turn off desktop-app access. Restart the app, press the instruction hotkey, and start
      talking. **Expect:** the bar says `Couldn't start recording: …` with the browser's reason,
      and does **not** show itself recording. Typing still works. Pre-M24 it showed a recording
      that heard nothing. *(2026-10-22: watched by a person. Script, with the app's permission
      handler set to deny instead of the Windows toggle: "Couldn't start recording: microphone
      access was denied (Settings → Privacy → Microphone)." and no recording indicator.)*
- [ ] **5.2** The same with the **dictation** hotkey. **Expect:** the same message, nothing is
      typed into the other app, and the hotkey works again once access is turned back on.
      **Turn microphone access back on afterwards.** *(Script only: the same message, nothing
      typed; once access was granted again the hotkey started a recording, discarded with
      Escape.)*

## Known gaps, so nobody mistakes them for failures while testing

- **The dictation hotkey's own `speech.stop()` lives in `main.ts`** and has no test that could
  fail. The tests cover the same path through the microphone opening, which also stops speech.
- **Staleness exclusion is exact, not a reset.** An utterance's age leaves out only the time a
  clip was *playing*. Time it spent waiting *before* that clip started (while the clip was being
  synthesized) still counts. With a warm engine that is ~150 ms; with a cold one, seconds.
- **The grace (5 s) and the ceiling (120 s) are reasoned, not measured.** The time from
  `speech:play` to sound on a real device has not been measured. 4.2 is the only item where the
  grace is ever waited out.

---

**Findings**

None of the four is a regression of M24's changes; each was investigated without code changes
first (a scripted repro on the real planner, job runner and shell), and each became part of M25.

1. **"Read the rest" after a short answer said there was nothing more** (2026-10-22, live, in
   3.2's sequence: a long answer interrupted, "what's the time", then "read the rest"). Cause:
   `Planner.say()` cleared the held remainder on every answer that held nothing back — a
   deliberate M14.4 rule (pinned by a test), not the interruption. **Fixed in M25 Fix 1**; not
   re-watched yet (M25 checklist 1.1).
2. **Escape while "Thinking…" did not stop the instruction** (2026-10-22, live). Escape only hid
   the bar: the job went on, came back to the bar and was spoken, and a dangerous step would
   have opened its dialog. A voice instruction Escaped during transcription was run anyway.
   **Fixed in M25 Fix 2 + E5**; not re-watched yet (M25 checklist 4.x).
3. **A job reached the pill after one Escape** (2026-10-22, live): most likely an earlier run was
   still thinking when the hotkey was pressed (hotkey detaches by design); not reproduced with
   Escape alone; the M25 log lines will confirm live (M25 checklist 3.x).
4. **"What's the time?" got a long answer** (2026-10-22, live). There was no time tool; the
   model answered in prose, logged as a miss. **Fixed in M25 Fix 3**; not re-watched yet.
