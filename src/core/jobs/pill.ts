import type { JobState } from "../types.ts";
import type { JobView } from "./JobManager.ts";
import type { PillAction, PillItem, PillMode, PillView } from "./pillView.ts";

export type { PillAction, PillItem, PillMode, PillView };

// What the status pill shows (M23) — every decision about it, with no window in sight.
//
// The pill is a small always-on-top window at the bottom right of the screen. Drawing it and
// placing it are electron's business (src/main/pill/); WHAT it says, which jobs it lists, what
// each row's buttons are and where its rectangle goes are all decided here, as pure functions
// of the job list and a clock, so every one of those can be wrong in a test instead of on a
// screen.
//
// What it shows, most urgent first. The COLOUR is one mode at a time, from the most urgent
// group present; the LABEL counts every group present, in this order — "1 running · 2 done"
// (M27). Until M27 the label counted only the top group, so a running job hid done ones,
// which since M26 can wait indefinitely to be read.
//
//   needs-you   amber. Something is waiting for the user. It PULSES for a moment when a job
//               starts waiting, then holds steady: a pill that never stops moving is noise.
//   failed      stays until each failure is dismissed. Interrupted and expired jobs are
//               shown the same way — each is something that did not happen.
//   running     a count.
//   done        green, "N done", until its list has been opened with it in it — then a minute
//               more (M26). Until M26 it faded after 8 s whether anyone had looked or not.
//   hidden      no window at all.

export const PULSE_MS = 2_400;

// How long the list stays open with the pointer off it.
export const IDLE_COLLAPSE_MS = 10_000;

export interface PillState {
  jobs: readonly JobView[];
  now: number;
  // Is the list open? IN MEMORY ONLY, and it only ever becomes true by a click on the pill.
  // It is not a preference: it is never written to settings, an app that restarts starts
  // collapsed, and everything that means "the user has moved on" sets it back to false — see
  // `reducePill`. Found live: it used to be flipped by the click and by nothing else, so a
  // list opened once stayed open for every later job, as if the app had remembered a choice.
  expanded: boolean;
  muted: boolean;
  // Until when the pill pulses, or null.
  pulseUntil: number | null;
  // Is the pointer over the pill's window? The window cannot take focus, so there is no blur
  // to close the list on; where the pointer is stands in for it.
  hovering: boolean;
  // When an open list closes by itself, or null while the pointer is on it (or it is closed).
  collapseAt: number | null;
  // How tall the open list's content is, as the page measured it, or null before it has.
  contentHeight: number | null;
  // How wide each way of writing the label is, as the page measured it — kept with the labels
  // it measured, so a measurement of an older label is never applied to a newer one. Kept when
  // the list closes: it is about the label, not the list.
  labelMeasure: { labels: readonly string[]; widths: readonly number[] } | null;
}

export type PillEvent =
  | { type: "jobs"; jobs: readonly JobView[]; now: number }
  | { type: "tick"; now: number }
  // A click on the pill itself: open, or close.
  | { type: "expand"; expanded: boolean; now: number }
  // Anything that means the user has moved on: the hotkey, a new instruction, Review… or
  // Resume. NOT Dismiss or Cancel since M27: those leave the list open while anything is still
  // listed, and it closes when the last row goes (the `jobs` case below).
  | { type: "collapse" }
  // The pointer entered or left the pill's window.
  | { type: "hover"; inside: boolean; now: number }
  // The page measured the open list.
  | { type: "measured"; height: number }
  // The page measured these ways of writing the label (M27).
  | { type: "labelMeasured"; labels: readonly string[]; widths: readonly number[] }
  | { type: "mute"; muted: boolean };

export function initialPillState(muted: boolean, now: number): PillState {
  return {
    jobs: [],
    now,
    expanded: false,
    muted,
    pulseUntil: null,
    hovering: false,
    collapseAt: null,
    contentHeight: null,
    labelMeasure: null,
  };
}

const closed = (state: PillState): PillState => ({
  ...state,
  expanded: false,
  collapseAt: null,
  contentHeight: null,
});

