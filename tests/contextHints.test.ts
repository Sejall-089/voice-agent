import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalToolName } from "../src/core/chain.ts";
import {
  CLIPBOARD_LABEL_WITH_EMAIL,
  EMAIL_HINT_TIMEOUT_MS,
  EMAIL_OPEN_LINE,
  FROM_CLIPBOARD,
  MIN_CLIPBOARD_MATCH_CHARS,
  emailOpenHint,
  isClipboardText,
  markFromClipboard,
  usesClipboardBesideOpenEmail,
} from "../src/core/contextHints.ts";
import { UnavailableGmail } from "../src/core/gmail/UnavailableGmail.ts";
import { CHOOSE_SYSTEM, renderRequest } from "../src/core/llm/prompt.ts";
import { readEmailTool } from "../src/core/tools/readEmail.ts";
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

  // RE-JUSTIFIED, NOT RE-RUN (CLAUDE.md). This used to assert the hint sat ABOVE the clipboard,
  // which was the rule when it first shipped. A live run then filed a thousand characters of
  // clipboard as "this bug" with the hint sitting above it. The rule is now the opposite — the
  // hint is the LAST thing read — so the old assertion was not merely stale, it pinned the bug.
  it("comes AFTER the clipboard text, as the last thing in the request", () => {
    const text = render({ ...base, emailOpen: true, selectedText: "UNRELATED CLIPBOARD" });
    const instruction = text.indexOf("Instruction: file this bug in Linear");
    const clipboard = text.indexOf("UNRELATED CLIPBOARD");
    const hint = text.indexOf(EMAIL_OPEN_LINE);
    expect(instruction).toBeGreaterThanOrEqual(0);
    expect(clipboard).toBeGreaterThan(instruction);
    expect(hint).toBeGreaterThan(clipboard);
    expect(text.endsWith(EMAIL_OPEN_LINE)).toBe(true);
  });

  it("still appears, alone, when there is no clipboard text at all", () => {
    const text = render({ ...base, emailOpen: true });
    expect(text.endsWith(`Instruction: file this bug in Linear\n\n${EMAIL_OPEN_LINE}`)).toBe(true);
    expect(text).not.toContain("Clipboard text");
    expect(text).not.toContain("Selected text");
  });
});

describe("what the clipboard is called", () => {
  const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
  const base: CapturedContext = { selectedText: "CLIP", activeApp: null, activeWindowTitle: null };
  const render = (context: CapturedContext): string =>
    renderRequest("file this bug in Linear", context, null, NOW, "UTC");

  // The control. With no email open the clipboard is the only thing "this" can mean, and the
  // v0 workflow (select → copy → hotkey) is exactly what the old label describes.
  it("keeps its v0 name, and its place, when no email is open", () => {
    const text = render(base);
    expect(text.endsWith("Instruction: file this bug in Linear\n\nSelected text (clipboard):\nCLIP")).toBe(true);
    expect(text).not.toContain("may be unrelated");
    expect(render({ ...base, emailOpen: false })).toBe(text);
  });

  it("is called what it is — possibly unrelated — when an email is open", () => {
    const text = render({ ...base, emailOpen: true });
    expect(text).toContain(`${CLIPBOARD_LABEL_WITH_EMAIL}\nCLIP`);
    expect(CLIPBOARD_LABEL_WITH_EMAIL).toContain("may be unrelated");
    // It no longer claims the user selected it.
    expect(text).not.toContain("Selected text");
  });

  // The whole reason the hint is a boolean, restated for the new shape: an open email changes
  // the clipboard's LABEL and adds one fixed line. There is still no field through which
  // anything the email says could arrive.
  it("differs from the no-email prompt by exactly one label and one fixed line", () => {
    const without = render(base);
    const withEmail = render({ ...base, emailOpen: true });
    expect(
      withEmail
        .replace(CLIPBOARD_LABEL_WITH_EMAIL, "Selected text (clipboard):")
        .replace(`\n\n${EMAIL_OPEN_LINE}`, ""),
    ).toBe(without);
  });
});

