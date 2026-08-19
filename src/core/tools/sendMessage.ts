import { UnresolvedReferenceError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

const FORMAT_SYSTEM = [
  "You format rough notes into a clean message to post in a team chat channel.",
  "Keep every concrete detail (names, dates, numbers, decisions, owners). Add nothing new.",
  "Use short lines or bullets. No preamble, no sign-off, no commentary — output only the message.",
].join(" ");

// A channel that still reads like a reference ("the team", "my channel") means memory did not
// resolve it — we do NOT know where this would go, so we refuse rather than send somewhere wrong.
function isUnresolved(channel: string): boolean {
  return /^\s*(my|the)\s+\S/i.test(channel);
}

function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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
    "instruction; otherwise the user's selected text is used.",
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
  // The planner calls this with the RESOLVED args, so the user approves the real destination.
  confirmSummary: (args: ToolInput): string => {
    const channel = typeof args["channel"] === "string" ? args["channel"] : "(unknown channel)";
    const notes = typeof args["notes"] === "string" ? args["notes"] : "";
    const body = notes ? `\n\n${preview(notes)}` : "";
    return `Send to ${channel}?${body}`;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const channel = typeof input["channel"] === "string" ? input["channel"].trim() : "";

    if (channel.length === 0) {
      throw new Error("I don't know which channel to send to.");
    }
    // Memory couldn't resolve it — refuse rather than post to the wrong place. Nothing is sent.
    if (isUnresolved(channel)) {
      throw new UnresolvedReferenceError(
        `I don't know which channel "${channel}" means — teach me with: remember ${channel} is #your-channel.`,
      );
    }

    const rawNotes =
      typeof input["notes"] === "string" && input["notes"].trim().length > 0
        ? input["notes"]
        : deps.context.selectedText;

    if (!rawNotes || rawNotes.trim().length === 0) {
      throw new Error("There's nothing to send — select and copy the notes first.");
    }

    const formatted = await deps.llm.complete(FORMAT_SYSTEM, rawNotes);

    const result = await deps.sender.send(channel, formatted);
    if (!result.ok) {
      // Fail loudly. The planner logs this as an error and shows it — the user is never told
      // the message went out when it did not.
      throw new Error(`Could not send to ${channel}: ${result.error ?? "unknown error"}`);
    }

    return `Sent to ${channel}.\n\n${formatted}`;
  },
};
