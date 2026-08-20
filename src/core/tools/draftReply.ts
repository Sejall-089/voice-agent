import { composeReply } from "../compose.ts";
import { requiredInstruction, storedName, storedTone } from "./replySupport.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M10, task 8: reply to the email open in Gmail, following a spoken instruction, in the user's
// stored tone.
//
// This is the generalization of `rewrite` the roadmap has been pointing at since Update 1.
// `rewrite` applies one fixed transform to text the user copied; this takes text the app FOUND,
// plus a free-form instruction, and writes something new. The writing itself lives in
// core/compose.ts and knows nothing about Gmail — only the finding and the placing are
// Gmail-specific.
//
// `caution` (core/risk.ts): opening someone's reply box and putting words in it cannot be
// undone, but it is routine and low-stakes — so it runs without asking, and narrates first.
// Nothing here can send anything; that is `sendReply`, and it is `dangerous`.
export const draftReplyTool: Tool = {
  name: "draftReply",
  description:
    "Draft a reply to the email currently open in Gmail and put it in the reply box. Use this " +
    "when the user asks to reply, respond, answer, generate, or write back to an email they " +
    "are looking at — for example 'reply and say I can't make Tuesday, propose Thursday', or " +
    "'generate a reply' with no specifics at all. ALWAYS call this tool for a reply request, " +
    "even a vague one — never ask the user what it should say first; pass their words as-is " +
    "and a reasonable draft will be generated from the email's own content. Pass everything " +
    "they said about what the reply should say as `instruction`, in their own words — if they " +
    "gave no specifics, pass their instruction verbatim anyway. This only writes the draft " +
    "into the reply box; it never sends anything.",
  inputSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description:
          "What the reply should say, in the user's own words — e.g. \"say I can't make " +
          'Tuesday and propose Thursday instead".',
      },
    },
    required: ["instruction"],
  },
  risk: "caution",
  narrate: (): string => "Reading the open email and drafting a reply…",
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const instruction = requiredInstruction(input);

    // SAFE first: read the email before touching anything.
    const source = await deps.gmail.readOpenEmail();

    // Write BEFORE opening the reply box, not after. If the model fails or returns nothing, the
    // user's Gmail is exactly as they left it — no empty reply box hanging open that they have
    // to go and dismiss. The CAUTION steps only happen once there is something worth placing.
    const text = await composeReply(deps.llm, {
      instruction,
      tone: storedTone(deps.memory),
      source,
      recipientName: source.fromName,
      userName: storedName(deps.memory),
    });

    await deps.gmail.openReplyBox();
    await deps.gmail.setComposeText(text);

    // Remember the draft so a follow-up ("make it shorter") edits THIS reply instead of
    // answering the original email a second time.
    deps.draft.set({ text, source, updatedAt: Date.now() });

    return `Draft is in the Gmail reply box — read it before sending.\n\n${text}`;
  },
};
