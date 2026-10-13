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
// What it shows, most urgent first — one mode at a time:
//
//   needs-you   amber. Something is waiting for the user. It PULSES for a moment when a job
//               starts waiting, then holds steady: a pill that never stops moving is noise.
//   failed      stays until each failure is dismissed. Interrupted and expired jobs are
//               shown the same way — each is something that did not happen.
//   running     a count.
//   done        shown briefly, then gone. Nothing was asked of the user.
//   hidden      no window at all.

export const DONE_FADE_MS = 8_000;
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
}

export type PillEvent =
  | { type: "jobs"; jobs: readonly JobView[]; now: number }
  | { type: "tick"; now: number }
  // A click on the pill itself: open, or close.
  | { type: "expand"; expanded: boolean; now: number }
  // Anything that means the user has moved on: the hotkey, a new instruction, a row's button.
  | { type: "collapse" }
  // The pointer entered or left the pill's window.
  | { type: "hover"; inside: boolean; now: number }
  // The page measured the open list.
  | { type: "measured"; height: number }
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

function isShown(job: JobView, now: number): boolean {
  if (job.kind !== "work" || !job.background || job.acknowledged) return false;
  // Finished cleanly, or cancelled by the user's own hand: shown briefly, then gone.
  if (job.state === "done" || job.state === "cancelled") return now - job.updatedAt < DONE_FADE_MS;
  return true;
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
  if (job.state === "running" || job.state === "queued") return ["cancel"];
  return ["dismiss"];
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function pillView(state: PillState): PillView {
  const shown = state.jobs.filter((job) => isShown(job, state.now));
  const waiting = shown.filter((job) => job.state === "needs-you");
  const stopped = shown.filter((job) => STOPPED.includes(job.state));
  const working = shown.filter((job) => job.state === "running" || job.state === "queued");

  let mode: PillMode;
  let label: string;
  if (waiting.length > 0) {
    mode = "needs-you";
    label = countLabel(waiting.length, "needs you", "need you");
  } else if (stopped.length > 0) {
    mode = "failed";
    label = countLabel(stopped.length, "didn't finish", "didn't finish");
  } else if (working.length > 0) {
    mode = "running";
    label = countLabel(working.length, "running", "running");
  } else if (shown.length > 0) {
    mode = "done";
    label = "Done";
  } else {
    mode = "hidden";
    label = "";
  }

  // Waiting first, then what did not finish, then the rest — the order someone opening the
  // list needs them in.
  const rank = (job: JobView): number =>
    job.state === "needs-you" ? 0 : STOPPED.includes(job.state) ? 1 : 2;
  const items = [...shown]
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
    ...(state.expanded && state.contentHeight !== null ? { contentHeight: state.contentHeight } : {}),
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
export const PILL_COLLAPSED = { width: 232, height: 44 } as const;
const PILL_EXPANDED_WIDTH = 348;
const PILL_ROW_HEIGHT = 84;
const PILL_CHROME_HEIGHT = 96;
const PILL_MAX_HEIGHT = 440;

// How big the pill's window is. Collapsed: fixed. Open: AS TALL AS ITS CONTENT, up to a
// ceiling — the page measures the list and reports it (`contentHeight`), so one job with a
// long message gets a taller panel and no scrollbar, where a fixed height per row used to
// clip the message and scroll. Before the page has measured (the first frame after a click)
// an estimate from the row count stands in. Past the ceiling the list scrolls.
export function pillSize(
  view: Pick<PillView, "expanded" | "items" | "contentHeight">,
): { width: number; height: number } {
  if (!view.expanded) return { ...PILL_COLLAPSED };
  const estimated = PILL_CHROME_HEIGHT + Math.max(1, view.items.length) * PILL_ROW_HEIGHT;
  const wanted = typeof view.contentHeight === "number" ? view.contentHeight : estimated;
  const height = Math.max(PILL_COLLAPSED.height, Math.min(PILL_MAX_HEIGHT, Math.ceil(wanted)));
  return { width: PILL_EXPANDED_WIDTH, height };
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
