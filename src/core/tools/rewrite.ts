import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Used when the instruction names no tone. In M3 a stored tone preference arrives via the
// memory resolver filling args.tone — this handler does not change.
const DEFAULT_TONE = "clear, natural, and concise";

function rewriteSystem(tone: string): string {
  return [
    `You rewrite the user's selected text in this tone: ${tone}.`,
    "Preserve the meaning and any concrete details. Do not add new information.",
    "Output only the rewritten text — no preamble, no quotes, no commentary.",
  ].join(" ");
}

// Task 2 (spec.md §6): rewrite the selected text in a tone, then put it on the clipboard.
// The clipboard write goes through the shell (deps.shell.executeAction) so the handler stays
// OS-agnostic and testable against MockShell.
export const rewriteTool: Tool = {
  name: "rewrite",
  description:
    "Rewrite the user's currently selected text (captured from the clipboard) in a given tone, " +
    "and copy the result back to the clipboard. Use this when the user asks to rewrite, rephrase, " +
    "reword, polish, or change the tone of the selected/copied text. If the user names a tone " +
    "(e.g. 'more formal', 'warmer', 'punchier'), pass it as `tone`.",
  inputSchema: {
    type: "object",
    properties: {
      tone: {
        type: "string",
        description:
          "The tone to rewrite in, e.g. 'formal', 'concise and warm'. Omit if the user didn't say.",
      },
    },
    required: [],
  },
  risk: "reversible",
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const text = deps.context.selectedText;
    if (!text || text.trim().length === 0) {
      throw new Error("Nothing to rewrite — no text was captured. Select text and copy it first.");
    }

    const tone = typeof input["tone"] === "string" && input["tone"].trim().length > 0
      ? input["tone"]
      : DEFAULT_TONE;

    const rewritten = await deps.llm.complete(rewriteSystem(tone), text);

    const result = await deps.shell.executeAction({
      kind: "copyToClipboard",
      payload: rewritten,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "Could not copy the rewritten text to the clipboard.");
    }

    return `Rewritten (${tone}) and copied to clipboard.\n\n${rewritten}`;
  },
};
