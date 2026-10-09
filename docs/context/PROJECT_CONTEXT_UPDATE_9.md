# Project Context — Update 9 (M17, M18, and M19: MCP with Linear as the first connector)

Read alongside `spec.md` (§5b, §6e, and the M17–M19 parts of §9), `ARCHITECTURE.md` §4f,
`CLAUDE.md`, and the two open checklists: `docs/M18-live-checklist.md` and
`docs/M19-live-checklist.md`. Supersedes Update 8 for *status*. Update 8 stopped at M16; M17 and
M18 shipped without a handoff file of their own and are summarised here so the index is not
three milestones behind.

## Status (2026-10-07)

- **M17 — chained plans.** Shipped and live-tested. One instruction may resolve to a fixed,
  ordered plan of up to three existing tools, decided in one planning call and run by code. Not
  an agent loop. spec.md §5b.
- **M18 — opening apps and local media control.** Shipped; its live pass found four bugs and is
  ticked with items still open. `docs/M18-live-checklist.md`.
- **M19 — MCP support, Linear first.** **Shipped and ticked 2026-10-09, with named gaps.** The
  live pass saw the proof chain work, the confirm dialogs fully visible, and the plan-choice fix
  hold in one live run. It found three bugs, all fixed (below). Not run live and covered by tests only:
  the decline/failure cases, the long-email dialog, the injected-instruction email, the
  `functions.` prefix rule. 1214 tests pass, both typechecks clean, `npm run build` clean.

## What M19 is

The app speaks MCP. An app can now be reached through a generic adapter plus a small definition
file, instead of a hand-built surface. Linear is the first connector. The live proof is one
chained instruction: read a Gmail bug email → create a Linear issue → post the issue's link to
Slack.

Hand-built Gmail, Notion and Calendar are untouched. MCP is for apps with no hand-built
integration.

## Decisions made (by Sejal), and where they live

| Decision | Choice |
|---|---|
| Default tier for an unclassified connector tool | `caution`; only allowlisted tools are exposed at all |
| Tier of create-issue | `dangerous` — the dialog shows the full title and description |
| Linear auth | API key in `.env` as `LINEAR_API_KEY` (not OAuth) |
| Slack target for the proof | the webhook's channel; no DMs |
| Chained `sendMessage` | sent verbatim, shown in full; "chained" means the whole chain |
| Standalone `sendMessage` reformat-after-confirm gap | follow-up list, not M19 |
| The issue title | written by the model from the spoken instruction; `{step1}` is the description |
| Tool descriptions | ours, in code; the server's schema is used only for validation |
| Menu | pinned schemas in code, lazy connection, decided offline |
| Where `team` comes from | `defaultTeam` in `connectors.json`, shown in the confirm dialog |
| Create's arguments | title + description only |
| Config | `connectors.json` at the repo root, committed, no secrets; config file only, no UI |
| Recon script | strictly read-only; no create flag |
| **Standing rule** | **nothing automated ever creates a real Linear issue** — only the manual checklist does |

## What recon changed

The plan assumed a `create_issue` tool. The live server has none: `save_issue` creates when `id`
is absent and updates any issue when it is present. So the local tool name is not the remote
name, and what `linear__create_issue` can do is defined by a closed two-argument schema rather
than by the remote tool's reach. Results are a single text block of JSON, so every pinned tool
has a formatter; failures are `isError` results rather than thrown errors, so the adapter checks
for them. Linear's search turned out to be fuzzy (found by the live check). Details: spec.md §6e.

## What is verified, and how strongly

- **Headless, deterministic:** everything in spec.md §9 "M19 — proven vs. live-only". The MCP
  protocol is not faked — the SDK's real client and server over its in-memory transport.
- **Script against the real workspace, read-only:** `scripts/linear-recon.mjs` and
  `scripts/linear-live-check.ts`. The second drives this app's own adapter and passed.
- **A person at the keyboard (2026-10-08/09):** the proof chain end to end, the step 2 and 3
  dialogs fully visible, and the short instruction planning three steps with the real email
  once (clipboard contents not recorded). Not the decline/failure cases, the
  long-email dialog, the injected-instruction email, or the `functions.` prefix rule.

## What the next session needs

M19 is closed. Nothing is owed to ship it; these are what is left around it.

