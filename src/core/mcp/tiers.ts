import { highestTier, type Risk } from "../risk.ts";
import type { ConnectorToolDef, RemoteTool } from "./types.ts";

// What does a connector tool cost when it goes wrong? (M19)
//
// For a hand-built tool that is a judgement someone made while writing it. A connector tool is
// one line in a definition, and the pressure on that line runs one way: it is easy to add a tool
// and forget to think about it. So the rule is built to fail toward caution at every step.
//
//   1. A tool is `safe` ONLY BY BEING DECLARED SO, in code, in its connector's definition.
//   2. A tool with no declared tier is `caution` — it runs, but it announces itself first.
//   3. A name that looks like a delete, a removal or a send is `dangerous` whatever was
//      declared. Both names are checked — ours and the server's — because ours is a label this
//      repo chose and could have chosen innocently for something that is not.
//   4. THE SERVER'S OWN HINTS MAY ONLY EVER RAISE A TIER. `destructiveHint: true` makes a tool
//      `dangerous`; `readOnlyHint: false` makes a `safe` tool at least `caution`. Nothing a
//      server says can lower anything: `readOnlyHint: true` on a tool this repo did not declare
//      safe changes nothing at all. The hints are text from somebody else's machine, and a
//      server that describes its delete tool as read-only is precisely the one not to believe.
//
// An ABSENT hint is not a hint. The MCP spec gives hints defaults (a tool that says nothing is
// presumed destructive), and honouring those would let a server's SILENCE reclassify a tool —
// turning every search on a hint-less server into a confirm dialog. The floor for an
// unclassified tool is already `caution` by rule 2; only an explicit statement moves it further.

// Whole words only, so `resend_invite` matches and `sender_name` or `removed_at` do not. Checked
// against the name split on underscores, hyphens and camelCase humps.
const DANGEROUS_WORDS = new Set(["delete", "remove", "destroy", "purge", "erase", "send"]);

export function looksDangerous(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => DANGEROUS_WORDS.has(word));
}

// The tier from code alone — rules 1 to 3. Known without a connection.
export function baseTier(tool: Pick<ConnectorToolDef, "name" | "remote" | "risk">): Risk {
  const declared: Risk = tool.risk ?? "caution";
  const named = looksDangerous(tool.name) || looksDangerous(tool.remote);
  return named ? highestTier([declared, "dangerous"]) : declared;
}

// Rule 4. `remote` is what the server said about the tool on this connection.
export function effectiveTier(base: Risk, remote: Pick<RemoteTool, "readOnlyHint" | "destructiveHint">): Risk {
  const tiers: Risk[] = [base];
  if (remote.readOnlyHint === false) tiers.push("caution");
  if (remote.destructiveHint === true) tiers.push("dangerous");
  return highestTier(tiers);
}

// Every tier `effectiveTier` could return for this base, for `RiskPolicy.tiers` — which must be
// declared up front so the registry-wide invariants in tests/risk.test.ts stay answerable
// without calling anything.
export function possibleTiers(base: Risk): readonly Risk[] {
  const reachable: Risk[] = [base, "caution", "dangerous"];
  return reachable.filter(
    (tier, index) => reachable.indexOf(tier) === index && highestTier([base, tier]) === tier,
  );
}
