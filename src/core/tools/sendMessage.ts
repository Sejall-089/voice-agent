import { UnresolvedReferenceError } from "../errors.ts";
import type { Memory, Tool, ToolDeps, ToolInput } from "../types.ts";

const FORMAT_SYSTEM = [
  "You format rough notes into a clean message to post in a team chat channel.",
  "Keep every concrete detail (names, dates, numbers, decisions, owners). Add nothing new.",
  "Use short lines or bullets. No preamble, no sign-off, no commentary — output only the message.",
].join(" ");

// Phrased like a reference ("the team", "my channel") rather than like a destination. The same
// test memory's own `resolveArgs` applies to decide what is worth looking up.
function isReference(channel: string): boolean {
  return /^\s*(my|the)\s+\S/i.test(channel);
}

export type ChannelCheck = { ok: true; channel: string } | { ok: false; reason: string };

// Is this somewhere we can name? THE ONE PLACE THAT DECIDES, asked by the confirm summary and
// again by the handler, so the dialog and the send cannot disagree about where a message goes.
//
// A literal ("#design-team") is taken as given. A reference is looked up through the same
// `memory.resolve` the planner's argument resolution uses — once, never chased: if the answer
// is missing, or itself still reads like a reference, we do NOT know where this would go, and
// say which words we could not place rather than send somewhere wrong.
//
// It is the tool that asks, not the planner (`resolvesReferences: false` below), because the
// planner's resolution inspects every string VALUE: it cannot tell the channel from the message,
// and a message that happened to read "the team" was being swapped for the fact it named.
export function checkChannel(value: unknown, memory: Pick<Memory, "resolve">): ChannelCheck {
  const said = typeof value === "string" ? value.trim() : "";
  if (said.length === 0) {
    return { ok: false, reason: "I don't know which channel to send to." };
  }
  if (!isReference(said)) return { ok: true, channel: said };

  const channel = memory.resolve(said)?.value.trim() ?? "";
  if (channel.length === 0 || isReference(channel)) {
    return {
      ok: false,
      reason: `I don't know which channel "${said}" means — teach me with: remember ${said} is #your-channel.`,
    };
  }
  return { ok: true, channel };
}

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
  // Only `channel` is a reference, and `checkChannel` resolves it. Left to the planner, `notes`
  // would be resolved too — it is the user's message, to be sent as written.
  resolvesReferences: false,
  // The channel is resolved HERE, so the user approves the real destination — and an unknown
  // one is refused here, BEFORE the dialog. Throwing from a confirm summary means nothing runs
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
