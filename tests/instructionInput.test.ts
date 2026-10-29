import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import { SqliteJobStore } from "../src/core/jobs/JobStore.ts";
import type { InstructionInput } from "../src/core/jobs/JobStore.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { captureContext, Planner } from "../src/core/planner.ts";
import { InMemorySpeechStore } from "../src/core/speechStore.ts";
import { WhisperCppTranscriber } from "../src/core/transcribers/WhisperCppTranscriber.ts";
import type { Tool } from "../src/core/types.ts";
import { createOnInstructionHotkey } from "../src/main/instructionHotkey.ts";
import { createJobRunner } from "../src/main/jobs/JobRunner.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { jobWorld, ScriptedLLM, settle, tool } from "./jobWorld.ts";

// M34. Whether an instruction was TYPED into the bar or SPOKEN and transcribed, written down with
// its job (`jobs.input`) for a person reading the log. M33's rows 672 and 674 logged "remember the
// team is social" for what Sejal says she typed with a "#", and the log could not say which path
// the instruction had taken. Action-log rows join to it by `job_id`.
//
// The planner is NOT told. Typed and dictated instructions converge on one call site so that
// nothing deciding what runs can tell them apart (spec §4a) — the last describe pins that.

const scratch: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "va-input-"));
  scratch.push(dir);
  return join(dir, "memory.db");
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readThing: Tool = {
  name: "readThing",
  description: "Read a thing.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  background: "ok",
  planPhrase: "run a test step",
  handler: () => Promise.resolve("the thing"),
};

// The hotkey over fakes: what the bar resolves with (`typed`) and what the microphone heard.
function hotkey(typed: string, heard: string, runInstruction: (instruction: string, input: InstructionInput) => Promise<void>) {
  return createOnInstructionHotkey({
    shell: {
      isConfirmPending: () => false,
      isAskPending: () => false,
      focusAsk: () => undefined,
      narrate: () => undefined,
      showInput: () => Promise.resolve(typed),
      clearPointer: () => undefined,
      // Async like the real one (CLAUDE.md: a synchronous fake cannot test ordering).
      snapshotPointTarget: () => new Promise((resolve) => setTimeout(resolve, 0)),
    },
    dictation: null,
    voice: {
      begin: () => Promise.resolve(),
      finish: () => new Promise((resolve) => setTimeout(() => resolve(heard), 0)),
      getState: () => "idle",
    },
    speech: null,
    chain: { isRunning: () => false },
    runInstruction,
  });
}

describe("the hotkey says which path the instruction took", () => {
  it.each([
    { typed: "remember the team is #social", heard: "ignored", instruction: "remember the team is #social", input: "typed" },
    { typed: "", heard: "Remember the team is social.", instruction: "Remember the team is social.", input: "spoken" },
    // Whitespace is not typing: the transcript runs, as before M34, and is marked spoken.
    { typed: "   ", heard: "What's the time?", instruction: "What's the time?", input: "spoken" },
  ])("typed $typed.length chars, heard '$heard': runs '$instruction' as $input", async ({ typed, heard, instruction, input }) => {
    const runs: [string, InstructionInput][] = [];
    hotkey(typed, heard, (text, how) => {
      runs.push([text, how]);
      return Promise.resolve();
    })();
    await settle();
    expect(runs).toEqual([[instruction, input]]);
  });
});

describe("the marker is saved with the job", () => {
  // The real hotkey, the real job runner and planner, SQLite on a real file — then the app
  // "restarts": the file is reopened and the rows are read back, joined on job_id.
  it("typed and spoken each reach jobs.input, survive a reopen, and join to their action-log rows", async () => {
    const path = tempDb();
    const db = createDatabase(path);
    const memory = new SqliteMemory(db);
    const shell = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null } });
    let seq = 0;
    const manager = new JobManager({ store: new SqliteJobStore(db), newId: () => `job${(seq += 1)}` });
    const llm = new ScriptedLLM({ "read the thing": tool("readThing"), "Read the thing.": tool("readThing") });
    const run = createJobRunner({
      manager,
      shell,
      log: memory,
      speech: new InMemorySpeechStore(),
      capture: () => captureContext(shell, { hasOpenEmail: () => Promise.resolve(false) }),
      buildPlanner: (parts) =>
        new Planner(llm, parts.shell, [readThing], memory, parts.log, undefined, undefined, undefined, undefined,
          undefined, parts.speech, undefined, undefined, undefined, () => Promise.resolve(), parts.chain,
          undefined, parts.gate, manager),
    });

    hotkey("read the thing", "", run)();
    await settle(20);
    hotkey("", "Read the thing.", run)();
    await settle(20);
    db.close();

    const reopened = createDatabase(path);
    expect(
      reopened
        .prepare(
          `SELECT a.instruction, a.tool, a.status, j.input FROM action_log a JOIN jobs j ON j.id = a.job_id ORDER BY a.id`,
        )
        .all(),
    ).toEqual([
      { instruction: "read the thing", tool: "readThing", status: "ok", input: "typed" },
      { instruction: "Read the thing.", tool: "readThing", status: "ok", input: "spoken" },
    ]);
    reopened.close();
  });

  it("a job submitted without a marker is saved as not recorded (NULL)", () => {
    const db = createDatabase(":memory:");
    const manager = new JobManager({ store: new SqliteJobStore(db), newId: () => "j1" });
    manager.submit("summarize this");
    expect(db.prepare("SELECT input FROM jobs").all()).toEqual([{ input: null }]);
  });

  it("the store reads the marker back from a reopened file", () => {
    const path = tempDb();
    const first = createDatabase(path);
    const manager = new JobManager({ store: new SqliteJobStore(first), newId: () => "j1", now: () => 1000 });
    const id = manager.submit("send these to the team", "spoken");
    manager.detachAttached("hotkey");
    manager.finish(id, "failed", "Slack said no.");
    first.close();

    const second = createDatabase(path);
    expect(new SqliteJobStore(second).loadUnacknowledged(0)).toMatchObject([{ id: "j1", input: "spoken" }]);
    second.close();
  });
});

