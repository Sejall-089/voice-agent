// "Connecting to Linear…" — and whose bar it may be written in (M23).
//
// A connector's connection is shared by every job, and the line is said BY THE CONNECTION the
// first time anything uses it (core/mcp/SdkConnection.ts): it has no idea which job asked.
// Through M22 that did not matter, because there was one instruction at a time and it had the
// bar. With jobs, the caller may be detached — and a detached job must never write to the bar
// the user is now typing or dictating in.
//
// So the line is shown only when the job that HAS the bar is itself on a connector tool: then
// it is that job waiting, and the line is true of what the user is looking at. In every other
// case it is dropped; a background job's wait is already visible in the status pill.
//
// Extracted from main.ts so the rule has a test that could fail (CLAUDE.md).

export interface ConnectingNoticeDeps {
  // The tool the attached job is on right now, or null when no job has the bar.
  attachedTool: () => string | null;
  isConnectorTool: (name: string) => boolean;
  narrate: (line: string) => void;
}

export function createConnectingNotice(deps: ConnectingNoticeDeps): (line: string) => void {
  return (line: string): void => {
    const tool = deps.attachedTool();
    if (tool === null || !deps.isConnectorTool(tool)) return;
    deps.narrate(line);
  };
}
