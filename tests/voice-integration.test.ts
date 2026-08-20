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

// The claim this rests on: a dictated instruction reaches the planner on exactly the path a
// typed one does, and the planner cannot tell them apart. Everything downstream of
// runInstruction — planner, registry, tools, memory — is unchanged code.

const CLIP: AudioClip = { wav: new Uint8Array([1, 2, 3, 4]), durationMs: 1500 };

function contextWith(selectedText: string | null): CapturedContext {
  return { selectedText, activeApp: null, activeWindowTitle: null };
}

// Mirrors main.ts exactly: ONE hotkey opens the bar and starts listening, ONE planner call
// site, and the instruction is whatever the bar produced — typed or spoken.
function wire(options: { transcript: string; choice: ToolChoice; completion?: string }): {
  shell: MockShell;
  log: InMemoryActionLog;
  openBar: (typed: string) => Promise<void>;
  session: VoiceSession;
} {
  const shell = new MockShell({
    context: contextWith("A very long article about otters and their habitats..."),
    clips: [CLIP],
  });
  const llm = new FakeLLM(options.choice, options.completion ?? "");
  const log = new InMemoryActionLog();
  const planner = new Planner(llm, shell, registry, new NoopMemoryResolver(), log);
  const session = new VoiceSession(shell, new FakeTranscriber(options.transcript));

  const runInstruction = async (instruction: string): Promise<void> => {
    if (instruction.trim().length === 0) return;
    await planner.run(instruction);
  };

  // `typed` stands in for what the renderer sends on Enter: "" when you dictated.
  const openBar = async (typed: string): Promise<void> => {
    await session.begin();
    if (typed.trim().length > 0) await session.abandon(); // typing cancels the recording
    const instruction = typed.trim().length > 0 ? typed : await session.finish();
    await runInstruction(instruction);
  };

  return { shell, log, openBar, session };
}

describe("Voice → planner (dictation is just another way to produce the string)", () => {
  it("hands the transcript to the planner, which runs the tool and shows the result", async () => {
    const { shell, log, openBar } = wire({
      transcript: "summarize this",
      choice: { kind: "tool", name: "summarize", input: {} },
      completion: "SUMMARY",
    });

    await openBar(""); // spoke, pressed Enter with an empty bar

    expect(shell.results).toContain("SUMMARY");
    expect(log.entries).toHaveLength(1);
    // The logged row is indistinguishable from a typed run — same instruction, same status.
    expect(log.entries[0]).toMatchObject({
      instruction: "summarize this",
      tool: "summarize",
      status: "ok",
    });
  });

  it("runs the TYPED text and never the recording when you type instead of speaking", async () => {
    const { log, openBar, session } = wire({
      transcript: "summarize this",
      choice: { kind: "tool", name: "summarize", input: {} },
      completion: "SUMMARY",
    });

    await openBar("recall the team");

    // The instruction is what was typed; the abandoned transcript is nowhere.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.instruction).toBe("recall the team");
    expect(session.getState()).toBe("idle");
  });

  it("logs a miss for an unregistered spoken request, exactly like a typed one", async () => {
    const { shell, log, openBar } = wire({
      transcript: "book me a flight to Tokyo",
      choice: { kind: "none", text: "I can't help with that." },
    });

    await openBar("");

    expect(log.misses).toContain("book me a flight to Tokyo");
    // The model's own declined text is shown verbatim, not the canned refusal.
    expect(shell.results.at(-1)).toBe("I can't help with that.");
    expect(shell.actions).toHaveLength(0); // closed world holds for voice too
  });

  it("never reaches the planner when nothing was said", async () => {
    const { log, openBar } = wire({
      transcript: "",
      choice: { kind: "tool", name: "summarize", input: {} },
      completion: "SUMMARY",
    });

    await openBar("");

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
    );

    await session.begin();
    await planner.run(await session.finish());

    expect(shell.confirmMessages).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: "cancelled", tool: "sendMessage" });
  });
});
