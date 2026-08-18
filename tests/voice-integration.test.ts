import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { registry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { VoiceSession } from "../src/main/shell/VoiceSession.ts";
import type { AudioClip, CapturedContext, ToolChoice } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeTranscriber } from "./FakeTranscriber.ts";

// The claim this milestone rests on: a dictated instruction reaches the planner on exactly
// the path a typed one does, and the planner cannot tell them apart. Everything downstream
// of runInstruction — planner, registry, tools, memory — is unchanged code.

const CLIP: AudioClip = { wav: new Uint8Array([1, 2, 3, 4]), durationMs: 1500 };

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// Mirrors main.ts: ONE planner call site, wired to voice via the same callback the typed
// path uses.
function wire(options: { transcript: string; choice: ToolChoice; completion?: string }): {
  shell: MockShell;
  log: InMemoryActionLog;
  session: VoiceSession;
} {
  const shell = new MockShell({
    context: contextWith("A very long article about otters and their habitats..."),
    clips: [CLIP],
  });
  const llm = new FakeLLM(options.choice, options.completion ?? "");
  const log = new InMemoryActionLog();
  const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);

  const runInstruction = async (instruction: string): Promise<void> => {
    if (instruction.trim().length === 0) return;
    await planner.run(instruction);
  };

  const session = new VoiceSession(shell, new FakeTranscriber(options.transcript), runInstruction);
  return { shell, log, session };
}

describe("Voice → planner (M7: dictation is just another way to produce the string)", () => {
  it("hands the transcript to the planner, which runs the tool and shows the result", async () => {
    const { shell, log, session } = wire({
      transcript: "summarize this",
      choice: { kind: "tool", name: "summarize", input: {} },
      completion: "SUMMARY",
    });

    await session.toggle(); // start recording
    await session.toggle(); // stop → transcribe → planner

    expect(shell.results).toContain("SUMMARY");
    expect(log.entries).toHaveLength(1);
    // The logged row is indistinguishable from a typed run — same instruction, same status.
    expect(log.entries[0]).toMatchObject({
      instruction: "summarize this",
      tool: "summarize",
      status: "ok",
    });
  });

  it("logs a miss for an unregistered spoken request, exactly like a typed one", async () => {
    const { shell, log, session } = wire({
      transcript: "book me a flight to Tokyo",
      choice: { kind: "none", text: "I can't help with that." },
    });

    await session.toggle();
    await session.toggle();

    expect(log.misses).toContain("book me a flight to Tokyo");
    expect(shell.results.at(-1)).toMatch(/can't do that yet/i);
    expect(shell.actions).toHaveLength(0); // closed world holds for voice too
  });

  it("never reaches the planner when nothing was said", async () => {
    const { log, session } = wire({
      transcript: "",
      choice: { kind: "tool", name: "summarize", input: {} },
      completion: "SUMMARY",
    });

    await session.toggle();
    await session.toggle();

    expect(log.entries).toHaveLength(0); // no action, no miss — there was no instruction
  });

  it("still passes irreversible actions through the confirm gate when dictated", async () => {
    // Voice must not become a way around the gate: the tool's own `irreversible` flag is
    // what the planner reads, and it has no idea where the instruction came from.
    const shell = new MockShell({
      context: contextWith("meeting notes"),
      clips: [CLIP],
      confirms: [false], // the user declines
    });
    const llm = new FakeLLM({
      kind: "tool",
      name: "sendMessage",
      input: { channel: "#design-team", text: "notes" },
    });
    const log = new InMemoryActionLog();
    const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);
    const session = new VoiceSession(
      shell,
      new FakeTranscriber("send these notes to the design team"),
      async (instruction) => {
        await planner.run(instruction);
      },
    );

    await session.toggle();
    await session.toggle();

    expect(shell.confirmMessages).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: "cancelled", tool: "sendMessage" });
  });
});
