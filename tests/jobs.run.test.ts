import { describe, expect, it } from "vitest";
import { CANCELLED_BY_YOU, EXPIRED, EXPIRY_MS, QUEUED_NOTICE } from "../src/core/jobs/messages.ts";
import { jobStatusTool } from "../src/core/tools/jobStatus.ts";
import type { Risk, Tool, ToolDeps, ToolInput } from "../src/core/types.ts";
import { RUN_FAILED } from "../src/main/runInstruction.ts";
import { deferred, jobWorld, plan, settle, tool } from "./jobWorld.ts";

// Jobs running real planners (M23): the REAL JobManager, JobRunner, Planner, gate, job facades
// and confirm queue, over MockShell. See tests/jobWorld.ts for the three stand-ins.
//
// THE TOOLS BELOW ARE THE FIXTURES, and each records what its handler was actually given —
// "the handler was never called" and "the handler saw the snapshot" are both claims about a
// spy, not about a log line.

interface Spies {
  // How many times a confirm summary was BUILT. A job that expired or was cancelled while it
  // waited must stop before describing anything — not merely fail to get a dialog afterwards.
  summaries?: number;
  handled: { tool: string; input: ToolInput; clipboard: string | null; emailOpen: boolean }[];
}

function tools(spies: Spies, extra: { hold?: Promise<void>; world?: { value: string }; tier?: () => Risk } = {}) {
  const record = (name: string, input: ToolInput, deps: ToolDeps): void => {
    spies.handled.push({
      tool: name,
      input: { ...input },
      clipboard: deps.context.selectedText,
      emailOpen: deps.context.emailOpen === true,
    });
  };
  // Safe, fine in the background. Optionally held mid-handler by the test.
  const readThing: Tool = {
    name: "readThing",
    description: "Read a thing.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "ok",
    handler: async (input, deps): Promise<string> => {
      record("readThing", input, deps);
      if (extra.hold !== undefined) await extra.hold;
      return "the thing";
    },
  };
  // Caution, fine in the background: narrates before it acts.
  const noteThing: Tool = {
    name: "noteThing",
    description: "Note a thing.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "caution",
    background: "ok",
    narrate: (): string => "Noting the thing…",
    handler: (input, deps): Promise<string> => {
      record("noteThing", input, deps);
      return Promise.resolve("Noted.");
    },
  };
  // Dangerous, fine in the background: the confirm gate is what holds it. Its summary reads
  // `world.value` — a stand-in for the outside world — at the moment it is asked.
  const sendThing: Tool = {
    name: "sendThing",
    description: "Send a thing.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to send." } },
      required: ["text"],
    },
    risk: extra.tier === undefined ? "dangerous" : { tiers: ["caution", "dangerous"], resolve: () => extra.tier?.() ?? "dangerous" },
    background: "ok",
    confirmLabel: "Send thing",
    narrate: (): string => "Sending the thing…",
    confirmSummary: (input): string => {
      spies.summaries = (spies.summaries ?? 0) + 1;
      return `Send "${String(input["text"])}" to ${extra.world?.value ?? "nobody"}?`;
    },
    handler: (input, deps): Promise<string> => {
      record("sendThing", input, deps);
      return Promise.resolve(`Sent ${String(input["text"])}.`);
    },
  };
  // Safe, but about whatever is on screen at that moment.
  const screenThing: Tool = {
    name: "screenThing",
    description: "Do a thing on the screen.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background: "foreground-only",
    handler: (input, deps): Promise<string> => {
      record("screenThing", input, deps);
      return Promise.resolve("Did it on screen.");
    },
  };
  return [readThing, noteThing, sendThing, screenThing];
}

