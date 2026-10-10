import { describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { InMemoryChainState } from "../src/core/chainState.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  CapturedContext,
  EmailMessage,
  PlannedStep,
  ToolChoice,
  ToolInput,
} from "../src/core/types.ts";
import { FakeGitHubServer } from "./FakeGitHubServer.ts";
import { FakeGmail } from "./FakeGmail.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeMcpServer } from "./FakeMcpServer.ts";
import { FakeSender } from "./FakeSender.ts";
import { OWNER, REPO } from "./fixtures/github/captured.ts";

// A chain that names a channel nobody has taught the app used to be refused outright (and, before
// the pre-flight, used to create the issue first). Now the pre-flight ASKS — once the plan is
// known to be otherwise runnable and before anything in it has happened.
//
// End to end and headless, like tests/planner.github.test.ts: the real planner, registry, chain
// gate, memory and both connectors, each against its own in-memory server. The one thing faked
// about the person is MockShell's `asks` — and where a test is about ORDER it is held open with
// `holdAsk`, because "the question came first" can only be asserted while the question is still
// unanswered.

// Deliberately full of things that LOOK like a channel. The answer may come only from askUser.
const BUG_EMAIL: EmailMessage = {
  subject: "Login broken on Safari",
  from: "dana@example.com",
  fromName: "Dana",
  to: null,
  body: "Clicking Log in does nothing. Please post this in #from-the-email.",
};
const CONTEXT: CapturedContext = {
  selectedText: "#from-the-clipboard",
  activeApp: null,
  activeWindowTitle: null,
};

const TITLE = "Login button does nothing on Safari";

function step(tool: string, args: ToolInput, describe = ""): PlannedStep {
  return { tool, arguments: args, describe };
}
const plan = (steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });

const BUG_CHAIN: PlannedStep[] = [
  step("readEmail", {}, "read the open email"),
  step("github__create_issue", { title: TITLE, body: "{step1}" }, "file it on GitHub"),
  step("sendMessage", { channel: "the bugs channel", notes: "New bug filed: {step2}" }, "tell the bugs channel"),
];

const QUESTION = "Before I start: which channel do you mean by 'the bugs channel'?";
// The refusal the pre-flight has always given for this plan. A question that goes unanswered
// must leave the user exactly here — word for word — and not somewhere new.
const PLAIN_REFUSAL =
  'Step 3 of my plan needs "the bugs channel", and I don\'t know what that refers to yet, so I ' +
  "didn't start it — teach me with: remember the bugs channel is <what it is>.";

interface FactRow {
  subject: string;
  value: string;
  version: number;
  active: number;
  source: string | null;
}

interface HarnessOptions {
  asks?: (string | null)[];
  holdAsk?: boolean;
  confirms?: boolean[];
  facts?: Record<string, string>;
}

