import { describe, it, expect } from "vitest";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import type { Fact } from "../src/core/types.ts";

// Headless: no Electron, no file on disk, no API key.
function freshMemory() {
  const db = createDatabase(":memory:");
  return { db, memory: new SqliteMemory(db) };
}

describe("SqliteMemory.write / resolve", () => {
  it("writes a fact and resolves it back", () => {
    const { memory } = freshMemory();
    memory.write("tone", "concise and warm");

    expect(memory.resolve("my tone")).toEqual({ value: "concise and warm", confidence: 0.8 });
  });

  it("returns null for a reference it has never been taught", () => {
    const { memory } = freshMemory();
    expect(memory.resolve("my dashboard")).toBeNull();
  });

  // Pre-proves M4's "correction sticks": a differing value must version, never overwrite.
  it("versions on conflict instead of overwriting", () => {
    const { db, memory } = freshMemory();
    memory.write("team", "#general");
    memory.write("team", "#design-team");

    const rows = db
      .prepare<[], Fact>("SELECT * FROM facts WHERE subject = 'team' ORDER BY version")
      .all();

    expect(rows).toHaveLength(2); // the old fact is kept, not clobbered
    expect(rows[0]).toMatchObject({ value: "#general", version: 1, active: 0 });
    expect(rows[1]).toMatchObject({ value: "#design-team", version: 2, active: 1 });

    // The correction changes what future resolves return — the whole point.
    expect(memory.resolve("the team")?.value).toBe("#design-team");
  });

  it("re-asserting the same value does not create a new version", () => {
    const { db, memory } = freshMemory();
    memory.write("team", "#design-team");
    memory.write("team", "#design-team");

    const rows = db.prepare<[], Fact>("SELECT * FROM facts WHERE subject = 'team'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, active: 1 });
  });

  it("prefers the highest-confidence active fact", () => {
    const { memory } = freshMemory();
    memory.write("tone", "stiff", { confidence: 0.3 });
    memory.write("target:tone", "playful", { confidence: 0.95 });

    expect(memory.resolve("my tone")?.value).toBe("playful");
  });
});

describe("reference normalization", () => {
  it("maps 'my X' / 'the X' / 'the usual X' onto the right subjects", () => {
    const { memory } = freshMemory();
    memory.write("target:dashboard", "https://dash.example.com");
    memory.write("team", "#design-team");
    memory.write("tone", "concise and warm");

    // "my dashboard" finds the target: prefixed subject without the resolver knowing the tool.
    expect(memory.resolve("my dashboard")?.value).toBe("https://dash.example.com");
    expect(memory.resolve("the team")?.value).toBe("#design-team");
    expect(memory.resolve("the usual tone")?.value).toBe("concise and warm");
  });

  it("leaves literal (non-reference) values alone in resolveArgs", async () => {
    const { memory } = freshMemory();
    memory.write("tone", "concise and warm");

    // "formal" is a literal the user asked for — not a reference into memory.
    const args = await memory.resolveArgs({ tone: "formal", count: 3 });
    expect(args).toEqual({ tone: "formal", count: 3 });
  });

  it("swaps a vague reference for the stored value in resolveArgs", async () => {
    const { memory } = freshMemory();
    memory.write("tone", "concise and warm");

    const args = await memory.resolveArgs({ tone: "my usual tone" });
    expect(args).toEqual({ tone: "concise and warm" });
  });

  it("leaves an unresolvable reference untouched (so the tool can refuse)", async () => {
    const { memory } = freshMemory();
    const args = await memory.resolveArgs({ target: "my dashboard" });
    expect(args).toEqual({ target: "my dashboard" });
  });
});

describe("light decay (spec §7)", () => {
  it("reduces confidence for a fact older than 30 days", () => {
    const { db, memory } = freshMemory();
    memory.write("tone", "concise and warm", { confidence: 0.8 });

    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE facts SET updated_at = ? WHERE subject = 'tone'").run(old);

    const hit = memory.resolve("my tone");
    expect(hit?.value).toBe("concise and warm");
    expect(hit?.confidence).toBeLessThan(0.8); // stale but still usable
    expect(hit?.confidence).toBeCloseTo(0.4);
  });

  it("keeps full confidence for a fresh fact", () => {
    const { memory } = freshMemory();
    memory.write("tone", "concise and warm", { confidence: 0.8 });
    expect(memory.resolve("my tone")?.confidence).toBeCloseTo(0.8);
  });
});

describe("action log persistence", () => {
  it("persists actions and misses to the action_log table", () => {
    const { db, memory } = freshMemory();
    memory.logAction({
      ts: new Date().toISOString(),
      instruction: "summarize this",
      tool: "summarize",
      arguments: { style: "bullets" },
      result: "SUMMARY",
      status: "ok",
    });
    memory.logMiss("book me a flight");

    const rows = db
      .prepare<[], { instruction: string; tool: string | null; status: string }>(
        "SELECT instruction, tool, status FROM action_log ORDER BY id",
      )
      .all();

    expect(rows).toEqual([
      { instruction: "summarize this", tool: "summarize", status: "ok" },
      { instruction: "book me a flight", tool: null, status: "no_tool" },
    ]);
  });

  it("getLast() returns null when empty, then the most recently logged entry", () => {
    const { memory } = freshMemory();
    expect(memory.getLast()).toBeNull();

    memory.logAction({
      ts: new Date().toISOString(),
      instruction: "summarize this",
      tool: "summarize",
      arguments: { style: "bullets" },
      result: "SUMMARY",
      status: "ok",
    });
    memory.logMiss("book me a flight");

    expect(memory.getLast()).toMatchObject({
      instruction: "book me a flight",
      tool: null,
      status: "no_tool",
    });
  });
});
