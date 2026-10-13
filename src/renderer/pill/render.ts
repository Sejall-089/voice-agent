import type { PillAction, PillView } from "../../core/jobs/pillView.ts";

// Drawing the status pill (M23). One function from a view to DOM, with no state of its own:
// main decides everything (core/jobs/pill.ts) and this draws it.
//
// EVERY STRING IS SET WITH `textContent`. A row's title is the user's instruction and its
// detail can be a tool's result — an email, a ticket, text someone else wrote. None of it is
// ever parsed as HTML, and no link is made out of any of it.
//
// THE BUTTON LABELS ARE FIXED HERE, by action, and never come from the view: a button reads
// as a command, and the same rule that keeps a confirm dialog's approve label in a tool's code
// (CLAUDE.md, M21) keeps these out of reach of anything a job produced.

export interface PillHandlers {
  onAction(id: string, action: PillAction): void;
  onExpand(expanded: boolean): void;
  onMute(muted: boolean): void;
}

// "Review…" with an ellipsis on purpose: it opens a dialog and decides nothing itself.
export const ACTION_LABEL: Readonly<Record<PillAction, string>> = {
  review: "Review…",
  resume: "Resume",
  cancel: "Cancel",
  dismiss: "Dismiss",
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderPill(root: HTMLElement, view: PillView, handlers: PillHandlers): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.className = `pill mode-${view.mode}${view.pulse ? " pulse" : ""}${view.expanded ? " expanded" : ""}`;
  if (view.mode === "hidden") return;

  if (view.expanded) {
    const list = el(doc, "div", "list");

    const header = el(doc, "div", "header");
    header.append(el(doc, "span", "heading", "Background jobs"));
    const mute = el(doc, "button", "mute", view.muted ? "Chime off" : "Chime on");
    mute.type = "button";
    mute.setAttribute("aria-pressed", String(view.muted));
    mute.title = view.muted ? "The needs-you chime is muted" : "Mute the needs-you chime";
    mute.addEventListener("click", () => handlers.onMute(!view.muted));
    header.append(mute);
    list.append(header);

    if (typeof view.notice === "string" && view.notice.length > 0) {
      list.append(el(doc, "div", "notice", view.notice));
    }

    for (const item of view.items) {
      const row = el(doc, "div", `row state-${item.state}`);
      row.dataset["job"] = item.id;
      row.append(el(doc, "div", "title", item.title));
      if (item.detail.length > 0) row.append(el(doc, "div", "detail", item.detail));
      const buttons = el(doc, "div", "buttons");
      for (const action of item.actions) {
        const button = el(doc, "button", `action action-${action}`, ACTION_LABEL[action]);
        button.type = "button";
        button.addEventListener("click", () => handlers.onAction(item.id, action));
        buttons.append(button);
      }
      row.append(buttons);
      list.append(row);
    }
    root.append(list);
  }

  // The pill itself: one button, the whole width. Clicking it opens or closes the list.
  const summary = el(doc, "button", "summary");
  summary.type = "button";
  summary.setAttribute("aria-expanded", String(view.expanded));
  summary.append(el(doc, "span", "dot"), el(doc, "span", "label", view.label));
  summary.addEventListener("click", () => handlers.onExpand(!view.expanded));
  root.append(summary);
}