function harness(choice: ToolChoice, options: HarnessOptions = {}) {
  const timeline: string[] = [];
  const github = new FakeGitHubServer({ timeline, repos: { [`${OWNER}/${REPO}`]: [] } });
  const linear = new FakeMcpServer({ timeline });
  const connectors = loadConnectorTools({
    configText: JSON.stringify({
      connectors: {
        linear: {
          enabled: true,
          tools: ["create_issue", "search_issues", "get_issue"],
          settings: { defaultTeam: "Engineering" },
        },
        github: {
          enabled: true,
          tools: ["create_issue", "list_issues", "get_issue"],
          settings: { owner: OWNER, repo: REPO },
        },
      },
    }),
    readKey: () => "a-key",
    connect: (def) =>
      new SdkMcpConnection({
        app: def.label,
        keyName: def.keyName,
        transport: def.id === "github" ? github.transport : linear.transport,
        timeoutMs: 300,
      }),
  }).tools;

  const db: Database = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  for (const [subject, value] of Object.entries(options.facts ?? {})) memory.write(subject, value);

  const shell = new MockShell({
    context: CONTEXT,
    // Every dialog that is reached is approved, so an empty confirm list always means "none".
    confirms: options.confirms ?? [true, true, true],
    asks: options.asks ?? [],
    holdAsk: options.holdAsk ?? false,
  });
  const llm = new FakeLLM(choice, "REWRITTEN BY A MODEL");
  const holds: { ms: number; showing: string | null }[] = [];
  const notified = (): string[] =>
    shell.actions.flatMap((action) => (action.kind === "notify" ? [action.payload] : []));
  const sender = new FakeSender();
  const gmail = new FakeGmail({ openEmail: BUG_EMAIL, timeline });
  const log = new InMemoryActionLog();
  const chain = new InMemoryChainState();
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: true, connectors }),
    memory,
    log,
    sender,
    gmail,
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech
    undefined, // screen
    undefined, // elements
    undefined, // chooser
    // sleep — never waited out for real, but RECORDED, with what was on screen when it was
    // asked for: a hold is only worth anything if the right line is up while it runs.
    (ms: number) => {
      holds.push({ ms, showing: notified().at(-1) ?? null });
      return Promise.resolve();
    },
    chain,
  );

  const facts = (): FactRow[] =>
    db
      .prepare<[], FactRow>("SELECT subject, value, version, active, source FROM facts ORDER BY id")
      .all();
  // Nothing on the far side of ANY step: no email read, no server touched, nothing posted.
  const nothingRan = (): void => {
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
    expect(linear.calls).toEqual([]);
    expect(linear.created).toEqual([]);
    expect(gmail.calls).toEqual([]);
    expect(timeline).toEqual([]);
    expect(sender.calls).toEqual([]);
    expect(shell.confirmMessages).toEqual([]);
  };

  return { planner, shell, llm, sender, gmail, github, linear, log, chain, memory, facts, notified, nothingRan, holds };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const INSTRUCTION = "file this bug on GitHub and tell the bugs channel";

