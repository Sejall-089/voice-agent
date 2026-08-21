import { pickTab, type TabCandidate } from "../browser/tabs.ts";
import type { CdpSession, PageTarget } from "../browser/CdpClient.ts";
import {
  notionAgent,
  type AppendTarget,
  type NotionOp,
  type ScriptPage,
  type ScriptResult,
} from "./notionScript.ts";
import type { NotionPage, NotionSurface } from "../types.ts";

// The real `NotionSurface` (M11): the Notion page open in a Chrome the user launched with
// remote debugging — the SAME Chrome and setup Gmail uses (`core/browser/`), a different tab.
//
// THE CENTRAL DIFFERENCE FROM ChromeGmail, discovered live during M11 planning: Gmail's
// compose box is an ordinary browser-native contenteditable, and JS-dispatched DOM calls
// (`.focus()`, `document.execCommand()`) work on it correctly — that is the entire mechanism
// `gmailScript.ts` uses. Notion's editor does NOT respond to those calls: they report success
// (execCommand returns `true`) but nothing is saved, repeatedly, across several different
// attempts (direct `.click()`, `.focus()` + Selection/Range + execCommand, focusing the shared
// editor root). What DOES work, confirmed live, is real CDP-level input — the same signal a
// physical mouse and keyboard produce (`CdpSession.click`, `.pressKey`, `.insertText`) — which
// is why this class, unlike ChromeGmail, drives the page through those rather than through
// `session.evaluate()` alone. `notionScript.ts` still does the FINDING (structural, default-
// deny, jsdom-testable); this class does the ACTING.
const NOTION_HOSTS = ["notion.so", "notion.com"];

const ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
const END = { key: "End", code: "End", keyCode: 35 };

// How long to wait after each real input step for Notion's own JS to catch up — mirrors
// ChromeGmail's COMPOSE_WAIT_MS/waitFor pattern for the same reason: a straight-line read
// would race Notion's response to input that has no synchronous completion signal.
const FOCUS_SETTLE_MS = 300;
const KEY_SETTLE_MS = 150;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Narrow multiple qualifying Notion tabs down to the foreground one (M11's refinement over
// M10's flat zero/many rule — see core/browser/tabs.ts's `narrow` doc comment). Necessary
// because nearly every open notion.so/notion.com tab satisfies "has an editable page", so
// without this, having two Notion tabs open at all would refuse constantly.
async function narrowToVisible(candidates: TabCandidate[]): Promise<TabCandidate[]> {
  const visible: TabCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const isVisible = await candidate.session.evaluate<boolean>(
        'document.visibilityState === "visible"',
      );
      if (isVisible) visible.push(candidate);
    } catch {
      // Can't tell — treated as not-visible, not as a reason to fail the whole lookup.
    }
  }
  return visible;
}

export interface ChromeNotionOptions {
  baseUrl: string; // e.g. http://127.0.0.1:9222
  timeoutMs?: number;
}

export class ChromeNotion implements NotionSurface {
  private readonly baseUrl: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: ChromeNotionOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
  }

  async readOpenPage(): Promise<NotionPage> {
    return this.withTab(async (session, target) => {
      const page = await this.run<ScriptPage>(session, "readOpenPage");
      return { title: page.title, url: target.url, body: page.body };
    });
  }

  async appendToPage(text: string): Promise<void> {
    await this.withTab(async (session) => {
      // SAFE: find the last block and where to click, without touching anything yet.
      const target = await this.run<AppendTarget>(session, "locateAppendTarget");

      // Real CDP input from here — see the class comment for why JS-level calls don't work.
      // bringToFront appears necessary in practice: real input only reliably registered while
      // the tab was genuinely foreground during live testing (unverified WHY — plausibly
      // Chrome deprioritizing hit-testing for a backgrounded tab's compositor).
      await session.bringToFront();
      await session.click(target.x, target.y);
      await wait(FOCUS_SETTLE_MS);

      // Move the caret to the END of the clicked block's existing content. This, not a
      // select-all, is the append-only invariant: gmailScript's REPLACE pattern
      // (selectNodeContents + insertText) would wipe a Notion block if copied here.
      await session.pressKey(END.key, END.code, END.keyCode);
      await wait(KEY_SETTLE_MS);

      // One real Enter, then type, per line — NOT a single insertText with embedded "\n".
      // Confirmed live: a multi-line blob through insertText silently DROPPED everything
      // after the first newline, while an Enter keypress between lines correctly created a
      // genuine new block for each one, the same way a real user typing would.
      const lines = text.split("\n");
      for (const line of lines) {
        await session.pressKey(ENTER.key, ENTER.code, ENTER.keyCode);
        await wait(KEY_SETTLE_MS);
        if (line.trim().length > 0) {
          await session.insertText(line);
          await wait(KEY_SETTLE_MS);
        }
      }

      // Read the page back and confirm the text actually landed, rather than trusting that
      // the input calls "succeeded" — the whole reason this class exists is that Notion can
      // report success on operations that silently did nothing. If we can't confirm it, we
      // say so rather than claiming success on a guess.
      await wait(FOCUS_SETTLE_MS);
      const after = await this.run<ScriptPage>(session, "readOpenPage");
      const expected = clean(lines.find((line) => line.trim().length > 0) ?? text);
      if (expected.length > 0 && !after.body.includes(expected)) {
        throw new Error(
          "Couldn't confirm the note was actually added to the page — Notion may not have " +
            "accepted it. Check the page before trying again.",
        );
      }
    });
  }

  // --- internals ---

  private async withTab<T>(
    work: (session: CdpSession, target: PageTarget) => Promise<T>,
  ): Promise<T> {
    return pickTab(
      {
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        hostMatch: (url) => NOTION_HOSTS.some((host) => url.includes(host)),
        qualifies: (session) => this.run<boolean>(session, "hasEditablePage"),
        narrow: narrowToVisible,
        whenNoHost:
          "No Notion tab is open in the Chrome I can see. Open the page in the Chrome you " +
          "started with remote debugging, then try again.",
        whenNoneQualify: "There's no Notion page open right now — open one and try again.",
        whenMany: (count) =>
          `${String(count)} Notion pages match — I won't guess which one you mean. ` +
          "Leave one open and try again.",
      },
      work,
    );
  }

  // Ship notionAgent into the page and unwrap its result. Mirrors ChromeGmail's `run()`.
  private async run<T>(session: CdpSession, op: NotionOp): Promise<T> {
    const expression = `(${notionAgent.toString()})(document, ${JSON.stringify(op)})`;
    const result = await session.evaluate<ScriptResult<T> | undefined>(expression);
    if (result === undefined) {
      throw new Error(`Notion returned nothing for "${op}" — the page may still be loading.`);
    }
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.value;
  }
}
