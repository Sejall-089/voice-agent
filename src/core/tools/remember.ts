import { UnresolvedReferenceError } from "../errors.ts";
import { normalizeReference } from "../memory/normalize.ts";
import { userSource } from "../memory/source.ts";
import { resolveSlackName, slackRefusalText } from "./sendMessage.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// The value to save for this fact (M22). Unchanged unless this install is in bot mode — a bot
// sender AND a channel directory — and the fact is about a channel: its value starts with "#", or
// its subject ends in "channel" ("bugs channel"). Then it must be a channel Slack has, and what is
// saved is Slack's own "#name". A channel Slack does not have, or a Slack that cannot be asked,
// is refused in the send's wording (but ending "so nothing was saved."), and NOTHING is written.
async function channelFactValue(subject: string, value: string, deps: ToolDeps): Promise<string> {
  const directory = deps.sender.mode === "bot" ? deps.channelDirectory : undefined;
  if (directory === undefined) return value;
  if (!value.startsWith("#") && !/\bchannel$/.test(subject)) return value;

  const lookup = await resolveSlackName(directory, value);
  if (!lookup.ok) throw new UnresolvedReferenceError(slackRefusalText(lookup, value, "saved"));
  return `#${lookup.channel.name}`;
}

// Tasks 4 + 6 (spec.md §6): store a fact, and — the flagship — let a correction supersede an
// old one. The storage work is already done: this handler calls the existing, tested
// memory.write(), which versions the old fact instead of overwriting it.
//
// THE DESCRIPTION BELOW IS THE PROMPT. It is what teaches the model to classify a correction
// ("no, I meant the design channel") as a memory WRITE rather than a retry of the last action.
// That classification is the one part of this app that rests on model judgment, so if a real
// correction ever mis-routes, tune this text — not the planner.
export const rememberTool: Tool = {
  name: "remember",
  description: [
    "Store or update a fact about the user, so future requests can use it.",
    "",
    "Call this tool whenever the user tells you something about themselves or their setup — in any of these forms:",
    "1. An explicit request to remember: 'remember that my tone is concise and warm'.",
    "2. A plain statement of fact: 'the design channel is #design-team', 'my dashboard is https://app.example.com'.",
    "3. A CORRECTION of something you got wrong or acted on incorrectly: 'no, I meant the design channel',",
    "   'actually it's #design-team', 'that's the wrong one — use the new dashboard', 'not that, I meant...'.",
    "",
    "Corrections are the most important case. When the user contradicts or corrects a fact you previously",
    "used or acted on, that is a memory update: call `remember` with the corrected value. Do NOT re-run the",
    "previous action, and do NOT treat it as a retry — storing the correction is the whole job. The corrected",
    "fact will automatically supersede the old one and change what future requests resolve to.",
    "",
    "`subject` is a short, bare key with NO articles: 'team', 'tone', 'target:dashboard'.",
    "Use the 'target:' prefix for anything openable in a browser (its value is a URL), e.g. 'target:dashboard'.",
    "`value` is the concrete thing to store: '#design-team', 'concise and warm', 'https://app.example.com'.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description:
          "Short bare key, no articles: 'team', 'tone', 'target:dashboard'. Use the 'target:' prefix " +
          "when the value is a URL to open.",
      },
      value: {
        type: "string",
        description:
          "The concrete value to store, e.g. '#design-team', 'concise and warm', 'https://app.example.com'.",
      },
    },
    required: ["subject", "value"],
  },
  risk: "reversible",
  // This tool's args are literals to STORE, not references to look up. Without this, the planner
  // would resolve a subject like "the team" into the fact's current value before we ever saw it.
  resolvesReferences: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const rawSubject = typeof input["subject"] === "string" ? input["subject"] : "";
    const value = typeof input["value"] === "string" ? input["value"].trim() : "";

    // Canonicalize so a stray "the team" is stored under the same key "the team" resolves to.
    const subject = normalizeReference(rawSubject);

    if (subject.length === 0 || value.length === 0) {
      throw new Error("I need both what to remember and what its value is.");
    }

    // M22. In bot mode a CHANNEL fact is checked against Slack before it is saved, and saved as
    // Slack's own name for the channel ("#help") — so "remember the bugs channel is #bgus" is
    // refused with what Slack does have, instead of being remembered and failing at the next send.
    const stored = await channelFactValue(subject, value, deps);

    // What did we believe before? (Lets the result show the correction, and makes the
    // versioning visible to the user rather than silent.)
    const previous = deps.memory.query(subject).find((fact) => fact.subject === subject);

    // The existing, already-tested version-on-conflict write: on a differing value the old row
    // is deactivated and a new version is inserted. Never an overwrite.
    deps.memory.write(subject, stored, { source: userSource() });

    if (previous && previous.value !== stored) {
      return `Updated "${subject}": ${previous.value} → ${stored} (v${previous.version + 1}).`;
    }
    return `Remembered: ${subject} = ${stored}`;
  },
};
