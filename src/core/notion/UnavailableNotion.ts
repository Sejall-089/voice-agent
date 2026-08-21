import type { NotionPage, NotionSurface } from "../types.ts";

const REASON =
  "I can't reach Chrome. Set CHROME_DEBUG_URL in .env and start Chrome with " +
  '--remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\voice-agent-chrome", ' +
  "then open the Notion page there.";

// The default `NotionSurface` (M11) — the exact counterpart of `UnavailableGmail`.
//
// A planner built without a configured Chrome gets this, so "no browser configured" is a
// missing capability that explains itself rather than a null that blows up somewhere deeper.
// In the running app the Notion tools are not even offered to the model when Chrome isn't
// configured (see registry.buildRegistry), so this is the second line of defence, not the
// first.
export class UnavailableNotion implements NotionSurface {
  readOpenPage(): Promise<NotionPage> {
    return Promise.reject(new Error(REASON));
  }
  appendToPage(): Promise<void> {
    return Promise.reject(new Error(REASON));
  }
}
