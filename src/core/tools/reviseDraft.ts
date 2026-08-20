import { composeReply } from "../compose.ts";
import { UnresolvedReferenceError } from "../errors.ts";
import { requiredInstruction, storedName, storedTone } from "./replySupport.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M10, task 9: change the reply that is already in the box — "make it shorter", "warmer",
// "add that I'll send the deck tomorrow".
//
// A separate tool from `draftReply` rather than a mode of it, for the same reason `remember` is
// separate from `openTarget`: the two do different things to the world and the model picks
// between them by name. Their descriptions carry the distinction — "the reply you just drafted"
// versus "the email that is open".
export const reviseDraftTool: Tool = {
  name: "reviseDraft",
  description:
    "Change the reply draft that is already in the Gmail reply box. Use this for follow-up " +
    "tweaks to a reply that was just drafted — 'make it shorter', 'warmer', 'less formal', " +
    "'add that I'll send the deck tomorrow'. Pass the requested change as `instruction`. This " +
    "edits the existing draft; it never starts a new reply and never sends anything.",
  inputSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description:
          "The change to make, in the user's own words — e.g. 'make it shorter'.",
      },
    },
    required: ["instruction"],
  },
  risk: "caution",
  narrate: (): string => "Updating the draft in the reply box…",
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const instruction = requiredInstruction(input);

    const previous = deps.draft.get();
    if (previous === null) {
      // Not a malfunction — there is genuinely nothing to revise. Same class of honest "I don't
      // know what you mean" as an unresolved memory reference, so it is logged as `refused` and
      // shown in these words rather than wrapped in "Something went wrong".
      throw new UnresolvedReferenceError(
        "There's no reply draft to change. Ask me to draft a reply first.",
      );
    }

    // The box is the truth, not our copy of it. If the user hand-edited the draft and then said
    // "make it shorter", shortening our stale copy would silently throw their edit away.
    let live: string | null;
    try {
      live = await deps.gmail.readComposeText();
    } catch {
      deps.draft.clear();
      throw new UnresolvedReferenceError(
        "There's no reply draft open anymore. Ask me to draft a reply first.",
      );
    }
    const base = live !== null && live.trim().length > 0 ? live : previous.text;

    const text = await composeReply(deps.llm, {
      instruction,
      tone: storedTone(deps.memory),
      source: previous.source, // a revision still needs the email it is answering
      previousDraft: base,
      recipientName: previous.source.fromName,
      userName: storedName(deps.memory),
    });

    // No openReplyBox() here on purpose: the box is already open, and asking for it again is
    // how you end up with two drafts of the same reply.
    await deps.gmail.setComposeText(text);
    deps.draft.set({ text, source: previous.source, updatedAt: Date.now() });

    return `Updated the draft in the Gmail reply box.\n\n${text}`;
  },
};
