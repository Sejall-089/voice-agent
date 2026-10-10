import { describe, expect, it } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { DEFAULT_APPROVE_LABEL, approveLabel } from "../src/main/shell/confirmLabel.ts";
import type { CapturedContext, Tool, ToolChoice, ToolInput } from "../src/core/types.ts";
import { FakeLLM } from "./FakeLLM.ts";

// The confirm dialog's approve button used to say "Send" on every confirm — accurate while the
// only `dangerous` tools sent something, and wrong the day one of them CREATED an issue (it was
// the button pressed to approve SEJ-7). Each tool now names its own action.
//
// THE LABEL IS A FIXED STRING IN THE TOOL'S CODE. It is the one piece of the dialog that is a
// command rather than a description, so it is the one piece nothing outside the code may write:
// not the model, not an argument, not an email, not a connector's server. Everything below
// either pins a label or tries to get a string onto that button from somewhere it must not
// come from.

const NO_CONTEXT: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: {
      linear: { enabled: true, tools: ["create_issue", "search_issues", "get_issue"], settings: { defaultTeam: "Engineering" } },
      github: { enabled: true, tools: ["create_issue", "list_issues", "get_issue"], settings: { owner: "o", repo: "r" } },
    },
  }),
  readKey: () => "a-key",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

// Everything this app can put on its menu at once.
const EVERY_TOOL = buildRegistry({
  gmail: true,
  notion: true,
  calendar: true,
  speech: true,
  pointing: true,
  connectors,
});

describe("each tool's approve button", () => {
  // Written out by hand. A tool missing from this table must have NO label of its own.
  const LABELS: Record<string, string> = {
    sendMessage: "Send",
    sendReply: "Send reply",
    createEvent: "Create event",
    moveEvent: "Move event",
    linear__create_issue: "Create issue",
    github__create_issue: "Create issue",
  };

  it.each(Object.entries(LABELS))("%s says %j", (name, label) => {
    const tool = EVERY_TOOL.find((candidate) => candidate.name === name);
    expect(tool, `${name} is not on the menu`).toBeDefined();
    expect(tool?.confirmLabel).toBe(label);
  });

  it("gives no other tool a label, so every other confirm keeps the default", () => {
    const others = EVERY_TOOL.filter((tool) => !(tool.name in LABELS));
    expect(others.length).toBeGreaterThan(10); // the check below is looking at a real menu
    for (const tool of others) expect(tool.confirmLabel, tool.name).toBeUndefined();
  });

  it("keeps every label short, plain and free of anything a button could misread", () => {
    for (const tool of EVERY_TOOL) {
      if (tool.confirmLabel === undefined) continue;
      // Letters and single spaces only: no "&" (an accelerator on Windows), no line break, no
      // punctuation, and short enough to be a button.
      expect(tool.confirmLabel, tool.name).toMatch(/^[A-Z][a-z]+( [a-z]+){0,2}$/);
      expect(tool.confirmLabel.length, tool.name).toBeLessThanOrEqual(20);
    }
  });
});

