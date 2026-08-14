import type { Tool, ToolSchema } from "./types.ts";
import { summarizeTool } from "./tools/summarize.ts";
import { rewriteTool } from "./tools/rewrite.ts";
import { openTargetTool } from "./tools/openTarget.ts";
import { rememberTool } from "./tools/remember.ts";
import { sendMessageTool } from "./tools/sendMessage.ts";
import { recallTool } from "./tools/recall.ts";

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

// Look up a tool by the name the LLM proposed. Returns undefined for unknown names,
// which the planner treats as a hallucinated tool (graceful refusal).
export function findTool(name: string): Tool | undefined {
  return registry.find((tool) => tool.name === name);
}

// The subset of each tool the LLM sees (name + description + input schema).
export function toToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
