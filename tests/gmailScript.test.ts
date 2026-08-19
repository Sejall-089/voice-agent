// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  gmailAgent,
  type ScriptDocument,
  type ScriptElement,
  type ScriptEmail,
} from "../src/core/gmail/gmailScript.ts";

// The jsdom globals, typed locally. `tsconfig.node.json` deliberately gives /core, /main and
// /tests NO DOM lib, so that a stray `doc.` in the headless brain stays a compile error;
// widening the project's libs to typecheck one test file would remove that guard. Naming the
// exact surface used here costs a few lines and keeps it.
interface TestElement extends ScriptElement {
  addEventListener(type: string, handler: () => void): void;
  querySelector(selectors: string): TestElement | null;
  querySelectorAll(selectors: string): ArrayLike<TestElement>;
}
interface TestDocument extends ScriptDocument {
  body: { innerHTML: string };
  activeElement: unknown;
  querySelector(selectors: string): TestElement | null;
  querySelectorAll(selectors: string): ArrayLike<TestElement>;
}
const doc = (globalThis as Record<string, unknown>)["document"] as TestDocument;
const win = (globalThis as Record<string, unknown>)["window"] as {
  getSelection(): { isCollapsed: boolean; toString(): string } | null;
};

// The injected script, run against a hand-built Gmail-shaped DOM.
//
// BE CLEAR ABOUT WHAT THIS PROVES. It does NOT prove the selectors match real Gmail — the
// fixture below is something this repo wrote, and Gmail's markup is Gmail's to change. What it
// proves is the part that decides whether we act at all: find things by role and accessible
// name, refuse when nothing matches, refuse when SEVERAL match, and never fall back to guessing.
// That logic is what stands between a spoken instruction and a click, so it is tested here even
// though the DOM it will meet in production is only checked live.

function render(html: string): ScriptDocument {
  doc.body.innerHTML = html;
  return doc;
}

const OPEN_EMAIL = `
  <h2 data-thread-perm-id="t1">Tuesday sync</h2>
  <div data-message-id="m1">
    <span email="alex@example.com">Alex</span>
    <div class="a3s">Can you make the sync on Tuesday at 3pm?</div>
  </div>
  <div role="button" aria-label="Reply">Reply</div>
  <div role="button" aria-label="Reply all">Reply all</div>
`;

const REPLY_OPEN = `
  ${OPEN_EMAIL}
  <div role="dialog">
    <span email="alex@example.com">Alex</span>
    <div role="textbox" aria-label="Message Body" contenteditable="true" tabindex="1">Thanks — Thursday works better.</div>
    <div role="button" aria-label="Send ‪(Ctrl-Enter)‬">Send</div>
  </div>
`;

describe("reading (SAFE)", () => {
  it("reads the open message: subject, sender and body", () => {
    const result = gmailAgent(render(OPEN_EMAIL), "readOpenEmail");
    expect(result.ok).toBe(true);
    const email = (result as { ok: true; value: ScriptEmail }).value;
    expect(email.subject).toBe("Tuesday sync");
    expect(email.from).toBe("alex@example.com");
    expect(email.body).toContain("Tuesday at 3pm");
  });

  it("reports no open message rather than returning an empty one", () => {
    const result = gmailAgent(render("<div>inbox list</div>"), "readOpenEmail");
    expect(result).toMatchObject({ ok: false });
    expect(gmailAgent(render("<div>inbox list</div>"), "hasOpenMessage")).toMatchObject({
      value: false,
    });
  });

  it("ignores messages Gmail is keeping hidden", () => {
    const page = render(`<div data-message-id="old" aria-hidden="true">old collapsed message</div>`);
    expect(gmailAgent(page, "hasOpenMessage")).toMatchObject({ value: false });
  });

  it("reads the recipients off the compose box, not off the original email", () => {
    const page = render(`
      <div data-message-id="m1"><span email="someone-else@example.com">Other</span>
        <div class="a3s">hi</div></div>
      <div role="dialog">
        <span email="alex@example.com">Alex</span>
        <div role="textbox" aria-label="Message Body" contenteditable="true" tabindex="1">draft</div>
      </div>
    `);
    expect(gmailAgent(page, "readComposeRecipients")).toMatchObject({
      ok: true,
      value: "alex@example.com",
    });
  });

  it("answers 'no reply box' with null rather than an error — it is a question, not a failure", () => {
    expect(gmailAgent(render(OPEN_EMAIL), "readComposeText")).toMatchObject({
      ok: true,
      value: null,
    });
  });
});