describe("an attached job is an instruction exactly as it was before M23", () => {
  it("shows and speaks its result in the bar, and turns Thinking on and off", async () => {
    const spies: Spies = { handled: [] };
    const w = jobWorld({ script: { "read it": tool("readThing") }, tools: tools(spies) });
    await w.run("read it");

    expect(w.shell.results).toEqual(["the thing"]);
    expect(w.shell.spoken).toEqual(["the thing."]);
    expect(w.shell.thinking).toEqual([true, false]);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", background: false, lines: [] });
    // The row is stamped with its job, and as NOT detached.
    expect(w.log.entries[0]).toMatchObject({ status: "ok", jobId: "job1", detached: false });
  });

  it("opens its confirm at once, as an ordinary (not detached) dialog, and runs on a yes", async () => {
    const spies: Spies = { handled: [] };
    const w = jobWorld({
      script: { "send it": tool("sendThing", { text: "hello" }) },
      tools: tools(spies, { world: { value: "#team" } }),
      shell: { holdConfirm: true },
    });
    const done = w.run("send it");
    await settle();

    expect(w.shell.confirmMessages).toEqual(['Send "hello" to #team?']);
    expect(w.shell.confirmDetached).toEqual([false]);
    expect(w.shell.confirmLabels).toEqual(["Send thing"]);
    expect(w.manager.get("job1")?.state).toBe("running"); // an attached job never "needs you"
    expect(spies.handled).toEqual([]);

    w.shell.answerConfirm(true);
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["sendThing"]);
    expect(w.manager.get("job1")?.state).toBe("done");
  });

  it("runs a foreground-only tool straight away", async () => {
    const spies: Spies = { handled: [] };
    const w = jobWorld({ script: { "do it": tool("screenThing") }, tools: tools(spies) });
    await w.run("do it");
    expect(spies.handled.map((call) => call.tool)).toEqual(["screenThing"]);
    expect(w.shell.results).toEqual(["Did it on screen."]);
  });

  it("a run that throws is a failed job, reported in the bar in the fixed words", async () => {
    const spies: Spies = { handled: [] };
    const w = jobWorld({ script: {}, tools: tools(spies) });
    await w.run("anything");
    expect(w.shell.results).toEqual([RUN_FAILED]);
    expect(w.manager.get("job1")).toMatchObject({ state: "failed", result: RUN_FAILED });
    expect(w.shell.thinking).toEqual([true, false]);
  });
});

describe("a detached job never touches what is in front of the user (addition A)", () => {
  it("writes its narration and result to its own record — no bar, no speech, no Thinking, no 'read the rest'", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: { "read then note": plan({ tool: "readThing" }, { tool: "noteThing" }) },
      tools: tools(spies, { hold: hold.promise }),
    });
    const done = w.run("read then note");
    await settle();
    // Attached so far: the plan preview went to the bar and was spoken.
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    const before = {
      results: w.shell.results.length,
      narrations: w.shell.narrations.length,
      actions: w.shell.actions.length,
      spoken: w.shell.spoken.length,
    };
    expect(w.shell.thinking).toEqual([true]);

    w.manager.detachAttached();
    // Detaching is what turns the indicator off; the job's own "off" will go nowhere.
    expect(w.shell.thinking).toEqual([true, false]);
    // Something the user is then offered by whatever they did next, in front of the bar.
    w.speech.hold("the rest of an answer the user heard");

    hold.resolve();
    await done;

    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing", "noteThing"]);
    // NOTHING more reached the bar or the speaker after the detach.
    expect(w.shell.results.length).toBe(before.results);
    expect(w.shell.narrations.length).toBe(before.narrations);
    expect(w.shell.actions.length).toBe(before.actions);
    expect(w.shell.spoken.length).toBe(before.spoken);
    expect(w.shell.thinking).toEqual([true, false]);
    // It went to the job's record instead: step 1's result, step 2's narration, step 2's result.
    expect(w.manager.get("job1")).toMatchObject({
      state: "done",
      background: true,
      lines: ["the thing", "Step 2 of 2: Noting the thing…", "Noted."],
    });
    // And the slot behind "read me the rest" is exactly as the user left it — not even marked
    // as passed over (M25): a detached job's answers are heard by nobody.
    expect(w.speech.take()).toEqual({ text: "the rest of an answer the user heard", fromEarlier: false });
  });

  it("stamps its rows as detached, and they are not the 'previous turn' of the next instruction (addition C)", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: {
        "first, in front of me": tool("noteThing"),
        "second, in the background": tool("readThing"),
        "third, what I say next": tool("noteThing"),
      },
      tools: tools(spies, { hold: hold.promise }),
    });
    await w.run("first, in front of me");

    const background = w.run("second, in the background");
    await settle();
    w.manager.detachAttached();
    hold.resolve();
    await background;

    expect(w.log.entries.map((row) => [row.instruction, row.detached])).toEqual([
      ["first, in front of me", false],
      ["second, in the background", true],
    ]);
    // The previous turn is what the user last did in front of the bar.
    expect(w.log.getLast()?.instruction).toBe("first, in front of me");

    await w.run("third, what I say next");
    expect(w.llm.previousTurns[2]?.instruction).toBe("first, in front of me");
  });
});

