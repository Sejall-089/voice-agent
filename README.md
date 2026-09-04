# Voice-Action Agent — v0

A desktop assistant that turns a short instruction — typed, or **spoken** — plus what's on your
screen, plus what it remembers about you, into **exactly one concrete action**.

```
"send these notes to the team"   →   sendMessage(channel: "#design-team", text: "...")
```

The interesting part isn't the actions — it's the **memory**. Tell it *"no, I meant the design
channel"* and the old fact is **versioned, not overwritten**; every future request resolves to the
corrected value. That's the thing a plain prompt can't fake, and it's what this repo is built to
demonstrate.

---

## How it's put together

Three layers, one rule.

- **Shell** (`src/main/`) — the only OS-aware code. Hotkey, clipboard, open URL, dialogs. Lives
  behind the six-method `OSShell` interface, so porting means reimplementing one file.
- **Core** (`src/core/`) — the brain. A **tool registry** (the menu of what it can do) and a
  **planner** (the loop that turns an instruction into one validated tool call). Imports no
  `electron`, reads no globals — it runs headless in tests.
- **Memory** (`src/core/memory/`) — local SQLite. Facts carry **confidence, version, and an active
  flag**, so corrections and contradictions are first-class rather than overwrites.

**The one rule: the LLM proposes, the planner disposes.** The model's tool call is a *proposal*.
The registry check, argument resolution, validation, and the confirm gate are deterministic code.
The model never invents a capability, and nothing `dangerous` runs unconfirmed.

Since **M10** that gate is four tiers rather than a boolean (`src/core/risk.ts`), because the app
can now act *inside* another app, where most actions have no undo at all: `safe` and `reversible`
run; `caution` runs but **says what it is about to do first**; `dangerous` stops for an explicit
yes, every time.

Since **M13** a tier can also depend on the *arguments* rather than only on which tool was picked
— a calendar event with guests emails them the moment it is created, while the same event without
guests touches nobody. When that classifier can't reach an answer it **escalates**: "we couldn't
tell" resolves to *ask*, never to *go ahead*.

