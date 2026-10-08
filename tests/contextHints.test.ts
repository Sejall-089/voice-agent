import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalToolName } from "../src/core/chain.ts";
import {
  EMAIL_HINT_TIMEOUT_MS,
  EMAIL_OPEN_LINE,
  emailOpenHint,
} from "../src/core/contextHints.ts";
import { UnavailableGmail } from "../src/core/gmail/UnavailableGmail.ts";
import { renderRequest } from "../src/core/llm/prompt.ts";
import { createRunInstruction } from "../src/main/runInstruction.ts";
import type { CapturedContext, PlannerOutcome } from "../src/core/types.ts";
import { FakeGmail } from "./FakeGmail.ts";

// Two M19 live findings, and the pure halves of both fixes.
//
//   1. With unrelated text on the clipboard, "file this bug in Linear…" was planned against the
//      CLIPBOARD: the planner had no idea an email was open. → a one-line hint.
//   2. The same run was refused because the plan named `functions.linear__create_issue` — the
//      provider's own namespace, typed into a plan step. → one canonicalisation rule.
//
// The planner-level halves (the hint reaching the model, a prefixed plan actually running) are
// in tests/planner.mcp.test.ts.

const MENU = ["readEmail", "linear__create_issue", "sendMessage", "summarize"];

describe("canonicalToolName — the closed world, with one prefix forgiven", () => {
  it("returns a menu name untouched", () => {
    for (const name of MENU) expect(canonicalToolName(name, MENU)).toBe(name);
  });

  it("drops the provider prefix when — and only when — what is left is on the menu", () => {
    expect(canonicalToolName("functions.linear__create_issue", MENU)).toBe("linear__create_issue");
    expect(canonicalToolName("functions.readEmail", MENU)).toBe("readEmail");
  });

  it("leaves a prefixed name that is NOT on the menu exactly as it was sent", () => {
    // Real tools on Linear's server, and a hand-built tool this install does not have.
    for (const name of ["functions.linear__save_issue", "functions.delete_comment", "functions.readSchedule"]) {
      expect(canonicalToolName(name, MENU)).toBe(name);
      expect(MENU).not.toContain(canonicalToolName(name, MENU));
    }
  });

  // Everything here stays unknown. The first two are in this install's action log verbatim.
  it("forgives nothing else", () => {
    const refused = [
      "multi_tool_use.parallel", // the model reaching for parallel calls — names nothing
      "parallel",
      "functions.plan", // `plan` is never on the menu, so it cannot be smuggled in as a step
      "plan",
      "functions.functions.readEmail", // stripped ONCE: what is left is not a menu name
      "Functions.readEmail", // the prefix is case-sensitive
      "FUNCTIONS.readEmail",
      "functions.reademail", // and so is the name
      "functions.ReadEmail",
      "functions. readEmail",
      " functions.readEmail",
      "functions.readEmail ",
      "functions_readEmail",
      "functions:readEmail",
      "function.readEmail",
      "tools.readEmail",
      "default_api.readEmail",
      "readEmail.functions",
      "reademail",
      "ReadEmail",
      "readEmail ",
      "functions.",
      "",
    ];
    for (const name of refused) {
      const result = canonicalToolName(name, MENU);
      expect(result, JSON.stringify(name)).toBe(name);
      expect(MENU, JSON.stringify(name)).not.toContain(result);
    }
  });

  // The property that makes the rule safe, stated as the test: whatever goes in, what comes out
  // is either a menu name or the input itself. There is no third thing it can produce.
  it("can only ever return a menu name or its own input", () => {
    const inputs = [...MENU, ...MENU.map((name) => `functions.${name}`), "functions.x", "x", ""];
    for (const input of inputs) {
      const result = canonicalToolName(input, MENU);
      expect(result === input || MENU.includes(result), input).toBe(true);
    }
  });

  it("matches against THIS run's menu, not a fixed list", () => {
    expect(canonicalToolName("functions.readEmail", ["summarize"])).toBe("functions.readEmail");
    expect(canonicalToolName("functions.readEmail", [])).toBe("functions.readEmail");
  });
});

