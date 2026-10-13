import { describe, expect, it } from "vitest";
import { JobShell } from "../src/core/jobs/JobShell.ts";
import type { ForegroundShell, JobHandle } from "../src/core/jobs/JobShell.ts";
import { ConfirmBroker } from "../src/main/shell/ConfirmBroker.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";

// The confirm queue (M23) — the thing that replaced the shell's `confirmPending` boolean — and
// the job's-eye view of the gate in front of it.

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// A presenter the test answers by hand, recording how many dialogs were open at once.
function presenter() {
  const open: { name: string; answer: (approved: boolean) => void; fail: (error: Error) => void }[] = [];
  const log: string[] = [];
  let mostOpen = 0;
  const present = (name: string): Promise<boolean> => {
    log.push(`shown:${name}`);
    return new Promise<boolean>((resolve, reject) => {
      open.push({ name, answer: resolve, fail: reject });
      mostOpen = Math.max(mostOpen, open.length);
    }).finally(() => {
      open.splice(open.findIndex((entry) => entry.name === name), 1);
    });
  };
  return { present, open, log, mostOpen: () => mostOpen };
}

describe("ConfirmBroker", () => {
  it("presents the first request synchronously — pending is true before the call returns", () => {
    const p = presenter();
    const broker = new ConfirmBroker<string>(p.present);
    expect(broker.isPending()).toBe(false);
    void broker.request("a");
    expect(p.log).toEqual(["shown:a"]);
    expect(broker.isPending()).toBe(true);
    expect(broker.showing()).toBe("a");
  });

  it("ONE AT A TIME, in order: the second is not shown until the first is answered", async () => {
    const p = presenter();
    const settled: string[] = [];
    const broker = new ConfirmBroker<string>(p.present, (name) => settled.push(name));
    const a = broker.request("a");
    const b = broker.request("b");
    const c = broker.request("c");
    await tick();
    expect(p.log).toEqual(["shown:a"]);

    p.open[0]?.answer(true);
    await expect(a).resolves.toBe(true);
    await tick();
    expect(p.log).toEqual(["shown:a", "shown:b"]);
    // Still pending between the two: this is the gap the old boolean fell into.
    expect(broker.isPending()).toBe(true);

    p.open[0]?.answer(false);
    await expect(b).resolves.toBe(false);
    await tick();
    p.open[0]?.answer(true);
    await expect(c).resolves.toBe(true);

    expect(p.mostOpen()).toBe(1);
    expect(settled).toEqual(["a", "b", "c"]);
    expect(broker.isPending()).toBe(false);
    expect(broker.showing()).toBeNull();
  });

  it("each asker gets ITS OWN answer", async () => {
    const p = presenter();
    const broker = new ConfirmBroker<string>(p.present);
    const a = broker.request("a");
    const b = broker.request("b");
    p.open[0]?.answer(false);
    await expect(a).resolves.toBe(false);
    await tick();
    p.open[0]?.answer(true);
    await expect(b).resolves.toBe(true);
  });

  it("only a literal true is a yes", async () => {
    const broker = new ConfirmBroker<string>(() => Promise.resolve("yes" as unknown as boolean));
    await expect(broker.request("a")).resolves.toBe(false);
  });

  it("a dialog that fails rejects ITS request, runs the tidy-up, and the queue moves on", async () => {
    const p = presenter();
    const settled: string[] = [];
    const broker = new ConfirmBroker<string>(p.present, (name) => settled.push(name));
    const a = broker.request("a");
    const b = broker.request("b");
    p.open[0]?.fail(new Error("dialog exploded"));
    await expect(a).rejects.toThrow("dialog exploded");
    await tick();
    expect(p.log).toEqual(["shown:a", "shown:b"]);
    p.open[0]?.answer(true);
    await expect(b).resolves.toBe(true);
    expect(settled).toEqual(["a", "b"]);
    expect(broker.isPending()).toBe(false);
  });

  it("a presenter that throws synchronously is a rejection too, not a hang", async () => {
    const broker = new ConfirmBroker<string>(() => {
      throw new Error("no window");
    });
    await expect(broker.request("a")).rejects.toThrow("no window");
    expect(broker.isPending()).toBe(false);
  });

  it("the tidy-up runs AFTER the dialog stops counting as showing, and before the asker hears", async () => {
    const order: string[] = [];
    const broker: ConfirmBroker<string> = new ConfirmBroker<string>(
      () => Promise.resolve(true),
      () => order.push(`settled(showing=${String(broker.showing())})`),
    );
    await broker.request("a").then(() => order.push("answered"));
    expect(order).toEqual(["settled(showing=null)", "answered"]);
  });

  it("a tidy-up that throws does not lose the answer", async () => {
    const broker = new ConfirmBroker<string>(
      () => Promise.resolve(true),
      () => {
        throw new Error("tidy-up broke");
      },
    );
    await expect(broker.request("a")).resolves.toBe(true);
  });
});

