import { describe, it, expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { InMemoryDraftStore } from "../src/core/draft.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { UnavailableGmail } from "../src/core/gmail/UnavailableGmail.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type { CapturedContext, GmailSurface, ToolChoice } from "../src/core/types.ts";
import { FakeGmail, sampleEmail } from "./FakeGmail.ts";
import { FakeLLM } from "./FakeLLM.ts";

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

// A MockShell that also writes into a shared ordering log, so "the narration went out before
// anything touched Gmail" can be asserted as a fact about sequence rather than inferred.
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

// The same wiring the app uses, with Chrome, the LLM and the shell swapped for test doubles.
// The planner, the registry, the risk gates and the tool handlers are all the real ones.
function harness(options: {
  choice: ToolChoice;
  completion?: string;
  gmail?: GmailSurface;
  confirms?: boolean[];
  draft?: InMemoryDraftStore;
  timeline?: string[];
}) {
  const shell =
    options.timeline === undefined
      ? new MockShell({ context: NO_CONTEXT, confirms: options.confirms ?? [] })
      : new TimelineShell(NO_CONTEXT, options.confirms ?? [], options.timeline);
  const llm = new FakeLLM(options.choice, options.completion ?? "DRAFTED REPLY");
  const log = new InMemoryActionLog();
  const gmail = options.gmail ?? new FakeGmail();
  const draft = options.draft ?? new InMemoryDraftStore();
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: true }),
    new NoopMemoryResolver(),
    log,
    undefined,
    gmail,
    draft,
  );
  return { shell, llm, log, gmail, draft, planner };
}

function draftChoice(instruction = "say I can't make Tuesday, propose Thursday"): ToolChoice {
  return { kind: "tool", name: "draftReply", input: { instruction } };
}

describe("draftReply (M10)", () => {
  it("reads the open email, opens the reply box, and puts the draft in it", async () => {
    const gmail = new FakeGmail();
    const { planner, log, shell } = harness({ choice: draftChoice(), gmail });

    const outcome = await planner.run("reply and say I can't make Tuesday");

    expect(outcome.status).toBe("ok");
    expect(outcome.tool).toBe("draftReply");
    expect(gmail.composeText).toBe("DRAFTED REPLY");
    expect(gmail.replyBoxOpened).toBe(1);
    expect(log.entries[0]).toMatchObject({ status: "ok", tool: "draftReply" });
    // Nothing was sent, and no confirm was asked for: drafting is `caution`, not `dangerous`.
    expect(gmail.sent).toBe(0);
    expect(shell.confirmMessages).toHaveLength(0);
  });

  it("narrates what it is about to do BEFORE it touches Gmail", async () => {
    // The whole point of the caution tier: there is no undo for opening someone's reply box, so
    // the announcement has to land first, not alongside the result.
    const timeline: string[] = [];
    const gmail = new FakeGmail({ timeline });
    const { planner, shell } = harness({ choice: draftChoice(), gmail, timeline });

    await planner.run("reply to this");

    const narration = shell.actions.find((action) => action.kind === "notify");
    expect(narration?.payload).toMatch(/drafting a reply/i);
    // The sequence itself, not just the fact that both happened: the notify is the FIRST event
    // in the shared log, ahead of every Gmail call.
    expect(timeline[0]).toBe("shell:notify");
    expect(timeline).toContain("gmail:openReplyBox");
  });

  it("writes the draft before opening the reply box, so a model failure leaves Gmail untouched", async () => {
    const gmail = new FakeGmail();
    // An empty completion is compose.ts's failure case.
    const { planner } = harness({ choice: draftChoice(), completion: "   ", gmail });

    const outcome = await planner.run("reply to this");

    expect(outcome.status).toBe("error");
    expect(gmail.replyBoxOpened).toBe(0);
    expect(gmail.composeText).toBeNull();
  });

  it("refuses when no email is open — and clicks nothing", async () => {
    const gmail = new FakeGmail({ openEmail: null });
    const { planner } = harness({ choice: draftChoice(), gmail });

    const outcome = await planner.run("reply to this");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toMatch(/No email is open/i);
    expect(gmail.calls).toEqual(["readOpenEmail"]);
  });

  it("refuses without an instruction rather than inventing a reply", async () => {
    const gmail = new FakeGmail();
    const { planner } = harness({
      choice: { kind: "tool", name: "draftReply", input: { instruction: "  " } },
      gmail,
    });

    const outcome = await planner.run("reply");

    expect(outcome.status).toBe("error");
    expect(gmail.calls).toHaveLength(0);
  });

  it("explains itself when Chrome isn't configured at all", async () => {
    const { planner } = harness({ choice: draftChoice(), gmail: new UnavailableGmail() });

    const outcome = await planner.run("reply to this");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toMatch(/CHROME_DEBUG_URL/);
  });

  it("is not even offered to the model when Chrome isn't configured", () => {
    const names = buildRegistry({ gmail: false }).map((tool) => tool.name);
    expect(names).not.toContain("draftReply");
    expect(names).not.toContain("sendReply");
    expect(buildRegistry({ gmail: true }).map((t) => t.name)).toContain("draftReply");
  });
});

