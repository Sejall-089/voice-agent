import { describe, it, expect, vi, afterEach } from "vitest";
import { createOnInstructionHotkey } from "../src/main/instructionHotkey.ts";
import { createOnDictateHotkey } from "../src/main/dictate.ts";
import { createStartingSomethingElse } from "../src/main/jobs/startingSomethingElse.ts";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import type { Tool } from "../src/core/types.ts";
import { deferred, jobWorld, settle, tool } from "./jobWorld.ts";

// M25 addendum B. A live run found a job in the pill and nothing in the log to say how it got
// there. Three lines now say it: every detach with what did it, and every press of either hotkey
// that was ACCEPTED (an ignored press already logged why). The trigger word is decided where a
// test can see it — by the handler that accepted the press, or by the manager for a submission —
// never in main.ts.

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  return lines;
}

const detachLines = (lines: string[]): string[] => lines.filter((line) => / detached by /.test(line));

// A job held inside its handler, so it is attached and running when something detaches it.
function heldWorld() {
  const gate = deferred<string>();
  const slow: Tool = {
    name: "slowThing", description: "Do a slow thing.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe", background: "ok", handler: () => gate.promise,
  };
  const w = jobWorld({
    script: { "summarize this quarterly report for the whole team please": tool("slowThing") },
    tools: [slow],
  });
  return { w, gate };
}

describe("the detach log line (JobRunner)", () => {
  it("names the job, the first 40 characters of its instruction, its state, its step, and the trigger", async () => {
    const lines = logged();
    const { w, gate } = heldWorld();
    const running = w.run("summarize this quarterly report for the whole team please");
    await settle();

    expect(w.manager.detachAttached("outside-click")).toBe(true);

    expect(detachLines(lines)).toEqual([
      // Exactly 40 characters of the instruction — which here end in a space.
      '[main] job job1 detached by outside-click ("summarize this quarterly report for the ", running, step 1/1)',
    ]);
    gate.resolve("done");
    await running;
  });

  it("a submission while a job is still attached logs 'submit'", () => {
    const lines = logged();
    const manager = new JobManager({ store: new InMemoryJobStore() });
    // The manager alone: what is pinned here is that `submit()` itself names the trigger.
    manager.onChange((change) => {
      if (change.type === "detached") console.log(`[main] job ${change.job.id} detached by ${change.trigger}`);
    });
    manager.submit("first");
    manager.submit("second");

    expect(detachLines(lines)).toEqual([expect.stringMatching(/detached by submit$/)]);
  });

  it("nothing attached: no detach, no line", () => {
    const lines = logged();
    const { w } = heldWorld();
    expect(w.manager.detachAttached("hotkey")).toBe(false);
    expect(detachLines(lines)).toEqual([]);
  });
});

// The instruction hotkey's handler, over a fake shell that never blocks — and one that does.
function hotkey(options: { confirmPending?: boolean; detach: (trigger: "hotkey") => void }) {
  const shell = {
    isConfirmPending: () => options.confirmPending === true,
    isAskPending: () => false,
    focusAsk: () => undefined,
    narrate: () => undefined,
    showInput: () => new Promise<string>(() => undefined),
    clearPointer: () => undefined,
    snapshotPointTarget: () => Promise.resolve(),
  };
  return createOnInstructionHotkey({
    shell, dictation: null, voice: null,
    speech: { speak: () => undefined, stop: () => undefined },
    chain: null, detach: options.detach, runInstruction: () => Promise.resolve(),
  } as never);
}

describe("the instruction hotkey", () => {
  it("logs 'accepted' and detaches with 'hotkey' — through the real startingSomethingElse", async () => {
    const lines = logged();
    const { w, gate } = heldWorld();
    const running = w.run("summarize this quarterly report for the whole team please");
    await settle();
    const starting = createStartingSomethingElse({ jobs: w.manager, pill: () => null });

    hotkey({ detach: starting })();

    expect(lines.filter((line) => line === "[main] instruction hotkey accepted")).toHaveLength(1);
    expect(detachLines(lines)).toEqual([expect.stringContaining("detached by hotkey (")]);
    // The press is logged before the detach it causes.
    expect(lines.indexOf("[main] instruction hotkey accepted")).toBeLessThan(lines.findIndex((l) => / detached by /.test(l)));
    gate.resolve("done");
    await running;
  });

  it("an ignored press logs why, and never 'accepted', and detaches nothing", () => {
    const lines = logged();
    const detached: string[] = [];
    hotkey({ confirmPending: true, detach: (t) => void detached.push(t) })();

    expect(lines).toContain("[main] instruction hotkey ignored - a confirmation is waiting");
    expect(lines).not.toContain("[main] instruction hotkey accepted");
    expect(detached).toEqual([]);
  });
});

describe("the dictation hotkey", () => {
  it("logs 'accepted' and detaches with 'dictation'", async () => {
    const lines = logged();
    const { w, gate } = heldWorld();
    const running = w.run("summarize this quarterly report for the whole team please");
    await settle();
    const starting = createStartingSomethingElse({ jobs: w.manager, pill: () => null });

    createOnDictateHotkey({ begin: () => Promise.resolve() }, { getState: () => "idle" }, starting)();

    expect(lines).toContain("[dictate] hotkey accepted");
    expect(detachLines(lines)).toEqual([expect.stringContaining("detached by dictation (")]);
    gate.resolve("done");
    await running;
  });

  it("an ignored press logs why, and never 'accepted'", () => {
    const lines = logged();
    const accepted: string[] = [];
    createOnDictateHotkey({ begin: () => Promise.resolve() }, { getState: () => "recording" }, (t) => void accepted.push(t))();

    expect(lines).toContain("[dictate] hotkey ignored - an instruction is already being captured");
    expect(lines).not.toContain("[dictate] hotkey accepted");
    expect(accepted).toEqual([]);
  });
});
