import type { EmailMessage, GmailSurface } from "../types.ts";

const REASON =
  "I can't reach Chrome. Set CHROME_DEBUG_URL in .env and start Chrome with " +
  '--remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\voice-agent-chrome", ' +
  "then sign in to Gmail there.";

// The default `GmailSurface` (M10) — the exact counterpart of `UnavailableSender`.
//
// A Planner built without a configured Chrome gets this, so "no browser configured" is a
// missing capability that explains itself rather than a null that blows up somewhere deeper.
// In the running app the Gmail tools are not even offered to the model when Chrome isn't
// configured (see registry.buildRegistry), so this is the second line of defence, not the first.
export class UnavailableGmail implements GmailSurface {
  readOpenEmail(): Promise<EmailMessage> {
    return Promise.reject(new Error(REASON));
  }
  openReplyBox(): Promise<void> {
    return Promise.reject(new Error(REASON));
  }
  readComposeText(): Promise<string | null> {
    return Promise.reject(new Error(REASON));
  }
  readComposeRecipients(): Promise<string | null> {
    return Promise.reject(new Error(REASON));
  }
  setComposeText(): Promise<void> {
    return Promise.reject(new Error(REASON));
  }
  clickSend(): Promise<void> {
    return Promise.reject(new Error(REASON));
  }
}