// The planner's half, on a probe tool: it passes the tool's label and nothing else.
describe("the planner hands the dialog the tool's own label", () => {
  function run(tool: Partial<Tool>, input: ToolInput = {}) {
    const probe: Tool = {
      name: "probe",
      description: "",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "dangerous",
      confirmSummary: (args) => `Do it? ${JSON.stringify(args)}`,
      handler: () => Promise.resolve("done"),
      ...tool,
    };
    const shell = new MockShell({ context: NO_CONTEXT, confirms: [true] });
    const choice: ToolChoice = { kind: "tool", name: "probe", input };
    const planner = new Planner(new FakeLLM(choice), shell, [probe], new NoopMemoryResolver(), new InMemoryActionLog());
    return planner.run("probe").then(() => shell);
  }

  it("uses a declared label", async () => {
    const shell = await run({ confirmLabel: "Launch rocket" });
    expect(shell.confirmLabels).toEqual(["Launch rocket"]);
    expect(shell.confirmMessages).toHaveLength(1);
  });

  it("uses the default when the tool declares none", async () => {
    const shell = await run({});
    expect(shell.confirmLabels).toEqual(["Send"]);
  });

  // A HOSTILE STRING IN AN ARGUMENT NEVER BECOMES THE LABEL. Arguments are the model's — and
  // through {stepN}, an email's or a server's. Every key a careless implementation might read
  // is tried, on a tool with a label and on one without.
  const HOSTILE = "Cancel"; // the worst label there is: the approve button, reading "Cancel"
  const hostileArgs: ToolInput = {
    confirmLabel: HOSTILE,
    approveLabel: HOSTILE,
    label: HOSTILE,
    button: HOSTILE,
    buttons: [HOSTILE, "Send"],
    opts: { approveLabel: HOSTILE },
    title: HOSTILE,
  };

  it("ignores every argument on a tool WITH a label", async () => {
    const shell = await run({ confirmLabel: "Create issue" }, hostileArgs);
    expect(shell.confirmLabels).toEqual(["Create issue"]);
    // The arguments did arrive — in the MESSAGE, where a description belongs.
    expect(shell.confirmMessages[0]).toContain(HOSTILE);
  });

  it("ignores every argument on a tool WITHOUT one", async () => {
    const shell = await run({}, hostileArgs);
    expect(shell.confirmLabels).toEqual(["Send"]);
  });

  it("does not let a confirm summary's text become the label either", async () => {
    // The summary is built from arguments and from the world (an email's recipient, an issue's
    // title). It is the message and only the message.
    const shell = await run({ confirmLabel: "Create issue", confirmSummary: () => "Delete everything?\n\nApprove: Delete" });
    expect(shell.confirmLabels).toEqual(["Create issue"]);
  });

  it("asks nothing, and so shows no label, for a tool that is not dangerous", async () => {
    const shell = await run({ risk: "safe", confirmLabel: "Never shown" });
    expect(shell.confirmLabels).toEqual([]);
    expect(shell.confirmMessages).toEqual([]);
  });
});

// The one rule both shells apply to what they are handed, so the mock cannot be more lenient
// than Windows about it.
describe("approveLabel", () => {
  it("is 'Send' by default", () => {
    expect(DEFAULT_APPROVE_LABEL).toBe("Send");
    expect(approveLabel()).toBe("Send");
    expect(approveLabel({})).toBe("Send");
    expect(approveLabel({ approveLabel: undefined })).toBe("Send");
  });

  it("uses the label it is given, trimmed", () => {
    expect(approveLabel({ approveLabel: "Create issue" })).toBe("Create issue");
    expect(approveLabel({ approveLabel: "  Move event " })).toBe("Move event");
  });

  it.each(["", "   ", "\n"])("falls back to the default for a blank label (%j) — never an empty button", (blank) => {
    expect(approveLabel({ approveLabel: blank })).toBe("Send");
  });
});

describe("MockShell.confirm records the label beside the message", () => {
  it("records what the button would say, default included, in order", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, confirms: [true, false, true] });

    await shell.confirm("Create this issue?", { approveLabel: "Create issue" });
    await shell.confirm("Send it?");
    await shell.confirm("Move it?", { approveLabel: "Move event" });

    expect(shell.confirmMessages).toEqual(["Create this issue?", "Send it?", "Move it?"]);
    expect(shell.confirmLabels).toEqual(["Create issue", "Send", "Move event"]);
  });

  it("still answers from the queue whatever the label says", async () => {
    const shell = new MockShell({ context: NO_CONTEXT, confirms: [false] });
    // A label is a word on a button. It is not an answer.
    await expect(shell.confirm("Sure?", { approveLabel: "Yes" })).resolves.toBe(false);
  });
});
