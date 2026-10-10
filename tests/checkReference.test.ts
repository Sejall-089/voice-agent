import { describe, it, expect } from "vitest";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { checkReference, isVagueReference } from "../src/core/memory/checkReference.ts";

// "Does this value name something we know?" — the one rule behind a tool's own refusal
// (`checkChannel`) and a chain's pre-flight. Inputs are literal strings throughout: nothing here
// asks the code under test to produce what it is then checked against.

function memoryWith(facts: Record<string, string>): SqliteMemory {
  const memory = new SqliteMemory(createDatabase(":memory:"));
  for (const [subject, value] of Object.entries(facts)) memory.write(subject, value);
  return memory;
}

describe("isVagueReference", () => {
  it.each(["the team", "my dashboard", "  The usual tone", "MY channel"])(
    "treats %j as a reference",
    (value) => expect(isVagueReference(value)).toBe(true),
  );

  it.each(["#design-team", "https://the.example.com", "theme", "mythology", "the", "my ", "team"])(
    "treats %j as a literal",
    (value) => expect(isVagueReference(value)).toBe(false),
  );
});

describe("checkReference", () => {
  it("takes a literal as given, trimmed, and never asks memory about it", () => {
    // `team` is stored — and a literal "team" (no article) is still not a lookup.
    const memory = memoryWith({ team: "#design-team" });
    expect(checkReference("  #general ", memory)).toEqual({ ok: true, value: "#general" });
    expect(checkReference("team", memory)).toEqual({ ok: true, value: "team" });
  });

  it("resolves a reference to the stored value", () => {
    const memory = memoryWith({ team: "#design-team", "target:dashboard": "https://dash.example.com" });
    expect(checkReference("the team", memory)).toEqual({ ok: true, value: "#design-team" });
    expect(checkReference("my dashboard", memory)).toEqual({
      ok: true,
      value: "https://dash.example.com",
    });
  });

  it("reports a reference memory does not know, in the words it was given", () => {
    expect(checkReference(" the bugs channel ", memoryWith({ team: "#design-team" }))).toEqual({
      ok: false,
      why: "unresolved",
      said: "the bugs channel",
    });
  });

  it("reports a fact whose value is itself still a reference — one lookup, never a chase", () => {
    const memory = memoryWith({ "bugs channel": "the team", team: "#design-team" });
    expect(checkReference("the bugs channel", memory)).toEqual({
      ok: false,
      why: "unresolved",
      said: "the bugs channel",
    });
  });

  it.each([
    { label: "an empty string", value: "" },
    { label: "a blank string", value: "   " },
    { label: "a missing value", value: undefined },
    { label: "null", value: null },
    { label: "something that is not text", value: 42 },
  ])("reports $label as empty", ({ value }) => {
    expect(checkReference(value, memoryWith({}))).toEqual({ ok: false, why: "empty" });
  });

  // The agreement that matters: `resolveArgs` is what the planner runs at step 4, and this must
  // never call something unresolved that `resolveArgs` would have resolved, or the reverse.
  it.each(["the team", "my team", "the bugs channel", "#general", "team", "the usual tone"])(
    "agrees with memory.resolveArgs about %j",
    async (value) => {
      const memory = memoryWith({ team: "#design-team", tone: "concise and warm" });
      const viaPlanner = (await memory.resolveArgs({ arg: value }))["arg"];
      const check = checkReference(value, memory);
      if (check.ok) expect(check.value).toBe(viaPlanner);
      // Unresolved: the planner leaves the words exactly as they were.
      else expect(viaPlanner).toBe(value);
    },
  );
});
