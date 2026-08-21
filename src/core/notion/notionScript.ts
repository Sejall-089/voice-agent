// The code that runs inside the Notion tab to FIND things (M11). Same two constraints as
// gmailScript.ts, and for the same reasons — see that file's header comment:
//
// 1. `notionAgent` is SELF-CONTAINED — it imports nothing and references nothing at module
//    scope, because ChromeNotion ships it into the page with `notionAgent.toString()`.
// 2. It takes `doc` as a parameter instead of reaching for the global `document`, so the exact
//    same function runs under jsdom in `tests/notionScript.test.ts`.
//
// WHERE THIS DIFFERS FROM gmailScript.ts, AND WHY. gmailScript.ts both FINDS controls and ACTS
// on them (`.click()`, `document.execCommand()`) — Gmail's compose box is an ordinary
// browser-native contenteditable that responds correctly to JS-dispatched DOM calls. Live
// testing against real Notion (M11 planning) found that Notion's editor does NOT: JS-level
// `.click()` and `.focus()` calls report success but nothing is saved — Notion only reacts to
// genuine CDP-level input (the same signal a real mouse and keyboard produce), which can only
// be issued from the OUTER session (ChromeNotion.ts / CdpClient.ts), never from inside a
// page-injected function. So this file only FINDS and READS; ChromeNotion.ts does the
// clicking, keying, and typing, informed by what this file locates.
//
// THE SAFETY RULE is unchanged (clacky's default-deny, core/risk.ts): every ACTION target is
// resolved structurally, never by guessed pixel position, and an ambiguous or absent target is
// refused rather than guessed at. Notion's body content carries no ARIA roles at all (confirmed
// live — only the page title does), so the identity predicate here is `data-block-id`
// (document order) rather than Gmail's role + accessible name. "The last block in document
// order" is not a guess the way picking one of several role-matched elements would be — it is
// the one, unambiguous structural fact "append after everything" can mean.
//
// KNOWN LIMIT, same shape as gmailScript.ts's: these selectors are Notion's CURRENT markup,
// observed live during M11 planning (2026-08-20/21) against one real page. Notion's DOM is
// Notion's to change without notice, same as Gmail's.

export interface ScriptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScriptNode {
  querySelector(selectors: string): ScriptElement | null;
  querySelectorAll(selectors: string): ArrayLike<ScriptElement>;
}

export interface ScriptElement extends ScriptNode {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect?: () => ScriptRect;
  // Optional because a plain Element has none of these, and the point of every check below is
  // that we never assume.
  scrollIntoView?: (options?: { block?: string }) => void;
}

export interface ScriptDocument extends ScriptNode {
  title: string;
}

export type ScriptResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface ScriptPage {
  title: string | null;
  body: string;
}

export interface AppendTarget {
  blockId: string;
  // Where to click, in viewport coordinates — ChromeNotion issues the real CDP click here.
  // Always the CENTER of the last block's own bounding rect, after scrolling it into view.
  x: number;
  y: number;
}

export type NotionOp = "hasEditablePage" | "readOpenPage" | "locateAppendTarget";

export function notionAgent(doc: ScriptDocument, op: NotionOp): ScriptResult<unknown> {
  // --- helpers (must stay inside: this function is stringified into the page) ---

  const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

  // The page title. Notion's title is an H1 with role="textbox" and
  // aria-roledescription="page title" — the one place body content DOES carry a role, because
  // it is a single, well-known, always-present field rather than one of many interchangeable
  // blocks.
  const titleElement = (): ScriptElement | null =>
    doc.querySelector('h1[aria-roledescription="page title"]') ?? doc.querySelector("h1");

  // The page's own content area. `.notion-page-content` was the one container observed to
  // scope cleanly to the page body — a broader guess (`.notion-scroller`) turned out to match
  // the SIDEBAR's scroller first in document order, pulling in navigation text. This is
  // display/context only (used for `destination.existing`, never a click target), so a
  // slightly noisy read is a quality issue, not a safety one.
  const contentArea = (): ScriptElement | null => doc.querySelector(".notion-page-content");

  // Every real content block, in document order. The FIRST is the page's own wrapper block
  // (its data-block-id matches the page itself, not a piece of content) — everything after
  // that is actual body content.
  const blocks = (): ScriptElement[] => {
    const found = doc.querySelectorAll("[data-block-id]");
    const out: ScriptElement[] = [];
    for (let i = 0; i < found.length; i += 1) out.push(found[i] as ScriptElement);
    return out;
  };

  // --- operations ---

  if (op === "hasEditablePage") {
    return { ok: true, value: titleElement() !== null };
  }

  if (op === "readOpenPage") {
    const title = titleElement();
    if (title === null) {
      return { ok: false, reason: "No Notion page is open here — open one and try again." };
    }
    const titleText = clean(title.textContent ?? "");
    const contentEl = contentArea();
    const bodyText = clean(contentEl === null ? "" : contentEl.textContent ?? "");
    const page: ScriptPage = {
      title: titleText.length > 0 ? titleText : null,
      body: bodyText,
    };
    return { ok: true, value: page };
  }

  if (op === "locateAppendTarget") {
    const all = blocks();
    // The first entry is the page's own wrapper block, not real content — fewer than two
    // means there is nothing to anchor an append after. Refuse rather than guess at where
    // "the end of the page" is on what may be a still-loading or genuinely empty page.
    if (all.length < 2) {
      return {
        ok: false,
        reason: "Couldn't find anywhere to add content on this Notion page.",
      };
    }
    const last = all[all.length - 1];
    if (last === undefined || last.getBoundingClientRect === undefined) {
      return {
        ok: false,
        reason: "Couldn't find anywhere to add content on this Notion page.",
      };
    }
    if (typeof last.scrollIntoView === "function") {
      last.scrollIntoView({ block: "center" });
    }
    const rect = last.getBoundingClientRect();
    const target: AppendTarget = {
      blockId: last.getAttribute("data-block-id") ?? "",
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
    return { ok: true, value: target };
  }

  return { ok: false, reason: "Unknown Notion operation: " + String(op) };
}
