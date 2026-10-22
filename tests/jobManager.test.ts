import { describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/JobManager.ts";
import type { JobChange } from "../src/core/jobs/JobManager.ts";
import { InMemoryJobStore } from "../src/core/jobs/JobStore.ts";
import type { GateAnswer, JobGate, StepEntry } from "../src/core/jobs/gate.ts";
import { EXPIRY_MS } from "../src/core/jobs/messages.ts";

// The job state machine (M23), on its own: no planner, no shell, no tool. A test here plays
// the part the planner plays — it asks the gate the same questions in the same order — and
// asserts what the manager answered and what state it left the job in.
//
// THE CLOCK IS A VARIABLE. Nothing in this file waits; thirty minutes is `clock.now += …`.

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { maxRunning?: number; foregroundFree?: () => boolean } = {}) {
  const clock = { now: 1_000_000 };
  const store = new InMemoryJobStore();
  let seq = 0;
  const manager = new JobManager({
    store,
    now: () => clock.now,
    newId: () => `j${(seq += 1)}`,
    ...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
    ...(options.foregroundFree === undefined ? {} : { foregroundFree: options.foregroundFree }),
  });
  const changes: JobChange[] = [];
  manager.onChange((change) => changes.push(change));
  return { clock, store, manager, changes };
}

const WORK = { tools: ["doThing"], statusOnly: false };
const step = (tool: string, foregroundOnly = false, index = 1, total = 1): StepEntry => ({
  tool,
  index,
  total,
  foregroundOnly,
});

// Records what a pending gate question was eventually answered with, without awaiting it.
function watch<T>(pending: Promise<T>): { value: T | "PENDING" } {
  const seen: { value: T | "PENDING" } = { value: "PENDING" };
  void pending.then((value) => (seen.value = value));
  return seen;
}

