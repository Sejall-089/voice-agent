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
- **M19 — MCP support, Linear first.** **Code-complete, pushed, and never run by a person.**
  1138 tests pass, both typechecks clean, `npm run build` clean. The milestone box in spec.md §9
  is deliberately unticked until the live checklist is done.

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
- **A person at the keyboard:** nothing yet.

## What the next session needs

1. **Run `docs/M19-live-checklist.md`.** Section 0 is a regression check and goes first.
   Section 4 is the proof chain; point the Slack webhook at a test channel.
2. **Run the opt-in plan eval** (4 model calls):
   `M19_PLAN_EVAL=1 npx vitest run tests/eval/planChoice.eval.test.ts`. The known gap since M17
   is the model not reaching for `plan`. A worked example was added to the plan tool's
   description to help; whether it does is unmeasured. The eval's single-tool control is the
   check for over-teaching.
3. **Delete `SEJ-5 "M19 recon - safe to delete"`** in Linear by hand. It was created once during
   recon to capture the create-result shape; Linear's MCP server has no delete tool.
4. Expect at least one live bug. The most likely places: `app.getAppPath()` not finding
   `connectors.json` under `npm run dev`; the model choosing one tool instead of a plan; the
   title it writes; how a result containing a URL and an identifier sounds.
5. Tick the M19 box in spec.md §9 only after the live pass, and record what it found in the
   checklist's "Live results".

## Live pass, so far (2026-10-09)

The first live chain found the first bug: **step 3's confirm dialog opened behind the
instruction bar**, text and buttons covered. The always-on-top bar had only ever been kept clear
of the dialog by losing focus; a chain's step result re-shows it unfocused. Fixed in
`WindowsShell.confirm()` — the dialog is parented to the bar window, the bar is hidden for the
dialog's lifetime and restored after, and nothing may show the bar or arm Escape while a confirm
is pending. 13 more tests; `scripts/confirm-zorder-recon.cjs` measures the z-order. **A person
re-checking it is still owed** — the items under "The dialogs themselves" in section 4 of the
checklist, including the one no script could measure: whether the dialog takes keyboard focus
when the app is not the foreground app.

## Follow-up list (carried, not started)

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
