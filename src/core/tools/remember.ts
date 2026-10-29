import { UnresolvedReferenceError } from "../errors.ts";
import { normalizeReference } from "../memory/normalize.ts";
import { userSource } from "../memory/source.ts";
import { resolveSlackName, slackRefusalText } from "./sendMessage.ts";
import type { Fact, Memory, PrepareDeps, Tool, ToolDeps, ToolInput } from "../types.ts";

// M33 (live finding). Two values NAME THE SAME THING when they match once one leading "#" is set
// aside, with case and surrounding spaces ignored: "#social", "social" and " #Social " are one
// channel. Speech-to-text cannot write a "#" at all, so "remember the team is #social", said
// aloud, arrives as "social" — and was being asked about as if it changed the team.
export function sameName(a: string, b: string): boolean {
  const name = (value: string): string => value.trim().replace(/^#/, "").trim().toLowerCase();
  return name(a) === name(b);
}

// What writing `value` would do to the fact `current` (the active one with exactly this subject):
//   first    nothing is stored: written, silently
//   same     the very same text: written as before, which only refreshes it (no new version)
//   keep     the same name, and the stored form is already the "#" one or differs only in case:
//            NOTHING is written, and the stored form stands ("Already remembered …")
//   upgrade  the same name, and only the new form has the "#": written silently, as v2
//   change   a different value: asked about first (the tier is `dangerous`)
export type Judgement = "first" | "same" | "keep" | "upgrade" | "change";

export function judge(current: Pick<Fact, "value"> | undefined, value: string): Judgement {
  if (current === undefined) return "first";
  if (current.value === value) return "same";
  if (!sameName(current.value, value)) return "change";
  return value.trim().startsWith("#") && !current.value.trim().startsWith("#") ? "upgrade" : "keep";
}

// The active fact with EXACTLY this subject — not `query`'s LIKE match, which would let
// "channel" stand in for "bugs channel". A memory that cannot be read throws.
function currentFact(subject: string, memory: Pick<Memory, "query">): Fact | undefined {
  return memory.query(subject).find((fact) => fact.subject === subject);
}

// M34. What writing `value` under `subject` would do, judged against the active fact with exactly
// that subject. ONE function for every place that asks — `prepare`, the tier and the handler — so
// they cannot disagree about what a first write is. A memory that cannot be read throws.
export function writeJudgement(
  subject: string,
  value: string,
  memory: Pick<Memory, "query">,
): { judgement: Judgement; current: Fact | undefined } {
  const current = currentFact(subject, memory);
  return { judgement: judge(current, value), current };
}

// M33. The fact this call would REPLACE with a different value, or null: a first write, the same
// value said again and the same name in another form are not replacements. A memory that cannot
// be read throws, and the tier escalates (core/risk.ts).
function replaced(args: ToolInput, memory: Pick<Memory, "query">): Fact | null {
  const subject = typeof args["subject"] === "string" ? args["subject"] : "";
  const value = typeof args["value"] === "string" ? args["value"] : "";
  const { judgement, current } = writeJudgement(subject, value, memory);
  return judgement === "change" && current !== undefined ? current : null;
}

// M33. In the dialog only, a long value is cut; what is saved stays whole.
export const DIALOG_VALUE_MAX = 200;
const forDialog = (value: string): string =>
  value.length > DIALOG_VALUE_MAX ? `${value.slice(0, DIALOG_VALUE_MAX)}...` : value;

// What the dialog knows about the value being replaced.
//   value    the value being replaced
//   unread   memory could not be read, so what it holds is not known (the tier escalated)
//   nothing  memory was read and holds nothing to replace — reached only when the tier escalated
//            on an earlier failed read, so the dialog says what is true now
export type Replacing = { kind: "value"; value: string } | { kind: "unread" } | { kind: "nothing" };

function question(subject: string, from: Replacing, to: string, show: (value: string) => string): string {
  if (from.kind === "value") {
    return `Change what I remember for "${subject}" from ${show(from.value)} to ${show(to)}?`;
  }
  if (from.kind === "unread") {
    return `Change what I remember for "${subject}" to ${show(to)}? I couldn't check what it holds now.`;
  }
  return `Remember "${subject}" as ${show(to)}?`;
}

// The dialog's question, as written. Plain ASCII around the values.
export function changeQuestion(subject: string, from: Replacing, to: string): string {
  return question(subject, from, to, forDialog);
}

// The same question as it is SAID (`speakConfirm`). The speech cleaner drops every "#", which
// is right for "Send to #design-team?" and wrong here: `#social` → `help` would be heard without
// the one mark that tells a channel from a word. So a value's leading
// "#" is said as "hash" — in the spoken words only; the written dialog is `changeQuestion`'s.
export function spokenChangeQuestion(subject: string, from: Replacing, to: string): string {
  return question(subject, from, to, (value) => forDialog(value).replace(/^#/, "hash "));
}

// What the dialog knows about the value this call would replace. A read that fails is "unread".
function replacing(args: ToolInput, memory: Pick<Memory, "query">): Replacing {
  try {
    const current = replaced(args, memory);
    return current === null ? { kind: "nothing" } : { kind: "value", value: current.value };
  } catch {
    return { kind: "unread" };
  }
}

// The value to save for this fact (M22). Unchanged unless this install is in bot mode — a bot
// sender AND a channel directory — and the fact is about a channel: its value starts with "#", or
// its subject ends in "channel" ("bugs channel"). Then it must be a channel Slack has, and what is
// saved is Slack's own "#name". A channel Slack does not have, or a Slack that cannot be asked,
// is refused in the send's wording (but ending "so nothing was saved."), and NOTHING is written.
async function channelFactValue(subject: string, value: string, deps: PrepareDeps): Promise<string> {
  const directory = deps.senderMode === "bot" ? deps.channelDirectory : undefined;
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
  // M33. REPLACING a value the user taught is confirmed first. The old row is kept, but nothing
  // shows it again (`recall` lists active facts only) and nothing restores it — so a write the
  // model planned for a correction it misread ("no, I meant the design channel" → `team` = "the
  // design channel", seen live in M33) would quietly change what "the team" means. (M32's own
  // `team` = `social` against #social is the same channel and changes nothing.) A first write, the same value
  // again, and anything `prepare` refused stay as they were: no dialog.
  risk: {
    tiers: ["reversible", "dangerous"],
    resolve: (args: ToolInput, deps: ToolDeps) => (replaced(args, deps.memory) === null ? "reversible" : "dangerous"),
  },
  // From the settled arguments, so the dialog names what will be saved (Slack's "#social", not a
  // typed "Social"). If memory cannot be read here either, the dialog still asks, and says so.
  confirmSummary: (args: ToolInput, deps: ToolDeps): string => {
    const subject = typeof args["subject"] === "string" ? args["subject"] : "";
    const value = typeof args["value"] === "string" ? args["value"] : "";
    return changeQuestion(subject, replacing(args, deps.memory), value);
  },
  // Said before the dialog opens, with a value's leading "#" as "hash" (see spokenChangeQuestion).
  speakConfirm: (args: ToolInput, deps: ToolDeps): string => {
    const subject = typeof args["subject"] === "string" ? args["subject"] : "";
    const value = typeof args["value"] === "string" ? args["value"] : "";
    return spokenChangeQuestion(subject, replacing(args, deps.memory), value);
  },
  confirmLabel: "Change it",
  background: "ok",
  planPhrase: "save a fact to memory",
  // This tool's args are literals to STORE, not references to look up. Without this, the planner
  // would resolve a subject like "the team" into the fact's current value before we ever saw it.
  resolvesReferences: false,
  // M33. WHAT WILL BE SAVED IS SETTLED HERE, before the tier and any dialog (M21, `Tool.prepare`):
  // the canonical subject and the value as it will be stored. Everything after this — and from
  // M33 the tier and the dialog — sees these arguments, and the handler writes exactly them.
  prepare: async (input: ToolInput, deps: PrepareDeps): Promise<ToolInput> => {
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
    return { subject, value: await channelFactValue(subject, value, deps) };
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    // Settled by `prepare`: written exactly as they are, with no second lookup.
    const subject = typeof input["subject"] === "string" ? input["subject"] : "";
    const stored = typeof input["value"] === "string" ? input["value"] : "";
    if (subject.length === 0 || stored.length === 0) {
      throw new Error("I need both what to remember and what its value is.");
    }

    // What did we believe before? (Lets the result show the correction, and makes the
    // versioning visible to the user rather than silent.)
    const { judgement, current: previous } = writeJudgement(subject, stored, deps.memory);

    // M33. The same name in a form no better than the stored one ("social" for #social): the
    // stored form stands, and nothing is written — not even a refresh.
    if (previous !== undefined && judgement === "keep") {
      return `Already remembered "${subject}" as ${previous.value}.`;
    }

    // The existing, already-tested version-on-conflict write: on a differing value the old row
    // is deactivated and a new version is inserted. Never an overwrite.
    deps.memory.write(subject, stored, { source: userSource() });

    if (previous && previous.value !== stored) {
      return `Updated "${subject}": ${previous.value} → ${stored} (v${previous.version + 1}).`;
    }
    return `Remembered: ${subject} = ${stored}`;
  },
};
