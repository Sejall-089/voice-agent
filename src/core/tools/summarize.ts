import type { Tool, ToolDeps, ToolInput } from "../types.ts";

const SUMMARIZE_SYSTEM = [
  "You summarize the user's selected text into a clear, concise summary.",
  "Keep it faithful to the source. Prefer a few short sentences or tight bullet points.",
  "Do not add information that isn't in the text. Output only the summary.",
].join(" ");

// Task 1 (spec.md §6): summarize the selected text via the LLM and return it for display.
// Reads no memory, no side effects, reversible. The handler receives its dependencies —
// it never reaches for globals — so it's testable against MockShell + a fake LLM.
export const summarizeTool: Tool = {
  name: "summarize",
  description:
    "Summarize the user's currently selected text (captured from the clipboard) into a " +
    "short, clear summary. Use this when the user asks to summarize, condense, TL;DR, or " +
    "give the gist of the selected/copied text.",
  inputSchema: {
    type: "object",
    properties: {
      style: {
        type: "string",
        description: "Optional style hint, e.g. 'bullets' or 'one sentence'.",
      },
    },
    required: [],
  },
  irreversible: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const text = deps.context.selectedText;
    if (!text || text.trim().length === 0) {
      throw new Error("Nothing to summarize — no text was captured. Select text and copy it first.");
    }
    const style = typeof input["style"] === "string" ? input["style"] : null;
    const user = style ? `Summarize in this style: ${style}.\n\n${text}` : text;
    return deps.llm.complete(SUMMARIZE_SYSTEM, user);
  },
};
