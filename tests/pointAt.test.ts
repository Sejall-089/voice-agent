import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry, findTool } from "../src/core/registry.ts";
import { pointAtTool } from "../src/core/tools/pointAt.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { screenCaptureError, visionError } from "../src/core/errors.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeScreen, RECON_SHOT } from "./FakeScreen.ts";
import { FakeVisionLocator, VISION } from "./FakeVisionLocator.ts";
import type {
  CapturedContext,
  LocateResult,
  Memory,
  ToolChoice,
  ToolInput,
} from "../src/core/types.ts";

// The pointing flow end to end through the planner (M15), against fakes: no screen is captured,
// no image is sent anywhere, and no electron window is created.
//
// The assertion that appears in almost every case below is `screen.pointed` being EMPTY. That is
// the milestone's one safety property written down: an answer the deterministic gate does not
// trust must never become a marker, because the user clicks what we point at.

const NO_CONTEXT: CapturedContext = {
  selectedText: null,
  activeApp: null,
  activeWindowTitle: null,
};

const TARGET = "the send button";

function choice(target: string = TARGET): ToolChoice {
  return { kind: "tool", name: "pointAt", input: { target } };
}

interface Wiring {
  answer?: LocateResult | LocateResult[];
  visionFails?: Error;
  screen?: FakeScreen;
  memory?: Memory;
  choice?: ToolChoice;
}

function setup(wiring: Wiring = {}) {
  const shell = new MockShell({ context: NO_CONTEXT });
  const log = new InMemoryActionLog();
  const screen = wiring.screen ?? new FakeScreen();
  const vision = wiring.visionFails
    ? FakeVisionLocator.failing(wiring.visionFails)
    : new FakeVisionLocator(wiring.answer ?? VISION["sendButton"]!);
  const llm = new FakeLLM(wiring.choice ?? choice());

  // Six `undefined`s, and they are load-bearing rather than lazy: `screen` and `vision` are the
  // twelfth and thirteenth constructor parameters, so everything optional between the log and
  // them has to be named to reach them. Written out once, here, instead of in every test.
  //
  // This is the cost of the deferred options-object refactor, honestly paid. It is not a silent
  // hazard — the surfaces are structurally different types, so miscounting the gaps is a
  // compile error rather than a calendar arriving where a screen belongs — but it is the
  // clearest argument in the codebase for making that change next.
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: false, vision: true }),
    wiring.memory ?? new NoopMemoryResolver(),
    log,
    undefined, // sender
    undefined, // gmail
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech store
    screen,
    vision,
  );
  return { shell, log, screen, vision, planner };
}

describe("pointing at something", () => {
  it("captures, asks, and draws the marker where the answer says", async () => {
    const { planner, screen, vision, shell } = setup();

    const outcome = await planner.run("where's the send button?");

    expect(outcome.status).toBe("ok");
    expect(screen.captures).toBe(1);
    // The captured frame and the user's own words both reached the model.
    expect(vision.asked).toEqual([{ target: TARGET, shot: RECON_SHOT }]);
    // Image pixels {1200,100,120,40} on a 1568x882 frame of a 1280x720 display, mapped to DIP.
    // Hand-computed in tests/visionGeometry.test.ts — repeated here as a literal so a mapping
    // regression fails in the flow test too, not only in the unit that owns it.
    expect(screen.pointed).toEqual([
      { rect: { x: 980, y: 82, width: 98, height: 32 }, label: "Send" },
    ]);
    expect(outcome.result).toBe(`Pointing at "Send" — the top right of your screen.`);
    expect(shell.results).toEqual([`Pointing at "Send" — the top right of your screen.`]);
  });

  it("announces that it is about to look, before it looks", async () => {
    // `caution` narration, and here it is doing real work rather than ceremony: this is the
    // first capability in the app that sends a picture of the user's screen off the machine, so
    // the announcement is the thing that makes it observable at the moment it happens.
    const { planner, shell } = setup();
    await planner.run("where's the send button?");

    expect(shell.actions).toEqual([
      { kind: "notify", payload: `Looking at your screen to find ${TARGET}…` },
    ]);
    expect(shell.spoken[0]).toMatch(/Looking at your screen to find the send button/);
    // Never a confirm dialog — a yes/no in front of every "where is X" would make the one thing
    // this is for unusable.
    expect(shell.confirmMessages).toEqual([]);
  });

  it("narrates even when the capture then fails, so the order is provable", async () => {
    // If narration happened after the capture, a failed capture would leave the user with an
    // error about a screenshot they were never told was being taken.
    const screen = new FakeScreen({ failCapture: screenCaptureError("no-display") });
    const { planner, shell } = setup({ screen });

    await planner.run("where's the send button?");

    expect(shell.actions).toEqual([
      { kind: "notify", payload: `Looking at your screen to find ${TARGET}…` },
    ]);
  });

  it("speaks the answer, so it works without looking at the marker", async () => {
    const { planner, shell } = setup();
    await planner.run("where's the send button?");
    // The marker is the disposable channel; the sentence is the durable one (spec §4d).
    expect(shell.spoken.some((line) => /top right of your screen/.test(line))).toBe(true);
  });
});