describe("MockShell uses the same queue, and counts what was actually on screen", () => {
  it("two confirms asked together are shown one after the other", async () => {
    const shell = new MockShell({
      context: { selectedText: null, activeApp: null, activeWindowTitle: null },
      holdConfirm: true,
    });
    const first = shell.confirm("First?");
    const second = shell.confirm("Second?", { detached: true, approveLabel: "Create issue" });
    await tick();
    expect(shell.confirmMessages).toEqual(["First?"]); // the second has not been SHOWN
    expect(shell.isConfirmPending()).toBe(true);

    shell.answerConfirm(true);
    await expect(first).resolves.toBe(true);
    await tick();
    expect(shell.confirmMessages).toEqual(["First?", "Second?"]);
    expect(shell.confirmDetached).toEqual([false, true]);
    expect(shell.confirmLabels).toEqual(["Send", "Create issue"]);

    shell.answerConfirm(false);
    await expect(second).resolves.toBe(false);
    expect(shell.maxOpenConfirms).toBe(1);
    expect(shell.isConfirmPending()).toBe(false);
  });
});

describe("JobShell.confirm — which dialog a job may open, if any", () => {
  function harness(permit: "attached" | "detached" | "none", attached: boolean, cancelled = false) {
    const asked: { message: string; detached: boolean; label: string | undefined }[] = [];
    const real = {
      confirm: (message: string, options?: { detached?: boolean; approveLabel?: string }) => {
        asked.push({ message, detached: options?.detached === true, label: options?.approveLabel });
        return Promise.resolve(true);
      },
    } as unknown as ForegroundShell;
    const job: JobHandle = {
      id: "j1",
      isAttached: () => attached,
      record: () => undefined,
      takeConfirmPermit: () => permit,
      isCancelled: () => cancelled,
    };
    const context = Promise.resolve({ selectedText: null, activeApp: null, activeWindowTitle: null });
    return { shell: new JobShell(real, job, context), asked };
  }

  it("attached permit: the ordinary dialog, label passed through", async () => {
    const { shell, asked } = harness("attached", true);
    await expect(shell.confirm("Send?", { approveLabel: "Send reply" })).resolves.toBe(true);
    expect(asked).toEqual([{ message: "Send?", detached: false, label: "Send reply" }]);
  });

  it("detached permit: the same dialog, marked detached, label still passed through", async () => {
    const { shell, asked } = harness("detached", false);
    await expect(shell.confirm("Send?", { approveLabel: "Create issue" })).resolves.toBe(true);
    expect(asked).toEqual([{ message: "Send?", detached: true, label: "Create issue" }]);
  });

  it("NO PERMIT: no dialog is opened at all, and the answer is no", async () => {
    // A job detached without having been resumed for this confirm. A dialog must never appear
    // unasked on someone doing something else, and "no dialog" can only mean "not approved".
    const { shell, asked } = harness("none", false);
    await expect(shell.confirm("Send?")).resolves.toBe(false);
    expect(asked).toEqual([]);
  });

  it("a YES given to a job that was cancelled while its dialog was up is not a yes", async () => {
    // The queue cannot take a request back, so a dialog can outlive its job being cancelled
    // from the pill. The real shell answers true here; the job's shell does not pass it on.
    for (const permit of ["attached", "detached"] as const) {
      const live = harness(permit, permit === "attached", false);
      await expect(live.shell.confirm("Send?"), permit).resolves.toBe(true);
      const cancelled = harness(permit, permit === "attached", true);
      await expect(cancelled.shell.confirm("Send?"), permit).resolves.toBe(false);
      expect(cancelled.asked.length).toBe(1); // the dialog WAS shown; its yes was discarded
    }
  });

  it("a detached job cannot ask a question, open the bar, or act on the screen", async () => {
    const { shell } = harness("none", false);
    await expect(shell.askUser("Which channel?")).resolves.toBeNull();
    await expect(shell.showInput()).resolves.toBe("");
    for (const action of [
      { kind: "openUrl", payload: "https://example.com" },
      { kind: "copyToClipboard", payload: "x" },
      { kind: "openApp", payload: "notepad" },
      { kind: "mediaKey", payload: "mute" },
    ] as const) {
      const result = await shell.executeAction(action);
      expect(result.ok, action.kind).toBe(false);
    }
    // Speech is accepted and dropped — silence is a supported state, not a failure.
    await expect(shell.executeAction({ kind: "speak", payload: "hello" })).resolves.toEqual({ ok: true });
  });
});