describe("a job from submission to its end", () => {
  it("starts attached and running, and is recorded at once", () => {
    const { manager, store } = harness();
    const id = manager.submit("summarize this");
    const job = manager.get(id);
    expect(job).toMatchObject({ state: "running", attached: true, background: false, kind: "work" });
    expect(store.records.get(id)?.state).toBe("running");
  });

  it("an attached job is admitted, steps, and finishes as done — never appearing in the pill", async () => {
    const { manager } = harness();
    const id = manager.submit("summarize this");
    const gate = manager.gateFor(id);
    expect(await gate.admit(WORK)).toBe("go");
    expect(await gate.enterStep(step("doThing"))).toBe("go");
    gate.handlerStarting();
    gate.handlerFinished();
    gate.leaveStep();
    manager.finish(id, "done", "Summary.");
    expect(manager.get(id)).toMatchObject({ state: "done", result: "Summary." });
    // The user watched it finish in the bar. It is not background work and is not listed.
    expect(manager.views()).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it("only one job is attached at a time: a new submission detaches the one before", () => {
    const { manager } = harness();
    const first = manager.submit("one");
    const second = manager.submit("two");
    expect(manager.isAttached(first)).toBe(false);
    expect(manager.get(first)?.background).toBe(true);
    expect(manager.isAttached(second)).toBe(true);
  });

  it("ignores a move that is not legal, instead of throwing", () => {
    const { manager } = harness();
    const id = manager.submit("one");
    manager.finish(id, "done", "first");
    // Already ended: a second ending (a late planner outcome after a cancel, say) changes nothing.
    manager.finish(id, "failed", "second");
    expect(manager.get(id)).toMatchObject({ state: "done", result: "first" });
    expect(manager.cancel(id)).toBe(false);
    expect(manager.resume(id)).toBe("not-waiting");
  });
});

describe("the cap: three jobs execute, the rest queue", () => {
  it("admits three, queues the fourth, and starts it when one finishes", async () => {
    const { manager } = harness();
    const ids = ["a", "b", "c", "d"].map((name) => manager.submit(name));
    const answers = ids.map((id) => watch(manager.gateFor(id).admit(WORK)));
    await flush();

    expect(answers.map((answer) => answer.value)).toEqual(["go", "go", "go", "PENDING"]);
    expect(ids.map((id) => manager.get(id)?.state)).toEqual(["running", "running", "running", "queued"]);

    manager.finish(ids[0] ?? "", "done", null);
    await flush();
    expect(answers[3]?.value).toBe("go");
    expect(manager.get(ids[3] ?? "")?.state).toBe("running");
  });

  it("queued jobs start in the order they were queued", async () => {
    const { manager } = harness({ maxRunning: 1 });
    const ids = ["a", "b", "c"].map((name) => manager.submit(name));
    const answers = ids.map((id) => watch(manager.gateFor(id).admit(WORK)));
    await flush();
    expect(answers.map((answer) => answer.value)).toEqual(["go", "PENDING", "PENDING"]);

    manager.finish(ids[0] ?? "", "done", null);
    await flush();
    expect(answers.map((answer) => answer.value)).toEqual(["go", "go", "PENDING"]);
  });

  it("PLANNING is not capped: a job holds no slot until it is admitted", async () => {
    const { manager } = harness({ maxRunning: 1 });
    // Four jobs submitted and still planning. None has asked to execute.
    const planning = ["a", "b", "c", "d"].map((name) => manager.submit(name));
    expect(planning.map((id) => manager.get(id)?.state)).toEqual(["running", "running", "running", "running"]);
    // The one slot is still free for whichever asks first.
    expect(await manager.gateFor(planning[3] ?? "").admit(WORK)).toBe("go");
  });

  it("a status question never waits for a slot and is never listed", async () => {
    const { manager } = harness({ maxRunning: 1 });
    const busy = manager.submit("long job");
    await manager.gateFor(busy).admit(WORK);
    manager.submit("another"); // detaches `busy`, making it background work

    const status = manager.submit("are my agents done yet");
    expect(await manager.gateFor(status).admit({ tools: ["jobStatus"], statusOnly: true })).toBe("go");
    expect(manager.get(status)?.kind).toBe("status");
    manager.submit("next thing"); // detach the status job too: it still must not be listed
    expect(manager.views().map((job) => job.id)).not.toContain(status);
    expect(manager.list().map((job) => job.id)).not.toContain(status);
    expect(manager.list().map((job) => job.id)).toContain(busy);
  });

  it("a job waiting for the user gives its slot back", async () => {
    const { manager } = harness({ maxRunning: 1 });
    const first = manager.submit("needs a yes");
    const gate = manager.gateFor(first);
    await gate.admit(WORK);
    const second = manager.submit("queued behind it"); // detaches `first`
    const queued = watch(manager.gateFor(second).admit(WORK));
    await flush();
    expect(queued.value).toBe("PENDING");

    await gate.enterStep(step("sendThing"));
    void gate.beforeConfirm(); // detached, so this pauses
    await flush();
    expect(manager.get(first)?.state).toBe("needs-you");
    expect(queued.value).toBe("go");
  });
});

describe("attached and detached", () => {
  it("an attached job is never paused: a confirm and a foreground-only step both go straight through", async () => {
    const { manager } = harness();
    const id = manager.submit("reply to this");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    expect(await gate.enterStep(step("draftReply", true))).toBe("go");
    expect(await gate.beforeConfirm()).toEqual({ answer: "go", waited: false });
    expect(manager.get(id)?.state).toBe("running");
  });

  it("a detached job pauses before a confirm, and `waited` says so", async () => {
    const { manager } = harness();
    const id = manager.submit("send these to the team");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    expect(manager.detachAttached("hotkey")).toBe(true);

    const asked = watch(gate.beforeConfirm());
    await flush();
    expect(asked.value).toBe("PENDING");
    expect(manager.get(id)).toMatchObject({ state: "needs-you", waitingFor: "confirm" });

    expect(manager.resume(id)).toBe("ok");
    await flush();
    expect(asked.value).toEqual({ answer: "go", waited: true });
    // Still detached: resuming a confirm lets the dialog open, it does not bring the job back.
    expect(manager.isAttached(id)).toBe(false);
  });

  it("a detached job pauses before a foreground-only tool, and an ok tool does not", async () => {
    const { manager } = harness();
    const id = manager.submit("summarize then add to my page");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["summarize", "addToPage"], statusOnly: false });
    manager.detachAttached("hotkey");

    expect(await gate.enterStep(step("summarize", false, 1, 2))).toBe("go");
    gate.leaveStep();
    expect(manager.get(id)?.state).toBe("running");

    const entered = watch(gate.enterStep(step("addToPage", true, 2, 2)));
    await flush();
    expect(entered.value).toBe("PENDING");
    expect(manager.get(id)).toMatchObject({ state: "needs-you", waitingFor: "foreground-only", tool: "addToPage" });

    // Resuming a foreground-only step brings the job back in front of the user.
    expect(manager.resume(id)).toBe("ok");
    await flush();
    expect(entered.value).toBe("go");
    expect(manager.isAttached(id)).toBe(true);
  });

  it("a foreground-only step cannot be resumed while the user is in the middle of something", async () => {
    let free = false;
    const { manager } = harness({ foregroundFree: () => free });
    const id = manager.submit("add to my page");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    manager.detachAttached("hotkey");
    const entered = watch(gate.enterStep(step("addToPage", true)));
    await flush();

    expect(manager.resume(id)).toBe("busy");
    expect(manager.get(id)?.state).toBe("needs-you");
    expect(entered.value).toBe("PENDING");

    free = true;
    expect(manager.resume(id)).toBe("ok");
  });

  it("nor while another job is attached", async () => {
    const { manager } = harness();
    const waiting = manager.submit("add to my page");
    const gate = manager.gateFor(waiting);
    await gate.admit(WORK);
    manager.submit("something else, attached now");
    void gate.enterStep(step("addToPage", true));
    await flush();
    expect(manager.resume(waiting)).toBe("busy");
  });
});

