# M22 — live verification checklist (by hand)

> **NOT RUN YET.** 0 boxes ticked. A ticked box means **a person at the keyboard watched it
> happen in the running app**: no test, eval or recon script earns a tick here. An open box means
> *not seen by a person yet*, not *failing*.
>
> M22 adds Slack **bot-token mode**: a message goes to the channel you name, checked against
> Slack's own channel list before any dialog. `spec.md` §6f has the design and the known limits.
>
> **How results are marked** (same convention as `docs/M21-live-checklist.md`):
>
> - `[x]` **Human-verified**: a person saw it in the running app.
> - `[ ]` **Not yet watched**, including anything only a test or script has shown.
>
> **Real posts in this list are made by hand, to channels you chose for testing.** Nothing
> automated posts a real message. Use test channels the first time; every post below is real.

**Before you start**

- `SLACK_BOT_TOKEN="xoxb-…"` is in `.env` (quoted). The bot has the scopes `chat:write`,
  `chat:write.public`, `channels:read` and `groups:read`.
- The workspace has `#social` and `#help`. Create one more channel right before step 2: call it
  `#m22-new`, and don't tell the app about it.
- Create two private channels, `#m22-private-in` and `#m22-private-out`. Add the bot to the
  first only.
- Create a public channel `#fun` (for 3.2). Make sure nothing is remembered as "second channel"
  (for 6.3–6.5).
- Have the Gmail tools (`CHROME_DEBUG_URL`) and a connector (GitHub or Linear) set up for the
  chains in step 8.

To make the app forget a channel between runs, deactivate the fact in
`%APPDATA%\voice-agent\memory.db` (`UPDATE facts SET active = 0 WHERE subject = 'bugs channel'`).

---

## 1. Start in bot mode, and the token stays secret

- [ ] **1.1 Close the app completely**, then rebuild the database module for Electron with
      `npm run rebuild:electron`. (`npm test` rebuilds it for node, and the app can't load that
      build; `npm run dev` runs this rebuild itself through `predev`.)
- [ ] **1.2 Start it:** `npm run dev`. (The sandbox sets `ELECTRON_RUN_AS_NODE=1`; clear it
      first, or the app boots as plain node.)
      **Expect:** a startup line `[main] Slack: bot mode (SLACK_BOT_TOKEN)`.
      If `SLACK_WEBHOOK_URL` is also set, expect a second line saying both are set and the bot
      token is used.
- [ ] **1.3 Read the whole console from startup.**
      **Expect:** no `xoxb`, no part of the token, and no `Bearer` anywhere.

## 2. Lone sends go to the channel you name

- [ ] **2.1** Copy some notes and say **"send these notes to #social"**.
      **Expect:** the dialog says `Send to #social?`, then the formatted message after a blank
      line. There is no "webhook" and no "(You asked for…)" note. Approve it, and the message
      appears in **#social**. The result says `Sent to #social.`
- [ ] **2.2** The same with **"#help"**.
      **Expect:** the dialog says `Send to #help?`, and the message appears in **#help**, not
      #social.
- [ ] **2.3** The same with **"#m22-new"**, the channel created a few minutes ago and never
      taught.
      **Expect:** `Send to #m22-new?`, and it posts there with no setup.
- [ ] **2.4 A channel created seconds ago** (added after prompt 7). Send something to #help first,
      so the app has just read the channel list. Then create **`#m22-newer`** in Slack, wait about
      5–10 seconds, and send to **"#m22-newer"**.
      **Expect:** `Send to #m22-newer?`, and it posts there. If you are quicker than about 5 s
      after the last read, it may be refused as not found; ask again a few seconds later and it is
      found (the documented limit).

## 3. Spelling doesn't matter

- [ ] **3.1** Send to **"HELP"**, **"help"** and **"#Help"**, one after another.
      **Expect:** every dialog says `Send to #help?`, in Slack's own spelling. Cancel each one or
      send each one; either is fine.