describe("finding controls (the default-deny rule)", () => {
  it("clicks Reply — and not Reply all, which would email people the user didn't choose", () => {
    const page = render(OPEN_EMAIL);
    const clicked: string[] = [];
    for (const button of Array.from(doc.querySelectorAll('[role="button"]'))) {
      button.addEventListener("click", () =>
        clicked.push(button.getAttribute("aria-label") ?? ""),
      );
    }

    expect(gmailAgent(page, "openReplyBox")).toMatchObject({ ok: true });
    expect(clicked).toEqual(["Reply"]);
  });

  it("refuses when the control simply isn't there", () => {
    const result = gmailAgent(render(`<div data-message-id="m1"><div class="a3s">hi</div></div>`), "openReplyBox");
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/could not find the reply button/i);
  });

  it("refuses when SEVERAL controls match — it will not pick one", () => {
    const page = render(`
      ${OPEN_EMAIL}
      <div role="button" aria-label="Reply">Reply</div>
    `);
    const result = gmailAgent(page, "openReplyBox");
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/refusing to guess/i);
  });

  it("matches on role and accessible name, never on class or position", () => {
    // Looks like Gmail's Reply button in every way except the two that count.
    const page = render(`
      ${OPEN_EMAIL.replace('<div role="button" aria-label="Reply">Reply</div>', "")}
      <div class="T-I J-J5-Ji" tabindex="0">Reply</div>
    `);
    expect(gmailAgent(page, "openReplyBox")).toMatchObject({ ok: false });
  });

  it("does not treat a hidden Reply in a collapsed menu as a candidate", () => {
    const page = render(`
      ${OPEN_EMAIL}
      <div aria-hidden="true"><div role="button" aria-label="Reply">Reply</div></div>
    `);
    // Exactly one VISIBLE match remains, so this succeeds rather than failing as ambiguous.
    expect(gmailAgent(page, "openReplyBox")).toMatchObject({ ok: true });
  });
});

describe("sending (DANGEROUS)", () => {
  it("finds Send through the bidi characters Gmail wraps its label in", () => {
    const page = render(REPLY_OPEN);
    let sent = 0;
    doc.querySelector('[aria-label^="Send"]')?.addEventListener("click", () => {
      sent += 1;
    });

    expect(gmailAgent(page, "clickSend")).toMatchObject({ ok: true, value: "sent" });
    expect(sent).toBe(1);
  });

  it("refuses to send when there is no reply box — Send is only ever this reply's Send", () => {
    const page = render(`
      ${OPEN_EMAIL}
      <div role="button" aria-label="Send">Send</div>
    `);
    let sent = 0;
    doc.querySelector('[aria-label="Send"]')?.addEventListener("click", () => {
      sent += 1;
    });

    expect(gmailAgent(page, "clickSend")).toMatchObject({ ok: false });
    expect(sent).toBe(0);
  });

  it("looks for Send inside the reply's own dialog, ignoring another compose window's", () => {
    const page = render(`
      ${REPLY_OPEN}
      <div role="dialog"><div role="button" aria-label="Send">Send</div></div>
    `);
    let wrongSent = 0;
    const dialogs = Array.from(doc.querySelectorAll('[role="dialog"]'));
    dialogs[1]?.querySelector('[role="button"]')?.addEventListener("click", () => {
      wrongSent += 1;
    });

    expect(gmailAgent(page, "clickSend")).toMatchObject({ ok: true });
    expect(wrongSent).toBe(0);
  });
});

describe("replacing the draft", () => {
  it("focuses the reply box and selects all of it, so typing replaces rather than appends", () => {
    const page = render(REPLY_OPEN);
    expect(gmailAgent(page, "focusComposeBox")).toMatchObject({ ok: true });

    const box = doc.querySelector('[aria-label="Message Body"]');
    expect(doc.activeElement).toBe(box);
    // A collapsed selection would mean the next insertText appends — two drafts in one box.
    const selection = win.getSelection();
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.toString()).toContain("Thursday works better");
  });
});