describe("what the attached job holds, and what a hotkey press may do about it", () => {
  it("a job that is merely working does not block, and can be detached", async () => {
    const { manager } = harness();
    const id = manager.submit("summarize this");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("summarize"));
    expect(manager.attachedBlocks()).toBe(false);
    expect(manager.detachAttached("hotkey")).toBe(true);
    expect(manager.isAttached(id)).toBe(false);
  });

  it("a foreground-only step blocks for its whole length, and refuses to be detached", async () => {
    const { manager } = harness();
    const id = manager.submit("reply to this");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("draftReply", true));
    expect(manager.attachedBlocks()).toBe(true);
    expect(manager.detachAttached("hotkey")).toBe(false);
    expect(manager.isAttached(id)).toBe(true);

    gate.handlerStarting();
    expect(manager.attachedBlocks()).toBe(true); // still acting on the screen
    gate.handlerFinished();
    gate.leaveStep();
    expect(manager.attachedBlocks()).toBe(false);
  });

  it("an ordinary step blocks from 'a confirm is needed' until its handler starts", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    expect(manager.attachedBlocks()).toBe(false);

    await gate.beforeConfirm();
    // The summary is being built and the dialog is about to open: not the moment to walk away.
    expect(manager.attachedBlocks()).toBe(true);
    expect(manager.takeConfirmPermit(id)).toBe("attached");

    gate.handlerStarting(); // the dialog was answered
    expect(manager.attachedBlocks()).toBe(false);
  });

  it("a background job never blocks", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    await manager.gateFor(id).admit(WORK);
    manager.detachAttached("hotkey");
    expect(manager.attachedBlocks()).toBe(false);
    expect(manager.hasAttached()).toBe(false);
  });
});

