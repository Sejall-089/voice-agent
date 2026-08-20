import type { Memory, ToolInput } from "../types.ts";

// Shared by the three M10 reply tools. Kept here rather than duplicated so "what tone do we
// write in" has one answer, and changing it changes it everywhere.

// The same fallback `rewrite` uses when nothing is stored, worded the same way on purpose:
// a reply and a rewrite should not sound like two different people.
const DEFAULT_TONE = "clear, natural, and concise";

// The stored `tone` fact — the thing that makes a generated reply sound like the user rather
// than like a model. Read directly rather than through the planner's argument resolution
// because the tone is never something the user says in the instruction; it is who they are.
export function storedTone(memory: Memory): string {
  const fact = memory.resolve("tone");
  return fact && fact.value.trim().length > 0 ? fact.value : DEFAULT_TONE;
}

// The user's own name, for signing off — genuinely optional, unlike tone. No fallback string:
// an absent name means the neutral sign-off in compose.ts's BASE_RULES applies instead.
export function storedName(memory: Memory): string | null {
  const fact = memory.resolve("name");
  return fact && fact.value.trim().length > 0 ? fact.value : null;
}

// Pull the free-form instruction out of the model's arguments, insisting it is really there.
// "Reply to this" with no instruction is not something to guess at — a reply invented from
// nothing would be put in front of a real person under the user's name.
export function requiredInstruction(
  input: ToolInput,
  field = "instruction",
): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Tell me what the reply should say, and I'll draft it.");
  }
  return value.trim();
}
