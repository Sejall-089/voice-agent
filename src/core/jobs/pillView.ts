// The shape the status pill is drawn from (M23). On its own in this file, importing nothing,
// because BOTH sides of the process boundary need it: main builds one (core/jobs/pill.ts) and
// the pill's page draws one (src/renderer/pill/), and the page must not pull the job machinery
// — or anything that knows what SQLite is — into the renderer's build to learn five types.

export type PillMode = "hidden" | "running" | "needs-you" | "failed" | "done";

// What a row's button asks main to do. NONE OF THEM APPROVES ANYTHING: "review" opens the
// native confirm dialog, where the yes or no is given.
export type PillAction = "review" | "resume" | "cancel" | "dismiss";

export interface PillItem {
  id: string;
  title: string;
  // A job state ("running", "needs-you", …), used only to style the row.
  state: string;
  // One line under the title: what it is waiting for, where it has got to, or how it ended.
  detail: string;
  actions: PillAction[];
}

export interface PillView {
  // The colour, from the most urgent group present.
  mode: PillMode;
  // Every group present, most urgent first — "1 running · 2 done" (M27) — or as many as fit,
  // with "+N more" for the jobs in the rest.
  label: string;
  // Every way of writing the label, longest first, for the page to measure (M27). Absent when
  // hidden. The page measures them all and reports the widths; main picks the one that fits.
  labelOptions?: string[];
  // The widths main accepted for exactly these `labelOptions`. Present: there is nothing to
  // report. Absent: the page should measure.
  labelWidths?: number[];
  // How wide the pill itself (the collapsed button) is drawn, in CSS pixels, once a
  // measurement has been accepted. Absent until then: the stylesheet's width stands.
  width?: number;
  pulse: boolean;
  expanded: boolean;
  muted: boolean;
  items: PillItem[];
  // Is "Dismiss all" offered beside the chime toggle in the open list (M27)? Only while the list is open
  // with at least one done, failed or expired row in it. Absent: not offered.
  dismissAll?: boolean;
  // A sentence shown for a moment (a resume that could not happen yet), or null/absent.
  notice?: string | null;
  // How tall the open list's content is, in CSS pixels, once the page has measured it and
  // main has accepted the figure. Main sizes the window from it; absent until then.
  contentHeight?: number;
}
