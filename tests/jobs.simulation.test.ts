import { describe, expect, it } from "vitest";
import { EXPIRED, EXPIRY_MS } from "../src/core/jobs/messages.ts";
import { InMemorySettings } from "../src/core/settings.ts";
import type { PillView } from "../src/core/jobs/pill.ts";
import type { Tool } from "../src/core/types.ts";
import { PillController } from "../src/main/pill/PillController.ts";
import { deferred, jobWorld, plan, settle, tool } from "./jobWorld.ts";

// A SCRIPTED, HEADLESS RUN OF THE WHOLE THING (M23): three jobs alive at once — one that never
// needs anybody, one that reaches a risky step, one that reaches a tool that needs the screen
// — with the real JobManager, JobRunner, Planner, confirm queue, PillController and Chime, over
// MockShell and a fake clock. No window, no sound, no model.
//
// It asserts what a person would be able to tell afterwards: how each job ended, how many
// times the chime played, what the pill showed along the way, which dialogs were put on
// screen, which handlers actually ran, and every row the action log holds.

describe("three concurrent jobs, start to finish", () => {
  it("one finishes alone, one is approved from the pill, one expires unanswered", async () => {
    const ran: string[] = [];
    const hold = deferred();
    const make = (name: string, over: Partial<Tool>): Tool => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "safe",
      background: "ok",
      handler: (): Promise<string> => {
        ran.push(name);
        return Promise.resolve(`${name} result`);
      },
      ...over,
    });
    const tools: Tool[] = [
      make("gather", {
        handler: async (): Promise<string> => {
          ran.push("gather");
          await hold.promise; // held, so all three jobs are mid-flight together
          return "gathered";
        },
      }),
      make("post", {
        risk: "dangerous",
        confirmLabel: "Post",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        confirmSummary: (input): string => `Post "${String(input["text"])}"?`,
        handler: (input): Promise<string> => {
          ran.push("post");
          return Promise.resolve(`Posted ${String(input["text"])}.`);
        },
      }),
      make("onScreen", { background: "foreground-only" }),
    ];

    const w = jobWorld({
      script: {
        "just gather": tool("gather"),
        "gather then post": plan({ tool: "gather" }, { tool: "post", arguments: { text: "{step1}" } }),
        "gather then act on screen": plan({ tool: "gather" }, { tool: "onScreen" }),
      },
      tools,
      shell: { holdConfirm: true },
    });
    const views: PillView[] = [];
    const sound = { chimes: 0 };
    const pill = new PillController({
      manager: w.manager,
      settings: new InMemorySettings(),
      surface: { render: (view) => void views.push(view) },
      playChime: () => (sound.chimes += 1),
      isBusy: () => false,
      now: () => w.clock.now,
    });
    const shown = (): PillView | undefined => views[views.length - 1];

    // --- Three instructions, one after another; then the user starts typing a fourth. ---
    const alone = w.run("just gather");
    const risky = w.run("gather then post");
    const screen = w.run("gather then act on screen");
    await settle();
    w.manager.detachAttached("hotkey");
    await settle();

    // All three are executing at once, each inside its first handler.
    expect(ran).toEqual(["gather", "gather", "gather"]);
    expect(["job1", "job2", "job3"].map((id) => w.manager.get(id)?.state)).toEqual(["running", "running", "running"]);
    expect(shown()).toMatchObject({ mode: "running", label: "3 running" });
    expect(sound.chimes).toBe(0);

    // --- The first steps finish. ---
    hold.resolve();
    await alone;
    await settle();

    expect(w.manager.get("job1")).toMatchObject({ state: "done" });
    expect(w.manager.get("job2")).toMatchObject({ state: "needs-you", waitingFor: "confirm", tool: "post" });
    expect(w.manager.get("job3")).toMatchObject({ state: "needs-you", waitingFor: "foreground-only", tool: "onScreen" });
    // Two jobs started waiting in the same moment: ONE chime.
    expect(sound.chimes).toBe(1);
    // RE-JUSTIFIED AT M27: it pinned "2 need you", which hid job1 — done in the background and,
    // since M26, kept until seen. That was M26's third live finding. The colour is still amber.
    expect(shown()).toMatchObject({ mode: "needs-you", label: "2 need you · 1 done", pulse: true });
    // Nobody was asked anything, and nothing risky or on-screen ran.
    expect(w.shell.confirmMessages).toEqual([]);
    expect(ran).toEqual(["gather", "gather", "gather"]);

    // --- The user opens the pill and reviews the risky one. ---
    w.clock.now += 5 * 60 * 1000;
    pill.tick();
    expect(shown()).toMatchObject({ mode: "needs-you", pulse: false }); // steady amber by now
    pill.onAction("job2", "review");
    await settle();
    // The native dialog, with the real argument from step 1, as a detached dialog.
    expect(w.shell.confirmMessages).toEqual(['Step 2 of 2: Post "gathered"?']);
    expect(w.shell.confirmDetached).toEqual([true]);
    expect(w.shell.confirmLabels).toEqual(["Post"]);
    expect(ran).not.toContain("post"); // the click approved nothing

    w.shell.answerConfirm(true);
    await risky;
    expect(ran).toEqual(["gather", "gather", "gather", "post"]);
    expect(w.manager.get("job2")).toMatchObject({ state: "done", result: "Posted gathered." });

    // --- Nobody comes back for the third. ---
    w.clock.now += EXPIRY_MS;
    pill.tick();
    await screen;

    // FINAL STATES.
    expect(["job1", "job2", "job3"].map((id) => w.manager.get(id)?.state)).toEqual(["done", "done", "expired"]);
    // The foreground-only tool NEVER ran.
    expect(ran).toEqual(["gather", "gather", "gather", "post"]);
    // CHIME COUNT: one, for the whole run. Not for the two that finished, not for the expiry.
    expect(sound.chimes).toBe(1);
    // One dialog was ever on screen, and never two at once.
    expect(w.shell.confirmMessages.length).toBe(1);
    expect(w.shell.maxOpenConfirms).toBe(1);
    // The expired job stays in the pill until dismissed.
    expect(shown()).toMatchObject({ mode: "failed" });
    expect(shown()?.items.find((item) => item.id === "job3")?.actions).toEqual(["dismiss"]);
    // No detached job ever put a result in the bar.
    expect(w.shell.results).toEqual([]);

    // ACTION-LOG ROWS, all of them, in order: which job, which tool, how it ended, and whether
    // the job was detached when it wrote the row.
    expect(w.log.entries.map((row) => [row.jobId, row.tool, row.status, row.detached])).toEqual([
      ["job1", "gather", "ok", true],
      ["job2", "gather", "ok", true],
      ["job3", "gather", "ok", true],
      ["job2", "post", "ok", true],
      ["job3", "onScreen", "expired", true],
    ]);
    expect(w.log.entries[3]?.arguments).toEqual({ text: "gathered" });
    expect(w.log.entries[4]?.result).toBe(EXPIRED);
    // And none of those rows is anybody's "previous turn".
    expect(w.log.getLast()).toBeNull();

    // The status answer, from the same records. job1 ended thirty-five minutes ago by this
    // clock, so "are my agents done yet" no longer mentions it; the other two it does.
    expect(w.manager.list().map((job) => [job.id, job.state])).toEqual([
      ["job2", "done"],
      ["job3", "expired"],
    ]);
  });
});