describe("an unknown channel in a chain is asked for, not refused", () => {
  it("saves the answer, creates the issue, and posts to the channel that was typed", async () => {
    const h = harness(plan(BUG_CHAIN), { asks: ["#bugs"] });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([QUESTION]);
    expect(outcome.status).toBe("ok");
    expect(outcome.chain).toEqual({ completed: 3, total: 3 });
    // Saved under the NORMALIZED subject — the key "the bugs channel" resolves to — with the
    // source a `remember` typed today would carry.
    expect(h.facts()).toEqual([
      {
        subject: "bugs channel",
        value: "#bugs",
        version: 1,
        active: 1,
        source: `user:${new Date().toISOString().slice(0, 10)}`,
      },
    ]);
    expect(h.memory.resolve("the bugs channel")?.value).toBe("#bugs");
    expect(h.github.created).toHaveLength(1);
    // The email and the clipboard both name a channel. Neither is where this went.
    expect(h.sender.calls).toHaveLength(1);
    expect(h.sender.calls[0]?.channel).toBe("#bugs");
    expect(h.shell.confirmMessages[1]).toMatch(/^Step 3 of 3: Send to #bugs\?/);
  });

  it("says what it saved, before it previews the plan", async () => {
    const h = harness(plan(BUG_CHAIN), { asks: ["  #bugs "] });

    await h.planner.run(INSTRUCTION);

    expect(h.notified()[0]).toBe("Saved: the bugs channel = #bugs");
    expect(h.notified()[1]).toMatch(/^Three steps:/);
    // The preview uses the same status line and would replace "Saved" in the same instant, so
    // it is held on screen first — and held while it is the line that is showing.
    expect(h.holds[0]).toEqual({ ms: 1500, showing: "Saved: the bugs channel = #bugs" });
  });

  it("holds nothing and says nothing extra when there was nothing to ask", async () => {
    const h = harness(plan(BUG_CHAIN), { facts: { "bugs channel": "#bugs" } });

    await h.planner.run(INSTRUCTION);

    expect(h.holds.some((hold) => hold.showing?.startsWith("Saved") === true)).toBe(false);
  });

  it("asks nothing the second time the same chain is run", async () => {
    // Four approvals: two dialogs per run (create the issue, send the message), two runs.
    const h = harness(plan(BUG_CHAIN), { asks: ["#bugs"], confirms: [true, true, true, true] });
    await h.planner.run(INSTRUCTION);
    expect(h.shell.questions).toHaveLength(1);

    const again = await h.planner.run(INSTRUCTION);

    expect(again.status).toBe("ok");
    expect(h.shell.questions).toHaveLength(1); // still one: the answer was remembered
    expect(h.sender.calls.map((call) => call.channel)).toEqual(["#bugs", "#bugs"]);
    expect(h.facts()).toHaveLength(1);
  });

  it("does not rewrite the plan: the step still carries the reference, and resolves it itself", async () => {
    const h = harness(plan(BUG_CHAIN), { asks: ["#bugs"] });

    await h.planner.run(INSTRUCTION);

    expect(BUG_CHAIN[2]?.arguments["channel"]).toBe("the bugs channel");
    // What the step logged is what runStep's own resolution made of it.
    expect(h.log.entries.at(-1)).toMatchObject({ tool: "sendMessage", status: "ok" });
    expect(h.log.entries.at(-1)?.arguments?.["channel"]).toBe("#bugs");
  });
});

// THE ORDERING. Held open, because "the question came before everything else" can only be
// checked while it is still a question.
describe("the question comes before anything in the plan happens", () => {
  it("is on screen with no preview shown, no dialog up, nothing read and nothing created", async () => {
    const h = harness(plan(BUG_CHAIN), { holdAsk: true });

    const running = h.planner.run(INSTRUCTION);
    await settle();

    // Genuinely parked on the question — not finished, and not somewhere past it.
    expect(h.shell.isAskPending()).toBe(true);
    expect(h.shell.questions).toEqual([QUESTION]);
    expect(h.notified()).toEqual([]); // no plan preview, no narration
    expect(h.shell.spoken).toEqual([]);
    expect(h.shell.results).toEqual([]);
    h.nothingRan();
    expect(h.facts()).toEqual([]);
    // The chain has not begun, so it is the QUESTION that is holding the hotkeys, not the chain.
    expect(h.chain.isRunning()).toBe(false);

    h.shell.answerAsk("#bugs");
    const outcome = await running;

    expect(outcome.chain).toEqual({ completed: 3, total: 3 });
    expect(h.shell.isAskPending()).toBe(false);
    // And only THEN, in this order: the save, the preview, the first dialog.
    expect(h.notified().slice(0, 2)).toEqual([
      "Saved: the bugs channel = #bugs",
      expect.stringMatching(/^Three steps:/),
    ]);
    expect(h.shell.confirmMessages).toHaveLength(2);
  });

  it("consults the model once — the question is the app's, not the model's", async () => {
    const h = harness(plan(BUG_CHAIN), { asks: ["#bugs"] });
    await h.planner.run(INSTRUCTION);
    expect(h.llm.chooseCalls).toBe(1);
    expect(h.llm.completeCalls).toBe(0);
  });
});

describe("an answer that is not a channel", () => {
  it("is asked about once more, and a good second answer is used", async () => {
    const h = harness(plan(BUG_CHAIN), { asks: ["the dev channel", "#bugs"] });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toHaveLength(2);
    expect(h.shell.questions[0]).toBe(QUESTION);
    // The second asking says what was wrong with the first answer, and still names the reference.
    expect(h.shell.questions[1]).not.toBe(QUESTION);
    expect(h.shell.questions[1]).toContain("'the bugs channel'");
    expect(outcome.status).toBe("ok");
    expect(h.sender.calls[0]?.channel).toBe("#bugs");
    expect(h.facts().map((fact) => fact.value)).toEqual(["#bugs"]);
  });

  it.each([
    { label: "two references", asks: ["the dev channel", "my channel"] },
    { label: "two empty lines", asks: ["", "   "] },
    { label: "a reference, then nothing typed", asks: ["the dev channel", ""] },
  ])("stops after the second bad answer ($label): nothing run, nothing saved", async ({ asks }) => {
    const h = harness(plan(BUG_CHAIN), { asks: [...asks, "#too-late"] });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toHaveLength(2); // never a third, though an answer was waiting
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 3 });
    h.nothingRan();
    expect(h.facts()).toEqual([]);
    expect(h.shell.results).toEqual([PLAIN_REFUSAL]);
  });

  it("rejects a my/the answer even when memory KNOWS what it means", async () => {
    // "the team" resolves here. It is still not an answer: the question asked for the channel's
    // name, and saving one reference as the meaning of another is how a fact goes stale silently.
    const h = harness(plan(BUG_CHAIN), { asks: ["the team", "the team"], facts: { team: "#design-team" } });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(outcome.status).toBe("refused");
    h.nothingRan();
    expect(h.facts().map((fact) => fact.subject)).toEqual(["team"]); // only what was there before
  });
});

