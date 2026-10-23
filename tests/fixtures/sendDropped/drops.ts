// EVERY ANSWER ON RECORD THAT DROPPED A REQUESTED SEND (M31), as the model sent it.
//
// The instruction asked to create an issue AND tell a channel; the answer was a lone create, so
// the issue would have been filed and the channel never told. Each answer is the model's own,
// kind and tool name exactly as sent. What is NOT kept:
//   - the clipboard. A description that was the clipboard as copied is replaced by
//     COPIED_MARKER; the check under test never reads a description.
//   - row 559's real issue title and description, which were the person's own work notes;
//     replaced by a neutral title of the same shape.
//
// Sources:
//   recon   M31's scripted recon, 2026-10-23: the real planner, gpt-5-mini at low effort, M28's long
//           clipboard, no email open, every connector faked. 3 of 6 trials with a fresh action
//           log dropped the send; 0 of 6 with a shared one. All three were lone tool calls.
//   eval    M28's baseline table (spec §9, M28): "create only, no description, no send". The
//           per-trial answer was not saved, so its kind is not known; it is replayed as a lone call.
//   live    The action log, row 559 (read read-only): a lone create that ran (a real issue was
//           created), with no send and no Notion step after it.

export const COPIED_MARKER = "<the clipboard, as copied: 1130 characters>";

export interface Dropped {
  source: string;
  instruction: string;
  // The model's answer: a lone tool call (`tool`) or a one-step plan (`plan`).
  answer:
    | { kind: "tool"; name: string; input: Record<string, unknown> }
    | { kind: "plan"; steps: { tool: string; arguments: Record<string, unknown>; describe: string }[] };
}

export const DROPS: readonly Dropped[] = [
  {
    source: "recon fresh #1",
    instruction: "create a linear issue and send to fun",
    answer: {
      kind: "tool",
      name: "linear__create_issue",
      input: { title: "Migration fails on orders: connection terminated mid-run (staging)", description: COPIED_MARKER },
    },
  },
  {
    source: "recon fresh #4",
    instruction: "create a linear issue and send to fun",
    answer: {
      kind: "tool",
      name: "linear__create_issue",
      input: { title: "Migration fails on orders table for large accounts — connection terminated", description: COPIED_MARKER },
    },
  },
  {
    source: "recon fresh #6",
    instruction: "create a linear issue and send to fun",
    answer: {
      kind: "tool",
      name: "linear__create_issue",
      input: { title: "Staging migration fails during orders migration: Connection terminated unexpectedly", description: COPIED_MARKER },
    },
  },
  {
    source: "eval M28 baseline, long clipboard, create only",
    instruction: "create a linear issue and send to fun",
    answer: { kind: "tool", name: "linear__create_issue", input: { title: "Migration fails on orders" } },
  },
  {
    source: "live row 559",
    instruction: "create a body issue in linear and send update to fun and note changes in notion",
    answer: {
      kind: "tool",
      name: "linear__create_issue",
      input: { title: "Deploy the service and add a throughput job", description: "Notes for the body of the issue." },
    },
  },
];
