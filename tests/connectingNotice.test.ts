import { describe, expect, it } from "vitest";
import { createConnectingNotice } from "../src/main/jobs/connectingNotice.ts";

// "Connecting to Linear…" must never be written into the bar by a job the user has walked
// away from (M23). Found by review, not by a test: main.ts handed the REAL shell's `narrate`
// to every connection, and a connection has no idea which job is using it.

function harness(attachedTool: string | null) {
  const said: string[] = [];
  const state = { attachedTool };
  const notice = createConnectingNotice({
    attachedTool: () => state.attachedTool,
    isConnectorTool: (name) => name === "linear__create_issue" || name === "github__get_issue",
    narrate: (line) => said.push(line),
  });
  return { said, state, notice };
}

describe("createConnectingNotice", () => {
  it("is shown when the job that has the bar is on a connector tool", () => {
    const { said, notice } = harness("linear__create_issue");
    notice("Connecting to Linear…");
    expect(said).toEqual(["Connecting to Linear…"]);
  });

  it("is DROPPED when no job has the bar — the caller is in the background", () => {
    const { said, notice } = harness(null);
    notice("Connecting to Linear…");
    expect(said).toEqual([]);
  });

  it("is dropped when the job with the bar is doing something else entirely", () => {
    // An attached `summarize` while a detached job opens Linear: the line would be true of
    // nothing the user is looking at.
    const { said, notice } = harness("summarize");
    notice("Connecting to Linear…");
    expect(said).toEqual([]);
  });

  it("is decided at the moment the connection opens, not when the notice was built", () => {
    const { said, state, notice } = harness("github__get_issue");
    state.attachedTool = null; // detached between planning and the connection opening
    notice("Connecting to GitHub…");
    expect(said).toEqual([]);
    state.attachedTool = "github__get_issue";
    notice("Connecting to GitHub…");
    expect(said).toEqual(["Connecting to GitHub…"]);
  });
});
