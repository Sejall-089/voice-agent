import type { ActionLogEntry, CapturedContext } from "../types.ts";

// Vendor-neutral prompt shaping shared by every LLMClient implementation, so the
// tool-routing framing and correction/previous-turn wording stay in sync across
// providers instead of forking per vendor.

// System prompt for the tool-choice call. The registry's descriptions/schemas do the
// real routing work; this just frames the job.
export const CHOOSE_SYSTEM = [
  "You are the planner for a desktop assistant.",
  "Pick exactly one tool from the provided tools that best fulfills the user's instruction,",
  "given the on-screen context. If no tool fits, do not call a tool — reply with a short",
  "explanation instead. Never invent a tool that is not in the list.",
  "You may also be shown the previous turn (the last instruction, tool, and result). Use it",
  "ONLY to resolve a correction or a pronoun reference in the CURRENT instruction ('no, I",
  "meant...', 'actually...', 'that's wrong'). Otherwise ignore it and treat the current",
  "instruction as an independent request.",
].join(" ");

// Serialize the instruction + captured context (+ previous turn, if any) into the user message.
export function renderRequest(
  instruction: string,
  context: CapturedContext,
  previousTurn: ActionLogEntry | null,
): string {
  const parts: string[] = [];
  if (previousTurn) {
    parts.push(`${renderPreviousTurn(previousTurn)}\n`);
  }
  parts.push(`Instruction: ${instruction}`);
  if (context.selectedText) {
    parts.push(`\nSelected text (clipboard):\n${context.selectedText}`);
  }
  if (context.activeWindowTitle) {
    parts.push(`\nActive window: ${context.activeWindowTitle}`);
  }
  return parts.join("\n");
}

// A short, bounded description of the previous turn — enough to resolve a correction,
// not so much that one verbose prior result balloons every subsequent prompt.
function renderPreviousTurn(entry: ActionLogEntry): string {
  const toolPart = entry.tool ? `called \`${entry.tool}\`` : "found no matching tool";
  const argsPart = entry.arguments ? ` with ${JSON.stringify(entry.arguments)}` : "";
  const resultPart = entry.result ? ` → ${preview(entry.result)}` : "";
  return (
    `Previous turn (for resolving corrections/pronouns only — otherwise ignore):\n` +
    `Instruction: "${entry.instruction}" — ${toolPart}${argsPart}${resultPart}`
  );
}

export function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