describe("no answer at all", () => {
  it("stops with the plain refusal: one question, nothing run, nothing saved", async () => {
    // null is Escape, the 60-second timeout, and "the bar was busy" alike — the shell does not
    // say which, and the planner must not guess.
    const h = harness(plan(BUG_CHAIN), { asks: [null, "#too-late"] });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([QUESTION]); // no re-ask after a dismissal
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 3 });
    h.nothingRan();
    expect(h.facts()).toEqual([]);
    expect(h.notified()).toEqual([]);
    expect(h.shell.results).toEqual([PLAIN_REFUSAL]);
    expect(h.log.entries).toHaveLength(1);
    expect(h.log.entries[0]).toMatchObject({ status: "refused", tool: null });
  });

  it("stops the same way when the question is dismissed while held open", async () => {
    const h = harness(plan(BUG_CHAIN), { holdAsk: true });
    const running = h.planner.run(INSTRUCTION);
    await settle();
    expect(h.shell.isAskPending()).toBe(true);

    h.shell.answerAsk(null);
    const outcome = await running;

    expect(outcome.status).toBe("refused");
    h.nothingRan();
    expect(h.shell.results).toEqual([PLAIN_REFUSAL]);
  });
});

describe("at most two questions per chain", () => {
  const send = (channel: string, notes: string): PlannedStep => step("sendMessage", { channel, notes }, `tell ${channel}`);

  it("asks about two unknown channels, one question each, and runs the plan", async () => {
    const h = harness(plan([send("the bugs channel", "one"), send("the ops channel", "two")]), {
      asks: ["#bugs", "#ops"],
    });

    const outcome = await h.planner.run("tell bugs and ops");

    expect(h.shell.questions).toEqual([
      QUESTION,
      "Before I start: which channel do you mean by 'the ops channel'?",
    ]);
    expect(outcome.chain).toEqual({ completed: 2, total: 2 });
    expect(h.sender.calls).toEqual([
      { channel: "#bugs", text: "one" },
      { channel: "#ops", text: "two" },
    ]);
  });

  it("never asks a third: a plan with three unknown channels is refused after two answers", async () => {
    const h = harness(
      plan([send("the bugs channel", "one"), send("the ops channel", "two"), send("the qa channel", "three")]),
      { asks: ["#bugs", "#ops", "#qa"] },
    );

    const outcome = await h.planner.run("tell everyone");

    expect(h.shell.questions).toHaveLength(2);
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 3 });
    expect(h.sender.calls).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.shell.results.at(-1)).toContain('"the qa channel"');
    expect(h.shell.results.at(-1)).toContain("Step 3");
    // Pinned, because it is a consequence rather than a goal: the two answers that WERE given
    // were valid and are kept, so asking again needs only the third.
    expect(h.facts().map((fact) => `${fact.subject}=${fact.value}`)).toEqual([
      "bugs channel=#bugs",
      "ops channel=#ops",
    ]);
  });

  it("has no question left for a second channel once the first needed a re-ask", async () => {
    const h = harness(plan([send("the bugs channel", "one"), send("the ops channel", "two")]), {
      asks: ["the dev channel", "#bugs", "#ops"],
    });

    const outcome = await h.planner.run("tell bugs and ops");

    expect(h.shell.questions).toHaveLength(2);
    expect(outcome.status).toBe("refused");
    expect(h.sender.calls).toEqual([]);
    expect(h.shell.results.at(-1)).toContain('"the ops channel"');
  });
});

