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
  onDismissAll(): void;
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

// The list's own button, beside the chime toggle (M27). Fixed here like the row buttons.
export const DISMISS_ALL_LABEL = "Dismiss all";

// The pill's own height and the gap above it (pill.html's stylesheet): what the window needs
// besides the list.
const SUMMARY_HEIGHT = 44;
const GAP = 6;

// How tall the window has to be to show the whole open list without scrolling: the list's
// full content height (its `scrollHeight`, which does not shrink when the box is too small),
// its border, the gap and the pill. Null when the list is not open.
export function measurePill(root: HTMLElement): number | null {
  const list = root.querySelector<HTMLElement>(".list");
  if (list === null) return null;
  const border = list.offsetHeight - list.clientHeight;
  return Math.ceil(list.scrollHeight + border + GAP + SUMMARY_HEIGHT);
}

// How wide the pill would have to be to show each of these labels whole (M27): a hidden copy
// of the pill, at its natural width, with each label in turn. Null when there is no pill drawn.
// It measures and decides nothing — which label is shown, and how wide, is main's call.
export function measureLabels(root: HTMLElement, labels: readonly string[]): number[] | null {
  const summary = root.querySelector<HTMLElement>(".summary");
  if (summary === null || labels.length === 0) return null;
  const probe = summary.cloneNode(true) as HTMLElement;
  // Inline, so it beats both the stylesheet's width and the width this view set on the pill.
  probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;width:max-content;";
  probe.setAttribute("aria-hidden", "true");
  root.append(probe);
  const text = probe.querySelector<HTMLElement>(".label");
  const widths = labels.map((label) => {
    if (text !== null) text.textContent = label;
    return Math.ceil(probe.getBoundingClientRect().width);
  });
  probe.remove();
  return widths;
}

export interface PillReports {
  contentHeight(height: number): void;
  labelWidths(labels: string[], widths: number[]): void;
}

// After a view is drawn: tell main what it needs to size the window. Each figure is reported
// only when the view shows main does not have it yet — otherwise every report would come
// straight back as a new view and be reported again.
export function reportMeasurements(root: HTMLElement, view: PillView, send: PillReports): void {
  const height = measurePill(root);
  if (height !== null && height !== view.contentHeight) send.contentHeight(height);
  const options = view.labelOptions ?? [];
  if (options.length > 0 && view.labelWidths === undefined) {
    const widths = measureLabels(root, options);
    if (widths !== null && widths.every((width) => width > 0)) send.labelWidths([...options], widths);
  }
}

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

    // The list's own row: its heading, and its own buttons — "Dismiss all" (M27) when main
    // offers it, then the chime toggle. Pinned to the top of the list by the stylesheet, so both
    // stay reachable however far the rows are scrolled.
    const header = el(doc, "div", "header");
    header.append(el(doc, "span", "heading", "Background jobs"));
    const controls = el(doc, "div", "controls");
    // Only when main offers it: it covers the done, failed and expired rows listed, and main
    // decides which those are — the page does not tell it.
    if (view.dismissAll === true) {
      const all = el(doc, "button", "dismiss-all", DISMISS_ALL_LABEL);
      all.type = "button";
      all.addEventListener("click", () => handlers.onDismissAll());
      controls.append(all);
    }
    const mute = el(doc, "button", "mute", view.muted ? "Chime off" : "Chime on");
    mute.type = "button";
    mute.setAttribute("aria-pressed", String(view.muted));
    mute.title = view.muted ? "The needs-you chime is muted" : "Mute the needs-you chime";
    mute.addEventListener("click", () => handlers.onMute(!view.muted));
    controls.append(mute);
    header.append(controls);
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
  // As wide as main sized the window for the label (M27); until then, the stylesheet's width.
  if (typeof view.width === "number") summary.style.width = `${view.width}px`;
  summary.append(el(doc, "span", "dot"), el(doc, "span", "label", view.label));
  summary.addEventListener("click", () => handlers.onExpand(!view.expanded));
  root.append(summary);
}
