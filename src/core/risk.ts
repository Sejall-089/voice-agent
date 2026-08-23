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
// gate reads the RESOLVED tier, never how the instruction arrived.
export function needsConfirm(risk: Risk): boolean {
  return risk === "dangerous";
}

// True for actions that run on their own but must be announced BEFORE they happen. Narration is
// what stands in for undo: by the time the reply box is open there is nothing to roll back, so
// the user's protection is knowing it is about to happen while it is still happening to them.
export function needsNarration(risk: Risk): boolean {
  return risk === "caution";
}

// --- Argument-dependent tiers (M13) ---
//
// Through M12 a tool's tier was a property of the TOOL: `sendReply` was dangerous whether the
// reply was one line or ten, because sending is sending. Calendar breaks that. Gmail could
// gate on `sendReply` alone because drafting and sending are separate moments; a calendar
// event has no equivalent later step — attendees are emailed the instant it is created or
// moved. So the same tool is routine when the event is yours alone and high-stakes when it
// puts a meeting invite in someone else's inbox, and the only thing that separates the two is
// the ARGUMENTS of this particular call.
//
// The gate itself does not change: the planner still reads one tier and does one of three
// things with it. What changes is where that tier comes from.
export interface RiskPolicy<Args, Deps> {
  // Every tier `resolve` may ever return, declared up front rather than discovered at runtime.
  // This is what keeps registry-wide invariants checkable — "anything that CAN be dangerous
  // has a confirmSummary" is a statement about the whole menu, and it needs to be answerable
  // without calling anything (see tests/risk.test.ts).
  readonly tiers: readonly Risk[];
  // SAFE, read-only work only: this runs BEFORE any gate has fired, so it must never change
  // the world it is classifying. May read the world (moveEvent has to look up whether the
  // event it would move has guests) — the same widening `confirmSummary` got in M10 and
  // `narrate` got in M11, for the same reason and under the same rule.
  resolve(args: Args, deps: Deps): Risk | Promise<Risk>;
}

// What a tool declares. A plain `Risk` is still the common case and still means exactly what
// it meant in M10 — every tool built before M13 is untouched.
export type ToolRisk<Args, Deps> = Risk | RiskPolicy<Args, Deps>;

const ORDER: readonly Risk[] = ["safe", "reversible", "caution", "dangerous"];

// The most cautious tier in a set. Used for fail-closed escalation below, and by the registry
// invariants to ask "what is the worst this tool could do?".
export function highestTier(tiers: readonly Risk[]): Risk {
  let worst: Risk = "safe";
  for (const tier of tiers) {
    if (ORDER.indexOf(tier) > ORDER.indexOf(worst)) worst = tier;
  }
  return worst;
}

// Every tier a tool could ever resolve to. A fixed tier declares exactly itself.
export function declaredTiers<A, D>(risk: ToolRisk<A, D>): readonly Risk[] {
  return typeof risk === "string" ? [risk] : risk.tiers;
}

// Work out what THIS call costs. Called by the planner with the resolved arguments (memory
// resolution has already run), so the tier describes the concrete action, exactly like
// `confirmSummary` describes the concrete action.
//
// ESCALATE, NEVER DE-ESCALATE. If the resolver throws — the calendar is unreachable, the token
// expired, the event vanished — or hands back a tier it never declared, we take the worst tier
// it declared instead. A classifier that fails must not be able to talk the planner OUT of a
// confirm gate; the failure mode of "we could not tell" has to be "ask", not "go ahead". In
// practice the escalation usually lands on `dangerous`, and `confirmSummary` then fails on the
// same broken read and refuses outright — fail-closed at both steps.
export async function resolveRisk<A, D>(
  risk: ToolRisk<A, D>,
  args: A,
  deps: D,
): Promise<Risk> {
  if (typeof risk === "string") return risk;
  const fallback = highestTier(risk.tiers);
  try {
    const resolved = await risk.resolve(args, deps);
    return risk.tiers.includes(resolved) ? resolved : fallback;
  } catch {
    return fallback;
  }
}
