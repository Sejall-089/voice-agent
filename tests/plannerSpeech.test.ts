import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { InMemorySpeechStore } from "../src/core/speechStore.ts";
import { UserFixableError } from "../src/core/errors.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import type { SpeechStore } from "../src/core/speechStore.ts";
import type { CapturedContext, Tool } from "../src/core/types.ts";

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

// M14 task 3: the planner saying what it shows.
//
// The whole speech POLICY lives in planner.ts and core/speech.ts, so all of it is provable here
// with no synthesizer, no audio device and no electron — which is the point of making speech a
// LocalAction the core requests rather than a side effect the shell performs behind it.
//
// What is NOT proved here, and cannot be: that any of these strings survive the trip through a
// real engine. That is step 5's live run.

function probe(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "probe",
    description: "test double",
    inputSchema: { type: "object", properties: {}, required: [] },
    risk: "safe",
    handler: () => Promise.resolve("Done."),
    ...overrides,
  };
}

function run(tool: Tool, confirms: boolean[] = [], speech: SpeechStore = new InMemorySpeechStore()) {
  const shell = new MockShell({ context: NO_CONTEXT, confirms });

  // One ordered record of everything that reached the user, so "before" and "after" are
  // assertable rather than assumed.
  const timeline: string[] = [];
  const action = shell.executeAction.bind(shell);
  shell.executeAction = async (a) => {
    timeline.push(a.kind === "speak" ? `speak:${a.payload}` : `action:${a.kind}`);
    return action(a);
  };
  const confirm = shell.confirm.bind(shell);
  shell.confirm = async (message) => {
    timeline.push("confirm");
    return confirm(message);
  };
  const show = shell.showResult.bind(shell);
  shell.showResult = (text) => {
    timeline.push("show");
    show(text);
  };

  const log = new InMemoryActionLog();
  const planner = new Planner(
    new FakeLLM({ kind: "tool", name: "probe", input: {} }),
    shell,
    [tool],
    new NoopMemoryResolver(),
    log,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    speech,
  );
  return { planner, shell, log, timeline };
}

describe("the planner says what it shows", () => {
  it("speaks a result once, after showing it", async () => {
    const { planner, shell, timeline } = run(probe());

    await planner.run("do the thing");

    expect(shell.spoken).toEqual(["Done."]);
    // The screen first: it is instant, and speech is the slow channel.
    expect(timeline).toEqual(["show", "speak:Done."]);
  });

  it("narrates then speaks, in that order, for a caution tool", async () => {
    const tool = probe({ risk: "caution", narrate: () => "Opening the reply box…" });
    const { planner, shell, timeline } = run(tool);

    await planner.run("reply to that");

    expect(shell.actions).toEqual([
      { kind: "notify", payload: "Opening the reply box…" },
    ]);
    expect(timeline).toEqual([
      "action:notify",
      "speak:Opening the reply box.",
      "show",
      "speak:Done.",
    ]);
  });

  it("speaks the question BEFORE the dialog opens", async () => {
    // Once showMessageBox is up it owns the user's attention. A question asked after the thing
    // it is about has appeared is not a question.
    const tool = probe({
      risk: "dangerous",
      confirmSummary: () => "Send this reply to alex@example.com?\n\nHi Alex, Thursday works.",
    });
    const { planner, timeline } = run(tool, [true]);

    await planner.run("send it");

    expect(timeline.indexOf("speak:Send this reply to alex@example.com? Check the dialog.")).toBe(
      timeline.indexOf("confirm") - 1,
    );
  });

  it("never speaks the draft body at the confirm gate", async () => {
    const tool = probe({
      risk: "dangerous",
      confirmSummary: () => "Send this reply to alex@example.com?\n\nHi Alex, Thursday works.",
    });
    const { planner, shell } = run(tool, [true]);

    await planner.run("send it");

    expect(shell.spoken.join(" ")).not.toContain("Thursday");
  });

  it("says nothing further when the confirm is declined", async () => {
    const tool = probe({ risk: "dangerous", confirmSummary: () => "Send it?" });
    const { planner, shell } = run(tool, [false]);

    const outcome = await planner.run("send it");

    expect(outcome.status).toBe("cancelled");
    // The question was asked out loud; the answer was no, and nothing else is said about it.
    expect(shell.spoken).toEqual(["Send it?"]);
  });

  it("speaks a refusal — an honest no is an answer, not a silence", async () => {
    const tool = probe({
      handler: () => Promise.reject(new UserFixableError("I'm not connected to your calendar.")),
    });
    const { planner, shell } = run(tool);

    const outcome = await planner.run("what's on today");

    expect(outcome.status).toBe("refused");
    expect(shell.spoken).toEqual(["I'm not connected to your calendar."]);
  });

  it("speaks a failure too", async () => {
    const tool = probe({ handler: () => Promise.reject(new Error("the tab vanished")) });
    const { planner, shell } = run(tool);

    await planner.run("do the thing");

    expect(shell.spoken).toEqual(["Something went wrong: the tab vanished."]);
  });

  it("prefers the tool's own spoken form when it has one", async () => {
    const tool = probe({
      handler: () => Promise.resolve("• a\n• b\n• c"),
      speakResult: () => ({ text: "Three things.", remainder: "a. b. c." }),
    });
    const { planner, shell } = run(tool);

    await planner.run("what's on");

    expect(shell.spoken).toEqual(["Three things."]);
    // ...and the screen still gets the full list, untouched.
    expect(shell.results).toEqual(["• a\n• b\n• c"]);
  });

  it("holds the remainder so 'read them out' has something to answer with", async () => {
    const speech = new InMemorySpeechStore();
    const tool = probe({
      handler: () => Promise.resolve("Head."),
      speakResult: () => ({ text: "Head.", remainder: "The rest." }),
    });
    const { planner } = run(tool, [], speech);

    await planner.run("what's on");

    expect(speech.take()).toBe("The rest.");
  });

  it("clears a stale remainder when the next answer withholds nothing", async () => {
    // Otherwise "read them out" would answer with the list from two instructions ago.
    const speech = new InMemorySpeechStore();
    speech.hold("yesterday's leftovers");
    const { planner } = run(probe(), [], speech);

    await planner.run("do the thing");

    expect(speech.take()).toBeNull();
  });

  it("stays silent rather than speaking an empty utterance", async () => {
    // The real engine exits non-zero on empty input, so "there was nothing to say" must not
    // become an error in the log.
    const tool = probe({ handler: () => Promise.resolve("   ") });
    const { planner, shell } = run(tool);

    await planner.run("do the thing");

    expect(shell.spoken).toEqual([]);
  });

  it("fails the run when a tool cannot say its own result", async () => {
    // Same rule narrate and confirmSummary already follow: if we cannot describe what happened,
    // that is a failure, not something to paper over.
    const tool = probe({
      speakResult: () => {
        throw new Error("speakResult blew up");
      },
    });
    const { planner, shell } = run(tool);

    const outcome = await planner.run("do the thing");

    expect(outcome.status).toBe("error");
    expect(shell.results).toEqual(["Something went wrong: speakResult blew up"]);
  });
});
