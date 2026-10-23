import { describe, expect, it } from "vitest";
import { combineInstructionBusy, createOnDictateHotkey } from "../src/main/dictate.ts";
import {
  CHAIN_RUNNING,
  CONFIRM_WAITING,
  createOnInstructionHotkey,
} from "../src/main/instructionHotkey.ts";
import type { Tool } from "../src/core/types.ts";
import { deferred, jobWorld, plan, settle, tool } from "./jobWorld.ts";
import type { World } from "./jobWorld.ts";

// The hotkey guards against REAL jobs (M23).
//
// THE RULE CHANGED, so the old tests were re-read rather than just re-run (CLAUDE.md). Through
// M22 "a chain is running" blocked both hotkeys for the chain's whole length. Now only the
// ATTACHED job blocks, and only while it holds the foreground: a step that acts on the screen,
// or a confirm being prepared. tests/instructionHotkey.test.ts still pins the guard's own
// branching (`isRunning()` true → blocked, with the right sentence, in the right order); what
// it cannot say is what makes `isRunning()` true. That is here, and each case below is one the
// old rule would have answered differently:
//
//   a background job mid-step          old rule: n/a (could not exist)   new: not blocked
//   an attached job mid ok-step chain  old rule: BLOCKED                 new: detached, proceeds
//   an attached foreground-only step   old rule: blocked only in a chain new: BLOCKED, even alone

function tools(hold: Promise<void>): Tool[] {
  const slow = (name: string, background: Tool["background"]): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    background,
    planPhrase: "run a test step",
    handler: async (): Promise<string> => {
      await hold;
      return `${name} done`;
    },
  });
  const sendThing: Tool = {
    name: "sendThing",
    description: "Send.",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "dangerous",
    background: "ok",
    planPhrase: "run a test step",
    confirmSummary: (): string => "Send it?",
    handler: (): Promise<string> => Promise.resolve("Sent."),
  };
  return [slow("okThing", "ok"), slow("screenThing", "foreground-only"), sendThing];
}

// The hotkey handler exactly as main.ts builds it, over the world's shell and job manager.
function hotkey(w: World) {
  const events: string[] = [];
  const press = createOnInstructionHotkey({
    shell: {
      isConfirmPending: () => w.shell.isConfirmPending(),
      isAskPending: () => w.shell.isAskPending(),
      focusAsk: () => w.shell.focusAsk(),
      narrate: (text) => events.push(`narrate:${text}`),
      showInput: () => {
        events.push("showInput");
        return Promise.resolve("");
      },
      clearPointer: () => events.push("clearPointer"),
      snapshotPointTarget: () => Promise.resolve(),
    },
    dictation: null,
    voice: null,
    speech: { speak: (text) => events.push(`speak:${text}`), stop: () => events.push("bargeIn") },
    chain: { isRunning: () => w.manager.attachedBlocks() },
    detach: () => {
      events.push("detach");
      w.manager.detachAttached("hotkey");
    },
    runInstruction: () => Promise.resolve(),
  });
  return { events, press };
}

