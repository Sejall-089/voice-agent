// The one canonical rule for turning what a human said into a fact subject.
// Shared by the resolver (reading) and the `remember` handler (writing) so a reference and
// the fact it was stored under always agree.
//
//   "my dashboard"    -> "dashboard"
//   "the team"        -> "team"
//   "the usual tone"  -> "tone"
//   "target:dashboard"-> "target:dashboard"   (prefix convention preserved)
//
// Deterministic string work only — never an LLM call, so resolve stays fast and testable.
export function normalizeReference(reference: string): string {
  return reference
    .toLowerCase()
    .trim()
    .replace(/^(my|the)\s+/, "")
    .replace(/^usual\s+/, "")
    .trim();
}
