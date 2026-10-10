import type { ConfirmOptions } from "./OSShell.ts";

// What the confirm dialog's approve button says when a tool names nothing better. "Send" was
// the label on EVERY confirm through M20, and still is for any tool that declares none — so a
// tool nobody has thought about keeps exactly the button it always had.
export const DEFAULT_APPROVE_LABEL = "Send";

// The label a shell should put on the approve button for these options.
//
// ONE function, used by the real shell and the mock alike, so a test against MockShell sees the
// label Windows would show and not a more forgiving one. A blank label falls back to the
// default: a dialog with an empty button is worse than one with a generic button, and it would
// sit beside "Cancel" as the only readable choice.
//
// It does not judge WHERE a label came from — it cannot. That is settled upstream: the planner
// passes `tool.confirmLabel`, a fixed string in the tool's code, and nothing else ever reaches
// `confirm()`'s options (core/planner.ts, step 6b).
export function approveLabel(options?: ConfirmOptions): string {
  const label = options?.approveLabel?.trim() ?? "";
  return label.length > 0 ? label : DEFAULT_APPROVE_LABEL;
}