// THE jobs TABLE AS M27 LEFT IT, written out literally (not taken from db.ts), with one row.
const PRE_M34_JOBS = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, instruction TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  background INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, step INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0, tool TEXT, pause_reason TEXT, pause_since INTEGER,
  in_flight_tool TEXT, in_flight_step INTEGER, result TEXT, seen_at INTEGER, steps_run INTEGER
);
INSERT INTO jobs (id, instruction, kind, state, background, created_at, updated_at, result)
  VALUES ('old', 'remember the team is social', 'work', 'failed', 1, 1000, 1000, 'It broke.');
`;

describe("rows from before M34 read as unknown", () => {
  it("the column is added to an old database, the old row keeps NULL, and reads as null", () => {
    const path = tempDb();
    const old = new Database(path);
    old.exec(PRE_M34_JOBS);
    old.close();

    const db = createDatabase(path);
    expect(db.prepare("SELECT id, input FROM jobs").all()).toEqual([{ id: "old", input: null }]);
    expect(new SqliteJobStore(db).loadUnacknowledged(0)).toMatchObject([{ id: "old", input: null }]);
    db.close();
  });

  it("a value the column should never hold reads as null, not as either kind", () => {
    const db = createDatabase(":memory:");
    db.exec(PRE_M34_JOBS.split("\n").filter((line) => line.startsWith("INSERT") || line.startsWith("  VALUES")).join("\n"));
    db.prepare("UPDATE jobs SET input = 'voice'").run();
    expect(new SqliteJobStore(db).loadUnacknowledged(0)).toMatchObject([{ id: "old", input: null }]);
  });
});

describe("the planner cannot tell them apart (spec §4a)", () => {
  it("the same instruction typed and spoken: the model is asked the same thing, and the same thing runs", async () => {
    const seen = async (input: InstructionInput) => {
      const w = jobWorld({ script: { "read the thing": tool("readThing") }, tools: [readThing] });
      await w.run("read the thing", input);
      await settle();
      return {
        contexts: w.llm.contexts,
        previous: w.llm.previousTurns,
        menus: w.llm.menus,
        rows: w.log.entries.map(({ ts: _ts, ...row }) => row),
        results: w.shell.results,
        marker: [...w.store.records.values()].map((record) => record.input),
      };
    };
    const typed = await seen("typed");
    const spoken = await seen("spoken");
    expect(typed.marker).toEqual(["typed"]);
    expect(spoken.marker).toEqual(["spoken"]);
    const { marker: _a, ...typedRest } = typed;
    const { marker: _b, ...spokenRest } = spoken;
    expect(typedRest.rows).toHaveLength(1);
    expect(spokenRest).toEqual(typedRest);
  });
});

// E3. The transcriber keeps a "#" that whisper writes: the cleaner removes only [bracketed] and
// (parenthesized) non-speech tokens. Run against a stand-in CLI through node (argsPrefix).
describe("a '#' in whisper's output survives the transcriber (E3)", () => {
  const SCRIPT = fileURLToPath(new URL("./fixtures/fakeWhisper.mjs", import.meta.url));
  const transcriber = new WhisperCppTranscriber({
    exePath: process.execPath,
    argsPrefix: [SCRIPT],
    modelPath: "ggml-base.en.bin", // never read by the stand-in
    timeoutMs: 10_000,
  });
  const clip = { wav: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]), durationMs: 1200 };

  it("' Remember the team is #social.' comes back with its '#'", async () => {
    delete process.env["FAKE_WHISPER_STDOUT"];
    expect(await transcriber.transcribe(clip)).toBe("Remember the team is #social.");
  });

  it("only the non-speech tokens are removed around it", async () => {
    process.env["FAKE_WHISPER_STDOUT"] = " [BLANK_AUDIO] Remember the team is #social. (silence)\n";
    try {
      expect(await transcriber.transcribe(clip)).toBe("Remember the team is #social.");
    } finally {
      delete process.env["FAKE_WHISPER_STDOUT"];
    }
  });
});