describe("refusing rather than guessing", () => {
  it("says so when the thing is not on screen, and points at nothing", async () => {
    const { planner, screen, log, shell } = setup({ answer: VISION["notFound"]! });

    const outcome = await planner.run("where's the send button?");

    expect(screen.pointed).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(shell.results).toEqual([
      `I couldn't find "the send button" on your screen — there's no browser window open.`,
    ]);
    // `refused`, not `no_tool`: spec §8 defines the miss list as a ranked backlog of tools worth
    // building, and "it isn't on your screen" is not a missing tool. Same distinction M9 drew
    // for a truncated model response.
    expect(log.misses).toEqual([]);
    expect(log.entries.at(-1)?.status).toBe("refused");
  });

  it("names the candidates when several match, instead of picking one", async () => {
    const { planner, screen, shell } = setup({ answer: VISION["ambiguous"]! });

    const outcome = await planner.run("where's the send button?");

    expect(screen.pointed).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe(
      `I can see more than one thing that could be "the send button": Send and Send later. ` +
        `Which one?`,
    );
  });

  it("refuses the hedge — a box covering the whole screen", async () => {
    const { planner, screen, shell } = setup({ answer: VISION["wholeScreen"]! });

    const outcome = await planner.run("where's the send button?");

    expect(screen.pointed).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toMatch(/doesn't look right/);
  });

  it("refuses coordinates that are in the wrong pixel space", async () => {
    // The likeliest real coordinate bug: an answer in the 1920x1080 native capture against the
    // 1568x882 frame we actually sent. Without the bounds check this is a confident marker in
    // the wrong place — the exact failure the milestone is designed around.
    const { planner, screen } = setup({ answer: VISION["nativeCoordinates"]! });

    const outcome = await planner.run("where's the close button?");

    expect(screen.pointed).toEqual([]);
    expect(outcome.status).toBe("refused");
  });

  it("refuses a small icon end to end, with a message distinct from 'not found'", async () => {
    // M15.1: proves the size gate fires through the WHOLE tool, not just the pure function
    // tests/visionLocate.test.ts already covers. The model here answers cleanly — in-frame,
    // sensibly labelled, tight box — exactly the shape of answer every OTHER check in
    // core/vision/locate.ts would pass. Only SMALL_TARGET_PX catches it.
    const { planner, screen, shell } = setup({
      answer: VISION["smallIcon"]!,
      choice: { kind: "tool", name: "pointAt", input: { target: "the settings icon" } },
    });

    const outcome = await planner.run("where's the settings icon?");

    expect(screen.pointed).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe(
      `I can see something that's probably "the settings icon", but it's small enough on ` +
        `screen that I can't point at it reliably — you may need to find it and click it yourself.`,
    );
    // The distinction the task cares about: this reads as "it's there, but I can't trust my
    // aim" — never as "I couldn't find it", which is a different fact with a different fix
    // (rephrase vs. just click it yourself).
    expect(shell.results[0]).not.toContain("couldn't find");
  });
});

describe("when the machinery itself is unavailable", () => {
  it("explains a screen that cannot be captured, and never asks the model", async () => {
    const screen = new FakeScreen({ failCapture: screenCaptureError("no-display") });
    const { planner, vision, shell } = setup({ screen });

    const outcome = await planner.run("where's the send button?");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toMatch(/couldn't get a picture of your screen/);
    // Nothing was sent anywhere, because there was nothing to send.
    expect(vision.asked).toEqual([]);
  });

  it("explains an unreachable model without blaming the screen", async () => {
    const { planner, screen, shell } = setup({
      visionFails: visionError("unreachable", "connect ETIMEDOUT"),
    });

    const outcome = await planner.run("where's the send button?");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toBe(
      "I couldn't reach Anthropic to look at your screen: connect ETIMEDOUT",
    );
    expect(screen.pointed).toEqual([]);
  });

  it("names the right key when the Anthropic one is missing", async () => {
    // The planner may be running perfectly well on OPENAI_API_KEY, so "the API key is missing"
    // would read as obviously false. This is M13's insufficient-scope lesson: a message that
    // sends someone to fix the wrong thing is worse than a vague one.
    const { planner, shell } = setup({ visionFails: visionError("no-key") });

    await planner.run("where's the send button?");

    expect(shell.results[0]).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses through the unavailable defaults when nothing is wired up at all", async () => {
    // The second line of defence: in the running app `pointAt` is not even on the menu without
    // VISION_ENABLED, but a planner built without the surfaces must still refuse honestly rather
    // than throw something shaped like a crash.
    const shell = new MockShell({ context: NO_CONTEXT });
    const planner = new Planner(
      new FakeLLM(choice()),
      shell,
      [pointAtTool],
      new NoopMemoryResolver(),
      new InMemoryActionLog(),
    );

    const outcome = await planner.run("where's the send button?");

    expect(outcome.status).toBe("refused");
    expect(shell.results[0]).toContain("VISION_ENABLED=1");
  });
});

describe("how the tool is wired", () => {
  it("is only on the menu when vision is turned on", () => {
    const off = buildRegistry({ gmail: false }).map((t) => t.name);
    const on = buildRegistry({ gmail: false, vision: true }).map((t) => t.name);

    expect(off).not.toContain("pointAt");
    expect(on).toContain("pointAt");
    // Still resolvable by name, so a model that names it on an install where it is off gets a
    // graceful refusal rather than a hallucinated-tool path.
    expect(findTool("pointAt")).toBe(pointAtTool);
  });

  it("keeps memory away from the target", async () => {
    // `target` is a literal description of something visible, not a reference to look up.
    // Resolution would rewrite "my inbox" into a URL and then hunt the screen for it.
    const resolved: ToolInput[] = [];
    // A real subclass, not a spread of one: `NoopMemoryResolver`'s methods live on the
    // prototype, so `{...new NoopMemoryResolver()}` copies nothing at all.
    class SpyMemory extends NoopMemoryResolver {
      override resolveArgs(input: ToolInput): Promise<ToolInput> {
        resolved.push(input);
        return super.resolveArgs(input);
      }
    }
    const spy: Memory = new SpyMemory();
    const { planner } = setup({ memory: spy, choice: choice("my inbox") });

    await planner.run("point at my inbox");

    expect(pointAtTool.resolvesReferences).toBe(false);
    expect(resolved).toEqual([]);
  });

  it("is caution, and declares only that", () => {
    // Not `reversible`: the overlay is undoable, but a screenshot that has left the machine is
    // not, and the tier describes the worse half. Not `dangerous`: nothing reaches anyone else.
    expect(pointAtTool.risk).toBe("caution");
    expect(pointAtTool.narrate).toBeTypeOf("function");
    expect(pointAtTool.confirmSummary).toBeUndefined();
  });

  it("asks for the target and nothing else", () => {
    expect(pointAtTool.inputSchema.required).toEqual(["target"]);
    expect(Object.keys(pointAtTool.inputSchema.properties)).toEqual(["target"]);
  });

  it("complains usefully when the model passes an empty target", async () => {
    const { planner, screen, shell } = setup({ choice: { kind: "tool", name: "pointAt", input: { target: "   " } } });

    const outcome = await planner.run("point at");

    // An empty required argument is a malfunction of the call, not a state of the world — so
    // this is an error, not a refusal.
    expect(outcome.status).toBe("error");
    expect(shell.results[0]).toContain("Tell me what to look for");
    expect(screen.pointed).toEqual([]);
  });
});

describe("what gets recorded", () => {
  it("logs the words and the answer, and no image", async () => {
    // The privacy claim in one assertion: the screenshot exists for the duration of the handler
    // and reaches nothing durable. The action log is the only thing in this app that persists a
    // record of what happened, and it must hold text.
    const { planner, log } = setup();

    await planner.run("where's the send button?");

    const entry = log.entries.at(-1);
    expect(entry?.tool).toBe("pointAt");
    expect(entry?.arguments).toEqual({ target: TARGET });
    expect(entry?.result).toBe(`Pointing at "Send" — the top right of your screen.`);

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("png");
    expect(serialized.length).toBeLessThan(400);
  });
});