describe("emailOpenHint", () => {
  it("is true when Gmail says a message is open", async () => {
    await expect(emailOpenHint(new FakeGmail())).resolves.toBe(true);
  });

  it("is false when nothing is open, when Chrome is gone, and when Gmail is not configured", async () => {
    await expect(emailOpenHint(new FakeGmail({ openEmail: null }))).resolves.toBe(false);
    await expect(emailOpenHint(new FakeGmail({ failWith: "Chrome is not there" }))).resolves.toBe(false);
    await expect(emailOpenHint(new UnavailableGmail())).resolves.toBe(false);
  });

  // The real surface is contracted never to throw. This is the belt to that pair of braces, so
  // it uses a hand-made surface rather than teaching FakeGmail to do something the real one
  // cannot (CLAUDE.md: a fake's failure must be the type the real thing raises — here, none).
  it("is false, not a rejection, if the surface throws or rejects anyway", async () => {
    await expect(
      emailOpenHint({ hasOpenEmail: () => Promise.reject(new Error("boom")) }),
    ).resolves.toBe(false);
    await expect(
      emailOpenHint({
        hasOpenEmail: () => {
          throw new Error("sync boom");
        },
      }),
    ).resolves.toBe(false);
  });

  it("is false for anything that is not literally true", async () => {
    const odd = { hasOpenEmail: () => Promise.resolve("yes" as unknown as boolean) };
    await expect(emailOpenHint(odd)).resolves.toBe(false);
  });

  // REAL TIME, on purpose. The claim is about elapsed time, and the fake genuinely takes
  // `probeDelayMs` to answer — an instantly-resolving fake could only show the deadline was
  // consulted, never that it held.
  it("gives no hint, and no delay beyond the deadline, when the check is slow", async () => {
    const gmail = new FakeGmail({ probeDelayMs: 400 });
    const started = performance.now();
    const hint = await emailOpenHint(gmail, 60);
    const elapsed = performance.now() - started;

    expect(hint).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(250); // nowhere near the 400ms the check would have taken
  });

  it("answers as soon as the check does when it is fast — the deadline is a ceiling, not a wait", async () => {
    const started = performance.now();
    await expect(emailOpenHint(new FakeGmail({ probeDelayMs: 20 }), 2_000)).resolves.toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("never hangs on a check that never answers", async () => {
    const never = { hasOpenEmail: () => new Promise<boolean>(() => undefined) };
    await expect(emailOpenHint(never, 40)).resolves.toBe(false);
  });

  it("leaves no timer running once the check has answered", async () => {
    vi.useFakeTimers();
    try {
      const pending = emailOpenHint({ hasOpenEmail: () => Promise.resolve(true) }, 60_000);
      await expect(pending).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has a short default deadline", () => {
    expect(EMAIL_HINT_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("the prompt line", () => {
  const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
  const base: CapturedContext = { selectedText: null, activeApp: null, activeWindowTitle: null };
  const render = (context: CapturedContext): string =>
    renderRequest("file this bug in Linear", context, null, NOW, "UTC");

  it("is one fixed sentence", () => {
    expect(EMAIL_OPEN_LINE).toBe("An email is open in Gmail.");
  });

  it("appears only when the context says an email is open", () => {
    expect(render({ ...base, emailOpen: true })).toContain(EMAIL_OPEN_LINE);
    expect(render(base)).not.toContain("Gmail");
    expect(render({ ...base, emailOpen: false })).not.toContain("Gmail");
  });

  it("sits under the instruction and ABOVE the clipboard text", () => {
    const text = render({ ...base, emailOpen: true, selectedText: "UNRELATED CLIPBOARD" });
    const instruction = text.indexOf("Instruction: file this bug in Linear");
    const hint = text.indexOf(EMAIL_OPEN_LINE);
    const clipboard = text.indexOf("UNRELATED CLIPBOARD");
    expect(instruction).toBeGreaterThanOrEqual(0);
    expect(hint).toBeGreaterThan(instruction);
    expect(clipboard).toBeGreaterThan(hint);
  });

  // The whole reason it is a boolean. Adding the hint must add exactly the fixed line and
  // nothing else — there is no field through which anything the email says could arrive.
  it("adds exactly that sentence to the prompt, and nothing else", () => {
    const without = render({ ...base, selectedText: "clip" });
    const withHint = render({ ...base, selectedText: "clip", emailOpen: true });
    expect(withHint.replace(`\n\n${EMAIL_OPEN_LINE}`, "")).toBe(without);
  });
});

describe("runInstruction prints what the model sent when it was refused", () => {
  const shell = { showThinking: (): void => undefined };
  const run = async (outcome: PlannerOutcome): Promise<string[]> => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await createRunInstruction({ run: () => Promise.resolve(outcome) }, shell)("do it");
    } finally {
      spy.mockRestore();
    }
    return lines;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a refused plan in full, arguments included", async () => {
    const lines = await run({
      status: "refused",
      tool: null,
      result: "My plan for that used a tool I don't have",
      chain: { completed: 0, total: 2 },
      proposed: {
        plan: [
          { tool: "functions.nope", arguments: { title: "T" }, describe: "file it" },
          { tool: "sendMessage", arguments: { channel: "#bugs" }, describe: "tell them" },
        ],
      },
    });
    const line = lines.find((entry) => entry.startsWith("[main] refused plan, as sent: "));
    expect(line).toBeDefined();
    expect(line).toContain('"tool":"functions.nope"');
    expect(line).toContain('"title":"T"');
  });

  it("prints a refused single tool name", async () => {
    const lines = await run({
      status: "no_tool",
      tool: null,
      result: "I can't do that yet",
      proposed: { tool: "functions.nope" },
    });
    expect(lines).toContain('[main] refused tool name, as sent: "functions.nope"');
  });

  it("prints neither for an ordinary outcome", async () => {
    const lines = await run({ status: "ok", tool: "summarize", result: "SUMMARY" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[main] ok: SUMMARY");
  });
});
