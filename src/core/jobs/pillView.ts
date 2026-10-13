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
  mode: PillMode;
  label: string;
  pulse: boolean;
  expanded: boolean;
  muted: boolean;
  items: PillItem[];
  // A sentence shown for a moment (a resume that could not happen yet), or null/absent.
  notice?: string | null;
}