describe("what the rest of the app may ask about the attached job", () => {
  it("attachedTool is the tool the job with the bar is on, and null once nothing has the bar", async () => {
    const { manager } = harness();
    expect(manager.attachedTool()).toBeNull();
    const id = manager.submit("file it");
    expect(manager.attachedTool()).toBeNull(); // still planning: on no tool yet
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["linear__create_issue"], statusOnly: false });
    expect(manager.attachedTool()).toBe("linear__create_issue");
    await gate.enterStep(step("linear__create_issue"));
    gate.leaveStep();
    manager.detachAttached("hotkey");
    // In the background now: it is nobody's bar.
    expect(manager.attachedTool()).toBeNull();
  });

  it("isCancelRequested: false for a live job, true once cancelled — mid-step or waiting — and for an unknown id", async () => {
    const { manager } = harness();
    const running = manager.submit("a");
    await manager.gateFor(running).admit(WORK);
    expect(manager.isCancelRequested(running)).toBe(false);
    manager.cancel(running); // mid-run: only a request
    expect(manager.get(running)?.state).toBe("running");
    expect(manager.isCancelRequested(running)).toBe(true);
    expect(manager.isCancelRequested("no-such-job")).toBe(true);
  });

  it("BACKSTOP: a submission while the attached job holds the foreground does not get the bar too", async () => {
    const { manager } = harness();
    const first = manager.submit("reply to this");
    const gate = manager.gateFor(first);
    await gate.admit(WORK);
    await gate.enterStep(step("draftReply", true)); // acting on the screen: cannot be detached
    const second = manager.submit("something else");
    expect(manager.isAttached(first)).toBe(true);
    expect(manager.get(second)).toMatchObject({ attached: false, background: true });
  });
});

describe("the confirm permit", () => {
  it("is 'none' for a job nobody resumed: no dialog may open unasked", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    await manager.gateFor(id).admit(WORK);
    manager.detachAttached("hotkey");
    expect(manager.takeConfirmPermit(id)).toBe("none");
  });

  it("is 'detached' after a resume, once, and then gone", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    manager.detachAttached("hotkey");
    const asked = gate.beforeConfirm();
    await flush();
    manager.resume(id);
    await asked;
    expect(manager.takeConfirmPermit(id)).toBe("detached");
    expect(manager.takeConfirmPermit(id)).toBe("none");
  });

  it("does not survive the step it was issued for", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    await gate.beforeConfirm();
    gate.leaveStep();
    expect(manager.takeConfirmPermit(id)).toBe("none");
  });
});

describe("expiry: thirty minutes, then 'expired, not run'", () => {
  async function waitingJob(manager: JobManager): Promise<{ id: string; asked: { value: unknown } }> {
    const id = manager.submit("send these");
    const gate: JobGate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    manager.detachAttached("hotkey");
    const asked = watch(gate.beforeConfirm());
    await flush();
    return { id, asked };
  }

  it("does not expire one millisecond early", async () => {
    const { manager, clock } = harness();
    const { id, asked } = await waitingJob(manager);
    clock.now += EXPIRY_MS - 1;
    expect(manager.expireDue()).toBe(0);
    expect(manager.get(id)?.state).toBe("needs-you");
    expect(asked.value).toBe("PENDING");
  });

  it("expires at the limit, and the gate answers 'expired' — the answer the planner does not run on", async () => {
    const { manager, clock } = harness();
    const { id, asked } = await waitingJob(manager);
    clock.now += EXPIRY_MS;
    expect(manager.expireDue()).toBe(1);
    await flush();
    expect(manager.get(id)?.state).toBe("expired");
    expect(asked.value).toEqual({ answer: "expired", waited: true });
  });

  it("is checked AT THE CLICK: a resume after the limit expires the job even if no timer ran", async () => {
    const { manager, clock } = harness();
    const { id, asked } = await waitingJob(manager);
    clock.now += EXPIRY_MS + 5;
    expect(manager.resume(id)).toBe("expired");
    await flush();
    expect(manager.get(id)?.state).toBe("expired");
    expect((asked.value as { answer: GateAnswer }).answer).toBe("expired");
  });

  it("once resumed, the clock no longer applies: the answer is the user's", async () => {
    const { manager, clock } = harness();
    const { id } = await waitingJob(manager);
    clock.now += EXPIRY_MS - 1;
    expect(manager.resume(id)).toBe("ok");
    clock.now += EXPIRY_MS * 3; // a dialog left open over lunch
    expect(manager.expireDue()).toBe(0);
    expect(manager.get(id)?.state).toBe("running");
  });

  it("an expired job cannot be resumed or expired again", async () => {
    const { manager, clock } = harness();
    const { id } = await waitingJob(manager);
    clock.now += EXPIRY_MS;
    manager.expireDue();
    expect(manager.resume(id)).toBe("not-waiting");
    expect(manager.expireDue()).toBe(0);
  });
});