Since **M17** one instruction can be a short *sequence* of those calls rather than one — and the
rule is unchanged, which is the whole design. The model answers **once**, with a fixed plan of up
to three tools it already has; deterministic code then runs them, and every step re-enters the
same gate a lone instruction does. It is never asked "what now?" after seeing a result. See
[Chained instructions](#chained-instructions-m17).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for diagrams and [`spec.md`](spec.md) for the decisions.

---

## The demo tasks

| # | Say this | It does |
|---|---|---|
| 1 | "summarize this" | Summarizes your copied text |
| 2 | "rewrite this in my tone" | Rewrites it using your **stored** tone → clipboard |
| 3 | "open my dashboard" | Resolves the name → opens the URL |
| 4 | "remember my dashboard is …" | Stores the fact |
| 5 | "send these notes to the team" | Formats + posts to Slack — **after you confirm** |
| 6 | "no, I meant the design channel" | **Corrects** the fact: old row retired, new version active |
| 7 | "what do you know about the team?" | Recalls it — with confidence, version, recency |

…and three more in **M10**, with a Gmail message open in Chrome:

| # | Say this | It does |
|---|---|---|
| 8 | "reply and say I can't make Tuesday, propose Thursday" | Reads the open email, drafts a reply **in your tone**, opens the reply box, puts it in |
| 9 | "make it shorter" | Rewrites **that same draft** — including any edits you made by hand |
| 10 | "send it" | Shows the real recipient and the **whole** draft, and sends only if you say yes |

…and one more in **M11**, with a Notion page open in the same Chrome:

| # | Say this | It does |
|---|---|---|
| 11 | "note that the launch moved to Friday" | Reads the open page, writes a note **in your tone**, adds it to the end |

Task 11 is one-shot, not three like 8-10: Notion has no staging area and no send button, so
there's nothing to draft-then-send. A follow-up like "make that note shorter" is an honest
miss, not a silent edit — see [Scope](#scope).

…and three more in **M13**, with a Google account connected:

| # | Say this | It does |
|---|---|---|
| 12 | "what's on tomorrow?" | Lists the day's events, with who's on each |
| 13 | "block out an hour Thursday to write the deck" | Adds it — **narrates**, doesn't ask, because it reaches nobody |
| 14 | "set up a design sync with alex@… and sam@…" | Names the event, the time and **every** invitee, and creates it only if you say yes |

Tasks 13 and 14 are the **same tool**. That's the M13 design decision: unlike Gmail, where
drafting and sending are separate moments, a calendar event emails its guests the instant it's
created — there's no later "send" to gate. So the risk tier is decided from *this call's
arguments*, not from which tool was picked. "Move the review to 4" works the same way, except
it has to look up who's on it first (see `spec.md` §6c).

Anything else → an honest refusal, logged as a miss (a ranked backlog of what to build next).
It never guesses.

---

## System-wide dictation (M12, M12.1, M12.2)

Not one of the tasks above — it never touches the planner, the registry, or memory. Hold
nothing: tap the **dictation hotkey** (separate from the instruction hotkey) to start
listening, then **press Enter** to stop and **type the raw transcript at the cursor of
whatever window currently has focus, in any app** — a terminal, Notepad, a browser text
field, Word. No tool selection, no confirm gate, because there's no plan to confirm: it's the
literal "type what I said" primitive.

It narrates *before* it types (naming the window it captured focus on, so you know where
text is about to land before you speak — and it tells you Enter is what finishes it), and it
refuses rather than guesses: if focus moved between speaking and typing, or the OS reports
fewer keystrokes accepted than sent (most often an unelevated app trying to type into an
elevated one), nothing is typed and the transcript you spoke is shown back to you instead.

**Enter is captured system-wide for as long as a recording is live.** That's the whole point
of "Enter finishes it, no matter what has focus" — but it does mean that while you're
dictating, Enter won't reach whatever app you're in for its normal purpose (submitting a
form, a newline) until the recording ends, one way or another. It's released the instant the
session returns to idle.

See [Setting up dictation](#setting-up-dictation-optional) below and `spec.md` §4c for the
full design.

---

## Voice output (M14)

The app says its narration, confirms, and results out loud instead of only showing them. Local
synthesis (Piper), no API key, for the same reason voice *input* is local — and **off is a real
state**: with `PIPER_EXE_PATH` unset it simply stays quiet, the `elaborate` tool is never
offered, and nothing else changes.

The decision worth knowing about is that there are **two representations, not one**. The
screen keeps exactly the text it shows today, and the spoken line is *derived* from it by pure
code in `src/core/speech.ts` — flattened to one line, stripped of the bullets and markdown a
phonemizer would either mispronounce or drop, capped to a couple of sentences, with anything
held back offered rather than read ("plus 7 more, want me to read them?").

Deriving it rather than writing it twice is what keeps the two from drifting apart. Keeping
them separate at all is what protects the confirm dialog: that text is deliberately
*exhaustive* — the whole draft, every attendee by name, never "and 2 others" — because it's
the last thing between an instruction and something irreversible. Speech says the question and
points at the dialog; it never reads the draft aloud.

**Answering a confirm by voice is deliberately not part of this.** Putting speech recognition
on the one gate that must never be bypassed needs its own fail-closed design, so while a
confirm is open both hotkeys are blocked and the app says so rather than doing nothing — it
won't quietly start a second instruction over the top of a decision you haven't made yet.

"Plus 7 more" is only honest if the rest is still somewhere, so it is: a one-slot, five-minute
scratch store, and an **`elaborate`** tool that reads it out when you say "go on" or "read them
out". It empties the slot, so asking twice tells you there's nothing more rather than repeating
itself, and with nothing held it says so plainly instead of failing. It's only on the menu when
the app can actually speak.

`readSchedule` writes its own spoken form rather than taking the generic one, because the
generic version would read attendees' email addresses out loud, character by character. Spoken,
they become a count — *"You have 5 things coming up. First up, Wed 26 Aug, 3 to 4 PM, One, with
2 guests. Want me to read the rest?"* The screen still names every guest in full.

Dates and times are rewritten for the ear in the same place — "Wed 26 Aug, 3:00–4:00 PM" is said
as "Wednesday 26 August, 3 to 4 PM". Every part of that earned its place by measurement: the
abbreviations are otherwise read as ordinary words ("wed", "aug"); the en dash was arriving as
mojibake and being voiced as its mis-decoded bytes (fixed at the source, by forcing UTF-8 on the
engine); and even once decoded correctly it is dropped silently rather than said as "to", so the
word has to be supplied. The colon goes the same way — the engine reads "3:00" as "three zero
zero", applying no time normalisation of its own.

The planner now asks for all of this out loud — narration, the confirm question, every result,
every refusal. Speech is an *action* it requests, not a method it calls, so a machine with no
synthesizer accepts it and stays quiet, and the whole policy is testable with no audio device
at all.

**Talk over it and it stops.** Press **Escape** to just silence it, or either hotkey to
interrupt and start giving a new instruction — the app goes quiet immediately — queue dropped, playback cut, anything the engine was still working on thrown
away. That last part matters: audio synthesized just before you interrupted would otherwise
arrive just after, and talk over the instruction you're already speaking. The microphone is
never open while the app is talking, enforced where every path to the microphone passes through
rather than at each hotkey. Nothing is lost when it's cut off, because the full text is still on
screen — speech is the disposable channel.

**156 tests**, and `scripts/tts-recon.mjs` — which interrogates a real Piper binary rather than
guessing at it, the M11 "never hand-author a fixture" lesson applied to an audio engine. It is
what established that the engine mis-decodes non-ASCII without `PYTHONUTF8=1`, applies no time
normalisation of its own, and takes about five seconds to start.

**Fixed since:** that ~5s cold start. `PiperSynthesizer` now keeps one warm process alive
(`--output-dir` streaming, not the HTTP server mode — recon ruled that out, it needs Flask and
binds every interface by default) instead of spawning fresh per utterance. Measured through the
shipped class: ~3–5s per call before, ~2.9s to load the model once, then 108–160ms per call after
— about 20–30x. A crash mid-session (a line with nothing phonemizable kills the process, same as
it always did) restarts on the next call rather than retrying the line that caused it. The
archived rhasspy build (`PIPER_LEGACY_FLAGS=1`) keeps the original spawn-per-utterance path
unchanged, since its support for `--output-dir` has never been confirmed against a real install.

See `spec.md` §2, §3, §4d, and §6's `speakResult`.

---

## Pointing — point, don't click (M15, regrounded in M16)

Ask **"where's the send button?"** and the app works out where the thing you named is and draws
a marker over it. Then it stops. **You** click it.

### It does not photograph your screen

The first version of this did. It sent a screenshot to a vision model and asked where the thing
was — and on ordinary Windows chrome it answered with the **wrong control**: one tab over on a
tab strip, ~200px onto a neighbouring toolbar icon. Not imprecision, the wrong answer given
confidently. That is a known-hard problem (published benchmarks put the best models near 31%
strict accuracy against ~97% human, worst on exactly the small dense targets a desktop is made
of), so it was replaced rather than tuned.

**Now the coordinates come from Windows.** UI Automation — the same accessibility layer screen
readers use — lists the controls in the window you were looking at, with their exact rectangles.
Code numbers that list. The model's entire answer is **one number**, picking an entry. An integer
cannot be off by 200 pixels.

### What leaves your machine

The **names** of the controls in **one window**, as text — `"File"`, `"Edit"`, `"Advice.txt"`,
`"New"` — plus the words you used. That's it. No image is captured at all.

It reads the window that was in front when you pressed the hotkey, snapshotted *before* the
command bar takes focus. Not the desktop, not your other windows, and never the app's own UI.

### When it declines

It refuses rather than guessing, and says which kind of "no" it is:

| | |
|---|---|
| **can't read that window right now** | the window exposes only its title bar to the accessibility layer. Some apps do this transiently — one measured flat for 9.4 seconds and fully populated an hour later — so the message is present-tense, not a claim about the app. |
| **still loading** | the control list was still changing. It waits, and refuses rather than answering against a half-built list. |
| **several things could be that** | two controls the model had no way to tell apart. It names them by the labelled container each sits in when one exists ("the one under 'Date modified'"), or by left-to-right position otherwise — never picks for you. |
| **couldn't find it** | and it says how many controls it actually looked at — a claim you can check, which the vision version could never make. |
| **it's there, but disabled** | a genuinely different fact from "couldn't find it" — the control exists and is greyed out, so there's nothing to click yet. |
| **you've switched away** | you changed windows while it was working, or the window moved. The marker is always-on-top, so drawing anyway would put it over the wrong app. |


## Chained instructions (M17)

"Reply to this and send it" used to be two hotkey presses. Now it's one.

One instruction can resolve to a short, ordered sequence of tools **it already has** — up to
three. It tells you the whole plan before it starts:

```
Two steps:
1. Read tomorrow's schedule
2. Add it to your Notion page
```

...and then runs them, announcing where it is as it goes ("Step 2 of 2: Adding a note to
Roadmap…").

**It is a workflow, not an agent.** The model is asked once, gets the whole plan out in that one
answer, and is never consulted again. That means the number of steps is known before anything
happens — there is no loop that decides for itself when to stop. A later step can use an earlier
one's output by writing `{step1}` into a text argument, and code substitutes the real text in at
the moment that step runs, *before* its confirm dialog — so what you're asked to approve is
always the real thing, never a placeholder.

**Every step keeps its own gate.** Chaining changes nothing about what an action costs: a
`dangerous` step still stops for an explicit yes at position 3 of 3, and three `safe` steps don't
become risky by being chained. And a plan is never approved wholesale — the preview is there so
you know what's coming, not so you can pre-authorise it.

**It stops rather than pushing through.** If any step can't run, nothing after it does, and it
says so plainly rather than reporting a success it didn't have:

> Your Notion page isn't open. I'd already done step 1 of 3, but steps 2 and 3 didn't run.

Some plans are refused before anything runs at all — more than three steps, a tool this install
doesn't have, or a step trying to use a result from a step that hasn't happened yet. Better to
decline the plan than to announce one that was always going to die halfway.

While a chain is running, both hotkeys are blocked — and *say* they're blocked, because a hotkey
that silently does nothing is indistinguishable from a broken app. If a chain is parked at a
confirm dialog, it tells you about the dialog, not about the chain: that's the one you can act on.

**Not built:** branching ("if I'm free at 3, book it, otherwise..."), any new tools, and anything
that outlives the instruction — a chain runs to completion or stops, it doesn't go away and ping
you later.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill in the keys below
npm run dev               # press Ctrl+Shift+Space anywhere
```

**One hotkey: `Ctrl+Shift+Space`.** It opens the command bar *and* starts listening, so you
decide whether to speak or type after the bar is up.

| You do | It does |
|---|---|
| **Speak**, then **Enter** | Stops, transcribes, runs it |
| **Start typing** | Silently cancels the recording — no stray transcript |
| Type, then **Enter** | Runs the typed text |
| **Esc** (works even while unfocused — e.g. mid-dictation), or click away | Discards everything. Nothing runs |
| Wait **90 s** | Mic released, audio kept — **Enter** still runs it, however long you leave it |

**Workflow:** select text → **Ctrl+C** → **Ctrl+Shift+Space** → speak or type.

Global shortcuts are first-come-first-served across the whole OS (`Ctrl+Alt+Space` is claimed by
the Microsoft IME on some installs), so the app takes the first free combo from
`Ctrl+Shift+Space` → `Ctrl+Alt+Space` → `Ctrl+Alt+M` → `Alt+Shift+Space` and prints which one won.
Pin your own with `HOTKEY` in `.env`.

Whichever way you produce it, the instruction goes to the planner on the same path — same registry
check, same memory resolution, same confirm gate. Nothing ever runs without your **Enter**.

**`.env` keys**

| Key | Needed for |
|---|---|
| `LLM_PROVIDER` | Which client `createLLMClient()` builds — `anthropic` or `openai`. Required; an unset or unrecognized value fails loudly at startup rather than guessing. |
| `ANTHROPIC_API_KEY` | Only if `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | Only if `LLM_PROVIDER=openai` |
| `SLACK_WEBHOOK_URL` | Task 5 only (`sendMessage`) |
| `WHISPER_EXE_PATH` · `WHISPER_MODEL_PATH` · `WHISPER_LANGUAGE` | Voice **and** dictation (M12). Optional — leave them blank and neither the bar's microphone nor the dictation hotkey ever activate; typed commands work exactly as before. |
| `HOTKEY` | Optional. Pins the instruction-bar combo instead of letting the app pick the first free one. |
| `DICTATE_HOTKEY` | Optional. Pins the **dictation** combo (M12) — separate from `HOTKEY` above. Needs `WHISPER_*` set too, or there's no transcriber to dictate with. |
| `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` · `GOOGLE_REFRESH_TOKEN` | Tasks 12-14 (M13). All three, or the calendar tools aren't offered at all. The refresh token comes from `npm run calendar:connect` — it's a **secret**, and the app never logs it or puts it in an error. |
| `CHROME_DEBUG_URL` | Tasks 8-11 (the Gmail reply tools **and** the Notion tool — one debug Chrome, both). Optional — leave it blank and none of those four tools are ever offered at all. |

### Setting up the Gmail reply tools (optional)

DOM-based, not screenshot-based: the app finds the real **Reply** button by its role and
accessible name, and refuses if it can't identify it. No pixel clicking anywhere.

1. **Start Chrome with remote debugging and its own profile.** Since Chrome 136 the debugging
   port is refused on your default profile, so the second flag isn't optional:

   ```
   chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\voice-agent-chrome"
   ```

2. **Sign in to Gmail in that window.** Use a **throwaway/test account first** — task 10 really
   does send email.
3. **Set `CHROME_DEBUG_URL=http://127.0.0.1:9222`** in `.env`. Leave it blank and the three
   Gmail tools are never even offered to the model — a capability the app can't exercise
   shouldn't be on the menu it chooses from.

Scoped to **Gmail in Chrome, English UI**, with one message open. Anything else — another app,
another language, no message open, two matching Gmail tabs — is an honest refusal, never a guess.

### Setting up the Notion tool (optional)

Same debug Chrome as Gmail above — no second setup, just a Notion tab open in it. Set
`CHROME_DEBUG_URL` once and both work.

Notion's page content carries no ARIA roles at all (unlike Gmail), so the app targets the last
block on the page by structure (`data-block-id`, document order) instead. It also can't act
through ordinary JS calls the way Gmail's tools do — Notion's editor was found, live, to
silently ignore `.click()`/`.focus()`/`execCommand()` (they report success but save nothing),
so this tool drives real mouse and keyboard input at the CDP level instead. One visible
consequence: **using it will bring that Chrome window to the foreground**, unlike the Gmail
tools, which never need to.

Scoped to **one open page, append only** — content lands after everything already there, and
nothing existing is ever edited, reordered, or removed. There's no revision tool: a follow-up
("make that note shorter") is a miss, not a silent edit, on purpose — undoing what was just
written would mean deleting real content from a live document with no staging area. Two or
more Notion tabs open at once is narrowed to whichever is the foreground tab; still ambiguous
after that, or no page open at all, is an honest refusal.

**Known limits:** Chrome tab only — the Notion **desktop app** is a different, unverified
transport and isn't supported.

### Setting up Google Calendar (optional)

The only integration that talks to a real **API** rather than driving a browser. That's not a
change of principle: Gmail and Notion needed a DOM because the point was a live, editable draft
you could read before it went anywhere. A calendar event is structured data — a title, a start,
an end, a guest list — so there's nothing to tweak in place, and an API doesn't break when
Google reskins.

One-time setup, in the [Cloud Console](https://console.cloud.google.com): new project → enable
the **Google Calendar API** → OAuth consent screen (External) → Credentials → OAuth client ID →
**Desktop app**. Put the client ID and secret in `.env`, then:

```bash
npm run calendar:connect     # opens your normal browser, prints a refresh token
```

Paste the token into `.env` as `GOOGLE_REFRESH_TOKEN` and **restart the app**. The consent flow
runs in a standalone script, not in an Electron window, because Google blocks OAuth in embedded
webviews — that's their policy, not a preference here.

**Two things that look like bugs and aren't:**

- **"Google hasn't verified this app."** Calendar is a *sensitive* scope; clearing that warning
  requires full verification — domain ownership, a published privacy policy, a review — which
  isn't worth pursuing for a personal project. Click **Advanced → Go to \<your app name\>**.
  Expect it every time you reconnect.
- **Access dying after 7 days.** A Cloud project left in **"Testing"** publishing status expires
  refresh tokens after a week. Set it to **"In production"** on the consent screen — an
  unverified app can still be used by its own owner, and the tokens stop expiring.

**Finding the event to move** is by name, not by the sentence you said it in: Google's search
requires every word to appear, so "the test one meeting" won't match an event called "test one".
It tries your exact phrasing first, then retries without filler words — so a real "Team meeting"
still matches directly, and "meeting" is only ever dropped when the alternative is giving up.

**What it refuses to do**, each rather than guessing: move an event when the description matches
none or several (it lists the candidates, and tells you both terms it searched for); move a **repeating** event (instance-or-series is a
real choice — Google's own UI asks, so this doesn't pretend to know); move or create an
**all-day** event; invite someone whose email address it doesn't have. That last one matters
more than it looks — silently dropping "the design team" would take the guest count to zero and
skip the confirm gate entirely.

**Known limits:** your primary calendar only; no recurring events; no free/busy lookup across
other people's calendars; reads all-day events but won't write one.

### Setting up voice (optional)

Transcription is **local** — audio never leaves the machine and there's no STT API key.

1. **Binary** — download a prebuilt Windows release from
   [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unzip it, and point
   `WHISPER_EXE_PATH` at `whisper-cli.exe`.
2. **Model** — download a ggml model (`ggml-base.en.bin` is a good starting point) from
   [the model repo](https://huggingface.co/ggerganov/whisper.cpp/tree/main) and point
   `WHISPER_MODEL_PATH` at it.
3. **Microphone permission** — Windows Settings → Privacy & security → Microphone → allow
   desktop apps.

Both paths absolute. Audio is captured in the renderer via Web Audio, downsampled to the 16 kHz
mono 16-bit WAV whisper.cpp expects, and passed to the binary as a temp file that's deleted
immediately after.

The provider lives behind the same `LLMClient` interface either way (`src/core/llm/` —
`anthropic.ts` / `openai.ts` / shared `prompt.ts` / `factory.ts`), so switching is a one-line
`.env` change, not a code change.

### Setting up voice output (optional)

Synthesis is **local** — nothing leaves the machine and there's no TTS API key. Unset means the
app simply stays quiet; nothing else changes.

1. **Binary** — either works, and the app spawns whatever `PIPER_EXE_PATH` points at:
   `pip install piper-tts` (maintained; gives you `<venv>Scriptspiper.exe`), or the archived
   [rhasspy/piper v1.2.0](https://github.com/rhasspy/piper/releases) Windows zip if you'd rather
   not have Python involved. If the pip console shim isn't on your PATH, point `PIPER_EXE_PATH`
   at `python` instead — the wrapper supports the `-m piper` module form.
2. **Voice** — download one **once, ahead of time**:
   `python -m piper.download_voices en_US-amy-medium`, then point `PIPER_MODEL_PATH` at the
   `.onnx` file. Downloading up front is deliberate: a feature whose whole premise is "nothing
   leaves the machine" must not make a network call on its first utterance.
3. **Nothing else.** No permission prompt — playback goes through the same renderer window that
   already owns the microphone.

Both paths absolute. `PIPER_DATA_DIR` and `PIPER_LEGACY_FLAGS=1` are available if you need them
(the archived build spells its flags `--model`/`--output_file` rather than `-m`/`-f`).

Two keys worth knowing while it's talking: **Escape** silences it, and either hotkey interrupts
it *and* starts listening for a new instruction.

If it's set up but silent, the app tells you why on screen rather than failing quietly — a wrong
`PIPER_EXE_PATH` names the path and the setting, and the engine's own error is passed through
verbatim.

### Setting up dictation (optional)

No extra setup beyond voice above — dictation shares the exact same `WHISPER_EXE_PATH` /
`WHISPER_MODEL_PATH` transcriber, so if voice already works, dictation does too, on its own
**separate** hotkey.

| You do | It does |
|---|---|
| Tap the dictation hotkey | Starts listening — narrates which window it will type into, and that Enter finishes it |
| **Enter** | Stops, transcribes, and types the transcript at that window's cursor |
| **Esc**, or click away | Discards the recording. Nothing is typed |
| Wait **~80 s** (10s before the 90s cap) | A "wrap up" warning — the recording is about to pause automatically |
| Wait **90 s** | Mic released, audio kept — **Enter** still types it. (A safety ceiling for a forgotten Enter, not a normal session — the usual way to finish is pressing Enter. Raised from 30s after live use showed it cutting off longer dictated thoughts.) |

**While a recording is live, Enter is captured system-wide** — it stops dictation instead of
reaching whatever app has focus for its normal purpose (submitting a form, a newline), until
the recording ends one way or another. That's inherent to "Enter finishes it, no matter what
has focus," not a bug.

The app claims the first free combo from `Ctrl+M` → `Ctrl+Shift+Alt+D` → `Ctrl+Alt+D` →
`Ctrl+Alt+J` and logs which one won — pin your own with `DICTATE_HOTKEY` in `.env`.
`Ctrl+Alt+V` (Excel's Paste Special) and `Alt+Shift+D` (Word's insert-date field) are
deliberately not on that list at all. `Ctrl+M` was promoted to first choice after live use —
a real 2-key combo, faster to reach for than the others; it happens to sit next to the
instruction bar's own `Ctrl+Alt+M` fallback, which is a naming coincidence, not a conflict —
the two hotkeys are negotiated completely independently.

It's a **separate** hotkey rather than reusing the instruction bar's one (M8), because the two
want opposite focus behaviour: the instruction bar steals focus on purpose (you're talking to
the agent); dictation must never steal focus (you're talking to whatever app you're already
in). They can't run at the same time either — both need the one microphone, and while dictation
is armed, Enter belongs to it — so triggering one while the other is busy is a logged no-op,
not a silent failure. That guard now covers the bar's whole open time, not just while its own
voice capture happens to be recording, so the bar's Enter-to-submit and dictation's
Enter-to-finish can never collide (M12.1).

If focus moves to a different window between when you finish speaking and when it's about to
type, or Windows blocks the keystrokes outright (typically an unelevated app trying to type
into an elevated one — an admin terminal, say), nothing gets typed. You'll see the transcript
you spoke instead of losing it silently.

### Setting up pointing (optional)

**Read the section above before turning this on.** It's the one capability here that reads the
contents of another window.

```env
POINTING_ENABLED=1
```

- **`POINTING_ENABLED=1` exactly.** Not `true`, not `yes`. It is a deliberate speed bump on the
  one capability that reads a window you did not point it at explicitly.
- **No extra key, no extra provider.** The model that picks a control is the planner's own —
  the request is a list of names and the answer is a number, so there is nothing a separate
  vision model would add. `VISION_ENABLED`, `VISION_PROVIDER` and `VISION_MODEL` were removed
  in M16 and do nothing if set.
- **Windows only.** It reads Windows' UI Automation tree through a PowerShell helper process,
  started on first use and kept warm (~0.9s once, then ~0.3–0.5s per question on a native
  window, ~1.9s on a Chromium one).

On startup you'll see one of:

```
[main] pointing ON - 'where is X' reads the focused window's control names and sends them to the model (no screenshot is taken)
[main] pointing off - POINTING_ENABLED not set (no window is ever read)
```

## Watching the memory story

```bash
npm run eval
```

The eval harness in [`tests/eval/`](tests/eval/) is the demo, as an asserted scenario. It is **one
continuous thread of state** — not six isolated tests — and prints as a narrative:

```
Step 1 — cold memory: "open my dashboard" cannot resolve, and NOTHING fires
      ❌ refused: I don't know what "my dashboard" refers to yet…
Step 2 — teach it                                    ✅ target:dashboard = https://old… (v1)
Step 3 — the SAME task now works                     ✅ opened https://old.example.com
Step 4 — correct it: "no, I meant the new one"       ✏️  v1 retired (active=0), v2 active
Step 5 — the same task uses the CORRECTED value      ✅ opened https://new.example.com
Step 6 — recall reveals it        🧠 target:dashboard → https://new… (confidence 0.80, v2, today)
```

`npm test` runs everything (345 tests): the planner, each tool, the memory engine, the risk gates,
the LLM-provider factory, the voice state machine, the dictation state machine, the Gmail reply
flow, the Notion page-writing flow, the calendar tools, and both eval suites. All headless against `MockShell`, a
`MockInputInjector` standing in for real `SendInput`, fake Gmail/Notion tabs, a fake calendar and a fake Google token endpoint, and jsdom
fixtures — **no API key, no network, no real Slack, no microphone, no whisper model, no browser,
no inbox, no Notion account, no Google account, no OAuth flow, and no OS keystroke actually sent.**

---

## Status — what's proved, and what isn't

**Chaining — the machinery is proved, the model's judgement is not (M17).** Everything
deterministic is tested: steps run in order; `{step1}` reaches step 2 carrying the earlier step's
real text; a skipped-back `{step1}` from step 3 resolves to step 1 and *not* step 2; the
substitution happens before the gate, so the confirm dialog is asserted to name the real argument;
a fourth step, an unknown tool, and a forward reference are each refused with **nothing run and
nothing announced**; a mid-chain refusal stops the chain and reports 1 of 3 done and 2 and 3 not
run; intermediate results are shown but provably not spoken. A chain of the **real** registry
(`readSchedule → addToPage`, against the fake calendar and fake Notion) is asserted to carry the
actual formatted listing across the step boundary, so the suite isn't only testing purpose-built
tools against itself.

The pending-confirm guard has its own regression test at **step N of N** — the one place a
mistake here would reproduce the M14 near-miss. It uses a confirm that genuinely *blocks*
(`MockShell.holdConfirm`), because a fake that answers instantly can only prove the guard was
consulted, never that it held while the dialog was up.

**What that does not prove:** that a real model chains when it should and doesn't when it
shouldn't. The prompt is deliberately lopsided against chaining, but "does gpt-5 wrap a
single-tool request in a plan?" is a live question, and so is whether it writes `{stepN}` into
sensible argument positions. Unverified until someone runs it.

**One live bug it did find, and this is the one that ran that question for real.** The exact same
instruction, run twice, produced two different outcomes: once the model tried to bundle
everything into a single response with more than one tool call in it, and both provider clients
used to keep only the first and silently drop the rest — the tool that ran spoke normally, then
the run just stopped with nothing on screen and nothing logged. Fixed by refusing out loud the
moment a response contains more than one tool call, instead of guessing which one to run
(`core/llm/toolChoice.ts`). See `spec.md`'s M17 proven-vs-live-only section for the full account.

**A second, on how the plan preview reads.** On a chain whose steps all finished fast, the
preview text was replaced by step 1's result in well under a second — not long enough to read.
The spoken narration was fine both times (audio plays out at its own pace regardless of how fast
the planner runs); this was screen-only. Fixed with a minimum, adaptive read-time hold — 2.5s,
minus however much real time the narration already took — so a chain that's already slow for a
real reason is never delayed further on top of it.

**A third: the 3-step cap couldn't actually be tested live, at first.** Six attempts at a 4-step
chain all failed — safely, never as anything misleading — but before ever reaching the step-cap
refusal itself: the model ran out of reasoning-token budget trying to plan that many steps, the
same failure class the app already catches cleanly as "I ran out of room," just never previously
exercised by a request this size. Raised the token budget (4096 → 8192) so a plan attempt has
enough headroom to actually finish forming and reach the cap that's supposed to catch it.

**Verified deterministically (798 tests across the suite; these among them):** tool routing, the registry guard against hallucinated
tools, memory resolution, version-on-conflict, decay, the correction loop end to end, the confirm
gate (**"no" provably sends nothing** — the fake sender is asserted to have received zero calls),
failure-after-confirm, graceful refusal, and `LLM_PROVIDER` selection/error handling.

**Voice — mechanism verified, speech not.** Every state transition is asserted directly,
including the decided edge cases: typing cancels the recording **silently** (no message, no stray
transcript), the 90 s cap releases the mic without transcribing while `Enter` still runs what you
said, a second `Enter` during transcription never starts a second run, and every failure — blocked
mic, whisper crash, blank transcript, sub-300 ms clip — returns to `idle` with the hotkey still
live. The load-bearing test is that a dictated instruction produces an `action_log` row
**indistinguishable from a typed one**, and that a dictated irreversible action still stops at the
confirm gate.

**One measured bug, found and fixed.** Live use felt slow, and typed input was affected too —
which pointed at the shared path, not at voice. `showInput()` was registering a fresh IPC listener
per call and only removing it on submit or Escape, so clicking the bar away stranded one. Measured:
five abandoned openings left five stranded listeners, and the next single keystroke fired **six
concurrent planner runs — twelve LLM calls, six `action_log` rows, and six executions of the
chosen tool.** (Had it routed to `sendMessage`: six confirm dialogs, six Slack posts.) The resolver
now lives on the shell instance behind one persistent listener, and every way of hiding the bar
ends the capture. Re-measured after the fix: **one run, flat listener count.** Details and the
before/after table are in [`spec.md`](spec.md).

That fix is now **pinned by a test rather than by care**. Cleanup is bound to the window's own
`hide`/`closed` events instead of to one method, so a future direct `window.hide()` cannot quietly
reintroduce it, and `tests/WindowsShell.capture.test.ts` opens and hides the bar 20 times across
all five hide paths asserting the listener count never moves. Both failure shapes were verified to
actually turn it red.

**A silent failure that no longer is.** `chooseTool` asked for 1024 tokens, but on a reasoning
model the reasoning is spent from the same allowance the tool call must fit in — so a long think
could return no tool call, and the app reported that as *"I don't have a tool for that"* and filed
it in the miss backlog as a missing capability. Both wrong, and invisible. The budget is now 4096,
and truncation is its own outcome (`{ kind: "incomplete" }`) that surfaces the real reason and
stays out of the build-next backlog.

While the planner works, the bar shows **Thinking…** — a 6–13 s wait that shows work reads
very differently from one that looks frozen. It makes nothing faster; it makes the time legible.

**Baseline latency is the model, not the app.** Measured end-to-end: `chooseTool` 3.4–8.8 s,
`complete` 2.5–6.1 s, whole instruction 6.5–12.7 s — while hotkey → bar visible is 5–40 ms. `gpt-5`
is a reasoning model and dominates every run; if instructions need to feel faster, that is the
lever, not the shell.

**Not verified: anything requiring a real microphone or model** — transcription accuracy and CPU
latency, Windows 11 mic permission, the 48 kHz→16 kHz resample against a real device, and whether
tap-to-toggle *feels* right in practice. The fakes prove the machinery, not the speech.

**Live-verified: OpenAI / `gpt-5`.** A real run surfaced a genuine gap and it's now fixed: a
correction that names its subject ("no, my dashboard is actually `<url>`") always routed to
`remember` correctly, but a *bare* correction ("no I meant this `<url>`") was inconsistent —
`chooseTool` had no memory of the previous instruction, so the model sometimes declined,
sometimes mis-fired `openTarget`. Fixed by giving the planner one turn of state: `ActionLog.getLast()`
is now passed into every `chooseTool` call, scoped strictly to resolving a correction/pronoun in
the current instruction (`src/core/planner.ts`, `src/core/llm/prompt.ts`). Re-verified 3/3
consistent after the fix. Slack send (confirm gate → format → real webhook POST) also confirmed
working live.

**Not yet live-tested: Anthropic / `claude-sonnet-4-6`.** It's implemented against the exact same
`LLMClient` interface and typechecks, but nobody has run it against a real Anthropic key yet — flip
`LLM_PROVIDER=anthropic` in `.env` to try it. Until that happens, treat it as
implemented-but-unverified, not proven.

If correction-routing ever misfires again, the fix belongs in the **`remember` tool's description**
(`src/core/tools/remember.ts`) or the previous-turn framing in `src/core/llm/prompt.ts` — **not**
in the planner's control flow.

**M11, live-verified against a real Notion page.** The mechanism this milestone rests on was
tested directly before being shipped: JS-level `.click()`/`.focus()`/`document.execCommand()`
calls report success on Notion's editor but save nothing — confirmed across several distinct
approaches — while real CDP-level mouse and keyboard input works. A single multi-line
`insertText` call also silently dropped everything after its first newline; a real Enter
keypress between separately-typed lines does not. The **shipped** `ChromeNotion` class (not a
throwaway script) then appended real, verifiable text to the live page end to end, and a live
Gmail regression confirmed the `core/browser/` extraction broke nothing. Not yet proven by
anything short of more live use: behavior on a locked/read-only page (none was available to
test against — `appendToPage` verifies success by reading the page back rather than
pre-checking for one), and whether `Page.bringToFront`'s visible tab-switch is an acceptable
cost in daily use.

**M12 — mechanism verified once, manually; the full state machine proven, real keystrokes
not.** `SendInput` + `KEYEVENTF_UNICODE`'s exact P/Invoke shape (the nested-type array
construction, `Marshal.SizeOf`, the struct layout) was checked by hand outside the test suite
before being shipped — deliberately via a **zero-length** `SendInput` call plus a read-only
foreground-window query, so the verification step itself could never inject a keystroke
anywhere. `DictationSession`'s state machine is pinned the same way `VoiceSession`'s is: the
begin → recording → transcribing → inserting → idle order; a focus change between speaking
and typing refusing outright with the transcript preserved, never guessing it's still safe to
type; a short/blocked write becoming a thrown refusal rather than a silent partial type; the
30 s cap releasing the mic without acting; and — the specific regression this milestone's own
`WindowsShell` change was for — Escape, a direct `window.hide()`, and the window closing all
correctly cancel a dictation session that never called `showInput()` at all, something the
pre-M12 code had no way to do since its only guard was "is a typed-text capture pending".
**Not yet proven, and only a live run can prove it:** that real keystrokes land correctly in
real targets (a terminal, an IDE with its own autocomplete, Word/Excel specifically, since the
hotkey list was chosen around avoiding exactly those apps' own shortcuts), that the
elevated-window refusal fires the way the design assumes, and whether the 30 s cap is the
right length in practice.

**M12.1 — the gesture changed after the first live test, same proof structure as M12.** Live
use surfaced the original same-hotkey toggle as the wrong mental model — people reflexively
reach for Enter, the way the instruction bar already works. `DictationSession` now matches
`VoiceSession`'s own `begin()`/`finish()` shape, with `finish()` firing on a **global** Enter
press (`WindowsShell.armStopKey`/`disarmStopKey`) armed only between `begin()` and the session
returning to idle. Proven deterministically (11 tests): the arm/disarm lifecycle fires exactly
once per session regardless of which path got it back to idle; a stray Enter before any
recording has started is a harmless no-op; firing the REAL "Return" accelerator (against the
actual `WindowsShell`, not just a mock) runs the whole stop → transcribe → type sequence and
then frees Enter for every other app; Escape still cancels independently. The mutual-exclusion
guard was also widened and re-proven: the dictation hotkey now stays blocked for the
instruction bar's whole open lifetime, not just while its own voice capture happens to be
recording — closing a gap that was harmless under the old toggle (which never touched Enter)
but became a real one once Enter became a trigger both flows reach for. **Not yet proven:**
whether capturing Enter system-wide for a recording's duration feels right in daily use, and
whether the global "Return" registration itself ever collides with something else that already
owns it (logged, but never hit).

**M12.2 — four fixes straight from live use, no new tests needed.** Unlike every earlier
dictation milestone, these landed from testing directly rather than being planned first: a
faster `Ctrl+M` hotkey candidate; the cap raised 30s → 90s (30s was cutting off longer
dictated thoughts) plus a 10s pre-cap warning, with the cap-reached message now deriving its
wording from the actual configured length instead of a literal `"30s"` that would otherwise
have silently gone stale; a real double-`finish()` race fixed by claiming the session
(`enter("transcribing")`) before the first `await` — Enter's global callback firing twice for
one physical press had let two concurrent `finish()` calls both pass the guard and race into
typing, producing genuinely interleaved, duplicated-letter text; and `WindowsInputInjector`'s
chunking tightened from 25 chars/8ms to **1 char/40ms** after live testing produced real
OS-level character repetition ("mmmmmm") at the faster pacing — `KEYEVENTF_UNICODE` events
carry no virtual-key code, so a fast enough stream of them can trip Windows' own key-repeat
handling. That last fix has a real, undisputed cost: longer dictations now visibly take longer
to type out. The existing test suite (no new tests) caught one regression from the race-
condition fix before it shipped — a leftover, now-duplicate state transition that double-
emitted "transcribing" and failed an existing ordering assertion — proof the coverage from
M12/M12.1 was still doing its job. **Not yet proven:** whether 1 char/40ms is the right
trade point or something less costly would still fix the repetition, and whether the
double-`finish()` race has any trigger besides Enter's observed double-fire.

**M13 — proven against fakes, not yet live.** The three calendar tools, the argument-dependent
risk tier, and the OAuth refresh logic are all covered deterministically (71 tests): every
refusal, the escalate-never-de-escalate rule, resolve-the-tier-exactly-once, declining a
`dangerous` create provably creating nothing, and — the one that decides every tier —
that Google listing you as an attendee on your own event maps to **zero** guests. Two bugs
surfaced during the build, both from tests rather than live use: a derived end time coming back
in UTC while its start was `+05:30` (same instant, so nothing broke — which is why it was worth
fixing before it hid something), and a refresh token that could reach an error message through
an interpolated network-error string, now redacted.

**Then the first live run found two more, both in the one file that had no tests.** Every
calendar instruction reported the connection as *revoked* while a manual token refresh with the
same credentials returned `200` — so the answer had to come from the actual HTTP responses, not
from the code path that produced the verdict. (1) `calendarTimeZone()` read
`GET /calendars/primary`, the **Calendars** resource, which the `calendar.events` scope doesn't
grant: `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. Since that's the first call in almost every path,
*everything* failed on its opening request. The timezone now comes from the events listing's own
envelope — same scope, and usually no extra request at all. (2) Every 403 was being read as a
revocation, which is what made the first bug unreadable: it told you to reconnect, and
reconnecting asks for the *same* permissions, so it could never have worked. 403s are now
classified by reason, and `insufficient-scope` joined the named auth failures.

The lesson is narrower than "test everything". Leaving that file untested was right for request
*shaping* — only a real API can verify that — and wrong for error *classification*, which is
ordinary logic that happened to live in the same file. That logic is tested now; the shaping
still isn't, because it still can't be.

**A third live bug, and it was the one predicted.** "move the test one meeting to 8pm" found
nothing; "move test one to 8pm" worked. Google's `q=` ANDs its search terms, so the two words
added to make an English sentence became two more things the event had to contain — and the
tool description had *told* the model to pass the user's own phrasing, article and all. Now the
description asks for the event's name, and the search tries the exact phrasing first, retrying
without filler words only when that misses. That order matters: an event genuinely called "Team
meeting" matches on the first attempt, so "meeting" is only ever stripped when the alternative
is refusing outright. `FakeCalendar` had hidden it by matching on substrings, which made the
working and failing phrasings behave identically; it now mirrors the real AND-of-terms rule.

**Still not proven:** whether the filler list matches how this user actually speaks, and whether
the model reliably turns "tomorrow at 3" into a correct ISO instant now that the prompt carries
a clock. That change is proven to *render*, not proven to *work*.

**M15 was rejected and rebuilt as M16 — vision proposing coordinates directly was measured wrong,
so grounding moved to Windows' own accessibility layer.** M15's numbers stayed true to what was
tested (they're preserved in git history and in `spec.md`'s M15 write-up as the record of why the
approach was rejected), but the pipeline they describe no longer exists in this tree: no
screenshot, no `VisionLocator`, no `SMALL_TARGET_PX`. What follows is what replaced it.

**The inversion.** UI Automation — the same accessibility layer screen readers use — enumerates
the target window's controls with exact rects, deterministically. Code filters, deduplicates and
numbers them. The model's *entire* output is one integer, picking a candidate off a list this
process built. It can still be the wrong integer — a semantic error — but it can no longer be off
by 208 pixels, which is what M15's model did on real Windows chrome: pointed at the tab one over,
or ~208px onto a neighbouring toolbar icon, confidently.

**Proven deterministically (100+ tests, no PowerShell for most of the build).** Filtering, dedup
and numbering against eight fixtures — six transcribed from real UI Automation dumps, two
synthetic and labelled as such — including a byte-for-byte proof that the narrowing condition
used in production loses zero real candidates against pulling the whole tree. The settle decision
(is this window's control list still loading, or genuinely this small?) as a pure state machine
with no clock. The choose prompt and its parser against every malformed reply shape. Native-pixel
→ DIP geometry with hand-derived literals on the machine's real 1.5×-scaled display, including a
test that asserts the *specific wrong answer* an un-translated origin would produce. The
load-bearing assertion, carried over from M15 unchanged: **`screen.pointed` stays empty on every
refusal path** — an answer the gate doesn't trust must never become a marker.

**Then proven against the real PowerShell host, not just fakes.** All three of M15's failure
cases — the File menu, a specific tab, a toolbar button — re-verified at their exact rects on
live Notepad and Explorer. This step alone found two real bugs no fixture could: PowerShell's
`-Command -` invocation does not reliably deliver commands over stdin (fixed by writing the host
script to a file instead), and enumerating a window's whole control tree costs *seconds*, not
milliseconds, until the query is narrowed at the source — an 11× speedup with a proof that
nothing real was lost by narrowing it.

**Then driven through the actual app — real global hotkey, real keypress, not a script.** All
nine live-verification checks passed by hand, but getting there found two more bugs that only a
human at the keyboard could have caught:

- **The foreground-window snapshot was reading the app's own command bar, every single time.**
  It fired-and-forgot before the bar opened; the read always resolved *after* the bar had already
  taken focus, so the app answered every question about itself. Not a race — it could never have
  worked. Fixed by awaiting the snapshot (pre-warming the reader at startup so that costs ~15ms,
  not ~1s), and having the reader refuse to name one of the app's own windows even if asked.
- **The marker was one call behind.** Its position travelled in a URL hash; a hash-only change is
  a same-document navigation in Chromium, so the overlay's script — which reads its position once
  at load — never re-ran, and the marker kept showing the *previous* answer. Every new question
  wrong, every identical repeat right — more dangerous than "always wrong," because a first
  answer looks authoritative and nothing on screen suggests it's stale. Fixed by moving the
  position into the query string instead (forces a real navigation) plus a nonce.

Live testing also reshaped two refusal messages: a raw COM exception was reaching the UI
verbatim through the `unreadable` path (the host now returns classified codes, never engine
text, and retries once); and a disabled control was being filtered out of the candidate list
entirely, which collapsed "it's there but greyed out" into "I couldn't find it" — disabled
controls are now kept, shown to the model marked as disabled, and refused with their own honest
wording. A five-column Explorer window also showed that naming ambiguous candidates by
left-to-right ordinal ("3rd from the left") technically worked but made the reader count
columns; candidates inside a labelled container are now named by it ("under \"Date modified\"")
instead.

**Still not verified: multi-monitor**, for lack of a second display to test on — the arithmetic
is unit-tested against hand-derived values including the specific wrong answer a buggy version
would produce, but nothing has run against real hardware. **One refusal's live wording was never
provoked**: every attempt to catch a window's accessibility tree in its bare, pre-population
state found the tree had already woken up by the time the hotkey landed — the same "populated an
hour later" behaviour that is *why* the refusal is worded in the present tense rather than as a
permanent claim about an app.

---

## Scope

v0 is deliberately small: one instruction → one plan → one action. **Voice was added in M7**, after
v0 was complete — deliberately in that order, because voice is only a second way to produce the
instruction string, and it was worth building only once the string reliably produced the right
action. It changed nothing in `/core`.

**M10 added acting inside one app** — Gmail in Chrome, via the DevTools Protocol, finding
controls by role and accessible name. Deliberately one app: the writing half
(`src/core/compose.ts`) is app-agnostic and free to reuse, but the finding half needs real
verification per app, and "works everywhere, reliably nowhere" is the failure this project has
been avoiding since day one.

**M11 added a second app — Notion in Chrome, one page, append only** — specifically to test
whether that split was real. It mostly was: the generic browser transport
(`src/core/browser/`) and a genuinely shared writing core (`src/core/composeShared.ts`) both
came out of it clean and reusable. What did NOT transfer: `compose.ts`'s reply-shaped rules
(a note needs no greeting or sign-off), the three-tool draft/revise/send shape (Notion has no
staging area to build the other two around), and — the biggest surprise — the *mechanism*
itself. Gmail's compose box takes ordinary JS calls; Notion's editor silently ignores them and
needs real CDP-level input instead. Even the safety RULE ("resolve every target structurally,
refuse on ambiguity") only partly transferred: Notion exposes no ARIA roles on page content at
all, so the identification strategy had to become `data-block-id` + document order rather than
role + accessible name.

**M13 added a real API integration rather than a fourth thing to drive** — Google Calendar,
over HTTP. Not a reversal of the DOM approach: Gmail and Notion needed a browser because the
deliverable was a live, editable draft you could read before it went anywhere. A calendar event
is structured data, so there's nothing to edit in place and nothing a DOM buys. It also forced
the first real change to the risk model since M10 — a tier that depends on the *arguments* of a
call, because an event with guests emails them the instant it exists and there's no later
"send" left to gate.

**M12 added acting outside any browser at all — system-wide dictation.** Deliberately the
narrowest possible slice of "act on the OS": one operation (insert text at the caret),
triggered by a hotkey the model never sees and never chooses, so none of the tool-choosing
machinery M10/M11 needed even applies. It's the generalization the Gmail/Notion CDP work
always implied — real device-level input beats JS calls a target can silently ignore — played
on the one surface Chrome's DevTools Protocol can't reach: everything that isn't Chrome.

**M15 added the half of screenshot-driven computer-use that doesn't click.** It's the first
capability that acts on a model's *guess* about pixels rather than on something structurally
resolvable — and the first that sends the user's screen off the machine, which is why it's the
only one behind an explicit opt-in rather than behind "did you configure the thing it needs?".
Both of those are only acceptable because of what it doesn't do: it draws a marker and stops, so
a wrong answer costs you a glance rather than a click. The checkability that Gmail and Notion got
free from the DOM had to be manufactured for pixels instead — a set of rules about what a
*certainly wrong* answer looks like, every one of which refuses rather than nudges.

**Still not built:** auto-clicking anything the vision model identifies (deliberately — see
above), scrolling to find something off-screen, open-ended agent loops (M17 chains a *fixed*
plan of up to three existing tools decided in one call — what's still missing is the model
choosing its next move after seeing each result, plus branching and anything that outlives the
instruction),
more than one external connector, macOS/Linux, any email app but Gmail-in-Chrome, any page editor
but Notion-in-Chrome (and only the Chrome tab, not the Notion desktop app), search/navigation
within either app, and any dictation cleanup/rewrite pass (raw transcript only — see `spec.md`
§4c for the seam left for a later milestone). Those are architected for (behind `OSShell` /
`VoiceShell` / `InputInjector` / `GmailSurface` / `NotionSurface` and the tool registry) but not
built.