describe("a detached job waits at a confirm (decision 5, addition B)", () => {
  async function pausedAtConfirm(options: { world: { value: string }; tier?: () => Risk; clipboard?: string }) {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: {
        "read then send": plan({ tool: "readThing" }, { tool: "sendThing", arguments: { text: "hello" } }),
      },
      tools: tools(spies, { hold: hold.promise, world: options.world, ...(options.tier ? { tier: options.tier } : {}) }),
      shell: { holdConfirm: true, clipboard: options.clipboard ?? null },
    });
    const done = w.run("read then send");
    await settle();
    w.manager.detachAttached();
    hold.resolve();
    await settle();
    return { w, spies, done };
  }

  it("opens no dialog on its own: it becomes needs-you and stays there", async () => {
    const { w, spies } = await pausedAtConfirm({ world: { value: "#team" } });
    expect(w.manager.get("job1")).toMatchObject({ state: "needs-you", waitingFor: "confirm", tool: "sendThing", step: 2, total: 2 });
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.shell.isConfirmPending()).toBe(false);
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
  });

  it("builds the summary WHEN THE DIALOG OPENS, not when the job paused", async () => {
    const world = { value: "#team" };
    const { w, spies, done } = await pausedAtConfirm({ world });
    // Twenty minutes later the world is different.
    world.value = "#everyone";
    w.clock.now += 20 * 60 * 1000;

    expect(w.manager.resume("job1")).toBe("ok");
    await settle();
    expect(w.shell.confirmMessages).toEqual(['Step 2 of 2: Send "hello" to #everyone?']);
    // A detached dialog: the shell is told so, and treats the bar accordingly.
    expect(w.shell.confirmDetached).toEqual([true]);
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]); // resuming approved nothing

    w.shell.answerConfirm(true);
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing", "sendThing"]);
    expect(w.manager.get("job1")).toMatchObject({ state: "done", attached: false });
    // Still silent: a detached job's question and result are never spoken.
    expect(w.shell.results).toEqual([]);
  });

  it("works the tier out again after the wait, and the stricter answer stands", async () => {
    // Dangerous when the job paused; by the click the world says "caution". A wait must not be
    // able to talk the planner out of the confirm the user was brought back to give.
    let tier: Risk = "dangerous";
    const { w, done } = await pausedAtConfirm({ world: { value: "#team" }, tier: () => tier });
    tier = "caution";
    w.manager.resume("job1");
    await settle();
    expect(w.shell.confirmMessages.length).toBe(1);
    w.shell.answerConfirm(false);
    await done;
  });

  it("a no in the dialog cancels it: the handler is not called", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" } });
    w.manager.resume("job1");
    await settle();
    w.shell.answerConfirm(false);
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.manager.get("job1")?.state).toBe("cancelled");
    expect(w.log.entries.map((row) => row.status)).toEqual(["ok", "cancelled"]);
  });

  it("EXPIRED: after thirty minutes the handler is never called, and the row says so", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" } });
    w.clock.now += EXPIRY_MS;
    expect(w.manager.expireDue()).toBe(1);
    await done;

    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.shell.confirmMessages).toEqual([]); // no dialog was ever shown
    expect(w.manager.get("job1")).toMatchObject({ state: "expired" });
    expect(w.log.entries.map((row) => [row.tool, row.status])).toEqual([
      ["readThing", "ok"],
      ["sendThing", "expired"],
    ]);
    expect(w.log.entries[1]?.result).toBe(EXPIRED);
    // The job's own account leads with why, then says how much of the plan ran.
    expect(w.manager.get("job1")?.result).toContain(EXPIRED);
    expect(w.manager.get("job1")?.result).toContain("step 1 of 2");
    // It stopped BEFORE the summary: nothing was read or described for a step that will not run.
    expect(spies.summaries ?? 0).toBe(0);
  });

  it("EXPIRED AT THE CLICK: a late resume runs nothing either", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" } });
    w.clock.now += EXPIRY_MS + 1;
    expect(w.manager.resume("job1")).toBe("expired");
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.log.entries[1]).toMatchObject({ tool: "sendThing", status: "expired", result: EXPIRED });
    expect(spies.summaries ?? 0).toBe(0);
  });

  it("CANCELLED from the pill: the handler is never called", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" } });
    w.manager.cancel("job1");
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.shell.confirmMessages).toEqual([]);
    expect(w.manager.get("job1")?.state).toBe("cancelled");
    // In the gate's own words, which a dialog nobody saw being declined would not leave.
    expect(w.log.entries[1]).toMatchObject({ tool: "sendThing", status: "cancelled", result: CANCELLED_BY_YOU });
    expect(spies.summaries ?? 0).toBe(0);
  });

  it("CANCELLED WHILE ITS DIALOG IS OPEN: pressing the approve button afterwards runs nothing", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" } });
    w.manager.resume("job1");
    await settle();
    expect(w.shell.confirmMessages.length).toBe(1); // the dialog is up
    // The user cancels the job from the pill, then clicks the dialog's approve button anyway.
    expect(w.manager.cancel("job1")).toBe(true);
    w.shell.answerConfirm(true);
    await done;

    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.manager.get("job1")?.state).toBe("cancelled");
    expect(w.log.entries.map((row) => [row.tool, row.status])).toEqual([
      ["readThing", "ok"],
      ["sendThing", "cancelled"],
    ]);
  });

  it("THE SNAPSHOT: the clipboard and the email flag are those of the submission, however long it waited", async () => {
    const { w, spies, done } = await pausedAtConfirm({ world: { value: "#team" }, clipboard: "notes at submission" });
    // Everything the user is looking at changes while the job waits.
    w.shell.clipboard = "a password copied since";
    w.gmail.emailOpen = true;
    w.clock.now += 25 * 60 * 1000;

    w.manager.resume("job1");
    await settle();
    w.shell.answerConfirm(true);
    await done;

    expect(spies.handled).toEqual([
      { tool: "readThing", input: {}, clipboard: "notes at submission", emailOpen: false },
      { tool: "sendThing", input: { text: "hello" }, clipboard: "notes at submission", emailOpen: false },
    ]);
    // Read exactly once, at submission, and never again — not at the step, not on resume.
    expect(w.shell.contextReads).toBe(1);
    expect(w.llm.contexts[0]).toMatchObject({ selectedText: "notes at submission" });
    expect(w.llm.contexts[0]?.emailOpen).toBeUndefined();
  });
});