describe("cancelling", () => {
  it("a waiting job is cancelled at once, and its gate answers 'cancelled'", async () => {
    const { manager } = harness();
    const id = manager.submit("send these");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage"));
    manager.detachAttached("hotkey");
    const asked = watch(gate.beforeConfirm());
    await flush();

    expect(manager.cancel(id)).toBe(true);
    await flush();
    expect(manager.get(id)?.state).toBe("cancelled");
    expect(asked.value).toEqual({ answer: "cancelled", waited: true });
  });

  it("a queued job is cancelled before it ever executes, and frees nothing it never held", async () => {
    const { manager } = harness({ maxRunning: 1 });
    const first = manager.submit("a");
    await manager.gateFor(first).admit(WORK);
    const second = manager.submit("b");
    const queued = watch(manager.gateFor(second).admit(WORK));
    await flush();

    manager.cancel(second);
    await flush();
    expect(queued.value).toBe("cancelled");
    manager.finish(first, "done", null);
    await flush();
    expect(manager.get(second)?.state).toBe("cancelled");
  });

  it("a job mid-step is not torn down: the next gate question answers 'cancelled'", async () => {
    const { manager } = harness();
    const id = manager.submit("two steps");
    const gate = manager.gateFor(id);
    await gate.admit({ tools: ["one", "two"], statusOnly: false });
    await gate.enterStep(step("one", false, 1, 2));
    gate.handlerStarting();

    manager.cancel(id);
    expect(manager.get(id)?.state).toBe("running"); // the handler in flight is left to finish
    gate.handlerFinished();
    gate.leaveStep();
    expect(await gate.enterStep(step("two", false, 2, 2))).toBe("cancelled");
  });
});

describe("what is written down", () => {
  it("the step-started marker is saved BEFORE the handler and cleared after", async () => {
    const { manager, store } = harness();
    const id = manager.submit("send these");
    const gate = manager.gateFor(id);
    await gate.admit(WORK);
    await gate.enterStep(step("sendMessage", false, 2, 3));
    expect(store.records.get(id)).toMatchObject({ inFlightTool: null, inFlightStep: null });

    gate.handlerStarting();
    expect(store.records.get(id)).toMatchObject({ inFlightTool: "sendMessage", inFlightStep: 2 });

    gate.handlerFinished();
    expect(store.records.get(id)).toMatchObject({ inFlightTool: null, inFlightStep: null });
  });

  it("every state change is announced with the state it came from", async () => {
    const { manager, changes } = harness({ maxRunning: 1 });
    const first = manager.submit("a");
    await manager.gateFor(first).admit(WORK);
    const second = manager.submit("b");
    void manager.gateFor(second).admit(WORK);
    await flush();
    manager.finish(first, "done", null);
    await flush();

    const moves = changes
      .filter((change): change is Extract<JobChange, { type: "state" }> => change.type === "state")
      .map((change) => `${change.job.id}: ${change.previous ?? "new"} -> ${change.job.state}`);
    expect(moves).toEqual([
      "j1: new -> running",
      "j2: new -> running",
      "j2: running -> queued",
      "j1: running -> done",
      "j2: queued -> running",
    ]);
    expect(changes.some((change) => change.type === "detached" && change.job.id === "j1")).toBe(true);
  });

  it("a dismissed job leaves the pill and the status answer", () => {
    const { manager } = harness();
    const id = manager.submit("a");
    manager.submit("b");
    manager.finish(id, "failed", "It broke.");
    expect(manager.views().map((job) => job.id)).toEqual([id]);
    // Only something that has ended can be dismissed.
    expect(manager.acknowledge("j2")).toBe(false);
    expect(manager.acknowledge(id)).toBe(true);
    expect(manager.views()).toEqual([]);
  });

  it("the status answer forgets a job that ended more than half an hour ago; the pill decides for itself", () => {
    const { manager, clock } = harness();
    const id = manager.submit("a");
    manager.submit("b");
    manager.finish(id, "failed", "It broke.");
    clock.now += 31 * 60 * 1000;
    expect(manager.list().map((job) => job.id)).not.toContain(id);
    expect(manager.views().map((job) => job.id)).toContain(id);
  });
});
