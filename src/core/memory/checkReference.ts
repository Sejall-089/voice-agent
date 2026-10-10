import type { Memory } from "../types.ts";

// A value is treated as a vague reference when it's phrased like one ("my dashboard",
// "the team", "the usual tone"). Literal values ("formal", "https://…") are left alone.
//
// ONE definition, shared by the resolver (which decides what is worth looking up) and
// `checkReference` (which decides whether the lookup worked), so the two cannot drift apart.
export function isVagueReference(value: string): boolean {
  return /^\s*(my|the)\s+\S/i.test(value);
}

export type ReferenceCheck =
  | { ok: true; value: string }
  // Nothing was given at all.
  | { ok: false; why: "empty" }
  // `said` is the reference as it was written, for whoever words the refusal.
  | { ok: false; why: "unresolved"; said: string };

// Does this value name something we know?
//
// A literal is taken as given. A reference is looked up through `memory.resolve` — the same call
// `resolveArgs` makes for the planner — once, never chased: an answer that is missing, or that
// itself still reads like a reference, is not somewhere a tool can act on.
//
// It returns a FACT, not a sentence. "I don't know which channel" and "step 3 of my plan" are
// different things to tell a person, and each caller knows which one it is saying.
export function checkReference(value: unknown, memory: Pick<Memory, "resolve">): ReferenceCheck {
  const said = typeof value === "string" ? value.trim() : "";
  if (said.length === 0) return { ok: false, why: "empty" };
  if (!isVagueReference(said)) return { ok: true, value: said };

  const resolved = memory.resolve(said)?.value.trim() ?? "";
  if (resolved.length === 0 || isVagueReference(resolved)) {
    return { ok: false, why: "unresolved", said };
  }
  return { ok: true, value: resolved };
}