describe("the standing rule about what 'this' means", () => {
  // RE-JUSTIFIED FOR THE VERB RULE. The first version of this test pinned a NOUN rule ("this bug
  // … means that email"). That rule measured 10/10 on the case it was written for and took
  // "summarize this" from 6/6 to 4/6. So each half of the rule is asserted separately, and the
  // noun form is asserted GONE — a test that only checked the email half would pass on the
  // version that broke summarize.
  it("is keyed on the verb in the planner's system prompt", () => {
    expect(CHOOSE_SYSTEM).toMatch(/What 'this' refers to is decided by the VERB/);
    // Text verbs → the clipboard, email or no email.
    expect(CHOOSE_SYSTEM).toMatch(
      /Summarize, rewrite, translate, explain and fix act on the clipboard text — use it, whether or not an email is open/,
    );
    // Filing verbs → the open email, even past a clipboard.
    expect(CHOOSE_SYSTEM).toMatch(
      /File, log, reply to and forward act on the open email when the request says an email is open in Gmail, EVEN IF clipboard text is also shown/,
    );
    // The explicit clipboard phrases win regardless of verb.
    expect(CHOOSE_SYSTEM).toMatch(
      /'This text', 'what I copied' and 'these notes' always mean the clipboard, whatever the verb/,
    );
    expect(CHOOSE_SYSTEM).toMatch(/does not say an email is open, 'this' means the selected text/);
  });

  it("has no noun rule, and no bare-'this' rule", () => {
    // The noun rule that broke "summarize this"…
    expect(CHOOSE_SYSTEM).not.toMatch(/'this bug'|'this email'|'this message'|'this report'/);
    // …and the patch that would have broken "log this as an issue".
    expect(CHOOSE_SYSTEM).not.toMatch(/bare 'this'/i);
    expect(readEmailTool.description).not.toMatch(/bare 'this'/i);
  });

  // The sentence that told the model the opposite of the hint. It was written for an earlier
  // fix, before the hint existed, and then contradicted it.
  it("no longer has readEmail telling the model that selected text wins", () => {
    expect(readEmailTool.description).not.toMatch(/usually means that text instead/i);
  });

  it("has readEmail say when it is, and is not, the tool", () => {
    expect(readEmailTool.description).toMatch(
      /asks to FILE, LOG or FORWARD 'this', they mean THAT EMAIL, even if clipboard text is also shown/,
    );
    expect(readEmailTool.description).toMatch(
      /Do NOT use readEmail when the user asks to summarize, rewrite, translate, explain or fix 'this'/,
    );
    expect(readEmailTool.description).toMatch(
      /'This text', 'what I copied' and 'these notes' always mean the clipboard/,
    );
    // Replying is draftReply's job, as it has been since M10.
    expect(readEmailTool.description).toMatch(/Do NOT use this before draftReply/);
  });
});

describe("isClipboardText", () => {
  const CLIP =
    "Tried the migration again on staging this morning and it still falls over.\n\nError: Connection terminated unexpectedly\n    at migrateOrders (migrate.js:214:19)";

  it("matches the clipboard verbatim, and verbatim inside something longer", () => {
    expect(isClipboardText(CLIP, CLIP)).toBe(true);
    expect(isClipboardText(`Reported by the user:\n\n${CLIP}\n\n— filed by voice`, CLIP)).toBe(true);
  });

  it("matches a copy whose whitespace was changed, or that was cut short", () => {
    expect(isClipboardText(CLIP.replace(/\s+/g, " "), CLIP)).toBe(true);
    expect(isClipboardText(`  ${CLIP}\r\n`, CLIP)).toBe(true);
    expect(isClipboardText(CLIP.slice(0, 80), CLIP)).toBe(true);
  });

  it("does not match different text, a paraphrase, or text that only shares words", () => {
    const email = "From: Dana\nSubject: Login broken\n\nClicking Log in does nothing on Safari 17.";
    expect(isClipboardText(email, CLIP)).toBe(false);
    expect(isClipboardText("The staging migration keeps failing with a dropped connection.", CLIP)).toBe(false);
    expect(isClipboardText("Tried the migration again on production last night", CLIP)).toBe(false);
  });

  it("ignores matches too short to mean anything", () => {
    expect(MIN_CLIPBOARD_MATCH_CHARS).toBe(20);
    expect(isClipboardText("Login is broken on Safari", "ok")).toBe(false); // clipboard too short
    expect(isClipboardText("Error", CLIP)).toBe(false); // value too short
    expect(isClipboardText("", CLIP)).toBe(false);
  });

  it("is false for anything that is not text, and for an empty clipboard", () => {
    expect(isClipboardText(42, CLIP)).toBe(false);
    expect(isClipboardText([CLIP], CLIP)).toBe(false);
    expect(isClipboardText(CLIP, null)).toBe(false);
  });
});

