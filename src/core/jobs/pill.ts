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

export interface PillState {
  jobs: readonly JobView[];
  now: number;
  expanded: boolean;
  muted: boolean;
  // Until when the pill pulses, or null.
  pulseUntil: number | null;
}

export type PillEvent =
  | { type: "jobs"; jobs: readonly JobView[]; now: number }
  | { type: "tick"; now: number }
  | { type: "expand"; expanded: boolean }
  | { type: "mute"; muted: boolean };

export function initialPillState(muted: boolean, now: number): PillState {
  return { jobs: [], now, expanded: false, muted, pulseUntil: null };
}

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
      return {
        ...state,
        jobs: event.jobs,
        now: event.now,
        pulseUntil: newlyWaiting ? event.now + PULSE_MS : state.pulseUntil,
      };
    }
    case "tick":
      return { ...state, now: event.now };
    case "expand":
      return { ...state, expanded: event.expanded };
    case "mute":
      return { ...state, muted: event.muted };
  }
}

const TITLE_CHARS = 64;
const DETAIL_CHARS = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
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
  };
}

// --- Where it goes ---

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PILL_MARGIN = 16;
export const PILL_COLLAPSED = { width: 232, height: 44 } as const;
const PILL_EXPANDED_WIDTH = 348;
const PILL_ROW_HEIGHT = 84;
const PILL_CHROME_HEIGHT = 96;
const PILL_MAX_HEIGHT = 440;

export function pillSize(view: Pick<PillView, "expanded" | "items">): { width: number; height: number } {
  if (!view.expanded) return { ...PILL_COLLAPSED };
  const wanted = PILL_CHROME_HEIGHT + Math.max(1, view.items.length) * PILL_ROW_HEIGHT;
  return { width: PILL_EXPANDED_WIDTH, height: Math.min(PILL_MAX_HEIGHT, wanted) };
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
