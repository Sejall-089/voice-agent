import type { JobSummary } from "../types.ts";

// "Are my agents done yet?" — answered by CODE, from the job records (M23).
//
// No model writes this. It is a count in a fixed sentence, plus — on screen only — one line
// per job. The one thing in it that is not this app's own wording is the user's instruction,
// quoted back and cut short; never a tool's result, which can be an email or a ticket someone
// else wrote.
//
// Two forms, because they have different jobs (§4d): `spoken` is one sentence and leads with
// whatever needs the user; `shown` is that sentence and then the list.

export interface StatusAnswer {
  spoken: string;
  shown: string;
}

const INSTRUCTION_CHARS = 60;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= INSTRUCTION_CHARS ? flat : `${flat.slice(0, INSTRUCTION_CHARS - 1)}…`;
}

function joined(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const LABEL: Readonly<Record<JobSummary["state"], string>> = {
  queued: "queued",
  running: "running",
  "needs-you": "waiting for you",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired, not run",
  interrupted: "interrupted",
};

export function statusAnswer(jobs: readonly JobSummary[]): StatusAnswer {
  if (jobs.length === 0) {
    const none = "Nothing is running in the background, and nothing is waiting for you.";
    return { spoken: none, shown: none };
  }

  const count = (...states: JobSummary["state"][]): number =>
    jobs.filter((job) => states.includes(job.state)).length;
  const waiting = count("needs-you");
  const working = count("running", "queued");
  const done = count("done");
  const failed = count("failed", "interrupted");
  const expired = count("expired");
  const cancelled = count("cancelled");

  // Waiting first: it is the only part of the answer that asks something of the listener.
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${plural(waiting, "job is", "jobs are")} waiting for you`);
  if (working > 0) parts.push(`${plural(working, "is", "are")} still running`);
  if (done > 0) parts.push(`${plural(done, "is", "are")} done`);
  if (failed > 0) parts.push(`${plural(failed, "has", "have")} failed`);
  if (expired > 0) parts.push(`${plural(expired, "has", "have")} expired without running`);
  if (cancelled > 0) parts.push(`${plural(cancelled, "was", "were")} cancelled`);

  // The first clause names its subject ("2 jobs are waiting"); if the list does not start with
  // the waiting clause, the first one needs "job(s)" put in.
  if (waiting === 0 && parts.length > 0) {
    const first = parts[0] ?? "";
    const n = Number.parseInt(first, 10);
    parts[0] = first.replace(/^(\d+) /, `$1 ${n === 1 ? "job" : "jobs"} `);
  }

  let spoken = `${joined(parts)}.`;
  spoken = spoken.charAt(0).toUpperCase() + spoken.slice(1);
  if (waiting > 0) spoken += " Open the status pill to answer.";
  else if (working === 0) spoken = `All done: ${spoken.charAt(0).toLowerCase()}${spoken.slice(1)}`;

  const lines = jobs.map((job) => {
    const why =
      job.state === "needs-you" && job.waitingFor === "confirm"
        ? " (needs your OK)"
        : job.state === "needs-you" && job.waitingFor === "foreground-only"
          ? " (needs you at the screen)"
          : "";
    return `- ${LABEL[job.state]}${why}: "${clip(job.instruction)}"`;
  });

  return { spoken, shown: `${spoken}\n\n${lines.join("\n")}` };
}