describe("usesClipboardBesideOpenEmail", () => {
  const CLIP = "Several paragraphs of something that was copied a while ago.";

  it("needs BOTH an open email and an argument that is the clipboard", () => {
    const args = { title: "Bug report", description: CLIP };
    expect(usesClipboardBesideOpenEmail(args, { selectedText: CLIP, emailOpen: true })).toBe(true);
    // No email open: the clipboard is the only candidate, and there is no ambiguity to flag.
    expect(usesClipboardBesideOpenEmail(args, { selectedText: CLIP })).toBe(false);
    expect(usesClipboardBesideOpenEmail(args, { selectedText: CLIP, emailOpen: false })).toBe(false);
    // Email open, but the text came from somewhere else.
    expect(
      usesClipboardBesideOpenEmail(
        { title: "Bug report", description: "From: Dana\n\nClicking Log in does nothing." },
        { selectedText: CLIP, emailOpen: true },
      ),
    ).toBe(false);
    expect(usesClipboardBesideOpenEmail(args, { selectedText: null, emailOpen: true })).toBe(false);
  });
});

describe("markFromClipboard", () => {
  it("puts the source into the question, and leaves everything after it untouched", () => {
    expect(markFromClipboard("Create this Linear issue in Engineering?\n\nTitle: T\n\nBODY")).toBe(
      "Create this Linear issue in Engineering from your clipboard text?\n\nTitle: T\n\nBODY",
    );
    expect(FROM_CLIPBOARD).toBe("from your clipboard text");
  });

  it("handles a one-line question, and a first line that is not a question", () => {
    expect(markFromClipboard("Run Acme peek?")).toBe("Run Acme peek from your clipboard text?");
    expect(markFromClipboard("Run Acme peek\n\nid: 1")).toBe(
      "Run Acme peek (from your clipboard text)\n\nid: 1",
    );
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

  // D. The question a live failure could not answer afterwards: was the hint in the prompt?
  it("puts what the model was told on the [main] line", async () => {
    const lines = await run({
      status: "cancelled",
      tool: "linear__create_issue",
      result: null,
      chain: { completed: 0, total: 2 },
      planning: { emailHint: true, emailCheckMs: 8, clipboardChars: 1050 },
    });
    expect(lines).toEqual([
      "[main] cancelled (chain 0/2) [email hint: sent, check 8ms; clipboard: 1050 chars]: ",
    ]);
  });

  it("says plainly when the hint was not sent", async () => {
    const lines = await run({
      status: "ok",
      tool: "summarize",
      result: "SUMMARY",
      planning: { emailHint: false, emailCheckMs: 800, clipboardChars: 0 },
    });
    expect(lines).toEqual([
      "[main] ok [email hint: not sent, check 800ms; clipboard: 0 chars]: SUMMARY",
    ]);
  });

  it("prints neither for an ordinary outcome", async () => {
    const lines = await run({ status: "ok", tool: "summarize", result: "SUMMARY" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[main] ok: SUMMARY");
  });
});
