// The code that actually runs inside the Gmail tab (M10).
//
// TWO CONSTRAINTS SHAPE THIS FILE, AND BOTH MATTER:
//
// 1. `gmailAgent` is SELF-CONTAINED — it imports nothing and references nothing at module
//    scope. That is not style: ChromeGmail ships it into the page with `gmailAgent.toString()`,
//    so anything it closed over would simply not exist there. Every helper lives inside it.
// 2. Because it takes `doc` as a parameter instead of reaching for the global `document`, the
//    exact same function runs under jsdom in `tests/gmailScript.test.ts`. The element-finding
//    logic — the safety-critical part — is therefore deterministically tested, even though the
//    real Gmail DOM is not.
//
// THE SAFETY RULE (clacky's default-deny, core/risk.ts): every INTERACTIVE control is found by
// role + accessible name, and a lookup that matches zero elements OR more than one returns
// `{ ok: false }` and touches nothing. We never fall back to position, index, or class name to
// decide what to click. If we cannot say which button this is, we do not press it.
//
// Reading the message body is the one place structural hooks (`[data-message-id]`, `.a3s`) are
// used, because Gmail exposes no accessible name for prose. That is a SAFE, read-only
// operation — the worst case is reading nothing — so it is held to a lower bar than clicking.
//
// KNOWN LIMIT: the control names below are Gmail's ENGLISH labels. A Gmail UI in another
// language will not match, and the tools will refuse rather than misfire. Localisation is out
// of scope for M10. These selectors are also the one part of this milestone that tests cannot
// prove — they are all in this file precisely so live verification has a single place to fix.

// The DOM surface this script relies on, declared structurally rather than pulled in from the
// `dom` lib. Two reasons, both deliberate:
//
//   - `tsconfig.node.json` gives /core and /main NO DOM types on purpose, so that a stray
//     `document.` in the headless brain is a compile error. Widening the whole project's libs to
//     type one file would quietly remove that guard.
//   - Writing the surface out is documentation: this is the entire contract this milestone has
//     with Gmail's DOM. If it grows, the coupling grew, and that is worth seeing in a diff.
//
// A real `Document`/`Element` (and jsdom's, in the tests) satisfies these structurally.

export interface ScriptNode {
  querySelector(selectors: string): ScriptElement | null;
  querySelectorAll(selectors: string): ArrayLike<ScriptElement>;
}

export interface ScriptElement extends ScriptNode {
  tagName: string;
  textContent: string | null;
  parentElement: ScriptElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  // Optional because a plain Element (an SVG node, say) has none of these, and the point of the
  // checks below is that we never assume.
  style?: { display: string; visibility: string };
  click?: () => void;
  focus?: () => void;
}

export interface ScriptRange {
  selectNodeContents(node: ScriptElement): void;
}

export interface ScriptSelection {
  removeAllRanges(): void;
  addRange(range: ScriptRange): void;
}

export interface ScriptDocument extends ScriptNode {
  getSelection?: () => ScriptSelection | null;
  createRange?: () => ScriptRange;
  execCommand?: (command: string, showUI: boolean, value: string) => boolean;
}

export type ScriptResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface ScriptEmail {
  subject: string | null;
  from: string | null;
  fromName: string | null;
  to: string | null;
  body: string;
}

export type GmailOp =
  | "hasOpenMessage" // tab selection: is a message actually open here?
  | "readOpenEmail" // SAFE
  | "openReplyBox" // CAUTION
  | "hasComposeBox"
  | "readComposeText" // SAFE
  | "readComposeRecipients" // SAFE — who the reply would actually go to
  | "focusComposeBox" // CAUTION — focuses and selects all, so insertText REPLACES
  | "clickSend"; // DANGEROUS — only ever reached past the planner's confirm gate