1. **Clean up Linear by hand** (its MCP server has no delete tool): SEJ-5 (recon), SEJ-6
   ("test"), SEJ-7 (the empty issue), SEJ-8 and SEJ-11 (created, Slack step never sent), and
   whichever of SEJ-9, SEJ-10, SEJ-12 are unwanted copies of the test bug.
2. **50 checklist boxes are open on purpose** — not run live, covered by tests only. If a
   future session has an hour at the keyboard, the ones worth the time are the decline and
   failure cases, a genuinely long email, and the injected-instruction email (section 5).
   `docs/M19-live-checklist.md`, "Live results 4".
3. **`npm test` has not been run plainly since the confirm fix.** The app was running and
   held the SQLite binary, so the suite was run against a separate Node build of the same
   better-sqlite3 version. Quit the app and run `npm test` once to confirm 1214.
4. **OpenAI credits were running out** during the pass. The plan-choice results are for
   `gpt-5`; `ANTHROPIC_API_KEY` is not set in `.env`. A Gemini provider is on the follow-up
   list as its own milestone.
5. The follow-up list in `spec.md` §9 ("M19 — proven vs. live-only") is the full list of
   what was noted and left out. Start there before proposing an M20.

## What the live pass found (three bugs, all fixed)

1. **Step 3's confirm dialog opened behind the instruction bar**, text and buttons covered.
   The always-on-top bar had only ever been kept clear of the dialog by losing focus; a
   chain's step result re-shows it unfocused. Fixed in `WindowsShell.confirm()`: the dialog
   is parented to the bar window, the bar is hidden for the dialog's lifetime and restored
   after, and nothing may show the bar or arm Escape while a confirm is pending.
   `scripts/confirm-zorder-recon.cjs` measures the z-order. Confirmed visible by a person.
2. **A plan skipped `readEmail` and filed an issue with an invented description** (SEJ-7).
   Wording fix in the planner prompt and two tool descriptions (commit `8baaa58`). Not
   enough on its own —
3. **with unrelated clipboard text the model filed the clipboard as the bug** (0 of 3 in the
   eval), and the live run was refused only because it also wrote the tool name as
   `functions.linear__create_issue`. Two fixes (commit `e4eab73`): the planner is told "An
   email is open in Gmail." when a new read-only `GmailSurface.hasOpenEmail()` says so —
   never the subject or sender — and a leading `functions.` is forgiven when, and only
   when, the remainder is exactly a name on the menu. Eval after: 15 of 15, including
   "summarize this" still meaning the clipboard. Seen working live once; the unrelated-clipboard
   case itself was not re-run by a person with the clipboard recorded.

The lessons are in `CLAUDE.md`: a property that holds by side effect; fixing a refusal can
remove the only thing in front of a worse bug; an eval must see what the app sees.

## Follow-up list (carried, not started)

- The `functions.` prefix rule has never met a real prefixed name since it shipped — tests only.
- A Gemini provider, as its own milestone (schema subset, the `plan` tool's free-form
  arguments, truncation handling, and its own tool-choice eval).
- The confirm approve button says "Send" on every confirm, including a create; name it after
  the action.
- A chain stops *after* the issue is created when the Slack channel is unknown, orphaning it.
- Esc is both "stop speaking" and the confirm dialog's Cancel, and the app speaks the confirm
  question, so silencing it cancels the confirm. Left as native Cancel by decision (2026-10-09).
  Idea, not designed: stop speaking the question some other way.

- Standalone `sendMessage` reformats the notes through a model *after* the confirm; what is sent
  is not what was approved. Fixed for chains only.
- The previous turn's result (300 characters) reaches the next planning prompt; after a chain it
  can be external text. Left as is, by decision.
- Gmail's "no email open" is a bare `Error`, so as step 1 of a chain it reads "Something went
  wrong". Pre-existing.
- More of Linear: priority, labels, assignee, comments. A second connector. Stdio servers and
  OAuth, if one ever needs them.
- Everything still parked from M18 (spec.md §9, "Parked after M18").

## Where things are

- `src/core/mcp/` — the whole feature. Start with `types.ts`, then `connectors/linear.ts`.
- `connectors.json` — which connector tools are on.
- `tests/FakeMcpServer.ts`, `tests/fixtures/linear/` — the in-memory Linear and what it was
  transcribed from.
- `tests/planner.mcp.test.ts` — the chain, end to end.
