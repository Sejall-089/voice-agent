import { normalizeReference } from "../memory/normalize.ts";
import { ageInDays, decayed, isStale } from "../memory/decay.ts";
import type { Fact, Tool, ToolDeps, ToolInput } from "../types.ts";

function formatAge(updatedAt: string): string {
  const days = ageInDays(updatedAt);
  if (days < 1) return "today";
  if (days < 2) return "1d ago";
  return `${Math.floor(days)}d ago`;
}

// One line per fact, carrying the epistemic metadata — this is the point of the tool.
// The confidence shown is the EFFECTIVE confidence a lookup would get (decay applied), not the
// raw stored number, so what a viewer sees is what the resolver would actually use.
function describe(fact: Fact): string {
  const effective = decayed(fact.confidence, fact.updated_at);
  const stale = isStale(fact.updated_at)
    ? `, stale — decayed from ${fact.confidence.toFixed(2)}`
    : "";
  return (
    `${fact.subject} → ${fact.value}\n` +
    `    (confidence ${effective.toFixed(2)}, v${fact.version}, updated ${formatAge(fact.updated_at)}${stale})`
  );
}

// Task 7 (spec.md §6): show what the agent remembers, WITH its metadata. The versioning,
// confidence, and decay machinery is the differentiator — a recall that printed only values
// would hide the very thing worth seeing. `v2` on a fact is the visible proof that a correction
// superseded an earlier version rather than overwriting it.
export const recallTool: Tool = {
  name: "recall",
  description:
    "Show what you remember about the user — the stored facts and their confidence, version, and " +
    "how recently they were updated. Use this when the user asks what you know or remember about " +
    "something ('what do you know about the team?', 'what do you remember about me?'). Pass " +
    "`subject` as a short bare key ('team', 'tone', 'dashboard') to narrow it, or omit it to show " +
    "everything.",
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description:
          "Optional. A short bare key to filter by ('team', 'tone', 'dashboard'). Omit for everything.",
      },
    },
    required: [],
  },
  irreversible: false,
  // `subject` is a LOOKUP KEY, not a reference to dereference. If the planner resolved
  // "the team" -> "#design-team" first, we'd then search for a fact whose subject is
  // "#design-team" and find nothing. Same reasoning as `remember`.
  resolvesReferences: false,
  handler: (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const raw = typeof input["subject"] === "string" ? input["subject"] : "";
    const subject = normalizeReference(raw);

    const facts = deps.memory.query(subject);

    if (facts.length === 0) {
      return Promise.resolve(
        subject.length > 0
          ? `I don't know anything about "${subject}" yet.`
          : "I don't know anything about you yet — tell me something with \"remember...\".",
      );
    }

    const header =
      subject.length > 0 ? `What I remember about "${subject}":` : "What I remember:";
    return Promise.resolve(`${header}\n\n${facts.map(describe).join("\n")}`);
  },
};
