import { UnresolvedReferenceError } from "../errors.ts";
import { checkReference } from "../memory/checkReference.ts";
import type { Memory, Tool, ToolDeps, ToolInput } from "../types.ts";

const FORMAT_SYSTEM = [
  "You format rough notes into a clean message to post in a team chat channel.",
  "Keep every concrete detail (names, dates, numbers, decisions, owners). Add nothing new.",
  "Use short lines or bullets. No preamble, no sign-off, no commentary — output only the message.",
].join(" ");

export type ChannelCheck = { ok: true; channel: string } | { ok: false; reason: string };

// Is this somewhere we can name? THE ONE PLACE THAT DECIDES, asked by the confirm summary and
// again by the handler, so the dialog and the send cannot disagree about where a message goes.
//
// The rule is `checkReference`'s (core/memory/checkReference.ts) — a literal is taken as given,
// a reference must resolve. What this adds is the WORDING: when we do not know where this would
// go, say which words we could not place rather than send somewhere wrong.
//
// Inside the planner `channel` arrives already resolved (`referenceArgs` below), and this is
// then the check that it WAS: a resolved channel is a literal and passes; one memory did not
// know still reads like a reference, is looked up again, and is refused.
export function checkChannel(value: unknown, memory: Pick<Memory, "resolve">): ChannelCheck {
  const check = checkReference(value, memory);
  if (check.ok) return { ok: true, channel: check.value };
  if (check.why === "empty") {
    return { ok: false, reason: "I don't know which channel to send to." };
  }
  return {
    ok: false,
    reason: `I don't know which channel "${check.said}" means — teach me with: remember ${check.said} is #your-channel.`,
  };
}

// A memory with nothing in it: under it `checkChannel` accepts a literal and nothing else.
const NOTHING_KNOWN: Pick<Memory, "resolve"> = { resolve: () => null };

// The channel, or an honest "I don't know that yet" — a refusal the planner shows verbatim.
function knownChannel(input: ToolInput, deps: ToolDeps): string {
  const check = checkChannel(input["channel"], deps.memory);
  if (!check.ok) throw new UnresolvedReferenceError(check.reason);
  return check.channel;
}

function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// The text this call is about: `notes` when the instruction carried them, otherwise what the user
// selected. ONE function, used by both the confirm summary and the handler, so in a chain the
// two cannot disagree about what is being sent.
function sourceText(input: ToolInput, deps: ToolDeps): string | null {
  const notes = input["notes"];
  return typeof notes === "string" && notes.trim().length > 0 ? notes : deps.context.selectedText;
}

// Task 5 (spec.md §6): format notes and send them to Slack. THE FIRST `dangerous` TOOL (§risk) —
// it cannot be undone, so the planner forces it through shell.confirm() before the handler runs.
// The Slack call goes through the injected MessageSender, so tests never touch real Slack.
export const sendMessageTool: Tool = {
  name: "sendMessage",
  description:
    "Format the user's notes into a clean message and send it to a team chat channel. Use this " +
    "when the user asks to send, post, share, or message notes to a channel or a group of people. " +
    "Pass `channel` exactly as the user referred to it (e.g. 'the team', '#design-team') — it will " +
    "be resolved against their saved facts. Put the raw notes in `notes` if they are in the " +
    "instruction; otherwise the user's selected text is used. As a step in a plan, `notes` is " +
    "sent EXACTLY as written once any {stepN} is filled in — nothing reformats it — so write " +
    "the whole message you want posted, e.g. 'New bug filed: {step2}'.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description:
          "The destination channel, as the user referred to it (e.g. 'the team', '#design-team').",
      },
      notes: {
        type: "string",
        description: "The raw notes to send. Omit to use the user's selected text.",
      },
    },
    required: ["channel"],
  },
  risk: "dangerous",
  // Only `channel` is a reference. `notes` is the user's message, to be sent as written — left
  // undeclared, a body that read "the team" was swapped for the fact it named.
  referenceArgs: ["channel"],
  // And the one reference worth ASKING about rather than refusing: a chain that names a channel
  // nobody has taught the app is one typed word away from being runnable.
  //
  // `accept` is `checkChannel` with a memory that knows NOTHING, on purpose. The question asked
  // for the channel's name, so the answer has to be one — an empty line is not, and neither is
  // another reference ("the team"), even one memory could resolve: saving one reference as the
  // meaning of another is how a fact goes stale without anyone noticing.
  askForReference: {
    channel: {
      question: (reference) => `Before I start: which channel do you mean by '${reference}'?`,
      retry: (reference) =>
        `I need the channel's own name, like #bugs. Which channel do you mean by '${reference}'?`,
      accept: (answer) => {
        const check = checkChannel(answer, NOTHING_KNOWN);
        return check.ok ? check.channel : null;
      },
    },
  },
  // The planner has resolved `channel` by now, so the user approves the real destination — and
  // one it could NOT resolve is refused here, BEFORE the dialog (`checkChannel` asks memory
  // again and gets the same answer). Throwing from a confirm summary means nothing runs
  // and nothing is asked: the user is never shown "Send to the bugs channel?" and then told,
  // after pressing Send, that there is no such place.
  //
  // IN A CHAIN (M19) IT SHOWS THE WHOLE MESSAGE, AND THE HANDLER SENDS EXACTLY THAT. Standalone,
  // this is a 140-character preview of notes that are then reformatted by a model AFTER the
  // user has said yes — a gap that predates chains and is on the follow-up list rather than
  // fixed here. A chain must not inherit it: the text is another step's output (a ticket link,
  // someone's email), the user has not seen it anywhere else, and it must not pass through a
  // model between the dialog and the send.
  confirmSummary: (args: ToolInput, deps: ToolDeps): string => {
    const channel = knownChannel(args, deps);
    if (deps.chained) {
      const text = sourceText(args, deps);
      return text ? `Send to ${channel}?\n\n${text}` : `Send to ${channel}?`;
    }
    const notes = typeof args["notes"] === "string" ? args["notes"] : "";
    const body = notes ? `\n\n${preview(notes)}` : "";
    return `Send to ${channel}?${body}`;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    // Asked again rather than trusted: the confirm summary's answer does not travel here, and a
    // handler must not depend on a gate having run to know where it is sending.
    const channel = knownChannel(input, deps);

    const rawNotes = sourceText(input, deps);

    if (!rawNotes || rawNotes.trim().length === 0) {
      throw new Error("There's nothing to send — select and copy the notes first.");
    }

    // VERBATIM in a chain: the text the confirm dialog showed is the text that is sent, with no
    // model in between. See `confirmSummary` above.
    const formatted = deps.chained
      ? rawNotes
      : await deps.llm.complete(FORMAT_SYSTEM, rawNotes);

    const result = await deps.sender.send(channel, formatted);
    if (!result.ok) {
      // Fail loudly. The planner logs this as an error and shows it — the user is never told
      // the message went out when it did not.
      throw new Error(`Could not send to ${channel}: ${result.error ?? "unknown error"}`);
    }

    return `Sent to ${channel}.\n\n${formatted}`;
  },
};
