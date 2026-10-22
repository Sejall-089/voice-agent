# M24 — live verification checklist (by hand)

> **DRAFT, 2026-10-22. Not run.** Written before the live pass, as the close-out procedure asks.
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

- [ ] **1.1** "Read the rest" on an answer whose remainder runs **over 30 s**. Don't touch
      anything. **Expect:** every word heard, to the last sentence. Pre-M24 it went quiet or
      stopped early around 15 s.
- [ ] **1.2** The same, but let the bar **auto-hide** while it is still talking (about 12 s after
      an unfocused result). **Expect:** the bar goes and the voice carries on to the end.
- [ ] **1.3** A long first answer on its own (a capped result plus "There's more. Want me to read
      the rest?", about 16–19 s). **Expect:** the offer at the end is heard in full.

## 2. Nothing talks over it

- [ ] **2.1** **The chime (M23 4.2c, never watched).** Start a long "read the rest". While it
      plays, make a detached job reach a confirm: start a `dangerous` instruction, then press the
      hotkey to send it to the background. **Expect:** no chime during the speech; one chime after
      the last word. Pre-M24: the chime came up to a second before the end, over the speech.
- [ ] **2.2** **Two things queued.** A `caution` action or a chain whose narration lands while a
      long clip is still playing, ideally more than 8 s before the clip ends. **Expect:** the long
      clip is **not cut**, the narration never plays over it, and it **is said after the clip**,
      however long it waited behind it. Pre-M24 the clip was cut at 15 s. Between the first and
      second M24 changes, the narration would have been dropped as stale.
- [ ] **2.3** **A read-out, then a send.** Start a long "read the rest". Before it finishes, in
      another window, trigger something that answers out loud on its own, such as a detached
      job's result as it reattaches. **Expect:** both are heard in full, one after the other.
      Optional: arranging it by hand is fiddly, and the tests cover the ordering.

## 3. Barge-in still stops it at once, and the next thing is heard

For each, start a long "read the rest" and interrupt it about 5 s in.

- [ ] **3.1** **Escape.** **Expect:** silence within a moment, and the bar closes.
- [ ] **3.2** **The instruction hotkey.** **Expect:** silence at the press. Say a short
      instruction ("what time is it" or similar). **Expect:** its answer is **spoken** within a
      few seconds. Pre-M24, an answer arriving in the first ~7 s after the interrupted clip began
      could be silently dropped.
- [ ] **3.3** **The dictation hotkey.** **Expect:** silence at the press, and nothing of the
      speech appears in the dictated text.
- [ ] **3.4** **A confirm answered mid-question.** Ask for something `dangerous` (a Slack send to
      the test channel), and click **Send** while the app is **still reading the question out**.
      **Expect:** the question stops, the send happens, and the result ("Sent…") **is spoken**.
      Pre-M24, it could be lost.

## 4. Failures say what happened

- [ ] **4.1** **A renderer that cannot play.** Optional, needs a way to block audio (for example,
      disable the output device mid-session). **Expect:** a console line starting
      `[WindowsShell] playback failed:` with the browser's own reason, and the next utterance
      still tried. Pre-M24 nothing was logged.
- [ ] **4.2** **Reload the bar mid-clip** (Ctrl+R in its DevTools, dev only). **Expect:** the
      sound stops; within the clip's length + 5 s the console prints `playback did not finish or
      report back within …` once, and later speech works. This is the one place that line *should*
      appear: a reload is neither a crash nor a report.

## 5. A blocked microphone

- [ ] **5.1** Block the app's microphone: Windows **Settings → Privacy & security → Microphone**,
      turn off desktop-app access. Restart the app, press the instruction hotkey, and start
      talking. **Expect:** the bar says `Couldn't start recording: …` with the browser's reason,
      and does **not** show itself recording. Typing still works. Pre-M24 it showed a recording
      that heard nothing.
- [ ] **5.2** The same with the **dictation** hotkey. **Expect:** the same message, nothing is
      typed into the other app, and the hotkey works again once access is turned back on.
      **Turn microphone access back on afterwards.**

## Known gaps, so nobody mistakes them for failures while testing

- **The dictation hotkey's own `speech.stop()` lives in `main.ts`** and has no test that could
  fail. The tests cover the same path through the microphone opening, which also stops speech.
- **Staleness exclusion is exact, not a reset.** An utterance's age leaves out only the time a
  clip was *playing*. Time it spent waiting *before* that clip started (while the clip was being
  synthesized) still counts. With a warm engine that is ~150 ms; with a cold one, seconds.
- **The grace (5 s) and the ceiling (120 s) are reasoned, not measured.** The time from
  `speech:play` to sound on a real device has not been measured. 4.2 is the only item where the
  grace is ever waited out.
