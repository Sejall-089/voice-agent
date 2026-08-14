# CLAUDE.md — working rules for this repo

Read `spec.md` and `ARCHITECTURE.md` before writing code. `spec.md` is the source of
truth for scope, stack, and decisions.

## How to work here
- **Use Plan Mode for anything structural** (new module, interface change, data model
  edit). Propose the plan, wait for approval, then implement.
- **Build milestone by milestone** (M0 → M6 in spec.md §9). Do not jump ahead. Each
  milestone must run and be committable before starting the next.
- **Respect the scope guardrails** (spec.md §2). If a task seems to need anything in
  the OUT-of-scope list (voice, computer-use, extra connectors, Mac/Linux, multi-step
  loops), stop and ask — don't scaffold it "just in case".
- **MockShell first.** Build and test the core against `MockShell` before wiring the
  real `WindowsShell`. `/core` must never import `electron`.

## Non-negotiables
- TypeScript strict; no `any` in `/core`.
- The LLM proposes, the planner disposes: registry check + validation + confirm gate
  are deterministic and must never be bypassed.
- Irreversible tools (`sendMessage`) always pass through `shell.confirm()`.
- Secrets only from `.env`; never log the API key or webhook URL.
- Unregistered requests → graceful refusal + `logMiss()`. Never invent a tool.

## When you finish a milestone
- Run the test suite against MockShell.
- Update `spec.md` if any decision changed.
- Summarize what changed and what the next milestone needs.
