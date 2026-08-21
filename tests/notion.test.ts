import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { InMemoryDraftStore } from "../src/core/draft.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { UnavailableGmail } from "../src/core/gmail/UnavailableGmail.ts";
import { UnavailableNotion } from "../src/core/notion/UnavailableNotion.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, NotionSurface, ToolChoice } from "../src/core/types.ts";
import { FakeNotion } from "./FakeNotion.ts";
import { FakeLLM } from "./FakeLLM.ts";

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// Same idea as gmail.test.ts's TimelineShell: a shared ordering log so "narration went out
// before appendToPage ran" can be asserted as a sequence fact, not inferred.
class TimelineShell extends MockShell {
  private readonly timeline: string[];

  constructor(context: CapturedContext, confirms: boolean[], timeline: string[]) {
    super({ context, confirms });
    this.timeline = timeline;
  }

  override executeAction(action: Parameters<MockShell["executeAction"]>[0]) {
    this.timeline.push(`shell:${action.kind}`);
    return super.executeAction(action);
  }
}

// The same wiring the app uses, with Chrome, the LLM, and the shell swapped for test doubles.
function harness(options: {
  choice: ToolChoice;
  completion?: string;
  notion?: NotionSurface;
  confirms?: boolean[];
  timeline?: string[];
  context?: CapturedContext;
}) {
  const context = options.context ?? NO_CONTEXT;
  const shell =
    options.timeline === undefined
      ? new MockShell({ context, confirms: options.confirms ?? [] })
      : new TimelineShell(context, options.confirms ?? [], options.timeline);
  const llm = new FakeLLM(options.choice, options.completion ?? "ADDED NOTE TEXT");
  const log = new InMemoryActionLog();
  const notion = options.notion ?? new FakeNotion();
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: false, notion: true }),
    new NoopMemoryResolver(),
    log,
    undefined,
    new UnavailableGmail(),
    new InMemoryDraftStore(),
    notion,
  );
  return { shell, llm, log, notion, planner };
}

function addChoice(instruction = "note that the launch moved to Friday"): ToolChoice {
  return { kind: "tool", name: "addToPage", input: { instruction } };
}

describe("addToPage (M11)", () => {
  it("reads the open page, composes, and appends the result", async () => {
    const notion = new FakeNotion();
    const { planner, log, shell } = harness({ choice: addChoice(), notion });

    const outcome = await planner.run("note that the launch moved to Friday");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("addToPage");
    expect(notion.appended).toEqual(["ADDED NOTE TEXT"]);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "addToPage" });
    // caution, not dangerous: no confirm dialog.
    expect(shell.confirmMessages).toHaveLength(0);
  });

  it("narrates what it is about to do, naming the page, BEFORE it touches Notion", async () => {
    // narrate() itself does a SAFE read (to name the page), so "notion:readOpenPage" can
    // legitimately be the very first timeline entry — that isn't a mutation. What actually
    // matters, and what this asserts, is that the narration reaches the user BEFORE the
    // MUTATING call (appendToPage) ever happens.
    const timeline: string[] = [];
    const notion = new FakeNotion({ timeline });
    const { planner, shell } = harness({ choice: addChoice(), notion, timeline });

    await planner.run("note that the launch moved to Friday");

    const narration = shell.actions.find((action) => action.kind === "notify");
    expect(narration?.payload).toMatch(/adding a note to "Launch plan"/i);
    const notifyIndex = timeline.indexOf("shell:notify");
    const appendIndex = timeline.indexOf("notion:appendToPage");
    expect(notifyIndex).toBeGreaterThanOrEqual(0);
    expect(appendIndex).toBeGreaterThan(notifyIndex);
  });

  it("appends nothing when composing fails, so a model failure leaves the page untouched", async () => {
    const notion = new FakeNotion();
    // An empty completion is composeNote's failure case.
    const { planner } = harness({ choice: addChoice(), completion: "   ", notion });

    const outcome = await planner.run("add a note");

    expect(outcome.status).toBe("error");
    expect(notion.appended).toHaveLength(0);
  });

  it("refuses when no Notion page is open — and appends nothing", async () => {
    const notion = new FakeNotion({ openPage: null });
    const { planner } = harness({ choice: addChoice(), notion });

    const outcome = await planner.run("add a note");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toMatch(/no Notion page/i);
    expect(notion.calls).toEqual(["readOpenPage"]);
  });

  it("refuses without an instruction rather than inventing content", async () => {
    const notion = new FakeNotion();
    const { planner } = harness({
      choice: { kind: "tool", name: "addToPage", input: { instruction: "  " } },
      notion,
    });

    const outcome = await planner.run("add");

    expect(outcome.status).toBe("error");
    // narrate() still does its SAFE read to name the page before the handler discovers the
    // instruction is blank — that's a read, not a mutation. What must never happen is a write.
    expect(notion.appended).toHaveLength(0);
  });

  it("passes clipboard content through as material to draw on", async () => {
    const notion = new FakeNotion();
    const { planner, llm } = harness({
      choice: addChoice("turn this into a note"),
      notion,
      context: { selectedText: "Q3 revenue grew 12%.", activeApp: null, activeWindowTitle: null },
    });

    await planner.run("turn this into a note");

    expect(llm.lastUserPrompt).toContain("Q3 revenue grew 12%.");
  });

  it("explains itself when Chrome isn't configured at all", async () => {
    const { planner } = harness({ choice: addChoice(), notion: new UnavailableNotion() });

    const outcome = await planner.run("add a note");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toMatch(/CHROME_DEBUG_URL/);
  });

  it("is not even offered to the model when Chrome isn't configured", () => {
    const names = buildRegistry({ gmail: false }).map((tool) => tool.name);
    expect(names).not.toContain("addToPage");
    expect(buildRegistry({ gmail: false, notion: true }).map((t) => t.name)).toContain(
      "addToPage",
    );
  });

  it("has no revision tool — a follow-up tweak is an honest miss, not a silent edit", () => {
    const names = buildRegistry({ gmail: false, notion: true }).map((tool) => tool.name);
    expect(names).not.toContain("reviseNote");
    expect(names).toContain("addToPage");
  });

  it("names the page as 'the open Notion page' when the page has no title yet", async () => {
    const notion = new FakeNotion({
      openPage: { title: null, url: "https://notion.so/x", body: "" },
    });
    const { planner, shell } = harness({ choice: addChoice(), notion });

    await planner.run("add a note");

    const narration = shell.actions.find((action) => action.kind === "notify");
    expect(narration?.payload).toMatch(/the open Notion page/i);
  });
});