describe("the instruction hotkey and running jobs", () => {
  it("a BACKGROUND job mid-step does not block: barge-in happens and the bar opens", async () => {
    const hold = deferred();
    const w = jobWorld({ script: { work: tool("okThing"), next: tool("okThing") }, tools: tools(hold.promise) });
    const first = w.run("work");
    await settle();
    w.manager.detachAttached("hotkey"); // it is in the background now, still inside its handler
    expect(w.manager.get("job1")).toMatchObject({ state: "running", attached: false });

    const { events, press } = hotkey(w);
    press();
    await settle();
    expect(events).toEqual(["detach", "bargeIn", "clearPointer", "showInput"]);

    hold.resolve();
    await first;
  });

  it("an ATTACHED job on an ordinary step is detached by the press, and the press goes through", async () => {
    const hold = deferred();
    const w = jobWorld({
      script: { chain: plan({ tool: "okThing" }, { tool: "okThing" }) },
      tools: tools(hold.promise),
    });
    const running = w.run("chain");
    await settle();
    // A chain, partway through step 1 — exactly what blocked the hotkey through M22.
    expect(w.chains[0]?.isRunning()).toBe(true);
    expect(w.manager.isAttached("job1")).toBe(true);

    const { events, press } = hotkey(w);
    press();
    await settle();
    expect(events).toEqual(["detach", "bargeIn", "clearPointer", "showInput"]);
    expect(w.manager.get("job1")).toMatchObject({ attached: false, background: true, state: "running" });

    hold.resolve();
    await running;
    expect(w.manager.get("job1")?.state).toBe("done");
  });

  it("an attached FOREGROUND-ONLY step blocks, says so, and is not detached", async () => {
    const hold = deferred();
    const w = jobWorld({ script: { screen: tool("screenThing") }, tools: tools(hold.promise) });
    const running = w.run("screen");
    await settle();

    const { events, press } = hotkey(w);
    press();
    await settle();
    expect(events).toEqual([`narrate:${CHAIN_RUNNING}`, expect.stringMatching(/^speak:/)]);
    expect(w.manager.isAttached("job1")).toBe(true);

    // The moment the step is over the same press is accepted.
    hold.resolve();
    await running;
    events.length = 0;
    press();
    await settle();
    expect(events).toContain("showInput");
  });

  it("an attached job parked at its confirm dialog blocks with the CONFIRM sentence, not the chain one", async () => {
    const hold = deferred();
    hold.resolve();
    const w = jobWorld({
      script: { send: tool("sendThing") },
      tools: tools(hold.promise),
      shell: { holdConfirm: true },
    });
    const running = w.run("send");
    await settle();
    expect(w.shell.isConfirmPending()).toBe(true);
    // Both are true here — the job holds the foreground AND a dialog is up — and the dialog
    // is the one the user can act on.
    expect(w.manager.attachedBlocks()).toBe(true);

    const { events, press } = hotkey(w);
    press();
    await settle();
    expect(events).toEqual([`narrate:${CONFIRM_WAITING}`, expect.stringMatching(/^speak:/)]);

    w.shell.answerConfirm(false);
    await running;
  });

  it("a detached job WAITING for the user does not block: starting something else is the point", async () => {
    const hold = deferred();
    hold.resolve();
    const w = jobWorld({ script: { send: plan({ tool: "okThing" }, { tool: "sendThing" }) }, tools: tools(hold.promise) });
    const running = w.run("send");
    w.manager.detachAttached("hotkey");
    await settle();
    expect(w.manager.get("job1")?.state).toBe("needs-you");

    const { events, press } = hotkey(w);
    press();
    await settle();
    expect(events).toContain("showInput");

    w.manager.cancel("job1");
    await running;
  });
});

describe("the dictation hotkey and running jobs", () => {
  const idleShell = { isInputCapturing: () => false, isConfirmPending: () => false, isAskPending: () => false };

  it("is 'chaining' only while the attached job holds the foreground", async () => {
    const hold = deferred();
    const w = jobWorld({
      script: { ok: tool("okThing"), screen: tool("screenThing") },
      tools: tools(hold.promise),
    });
    const busy = combineInstructionBusy(null, idleShell, { isRunning: () => w.manager.attachedBlocks() });

    const first = w.run("ok");
    await settle();
    expect(busy.getState()).toBe("idle"); // an ordinary step: dictation may start

    const second = w.run("screen"); // detaches the first; this one acts on the screen
    await settle();
    expect(busy.getState()).toBe("chaining");

    hold.resolve();
    await Promise.all([first, second]);
    expect(busy.getState()).toBe("idle");
  });

  it("an accepted press detaches the attached job before dictation begins; a blocked one does neither", () => {
    const order: string[] = [];
    const dictation = {
      begin: (): Promise<void> => {
        order.push("begin");
        return Promise.resolve();
      },
    };
    let state = "idle";
    const press = createOnDictateHotkey(dictation, { getState: () => state }, () => order.push("detach"));

    press();
    expect(order).toEqual(["detach", "begin"]);

    order.length = 0;
    state = "chaining";
    press();
    expect(order).toEqual([]);
  });
});
