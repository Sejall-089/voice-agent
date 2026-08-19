import type { Tool, ToolSchema } from "./types.ts";
import { summarizeTool } from "./tools/summarize.ts";
import { rewriteTool } from "./tools/rewrite.ts";
import { openTargetTool } from "./tools/openTarget.ts";
import { rememberTool } from "./tools/remember.ts";
import { sendMessageTool } from "./tools/sendMessage.ts";
import { recallTool } from "./tools/recall.ts";
import { draftReplyTool } from "./tools/draftReply.ts";
import { reviseDraftTool } from "./tools/reviseDraft.ts";
import { sendReplyTool } from "./tools/sendReply.ts";

// The closed-world menu of tools the app can do (spec.md §6). Adding a tool is additive:
// a handler file plus an entry here. The planner never changes.
export const registry: Tool[] = [
  summarizeTool,
  rewriteTool,
  openTargetTool,
  rememberTool,
  sendMessageTool,
  recallTool,
];

// The Gmail tools (M10). They only work against a Chrome started with remote debugging, so they
// are added by `buildRegistry` rather than listed above.
export const gmailTools: Tool[] = [draftReplyTool, reviseDraftTool, sendReplyTool];

export interface RegistryOptions {
  // Whether a Chrome to drive is actually configured.
  gmail: boolean;
}

// The menu for one app run.
//
// When Chrome isn't configured the Gmail tools are not merely refused — they are never shown to
// the model at all. A capability the app cannot exercise should not be on the menu it is asked
// to choose from: that removes a whole class of wrong answers instead of catching them later,
// and it keeps the miss log honest (a Gmail request on a machine without Chrome is a real miss
// worth seeing, not a tool that "failed").
export function buildRegistry(options: RegistryOptions): Tool[] {
  return options.gmail ? [...registry, ...gmailTools] : [...registry];
}

// Look up a tool by the name the LLM proposed. Returns undefined for unknown names,
// which the planner treats as a hallucinated tool (graceful refusal).
export function findTool(name: string): Tool | undefined {
  return [...registry, ...gmailTools].find((tool) => tool.name === name);
}

// The subset of each tool the LLM sees (name + description + input schema).
export function toToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
