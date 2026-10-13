import { describe, expect, it } from "vitest";
import { statusAnswer } from "../src/core/jobs/statusAnswer.ts";
import { toSpokenLine } from "../src/core/speech.ts";
import type { JobSummary } from "../src/core/types.ts";

// "Are my agents done yet?" — the template (M23). Literal expected strings throughout: the
// answer is fixed wording over counts, so the test says exactly what a person hears.

let seq = 0;
const job = (state: JobSummary["state"], over: Partial<JobSummary> = {}): JobSummary => ({
  id: `j${(seq += 1)}`,
  instruction: "send these notes to the team",
  state,
  waitingFor: state === "needs-you" ? "confirm" : null,
  tool: "sendMessage",
  ...over,
});

describe("statusAnswer", () => {
  it("0 jobs", () => {
    const answer = statusAnswer([]);
    expect(answer.spoken).toBe("Nothing is running in the background, and nothing is waiting for you.");
    expect(answer.shown).toBe(answer.spoken);
  });

  it("1 job, running", () => {
    const answer = statusAnswer([job("running", { instruction: "file this bug in Linear" })]);
    expect(answer.spoken).toBe("1 job is still running.");
    expect(answer.shown).toBe('1 job is still running.\n\n- running: "file this bug in Linear"');
  });

  it("1 job, done", () => {
    expect(statusAnswer([job("done")]).spoken).toBe("All done: 1 job is done.");
  });

  it("many, all still working — queued counts as running", () => {
    expect(statusAnswer([job("running"), job("running"), job("queued")]).spoken).toBe(
      "3 jobs are still running.",
    );
  });

  it("needs-you leads, says how to answer, and never says 'all done'", () => {
    const answer = statusAnswer([
      job("done"),
      job("needs-you", { instruction: "post the summary to #bugs" }),
      job("running"),
    ]);
    expect(answer.spoken).toBe(
      "1 job is waiting for you, 1 is still running and 1 is done. Open the status pill to answer.",
    );
    expect(answer.shown).toContain('- waiting for you (needs your OK): "post the summary to #bugs"');
  });

  it("two waiting, and why each is waiting", () => {
    const answer = statusAnswer([
      job("needs-you", { waitingFor: "confirm" }),
      job("needs-you", { waitingFor: "foreground-only", instruction: "add it to my Notion page" }),
    ]);
    expect(answer.spoken).toBe("2 jobs are waiting for you. Open the status pill to answer.");
    expect(answer.shown).toContain('- waiting for you (needs you at the screen): "add it to my Notion page"');
  });

  it("failed — an interrupted job counts as one that failed", () => {
    expect(statusAnswer([job("failed"), job("interrupted")]).spoken).toBe("All done: 2 jobs have failed.");
    expect(statusAnswer([job("failed")]).spoken).toBe("All done: 1 job has failed.");
  });

  it("failed alongside work still going is not 'all done'", () => {
    expect(statusAnswer([job("running"), job("failed")]).spoken).toBe(
      "1 job is still running and 1 has failed.",
    );
  });

  it("expired says it did not run; cancelled says so", () => {
    expect(statusAnswer([job("expired")]).spoken).toBe("All done: 1 job has expired without running.");
    expect(statusAnswer([job("cancelled"), job("cancelled")]).spoken).toBe("All done: 2 jobs were cancelled.");
    expect(statusAnswer([job("expired")]).shown).toContain("- expired, not run:");
  });

  it("everything at once, in a fixed order", () => {
    const answer = statusAnswer([
      job("cancelled"),
      job("expired"),
      job("failed"),
      job("done"),
      job("done"),
      job("queued"),
      job("needs-you"),
    ]);
    expect(answer.spoken).toBe(
      "1 job is waiting for you, 1 is still running, 2 are done, 1 has failed, " +
        "1 has expired without running and 1 was cancelled. Open the status pill to answer.",
    );
  });

  it("quotes the instruction cut short, on one line — and never a result", () => {
    const long = `summarize this\nand then ${"very ".repeat(30)}long thing`;
    const shown = statusAnswer([job("running", { instruction: long })]).shown;
    const line = shown.split("\n").find((text) => text.startsWith("- ")) ?? "";
    expect(line.length).toBeLessThanOrEqual(`- running: ""`.length + 60);
    expect(line.endsWith('…"')).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("every spoken form survives the speech cleaner unchanged, so nothing odd reaches the engine", () => {
    for (const jobs of [[], [job("running")], [job("needs-you"), job("failed")], [job("done"), job("done")]]) {
      const spoken = statusAnswer(jobs).spoken;
      expect(toSpokenLine(spoken)).toBe(spoken);
    }
  });
});