describe("reviseDraft (M10)", () => {
  it("edits the draft that is already there instead of starting a new reply", async () => {
    const gmail = new FakeGmail({ composeText: "FIRST DRAFT" });
    const draft = new InMemoryDraftStore();
    draft.set({ text: "FIRST DRAFT", source: sampleEmail(), updatedAt: Date.now() });
    const { planner, llm } = harness({
      choice: { kind: "tool", name: "reviseDraft", input: { instruction: "make it shorter" } },
      completion: "SHORTER DRAFT",
      gmail,
      draft,
    });

    const outcome = await planner.run("make it shorter");

    expect(outcome.status).toBe("ok");
    expect(gmail.composeText).toBe("SHORTER DRAFT");
    // The load-bearing assertion: no SECOND reply box. A revision that re-opened one would
    // strand the first draft and quietly answer the original email twice.
    expect(gmail.replyBoxOpened).toBe(0);
    // The previous draft actually reached the model — otherwise "shorter" has no referent.
    expect(llm.lastUserPrompt).toContain("FIRST DRAFT");
    expect(llm.lastUserPrompt).toContain("make it shorter");
  });

  it("revises what the user hand-edited, not our stale copy of it", async () => {
    const gmail = new FakeGmail({ composeText: "TEXT THE USER EDITED THEMSELVES" });
    const draft = new InMemoryDraftStore();
    draft.set({ text: "WHAT WE WROTE", source: sampleEmail(), updatedAt: Date.now() });
    const { planner, llm } = harness({
      choice: { kind: "tool", name: "reviseDraft", input: { instruction: "make it warmer" } },
      gmail,
      draft,
    });

    await planner.run("make it warmer");

    expect(llm.lastUserPrompt).toContain("TEXT THE USER EDITED THEMSELVES");
    expect(llm.lastUserPrompt).not.toContain("WHAT WE WROTE");
  });

  it("refuses honestly when there is no draft to revise", async () => {
    const gmail = new FakeGmail();
    const { planner, log } = harness({
      choice: { kind: "tool", name: "reviseDraft", input: { instruction: "make it shorter" } },
      gmail,
    });

    const outcome = await planner.run("make it shorter");

    // `refused`, not `error`: nothing broke — there is genuinely nothing to change.
    expect(outcome.status).toBe("refused");
    expect(outcome.result).toMatch(/no reply draft/i);
    expect(gmail.calls).toHaveLength(0);
    expect(log.entries[0]).toMatchObject({ status: "refused" });
  });

  it("treats an expired draft as no draft at all", async () => {
    const draft = new InMemoryDraftStore(1); // 1ms TTL
    draft.set({ text: "OLD", source: sampleEmail(), updatedAt: Date.now() - 1000 });
    expect(draft.get()).toBeNull();

    const { planner } = harness({
      choice: { kind: "tool", name: "reviseDraft", input: { instruction: "shorter" } },
      draft,
    });

    expect((await planner.run("shorter")).status).toBe("refused");
  });
});

describe("sendReply (M10) — the dangerous tier", () => {
  const sendChoice: ToolChoice = { kind: "tool", name: "sendReply", input: {} };

  it("sends nothing when the confirm is declined", async () => {
    const gmail = new FakeGmail({ composeText: "READY TO GO" });
    const { planner, log } = harness({ choice: sendChoice, gmail, confirms: [false] });

    const outcome = await planner.run("send it");

    expect(outcome.status).toBe("cancelled");
    expect(gmail.sent).toBe(0);
    expect(log.entries[0]).toMatchObject({ status: "cancelled", tool: "sendReply" });
  });

  it("sends exactly once when confirmed", async () => {
    const gmail = new FakeGmail({ composeText: "READY TO GO" });
    const { planner } = harness({ choice: sendChoice, gmail, confirms: [true] });

    const outcome = await planner.run("send it");

    expect(outcome.status).toBe("ok");
    expect(gmail.sent).toBe(1);
  });

  it("shows the real recipient and the WHOLE draft in the confirm — not a preview", async () => {
    const body = "Thanks Alex — Tuesday doesn't work, but Thursday afternoon does.";
    const gmail = new FakeGmail({ composeText: body, recipients: "alex@example.com" });
    const { planner, shell } = harness({ choice: sendChoice, gmail, confirms: [false] });

    await planner.run("send it");

    expect(shell.confirmMessages[0]).toContain("alex@example.com");
    expect(shell.confirmMessages[0]).toContain(body);
  });

  it("never opens the dialog when there is nothing to send", async () => {
    const gmail = new FakeGmail({ composeText: null });
    const { planner, shell } = harness({ choice: sendChoice, gmail, confirms: [true] });

    const outcome = await planner.run("send it");

    expect(outcome.status).toBe("error");
    // A queued `true` was available and still nothing went out: the gate was never reached,
    // because we could not describe what would happen.
    expect(shell.confirmMessages).toHaveLength(0);
    expect(gmail.sent).toBe(0);
  });

  it("clears the draft after sending, so a later tweak cannot rewrite a delivered email", async () => {
    const gmail = new FakeGmail({ composeText: "READY TO GO" });
    const draft = new InMemoryDraftStore();
    draft.set({ text: "READY TO GO", source: sampleEmail(), updatedAt: Date.now() });
    const { planner } = harness({ choice: sendChoice, gmail, draft, confirms: [true] });

    await planner.run("send it");

    expect(draft.get()).toBeNull();
  });
});
