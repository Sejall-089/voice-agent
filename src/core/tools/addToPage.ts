import { composeNote } from "../composeNote.ts";
import { storedTone } from "./replySupport.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M11: add instruction-driven content to the Notion page currently open in the debug Chrome.
//
// ONE tool, not three (contrast `draftReply` / `reviseDraft` / `sendReply`). Notion has no
// staging area and no irreversible send — nothing corresponds to Gmail's private compose box
// or its "Send" button. There is nothing to draft-then-send, so there is nothing to split
// into separate tools for. See spec.md §6b for the full reasoning.
//
// `risk: "caution"`, not `dangerous`: nothing leaves for a third party, and Ctrl+Z works
// inside Notion. Not `reversible` either: `risk.ts` defines that tier as recoverable by
// mechanisms THIS APP owns (clipboard, a tab, a versioned fact) — Notion's own page history is
// a feature we cannot see or invoke, so claiming it as our undo would be a safety claim we
// cannot verify.
//
// No revision tool. A follow-up like "make that note shorter" correctly logs as a miss:
// revising would mean deleting real content from a live document with no staging area, a
// materially higher-risk operation than anything this milestone adds.
export const addToPageTool: Tool = {
  name: "addToPage",
  description:
    "Add content to the end of the Notion page currently open in Chrome. Use this when the " +
    "user asks to add, write, note down, or jot something onto the page they have open in " +
    "Notion — for example 'add a note that the launch moved to Friday', or 'write down what " +
    "we just decided'. Pass what they want added as `instruction`, in their own words. This " +
    "only appends new content after everything already on the page — it never edits, removes, " +
    "or reorders anything that is already there, and it has no way to revise what it just " +
    "wrote.",
  inputSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description:
          "What to add to the page, in the user's own words — e.g. \"note that the launch " +
          'moved to Friday".',
      },
    },
    required: ["instruction"],
  },
  risk: "caution",
  // SAFE: reading the open page to name it in the narration. If Notion isn't reachable at
  // all, this throws and the planner refuses before anything runs — the same "if we can't say
  // what we're about to do, we don't do it" rule confirmSummary already follows.
  narrate: async (_args: ToolInput, deps: ToolDeps): Promise<string> => {
    const page = await deps.notion.readOpenPage();
    const where = page.title ? `"${page.title}"` : "the open Notion page";
    return `Adding a note to ${where}…`;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const value = input["instruction"];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Tell me what to add to the page, and I'll write it in.");
    }
    const instruction = value.trim();

    // SAFE first: read the page before touching anything.
    const page = await deps.notion.readOpenPage();

    // Write BEFORE appending, not after — same ordering as draftReply, for the same reason:
    // if the model fails or returns nothing, the page is exactly as the user left it.
    const text = await composeNote(deps.llm, {
      instruction,
      tone: storedTone(deps.memory),
      material: deps.context.selectedText,
      destination: { title: page.title, existing: page.body },
    });

    await deps.notion.appendToPage(text);

    const where = page.title ? `"${page.title}"` : "the page";
    return `Added to ${where}.\n\n${text}`;
  },
};