export function gmailAgent(
  doc: ScriptDocument,
  op: GmailOp,
  text?: string,
): ScriptResult<unknown> {
  // --- helpers (must stay inside: this function is stringified into the page) ---

  // Gmail wraps button labels in invisible bidi control characters (U+202A..U+202E around
  // "(Ctrl-Enter)" on Send), which would otherwise defeat an exact-name match.
  const clean = (text: string): string => {
    let out = "";
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      const bidi =
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      if (!bidi) out += ch;
    }
    return out.replace(/\s+/g, " ").trim();
  };

  const accessibleName = (el: ScriptElement): string => {
    const label = el.getAttribute("aria-label");
    if (label !== null && clean(label).length > 0) return clean(label);
    const title = el.getAttribute("title");
    if (title !== null && clean(title).length > 0) return clean(title);
    return clean(el.textContent ?? "");
  };

  // Gmail keeps whole hidden UIs in the DOM (collapsed menus, the rest of the conversation).
  // Without this, "Reply" matches several times and every lookup would fail as ambiguous.
  const visible = (el: ScriptElement): boolean => {
    let node: ScriptElement | null = el;
    while (node !== null) {
      if (node.getAttribute("aria-hidden") === "true") return false;
      if (node.hasAttribute("hidden")) return false;
      const style = node.style;
      if (
        style !== undefined &&
        (style.display === "none" || style.visibility === "hidden")
      ) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  };

  const matching = (
    root: ScriptNode,
    role: string,
    name: RegExp,
  ): ScriptElement[] => {
    const out: ScriptElement[] = [];
    const candidates = root.querySelectorAll('[role="' + role + '"]');
    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i] as ScriptElement;
      if (!visible(el)) continue;
      if (!name.test(accessibleName(el))) continue;
      out.push(el);
    }
    return out;
  };

  // The default-deny lookup. Zero and many are DIFFERENT failures and are reported as such —
  // "I can't see a Reply button" and "I can see three of them" need different fixes.
  const findOne = (
    root: ScriptNode,
    role: string,
    name: RegExp,
    what: string,
  ): ScriptResult<ScriptElement> => {
    const found = matching(root, role, name);
    const first = found[0];
    if (first === undefined)
      return { ok: false, reason: "Could not find the " + what + " in Gmail." };
    if (found.length > 1) {
      return {
        ok: false,
        reason:
          "Found " +
          String(found.length) +
          " things that look like the " +
          what +
          " — refusing to guess which one to use.",
      };
    }
    return { ok: true, value: first };
  };

  // Pressing something is its own little default-deny: an element we resolved but cannot
  // actually activate is a failure to report, not a click to pretend happened.
  const press = (el: ScriptElement, what: string): ScriptResult<string> => {
    if (typeof el.click !== "function") {
      return {
        ok: false,
        reason: "The " + what + " in Gmail can't be clicked.",
      };
    }
    el.click();
    return { ok: true, value: "clicked" };
  };

  // The compose box. Everything about a reply — reading it, replacing it, finding ITS Send
  // button rather than some other one — hangs off finding this first.
  const composeBox = (): ScriptResult<ScriptElement> =>
    findOne(doc, "textbox", /message body/i, "reply box");

  // The dialog the compose box lives in, so Send is searched for INSIDE the reply being worked
  // on and can never resolve to a different compose window.
  const composeScope = (box: ScriptElement): ScriptNode => {
    let node: ScriptElement | null = box;
    while (node !== null) {
      if (node.getAttribute("role") === "dialog" || node.tagName === "FORM")
        return node;
      node = node.parentElement;
    }
    return doc;
  };

  const openMessage = (): ScriptElement | null => {
    const byId = doc.querySelectorAll("[data-message-id]");
    const shown: ScriptElement[] = [];
    for (let i = 0; i < byId.length; i += 1) {
      const el = byId[i] as ScriptElement;
      if (visible(el)) shown.push(el);
    }
    // A thread shows several messages; the last visible one is the one being replied to.
    const last = shown[shown.length - 1];
    return last === undefined ? null : last;
  };

  const textOf = (el: ScriptElement | null): string =>
    clean(el === null ? "" : (el.textContent ?? ""));

  // --- operations ---

  if (op === "hasOpenMessage") {
    return { ok: true, value: openMessage() !== null };
  }

  if (op === "hasComposeBox") {
    return { ok: true, value: composeBox().ok };
  }

  if (op === "readOpenEmail") {
    const message = openMessage();
    if (message === null) {
      return {
        ok: false,
        reason: "No email is open in Gmail — open one and try again.",
      };
    }
    const body =
      message.querySelector(".a3s") ?? message.querySelector('[dir="ltr"]');
    const bodyText = textOf(body ?? message);
    if (bodyText.length === 0) {
      return {
        ok: false,
        reason:
          "The open email appears to be empty — there is nothing to reply to.",
      };
    }
    const sender = message.querySelector("span[email]");
    const heading =
      doc.querySelector("h2[data-thread-perm-id]") ??
      doc.querySelector('[role="heading"]');
    // Gmail puts the display name in a `name` attribute on this same span; fall back to its
    // text content for layouts that don't set one. Empty string collapses to null, same as
    // every other "nothing there" case in this file.
    const senderName =
      sender === null
        ? null
        : (sender.getAttribute("name") ?? textOf(sender)) || null;
    const email: ScriptEmail = {
      subject: heading === null ? null : textOf(heading) || null,
      from: sender === null ? null : sender.getAttribute("email"),
      fromName: senderName,
      to: null, // the reply's recipient comes from the compose box, not from here
      body: bodyText,
    };
    return { ok: true, value: email };
  }

  if (op === "openReplyBox") {
    // Already open — opening a second one would strand the first, so this is a no-op, not an
    // error. That makes the operation idempotent, which matters because a revision must never
    // accidentally start a second reply.
    if (composeBox().ok) return { ok: true, value: "already-open" };
    // `^reply$` and not `^reply` on purpose: "Reply all" is a different action with different
    // consequences, and choosing it silently would email people the user never meant to include.
    const button = findOne(doc, "link", /^reply$/i, "Reply button");
    if (!button.ok) return button;
    return press(button.value, "Reply button");
  }

  if (op === "readComposeText") {
    const box = composeBox();
    if (!box.ok) return { ok: true, value: null }; // no box open is an answer, not a failure
    return { ok: true, value: box.value.textContent ?? "" };
  }

  if (op === "readComposeRecipients") {
    const box = composeBox();
    if (!box.ok) return box;
    const chips = composeScope(box.value).querySelectorAll(
      "span[email], [data-hovercard-id]",
    );
    const addresses: string[] = [];
    for (let i = 0; i < chips.length; i += 1) {
      const el = chips[i] as ScriptElement;
      if (!visible(el)) continue;
      const address =
        el.getAttribute("email") ?? el.getAttribute("data-hovercard-id") ?? "";
      if (address.indexOf("@") > 0 && addresses.indexOf(address) === -1)
        addresses.push(address);
    }
    return {
      ok: true,
      value: addresses.length > 0 ? addresses.join(", ") : null,
    };
  }

  if (op === "focusComposeBox") {
    const box = composeBox();
    if (!box.ok) return box;
    if (typeof box.value.focus !== "function") {
      return { ok: false, reason: "The Gmail reply box can't be focused." };
    }
    box.value.focus();
    // Select everything so the CDP insertText that follows REPLACES the draft instead of
    // appending to it. Doing it here rather than in the client keeps "replace" atomic with
    // "focus" — there is no window in which the box is focused but the old text is unselected.
    const selection =
      doc.getSelection === undefined ? null : doc.getSelection();
    if (selection !== null && doc.createRange !== undefined) {
      const range = doc.createRange();
      range.selectNodeContents(box.value);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (text !== undefined) {
      if (doc.execCommand === undefined) {
        return {
          ok: false,
          reason: "Can't replace the Gmail reply text in this browser.",
        };
      }
      const inserted = doc.execCommand("insertText", false, text);
      if (!inserted)
        return {
          ok: false,
          reason: "Gmail didn't accept the replacement text.",
        };
      return { ok: true, value: "replaced" };
    }
    return { ok: true, value: "focused" };
  }

  if (op === "clickSend") {
    const box = composeBox();
    if (!box.ok) return box;
    const button = findOne(
      composeScope(box.value),
      "button",
      /^send\b/i,
      "Send button",
    );
    if (!button.ok) return button;
    // Belt and braces past the confirm gate: re-read the label off the element we are ABOUT to
    // click, and refuse if it is not Send. Between the user approving and this line the page
    // could have re-rendered underneath us.
    if (!/^send\b/i.test(accessibleName(button.value))) {
      return {
        ok: false,
        reason:
          "The control that was Send is no longer Send — nothing was sent.",
      };
    }
    const pressed = press(button.value, "Send button");
    if (!pressed.ok) return pressed;
    return { ok: true, value: "sent" };
  }

  return { ok: false, reason: "Unknown Gmail operation: " + String(op) };
}