- [ ] **3.2 "… channel"** (added after prompt 7). Send to **"social channel"**, **"#social
      channel"** and **"fun channel"**, one after another.
      **Expect:** the dialogs say `Send to #social?`, `Send to #social?` and `Send to #fun?`, and
      nothing is saved to memory. Then send to **"channel"** on its own: refused as not found,
      with no dialog.

## 4. A channel that doesn't exist

- [ ] **4.1** Send to **"#hepl"**.
      **Expect:** no dialog. The refusal is: "I couldn't find a Slack channel called #hepl. I
      can post to public channels and to private channels the bot has been added to. Similar
      channels: #help."
      The text has no question mark, and nothing is posted.
- [ ] **4.2** Send to **"#zzzz-not-a-channel"**.
      **Expect:** the same refusal with no "Similar channels" sentence.

## 5. Private channels

- [ ] **5.1** Send to **"#m22-private-in"**, where the bot is a member.
      **Expect:** `Send to #m22-private-in?`, and it posts there.
- [ ] **5.2** Send to **"#m22-private-out"**, where the bot is not a member.
      **Expect:** no dialog, and the not-found refusal ("…private channels the bot has been added
      to."). Nothing is posted.

## 6. "the help channel" with nothing remembered

- [ ] **6.1** Make sure no "help channel" fact exists. Say **"send these notes to the help
      channel"**.
      **Expect:** the dialog says `Send to #help?`, and it posts in #help.
- [ ] **6.2** Afterwards, look in `memory.db`.
      **Expect:** no "help channel" fact was saved.
- [ ] **6.3 A lone send asks** (added after prompt 7). With nothing remembered as "second
      channel", say **"send these notes to the second channel"**.
      **Expect:** no dialog yet. The bar asks "Before I start: which channel do you mean by 'the
      second channel'?"
- [ ] **6.4 Only a valid answer is saved.** Answer **"#hepl"**.
      **Expect:** it asks again: "I couldn't find a Slack channel called #hepl. … Similar
      channels: #help. Which channel do you mean by 'the second channel'?" Nothing is saved.
      Answer **"#help"**.
      **Expect:** `Saved: the second channel = #help`, then the dialog `Send to #help?`, and it
      posts in #help. In `memory.db`, "second channel" = `#help` and nothing else was written.
- [ ] **6.5 No answer saves nothing.** Remove the "second channel" fact, say the same thing again,
      and press **Escape** at the question.
      **Expect:** "I don't know which channel "the second channel" means — teach me with:
      remember the second channel is #your-channel." Nothing is posted or saved.

## 7. remember

- [ ] **7.1** Say **"remember the bugs channel is #help"**.
      **Expect:** `Remembered: bugs channel = #help`.
- [ ] **7.2** Then say **"send these notes to the bugs channel"**.
      **Expect:** `Send to #help?`, and it posts in #help.
- [ ] **7.3** Say **"remember the bugs channel is #hepl"**.
      **Expect:** refused ("I couldn't find a Slack channel called #hepl. … Similar channels:
      #help."). The stored fact is still `#help`; check with "what do you remember about the bugs
      channel" or in `memory.db`.

## 8. Chains

With a bug email open in Gmail:

- [ ] **8.1 Literal channel.** Say **"file this email as a bug on GitHub and post it in
      #help"**.
      **Expect:** the plan runs. You see the issue dialog, then `Step 3 of 3: Send to #help?`
      with the whole message. After you approve, the issue exists and the message is in #help.
- [ ] **8.2 Bad channel.** The same, but with **"#hepl"**.
      **Expect:** refused before step 1, with the not-found refusal. **No issue is created**
      (check GitHub or Linear), no dialog appears, and nothing is posted.
- [ ] **8.3 A channel from an earlier step.** Try to get a plan that takes the channel from a
      step's result. For example, with an email open that says "post this in #help", say **"post
      this email in the channel it names"**.
      **Expect:** if the model plans the channel as `{step1}`, the plan is refused before step 1:
      "In bot mode I need you to name the Slack channel yourself, not take it from an earlier
      step, so nothing was done." Nothing runs.
      (If the model plans it some other way, note what it planned; that is not a failure of
      this check.)
- [ ] **8.4 Unknown phrase in a chain.** Remove the "bugs channel" fact and say **"file this
      bug on GitHub and tell the bugs channel"**.
      **Expect:** the question "Before I start: which channel do you mean by 'the bugs
      channel'?". Answer **"hepl"** and it asks again with "Similar channels: #help." Answer
      **"help"** and it says `Saved: the bugs channel = #help`, and the chain runs.

## 9. Message text can't ping anyone

- [ ] **9.1** Send to #help the quoted message **`send "heads up <!channel> & <!here> — ask @someone" to #help`**.
      **Expect:** the dialog shows the text as written. In Slack it appears as plain text, with
      `<!channel>`, `<!here>` and `&` shown literally. **Nobody is notified.**

## 10. Slack unreachable

The app keeps Slack's channel list for 10 minutes, so whether it notices Wi-Fi is off depends
on whether that list is still fresh. Check both cases.

- [ ] **10.1 Cold list.** Close the app, turn Wi-Fi off, start the app, and send to **"#help"**.
      **Expect:** refused before any dialog: "I couldn't reach Slack to check the channel, so
      nothing was sent." Nothing is posted.
- [ ] **10.2 Warm list.** With Wi-Fi on, send to #help once, then turn Wi-Fi off and send to
      **"#help"** again within 10 minutes.
      **Expect:** the dialog appears, because the cached list still says #help exists. After you
      approve, the result says "Could not confirm the message to #help. It may have been sent.
      Check Slack before trying again."
      This is the documented limit: "may have been sent" even when it can't have been.
- [ ] **10.3** Turn Wi-Fi back on and send again.
      **Expect:** it works.

## 11. Back to webhook mode

- [ ] **11.1** Comment out `SLACK_BOT_TOKEN` in `.env` (keep `SLACK_WEBHOOK_URL`) and restart.
      **Expect:** the startup line `[main] Slack: webhook mode (SLACK_WEBHOOK_URL)`.
- [ ] **11.2** Send to **"#help"**.
      **Expect:** the M21 texts exactly. Either `Send to #social via your Slack webhook?` with
      `(You asked for #help; the webhook posts to its own channel.)`, or, with no
      `SLACK_WEBHOOK_CHANNEL`, `Send via your Slack webhook?` with the "ignores this" note. The
      message goes to the webhook's channel.
- [ ] **11.2a Webhook mode never asks** (added after prompt 7). Still in webhook mode, with nothing
      remembered as "second channel", say **"send these notes to the second channel"**.
      **Expect:** no question and no dialog: "I don't know which channel "the second channel"
      means — teach me with: remember the second channel is #your-channel."
- [ ] **11.3** Put `SLACK_BOT_TOKEN` back and restart.
      **Expect:** bot mode again.

## 12. Nothing leaked

- [ ] **12.1** Search the console output from this whole session for `xoxb` and `Bearer`.
      **Expect:** nothing found.
- [ ] **12.2** Search the action log for the same:
      `SELECT count(*) FROM action_log WHERE arguments LIKE '%xoxb%' OR result LIKE '%xoxb%' OR arguments LIKE '%Bearer%' OR result LIKE '%Bearer%'`
      in `%APPDATA%\voice-agent\memory.db`.
      **Expect:** `0`.

## 13. After the run

- [ ] **13.1** Restart once more and send a short message to #help.
      **Expect:** it posts, so the token still works.
- [ ] **13.2** Think back over the run: was the token shown anywhere? In a terminal, a
      screenshot, a pasted log, the app window.
      **Expect:** no. If it was, reinstall the Slack app (or rotate the token), put the new one in
      `.env`, and note it here.

---

**Findings** (fill in as you go): what was seen, what differed from the expectation, and the
action-log row ids for anything surprising.