export function reducePill(state: PillState, event: PillEvent): PillState {
  switch (event.type) {
    case "jobs": {
      // A pulse starts when a job is waiting that was not waiting a moment ago — never
      // because the list was merely re-sent while it waits.
      const wasWaiting = new Set(
        state.jobs.filter((job) => job.state === "needs-you").map((job) => job.id),
      );
      const newlyWaiting = event.jobs.some(
        (job) => job.state === "needs-you" && !wasWaiting.has(job.id),
      );
      // NOTE WHAT IS NOT HERE: nothing about a job — a new one, one that starts waiting, one
      // that fails — ever opens the list. Attention is asked for by the pulse and the chime.
      const next: PillState = {
        ...state,
        jobs: event.jobs,
        now: event.now,
        pulseUntil: newlyWaiting ? event.now + PULSE_MS : state.pulseUntil,
      };
      // And when there is nothing left to show, an open list is closed for good — so the pill
      // does not come back already open for the next job.
      return next.expanded && !event.jobs.some((job) => isShown(job, event.now)) ? closed(next) : next;
    }
    case "tick": {
      const next: PillState = { ...state, now: event.now };
      if (!next.expanded) return next;
      // Ten seconds with the pointer off it.
      if (next.collapseAt !== null && event.now >= next.collapseAt) return closed(next);
      // Or everything in it has faded away.
      return next.jobs.some((job) => isShown(job, event.now)) ? next : closed(next);
    }
    case "expand":
      if (!event.expanded) return closed(state);
      return {
        ...state,
        expanded: true,
        contentHeight: null,
        // The click that opened it is the pointer being on it; the countdown starts when it
        // leaves. If it is somehow known to be elsewhere, the countdown starts now.
        collapseAt: state.hovering ? null : event.now + IDLE_COLLAPSE_MS,
      };
    case "collapse":
      return state.expanded ? closed(state) : state;
    case "hover":
      return {
        ...state,
        hovering: event.inside,
        // Back on the list: the countdown is cancelled outright, not paused. Off it: a fresh
        // ten seconds from now.
        collapseAt: !state.expanded || event.inside ? null : event.now + IDLE_COLLAPSE_MS,
      };
    case "measured":
      // Only while open, and only a real height. The window is sized from this (`pillSize`).
      if (!state.expanded || !Number.isFinite(event.height) || event.height <= 0) return state;
      return { ...state, contentHeight: Math.ceil(event.height) };
    case "labelMeasured": {
      // Only for the labels the pill is showing NOW, one real width each. A report of labels
      // that have since changed is dropped; the page measures the new ones when it draws them.
      const now = labelOptions(labelGroups(state));
      const matches =
        sameStrings(event.labels, now) &&
        event.widths.length === now.length &&
        event.widths.every((width) => Number.isFinite(width) && width > 0);
      if (!matches) return state;
      return { ...state, labelMeasure: { labels: now, widths: event.widths.map((width) => Math.ceil(width)) } };
    }
    case "mute":
      return { ...state, muted: event.muted };
  }
}

const TITLE_CHARS = 64;
// Long enough for every sentence this app writes about a job (the longest, the interrupted
// and stopped-chain messages, are under 300), so those are shown whole and WRAPPED. Only
// something longer — a tool's own result — is cut, and then at a word.
const DETAIL_CHARS = 420;