describe("a detached job waits at a foreground-only tool", () => {
  it("pauses there, runs nothing, and an ok tool before it ran without pausing", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: { "read then screen": plan({ tool: "readThing" }, { tool: "screenThing" }) },
      tools: tools(spies, { hold: hold.promise }),
    });
    const done = w.run("read then screen");
    await settle();
    w.manager.detachAttached();
    hold.resolve();
    await settle();

    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.manager.get("job1")).toMatchObject({ state: "needs-you", waitingFor: "foreground-only", tool: "screenThing" });

    // Resumed from the pill: it comes back in front of the user and finishes in the bar.
    expect(w.manager.resume("job1")).toBe("ok");
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing", "screenThing"]);
    expect(w.manager.isAttached("job1")).toBe(true);
    expect(w.shell.results).toEqual(["Did it on screen."]);
  });

  it("expires like any other wait, and the tool never runs", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: { "read then screen": plan({ tool: "readThing" }, { tool: "screenThing" }) },
      tools: tools(spies, { hold: hold.promise }),
    });
    const done = w.run("read then screen");
    await settle();
    w.manager.detachAttached();
    hold.resolve();
    await settle();
    w.clock.now += EXPIRY_MS;
    w.manager.expireDue();
    await done;
    expect(spies.handled.map((call) => call.tool)).toEqual(["readThing"]);
    expect(w.log.entries[1]).toMatchObject({ tool: "screenThing", status: "expired" });
  });
});