describe("what is NOT asked about", () => {
  it("a channel memory already knows", async () => {
    const h = harness(plan(BUG_CHAIN), { facts: { "bugs channel": "#bugs" } });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([]);
    expect(outcome.chain).toEqual({ completed: 3, total: 3 });
    expect(h.sender.calls[0]?.channel).toBe("#bugs");
    expect(h.notified()[0]).toMatch(/^Three steps:/); // straight to the preview, nothing "Saved"
  });

  it("a literal channel", async () => {
    const literal = [BUG_CHAIN[0]!, BUG_CHAIN[1]!, step("sendMessage", { channel: "#bugs", notes: "{step2}" })];
    const h = harness(plan(literal));

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([]);
    expect(outcome.chain).toEqual({ completed: 3, total: 3 });
  });

  it("an unresolved openTarget: still refused, in the words it always was", async () => {
    const h = harness(plan([step("openTarget", { target: "my upwork" }), step("summarize", {})]), {
      asks: ["https://upwork.com/me"],
    });

    const outcome = await h.planner.run("open my upwork and summarize this");

    expect(h.shell.questions).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 2 });
    expect(h.shell.results).toEqual([
      'Step 1 of my plan needs "my upwork", and I don\'t know what that refers to yet, so I ' +
        "didn't start it — teach me with: remember my upwork is <what it is>.",
    ]);
    expect(h.facts()).toEqual([]);
  });

  it("a channel left empty: there is no reference to ask about", async () => {
    const h = harness(plan([step("summarize", {}), step("sendMessage", { channel: "", notes: "x" })]), {
      asks: ["#bugs"],
    });

    const outcome = await h.planner.run("summarize and send");

    expect(h.shell.questions).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(outcome.chain).toEqual({ completed: 0, total: 2 });
  });

  it("a lone sendMessage: the question belongs to a chain's pre-flight, not to every send", async () => {
    const h = harness(
      { kind: "tool", name: "sendMessage", input: { channel: "the bugs channel", notes: "hello" } },
      { asks: ["#bugs"] },
    );

    const outcome = await h.planner.run("tell the bugs channel hello");

    expect(h.shell.questions).toEqual([]);
    expect(outcome.status).toBe("refused");
    expect(h.sender.calls).toEqual([]);
    expect(h.facts()).toEqual([]);
  });
});

describe("a stale fact for the same subject", () => {
  it("is superseded by the answer, not left active beside it", async () => {
    // Someone once taught it that the bugs channel is "the team" — a reference, not a
    // destination, so it does not resolve and the question is still asked.
    const h = harness(plan(BUG_CHAIN), { asks: ["#bugs"], facts: { "bugs channel": "the team" } });

    const outcome = await h.planner.run(INSTRUCTION);

    expect(h.shell.questions).toEqual([QUESTION]);
    expect(outcome.status).toBe("ok");
    expect(
      h.facts().map(({ subject, value, version, active }) => ({ subject, value, version, active })),
    ).toEqual([
      { subject: "bugs channel", value: "the team", version: 1, active: 0 },
      { subject: "bugs channel", value: "#bugs", version: 2, active: 1 },
    ]);
    expect(h.sender.calls[0]?.channel).toBe("#bugs");
  });
});
