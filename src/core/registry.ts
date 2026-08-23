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
import { addToPageTool } from "./tools/addToPage.ts";
import { readScheduleTool } from "./tools/readSchedule.ts";
import { createEventTool } from "./tools/createEvent.ts";
import { moveEventTool } from "./tools/moveEvent.ts";

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

// The Notion tool (M11). Same gating idea as Gmail's, same debug Chrome — a different tab.
// Just one tool, not three: see spec.md §6b for why Notion's shape doesn't mirror Gmail's.
export const notionTools: Tool[] = [addToPageTool];

// The calendar tools (M13). Gated like the others, on a different thing: not a browser to drive
// but a connected Google account. The check is cheap and synchronous — is there a refresh token
// in the environment — so no network call decides what is on the menu.
export const calendarTools: Tool[] = [readScheduleTool, createEventTool, moveEventTool];

export interface RegistryOptions {
  // Whether a Chrome to drive is actually configured.
  gmail: boolean;
  // Optional (defaults to not offered) — independent of `gmail` in principle, though in the
  // running app both currently derive from the same CHROME_DEBUG_URL in main.ts (one debug
  // Chrome, two app surfaces in it).
  notion?: boolean;
  // Optional (defaults to not offered) — whether the app has credentials for a Google account.
  calendar?: boolean;
}

// The menu for one app run.
//
// When Chrome isn't configured a browser-backed tool is not merely refused — it is never shown
// to the model at all. A capability the app cannot exercise should not be on the menu it is
// asked to choose from: that removes a whole class of wrong answers instead of catching them
// later, and it keeps the miss log honest (a request on a machine without Chrome is a real
// miss worth seeing, not a tool that "failed").
export function buildRegistry(options: RegistryOptions): Tool[] {
  const tools = [...registry];
  if (options.gmail) tools.push(...gmailTools);
  if (options.notion === true) tools.push(...notionTools);
  if (options.calendar === true) tools.push(...calendarTools);
  return tools;
}

// Look up a tool by the name the LLM proposed. Returns undefined for unknown names,
// which the planner treats as a hallucinated tool (graceful refusal).
export function findTool(name: string): Tool | undefined {
  return [...registry, ...gmailTools, ...notionTools, ...calendarTools].find(
    (tool) => tool.name === name,
  );
}

// The subset of each tool the LLM sees (name + description + input schema).
export function toToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
