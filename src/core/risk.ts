// The four-tier risk model (M10), adapted from clacky's `permission.py`.
//
// Until M10 the only question a tool answered was "is this irreversible?", and a boolean was
// enough: everything the app could do was either a local, undoable transform or the one Slack
// POST. Acting *inside another app's GUI* breaks that. The honest reality of GUI actions is
// that most of them have no undo — you cannot un-open a reply box or un-type into a field —
// so "reversible?" stops being the useful question. Two different ones replace it:
//
//   SAFE       read-only (read the open email, read the compose box)     → run
//   REVERSIBLE mutates, but recoverable (clipboard, a browser tab, a     → run
//              versioned fact whose old row is kept)
//   CAUTION    irreversible but routine (open the reply box, insert a    → run, but SAY SO first
//              draft) — no undo, low stakes
//   DANGEROUS  irreversible AND high-stakes (send a message, click       → PAUSE for confirmation
//              Gmail's Send) — or a target we could not identify
//
// The last clause is the load-bearing one, and it lives in the Gmail layer rather than here:
// a control we cannot resolve by role + accessible name is never clicked at all. If we can't
// reason about what an action does, we don't do it — see `gmailScript.ts`.
export type Risk = "safe" | "reversible" | "caution" | "dangerous";

// True only for actions that must pause for an explicit user confirmation. Voice cannot route
// around this: dictated and typed instructions converge on one planner call site (§4a), and the
// gate reads the TOOL's tier, never how the instruction arrived.
export function needsConfirm(risk: Risk): boolean {
  return risk === "dangerous";
}

// True for actions that run on their own but must be announced BEFORE they happen. Narration is
// what stands in for undo: by the time the reply box is open there is nothing to roll back, so
// the user's protection is knowing it is about to happen while it is still happening to them.
export function needsNarration(risk: Risk): boolean {
  return risk === "caution";
}