// One line of text, at most `max` characters. Cut BETWEEN WORDS and ended with an ellipsis,
// never mid-word: a message that stops at "Check before try" reads as broken, and one that
// stops at "Check before…" reads as shortened. A single word longer than the limit has no
// boundary to cut at and is cut where it must be.
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max - 1);
  // Whole words only: if the cut landed inside a word, back up to the space before it.
  const cutInsideWord = flat.charAt(max - 1) !== " ";
  const lastSpace = head.lastIndexOf(" ");
  const kept = cutInsideWord && lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${kept.replace(/[\s,;:.\-—]+$/, "")}…`;
}

// How long a failed or expired job stays in the pill AFTER the user has seen it.
export const SEEN_CLEAR_MS = 60 * 60 * 1000;

// How long a DONE job stays in the pill after the user has seen it (M26). Short, because a done
// job asked nothing of the user: the minute is for finishing reading its result in the open list,
// not for being reminded of it. Tunable; the rule is "until seen", this is only the tail after.
export const DONE_SEEN_CLEAR_MS = 60 * 1000;
// How many jobs the open list shows. Older ones are not listed; nothing is deleted.
export const LIST_CAP = 10;

// How long each kind of job stays in the pill. THE PILL ONLY — leaving it deletes nothing:
// the job's record and its action-log rows are untouched (core/jobs/JobStore.ts).
//
//   running, queued, needs-you   while they are.
//   done                         UNTIL THE USER HAS SEEN IT, then DONE_SEEN_CLEAR_MS (M26). It
//                                used to fade after 8 s — safe while only the hotkey detached
//                                jobs, which left sends and creates behind. M25's outside click
//                                sends THINKING jobs here, often a summary whose result is the
//                                point, and live testing watched that result vanish unread.
//   cancelled                    not at all. The user did that; there is nothing to tell them.
//   failed, expired              UNTIL THE USER HAS SEEN IT, however long that takes — the
//                                pill stays red for a week if nobody opens it. "Seen" is the
//                                list being open with the job in it (`seenAt`, saved with the
//                                job). One hour after that it goes on its own.
//   interrupted                  until it is dismissed, and only then. It may say "may or may
//                                not have gone through", and that must not expire quietly.
//
// A dismissed job is gone at once, whatever it was.
function isShown(job: JobView, now: number): boolean {
  if (job.kind !== "work" || !job.background || job.acknowledged) return false;
  switch (job.state) {
    case "done":
      return job.seenAt === null || now - job.seenAt < DONE_SEEN_CLEAR_MS;
    case "cancelled":
      return false;
    case "failed":
    case "expired":
      return job.seenAt === null || now - job.seenAt < SEEN_CLEAR_MS;
    default:
      return true;
  }
}

const STOPPED: readonly JobState[] = ["failed", "interrupted", "expired"];

function detailOf(job: JobView): string {
  const where = job.total > 1 && job.step > 0 ? `Step ${job.step} of ${job.total}` : "";
  const tool = job.tool ?? "";
  const at = [where, tool].filter((part) => part.length > 0).join(" · ");
  switch (job.state) {
    case "needs-you":
      return job.waitingFor === "foreground-only"
        ? `Needs you at the screen${at ? ` — ${at}` : ""}`
        : `Needs your OK${at ? ` — ${at}` : ""}`;
    case "queued":
      return "Queued — starts when a running job finishes";
    case "running":
      // CANCELLING (M27): cancel was pressed, but a step in flight finishes first (§5c). Until
      // M27 the row went on saying "Running" and offered Cancel again, so a press seemed to do
      // nothing. A job still planning has no step yet: it stops before its first one.
      if (job.cancelRequested) {
        return job.step > 0
          ? `Cancelling — finishing step ${job.step} of ${job.total}`
          : "Cancelling — stops before its first step";
      }
      return at.length > 0 ? `Running — ${at}` : "Working…";
    default: {
      const said = job.result ?? job.lines[job.lines.length - 1] ?? "";
      return clip(said, DETAIL_CHARS);
    }
  }
}

function actionsOf(job: JobView): PillAction[] {
  if (job.state === "needs-you") {
    return [job.waitingFor === "foreground-only" ? "resume" : "review", "cancel"];
  }
  // No second Cancel on a job already cancelling (M27): there is nothing more it could do.
  if (job.state === "running" || job.state === "queued") return job.cancelRequested ? [] : ["cancel"];
  return ["dismiss"];
}

// What "Dismiss all" acts on (M27): the rows LISTED right now that have ended and asked nothing
// — done, failed, expired. Never a running, queued or waiting job: it would have to be
// cancelled, and Dismiss all cancels nothing. Never an INTERRUPTED one: it may say "may or may
// not have gone through", which is why it stays until dismissed on its own (§5c), and a bulk
// button would let it go unread. Never a job past the list's cap: it is not on screen.
const DISMISS_ALL_STATES: readonly string[] = ["done", "failed", "expired"];

export function dismissAllTargets(items: readonly PillItem[]): string[] {
  return items
    .filter((item) => DISMISS_ALL_STATES.includes(item.state) && item.actions.includes("dismiss"))
    .map((item) => item.id);
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

interface LabelGroup {
  mode: Exclude<PillMode, "hidden">;
  count: number;
  text: string;
}

// Every group with something in it, MOST URGENT FIRST: needs-you, didn't finish, running,
// done. The first one is the pill's colour. Cancelled jobs are never shown, so never counted.
function labelGroups(state: PillState): LabelGroup[] {
  const shown = state.jobs.filter((job) => isShown(job, state.now));
  const count = (test: (job: JobView) => boolean): number => shown.filter(test).length;
  const groups: LabelGroup[] = [
    { mode: "needs-you", count: count((job) => job.state === "needs-you"), text: "" },
    { mode: "failed", count: count((job) => STOPPED.includes(job.state)), text: "" },
    { mode: "running", count: count((job) => job.state === "running" || job.state === "queued"), text: "" },
    { mode: "done", count: count((job) => job.state === "done"), text: "" },
  ];
  const words: Record<LabelGroup["mode"], [string, string]> = {
    "needs-you": ["needs you", "need you"],
    failed: ["didn't finish", "didn't finish"],
    running: ["running", "running"],
    done: ["done", "done"],
  };
  return groups
    .filter((group) => group.count > 0)
    .map((group) => ({ ...group, text: countLabel(group.count, ...words[group.mode]) }));
}

const LABEL_SEPARATOR = " · ";

// Every way of writing the label, LONGEST FIRST: all the groups; then one group fewer, with
// "+N more" for the JOBS in the groups left off; down to the top group alone plus "+N more".
// The top group is never the one left off — it is the colour, and the most urgent.
function labelOptions(groups: readonly LabelGroup[]): string[] {
  if (groups.length === 0) return [];
  const options = [groups.map((group) => group.text).join(LABEL_SEPARATOR)];
  for (let keep = groups.length - 1; keep >= 1; keep -= 1) {
    const more = groups.slice(keep).reduce((sum, group) => sum + group.count, 0);
    options.push([...groups.slice(0, keep).map((group) => group.text), `+${more} more`].join(LABEL_SEPARATOR));
  }
  return options;
}

// Which label to show and how wide to draw the pill for it: the LONGEST option whose measured
// width is within the cap, and the pill at that width (never narrower than the M23 pill). If
// none fits — a very large font — the shortest, at the cap, where the stylesheet ellipsizes it.
function pickLabel(widths: readonly number[]): { index: number; width: number } {
  const fits = widths.findIndex((width) => width <= PILL_LABEL_MAX_WIDTH);
  const index = fits === -1 ? widths.length - 1 : fits;
  const wanted = widths[index] ?? PILL_COLLAPSED.width;
  return { index, width: Math.max(PILL_COLLAPSED.width, Math.min(PILL_LABEL_MAX_WIDTH, wanted)) };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((text, index) => text === b[index]);
}

export function pillView(state: PillState): PillView {
  const shown = state.jobs.filter((job) => isShown(job, state.now));
  const groups = labelGroups(state);
  const top = groups.at(0);
  const mode: PillMode = top === undefined ? "hidden" : top.mode;
  const options = labelOptions(groups);

  // The label as measured, when the page has measured exactly these options. Until it has
  // (the first frame after the counts change), the full label is drawn at the width the LAST
  // measurement chose, so the pill does not shrink for a frame and grow again.
  const measure = state.labelMeasure;
  const measured = measure !== null && sameStrings(measure.labels, options) ? measure.widths : null;
  const chosen = measured !== null ? pickLabel(measured) : null;
  const label = options[chosen?.index ?? 0] ?? "";
  const width = chosen?.width ?? (measure !== null ? pickLabel(measure.widths).width : undefined);

  // Waiting first, then what did not finish, then the rest — the order someone opening the
  // list needs them in.
  const rank = (job: JobView): number =>
    job.state === "needs-you" ? 0 : STOPPED.includes(job.state) ? 1 : 2;
  // THE LIST IS CAPPED (`LIST_CAP`): the ten most recent. A job that is waiting for the user
  // is never the one left off — it is listed ahead of any job that has merely ended, however
  // old it is, because the list is the only place it can be answered from. A job past the cap
  // is still counted in the label above, still in the store, and is listed again as the ones
  // in front of it clear; it is not "seen" until then.
  const listed = [...shown]
    .sort((a, b) => Math.min(rank(a), 1) - Math.min(rank(b), 1) || b.updatedAt - a.updatedAt)
    .slice(0, LIST_CAP);
  const items = listed
    .sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt)
    .map((job) => ({
      id: job.id,
      title: clip(job.instruction, TITLE_CHARS),
      state: job.state,
      detail: detailOf(job),
      actions: actionsOf(job),
    }));

  return {
    mode,
    label,
    // Only ever while something is actually waiting: a pulse outliving the wait would be
    // pointing at nothing.
    pulse: mode === "needs-you" && state.pulseUntil !== null && state.now < state.pulseUntil,
    expanded: state.expanded && mode !== "hidden",
    muted: state.muted,
    items,
    ...(state.expanded && dismissAllTargets(items).length > 0 ? { dismissAll: true } : {}),
    ...(state.expanded && state.contentHeight !== null ? { contentHeight: state.contentHeight } : {}),
    ...(mode !== "hidden" ? { labelOptions: options } : {}),
    ...(measured !== null && mode !== "hidden" ? { labelWidths: [...measured] } : {}),
    ...(width !== undefined && mode !== "hidden" ? { width } : {}),
  };
}

// --- Where it goes ---

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Is this screen point inside this rectangle? (The pointer, and the pill's window.) Edges on
// the left and top are inside; on the right and bottom, outside — the usual half-open box.
export function isPointInRect(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

export const PILL_MARGIN = 16;
// The collapsed pill at its narrowest — the M23 pill, which one group always fits.
export const PILL_COLLAPSED = { width: 232, height: 44 } as const;
const PILL_EXPANDED_WIDTH = 348;
// How wide the collapsed pill may grow to fit every group in its label (M27): the open list's
// width, so opening the list never makes the pill itself jump. Past it, "+N more".
export const PILL_LABEL_MAX_WIDTH = PILL_EXPANDED_WIDTH;
const PILL_ROW_HEIGHT = 84;
const PILL_CHROME_HEIGHT = 96;
const PILL_MAX_HEIGHT = 440;

// How big the pill's window is. Collapsed: as wide as its label, as the page measured it
// (`width`, between PILL_COLLAPSED.width and PILL_LABEL_MAX_WIDTH), and a fixed height. Open:
// AS TALL AS ITS CONTENT, up to a ceiling — the page measures the list and reports it
// (`contentHeight`), so one job with a long message gets a taller panel and no scrollbar,
// where a fixed height per row used to clip the message and scroll. Before the page has
// measured (the first frame after a click) an estimate from the row count stands in. Past the
// ceiling the list scrolls.
export function pillSize(
  view: Pick<PillView, "expanded" | "items" | "contentHeight" | "width">,
): { width: number; height: number } {
  const pillWidth =
    typeof view.width === "number" && Number.isFinite(view.width)
      ? Math.max(PILL_COLLAPSED.width, Math.min(PILL_LABEL_MAX_WIDTH, Math.ceil(view.width)))
      : PILL_COLLAPSED.width;
  if (!view.expanded) return { width: pillWidth, height: PILL_COLLAPSED.height };
  const estimated = PILL_CHROME_HEIGHT + Math.max(1, view.items.length) * PILL_ROW_HEIGHT;
  const wanted = typeof view.contentHeight === "number" ? view.contentHeight : estimated;
  const height = Math.max(PILL_COLLAPSED.height, Math.min(PILL_MAX_HEIGHT, Math.ceil(wanted)));
  return { width: Math.max(PILL_EXPANDED_WIDTH, pillWidth), height };
}

// The pill's rectangle: the bottom-right corner of a display's WORK AREA (the screen minus
// the taskbar), inset by a margin.
//
// Everything here is in DIP, which is the space electron reports a work area in and the space
// it places a window in. THERE IS NO SCALE FACTOR IN THIS FUNCTION, and that is deliberate
// (core/types.ts, `DisplayBounds`): at 100%, 150% and 200% the same work area in DIP gives the
// same answer, and a version that multiplied or divided by one would be right on exactly one
// of them. The work area's own origin is carried through, because a second monitor's does not
// start at (0, 0) — it may be negative.
//
// A pill larger than the work area is shrunk to fit and kept on that display rather than
// allowed to hang off its edge onto a neighbour.
export function pillBounds(
  workArea: Rect,
  size: { width: number; height: number },
  margin: number = PILL_MARGIN,
): Rect {
  const width = Math.max(1, Math.min(Math.round(size.width), workArea.width - 2 * margin));
  const height = Math.max(1, Math.min(Math.round(size.height), workArea.height - 2 * margin));
  return {
    x: Math.round(workArea.x + workArea.width - width - margin),
    y: Math.round(workArea.y + workArea.height - height - margin),
    width,
    height,
  };
}
