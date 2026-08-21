// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  notionAgent,
  type ScriptDocument,
  type ScriptElement,
} from "../src/core/notion/notionScript.ts";

// The jsdom globals, typed locally — same discipline as gmailScript.test.ts, for the same
// reason: tsconfig.node.json deliberately gives /core, /main, and /tests NO DOM lib, so a
// stray `doc.` in the headless brain stays a compile error.
interface TestElement extends ScriptElement {
  querySelector(selectors: string): TestElement | null;
  querySelectorAll(selectors: string): ArrayLike<TestElement>;
}
interface TestDocument extends ScriptDocument {
  body: { innerHTML: string };
  querySelector(selectors: string): TestElement | null;
  querySelectorAll(selectors: string): ArrayLike<TestElement>;
}
const doc = (globalThis as Record<string, unknown>)["document"] as TestDocument;

// THIS FIXTURE IS TRANSCRIBED FROM A LIVE RECON DUMP, NOT HAND-AUTHORED — see M11 planning
// notes and scripts/notion-recon.mjs. Captured live against app.notion.com on 2026-08-20/21:
//
//   - The page title is an <h1 role="textbox" aria-roledescription="page title"
//     contenteditable="true"> — confirmed the only role present anywhere on body content.
//   - Body content carries NO role attributes at all (confirmed: `rolesPresentOnPage` from the
//     live dump had zero roles matching text blocks — only the title had one). This is why
//     notionScript.ts identifies the append target by `data-block-id` + document order, not
//     by role + accessible name the way gmailScript.ts does for Gmail.
//   - `.notion-page-content` genuinely scopes to the page body — a broader guess
//     (`.notion-scroller`) matched the SIDEBAR's scroller first in document order in the real
//     page, which is exactly the kind of wrong-guess this transcription discipline exists to
//     catch before it reaches production code.
//   - The FIRST `[data-block-id]` element is the page's own wrapper block (its id matches the
//     page itself) — confirmed live: `R3_blocks.first` was the page-block div, not real
//     content.
//
// WHAT THIS DOES NOT PROVE, same honesty as gmailScript.test.ts: this proves the FINDING
// logic — which element is the title, which is the last real block, refusing when there is
// nothing to anchor an append after. It does NOT prove that real CDP-level click/keyboard
// input (issued by ChromeNotion.ts, not by this script) actually lands text where expected —
// only a live run against real Notion shows that, and that mechanism is exactly why
// notionScript.ts only FINDS and READS rather than also ACTING, unlike gmailScript.ts.

const PAGE_ID = "35317009-9987-8025-86a8-f069ac9a40c3";

function render(html: string): ScriptDocument {
  doc.body.innerHTML = html;
  return doc;
}

const TITLED_PAGE = `
  <h1 id=":rk:" role="textbox" aria-roledescription="page title" aria-multiline="true"
      placeholder="New page" contenteditable="true" class="content-editable-leaf-rtl notranslate">Launch plan</h1>
  <div class="notion-page-content">
    <div data-block-id="${PAGE_ID}" dir="ltr" class="notion-selectable notion-page-block">Launch plan</div>
    <div data-block-id="35317009-9987-801a-0001-000000000001" dir="auto" class="notion-selectable notion-text-block">Kickoff is Monday.</div>
    <div data-block-id="35317009-9987-801a-0002-000000000002" dir="auto" class="notion-selectable notion-text-block">Alex owns the deck.</div>
  </div>
`;

const BLANK_PAGE = `
  <h1 id=":rk:" role="textbox" aria-roledescription="page title" aria-multiline="true"
      placeholder="New page" contenteditable="true" class="content-editable-leaf-rtl notranslate"></h1>
  <div class="notion-page-content">
    <div data-block-id="${PAGE_ID}" dir="ltr" class="notion-selectable notion-page-block"></div>
  </div>
`;

describe("hasEditablePage (tab selection)", () => {
  it("is true when a page title element is present", () => {
    const result = notionAgent(render(TITLED_PAGE), "hasEditablePage");
    expect(result).toEqual({ ok: true, value: true });
  });

  it("is false on a page with no title element at all (still loading, wrong page)", () => {
    const result = notionAgent(render("<div>loading…</div>"), "hasEditablePage");
    expect(result).toEqual({ ok: true, value: false });
  });
});

describe("readOpenPage (SAFE)", () => {
  it("reads the title and the page content, scoped to .notion-page-content", () => {
    const result = notionAgent(render(TITLED_PAGE), "readOpenPage");
    expect(result.ok).toBe(true);
    const page = (result as { ok: true; value: { title: string | null; body: string } }).value;
    expect(page.title).toBe("Launch plan");
    expect(page.body).toContain("Kickoff is Monday.");
    expect(page.body).toContain("Alex owns the deck.");
  });

  it("reports a blank title as null, not an empty string", () => {
    const result = notionAgent(render(BLANK_PAGE), "readOpenPage");
    expect(result.ok).toBe(true);
    const page = (result as { ok: true; value: { title: string | null } }).value;
    expect(page.title).toBeNull();
  });

  it("never reads sidebar content into the body — only .notion-page-content", () => {
    const html = `
      <div class="notion-scroller">RecentsNew pagePrivateWelcome to Notion</div>
      ${TITLED_PAGE}
    `;
    const result = notionAgent(render(html), "readOpenPage");
    const page = (result as { ok: true; value: { body: string } }).value;
    expect(page.body).not.toContain("Recents");
    expect(page.body).not.toContain("Welcome to Notion");
  });

  it("refuses when no page is open at all", () => {
    const result = notionAgent(render("<div>loading…</div>"), "readOpenPage");
    expect(result).toEqual({
      ok: false,
      reason: "No Notion page is open here — open one and try again.",
    });
  });
});

describe("locateAppendTarget (SAFE — finds, never acts)", () => {
  it("targets the LAST real content block, not the page's own wrapper block", () => {
    const result = notionAgent(render(TITLED_PAGE), "locateAppendTarget");
    expect(result.ok).toBe(true);
    const target = (result as { ok: true; value: { blockId: string } }).value;
    expect(target.blockId).toBe("35317009-9987-801a-0002-000000000002");
    expect(target.blockId).not.toBe(PAGE_ID);
  });

  it("returns numeric viewport coordinates to click", () => {
    const result = notionAgent(render(TITLED_PAGE), "locateAppendTarget");
    const target = (result as { ok: true; value: { x: number; y: number } }).value;
    expect(typeof target.x).toBe("number");
    expect(typeof target.y).toBe("number");
  });

  it("refuses on a page with no real content block to anchor after — never guesses", () => {
    // Only the page's own wrapper block exists (a genuinely blank page) — there is nothing
    // honest to call "the end of the page" yet.
    const result = notionAgent(render(BLANK_PAGE), "locateAppendTarget");
    expect(result.ok).toBe(false);
  });

  it("refuses when there are no blocks at all", () => {
    const result = notionAgent(render("<h1>hi</h1>"), "locateAppendTarget");
    expect(result.ok).toBe(false);
  });
});