describe("two jobs at once", () => {
  it("each has its own chain state, and only one dialog is ever on screen", async () => {
    const spies: Spies = { handled: [] };
    const w = jobWorld({
      script: {
        "job A": plan({ tool: "readThing" }, { tool: "sendThing", arguments: { text: "from A" } }),
        "job B": plan({ tool: "readThing" }, { tool: "sendThing", arguments: { text: "from B" } }),
      },
      tools: tools(spies, { world: { value: "#team" } }),
      shell: { holdConfirm: true },
    });

    const a = w.run("job A");
    await settle();
    // A is parked at its dialog, attached. Its chain is at step 2 of 2.
    expect(w.shell.confirmMessages).toEqual(['Step 2 of 2: Send "from A" to #team?']);
    expect(w.chains[0]?.position()).toEqual({ step: 2, total: 2 });
    w.shell.answerConfirm(true);
    await a;
    expect(w.chains[0]?.isRunning()).toBe(false);

    // Now two alive together: C waits detached at its confirm while D is attached at its own.
    const w2 = jobWorld({
      script: {
        "job C": plan({ tool: "readThing" }, { tool: "sendThing", arguments: { text: "from C" } }),
        "job D": plan({ tool: "readThing" }, { tool: "sendThing", arguments: { text: "from D" } }),
      },
      tools: tools(spies, { world: { value: "#team" } }),
      shell: { holdConfirm: true },
    });
    const c = w2.run("job C");
    const d = w2.run("job D"); // submitting D detaches C
    await settle();

    expect(w2.manager.get("job1")).toMatchObject({ state: "needs-you", attached: false });
    expect(w2.manager.get("job2")).toMatchObject({ state: "running", attached: true });
    // BOTH chains are partway through, each at its own step 2 — neither overwrote the other.
    expect(w2.chains[0]?.position()).toEqual({ step: 2, total: 2 });
    expect(w2.chains[1]?.position()).toEqual({ step: 2, total: 2 });
    // D's dialog is up. C's is not: nobody asked for it.
    expect(w2.shell.confirmMessages).toEqual(['Step 2 of 2: Send "from D" to #team?']);

    // The user clicks C's row in the pill while D's dialog is still open.
    expect(w2.manager.resume("job1")).toBe("ok");
    await settle();
    // QUEUED behind D's, not shown over it.
    expect(w2.shell.confirmMessages.length).toBe(1);
    expect(w2.shell.isConfirmPending()).toBe(true);

    w2.shell.answerConfirm(true); // D's
    await settle();
    expect(w2.shell.confirmMessages).toEqual([
      'Step 2 of 2: Send "from D" to #team?',
      'Step 2 of 2: Send "from C" to #team?',
    ]);
    expect(w2.shell.confirmDetached).toEqual([false, true]);
    // D has finished and its chain state is cleared — and C's is NOT, which a shared flag
    // would have got wrong: the first chain to end used to clear it for both.
    await d;
    expect(w2.chains[1]?.isRunning()).toBe(false);
    expect(w2.chains[0]?.isRunning()).toBe(true);

    w2.shell.answerConfirm(true); // C's
    await c;
    expect(w2.chains[0]?.isRunning()).toBe(false);
    // One dialog at a time, throughout — read off the shell, where dialogs are actually shown.
    expect(w2.shell.maxOpenConfirms).toBe(1);
    // Each handler got its own job's text.
    expect(spies.handled.filter((call) => call.tool === "sendThing").map((call) => call.input["text"])).toEqual([
      "from A",
      "from D",
      "from C",
    ]);
  });

  it("the fourth job queues, says so in the bar while attached, and starts when a slot frees", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: { a: tool("readThing"), b: tool("readThing"), c: tool("readThing"), d: tool("readThing") },
      tools: tools(spies, { hold: hold.promise }),
    });
    const runs = ["a", "b", "c", "d"].map((instruction) => w.run(instruction));
    await settle();

    expect(["job1", "job2", "job3", "job4"].map((id) => w.manager.get(id)?.state)).toEqual([
      "running",
      "running",
      "running",
      "queued",
    ]);
    expect(spies.handled.length).toBe(3);
    expect(w.shell.actions).toContainEqual({ kind: "notify", payload: QUEUED_NOTICE });

    hold.resolve();
    await Promise.all(runs);
    expect(spies.handled.length).toBe(4);
    expect(["job1", "job2", "job3", "job4"].map((id) => w.manager.get(id)?.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });
});

describe("jobStatus through the planner", () => {
  it("answers from the job records, is not itself listed, and does not wait behind running jobs", async () => {
    const spies: Spies = { handled: [] };
    const hold = deferred();
    const w = jobWorld({
      script: { "long job": tool("readThing"), "are my agents done yet": tool("jobStatus") },
      tools: [...tools(spies, { hold: hold.promise }), jobStatusTool],
      maxRunning: 1,
    });
    const long = w.run("long job");
    await settle();

    // The one slot is taken. The question is answered anyway.
    await w.run("are my agents done yet");
    expect(w.shell.results).toEqual(['1 job is still running.\n\n- running: "long job"']);
    expect(w.shell.spoken).toEqual(["1 job is still running."]);
    expect(w.manager.get("job2")).toMatchObject({ kind: "status", state: "done" });
    expect(w.manager.list().map((job) => job.id)).toEqual(["job1"]);
    expect(w.manager.views().map((job) => job.id)).toEqual(["job1"]);

    hold.resolve();
    await long;
  });
});
