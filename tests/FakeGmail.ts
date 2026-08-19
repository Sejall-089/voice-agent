import type { EmailMessage, GmailSurface } from "../src/core/types.ts";

// A Gmail tab that exists only in memory (M10). The same role FakeLLM and FakeSender play:
// the tools and the planner run their real code, and the thing with real-world consequences is
// swapped for something a test can inspect.
//
// No test in this repo ever opens a browser or touches a real inbox. What that buys is that the
// *decisions* — draft before opening the box, revise instead of re-reply, never send without a
// confirmed yes — are proven deterministically. What it does not buy is any evidence that
// Gmail's actual DOM matches gmailScript's selectors; only a live run shows that.

export interface FakeGmailOptions {
  openEmail?: EmailMessage | null; // null = no message open
  composeText?: string | null; // pre-existing text, e.g. one the user hand-edited
  recipients?: string | null;
  failWith?: string; // when set, EVERY operation rejects with this — a Chrome that isn't there
  // Optional shared ordering log. The narration-before-acting test needs to compare events
  // across two different doubles, and "who pushed first" is the only honest way to do that.
  timeline?: string[];
}

export class FakeGmail implements GmailSurface {
  // Every mutation, in order. Assertions read this to check not just what happened but when —
  // narration before acting, one reply box rather than two.
  public readonly calls: string[] = [];
  public replyBoxOpened = 0;
  public sent = 0;
  public composeText: string | null;

  private readonly openEmail: EmailMessage | null;
  private readonly recipients: string | null;
  private readonly failWith: string | undefined;
  private readonly timeline: string[] | undefined;

  constructor(options: FakeGmailOptions = {}) {
    this.openEmail = options.openEmail === undefined ? sampleEmail() : options.openEmail;
    this.composeText = options.composeText ?? null;
    this.recipients = options.recipients ?? "alex@example.com";
    this.failWith = options.failWith;
    this.timeline = options.timeline;
  }

  private note(call: string): void {
    this.calls.push(call);
    this.timeline?.push(`gmail:${call}`);
  }

  readOpenEmail(): Promise<EmailMessage> {
    this.note("readOpenEmail");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    if (this.openEmail === null) {
      return Promise.reject(new Error("No email is open in Gmail — open one and try again."));
    }
    return Promise.resolve(this.openEmail);
  }

  openReplyBox(): Promise<void> {
    this.note("openReplyBox");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    this.replyBoxOpened += 1;
    if (this.composeText === null) this.composeText = "";
    return Promise.resolve();
  }

  readComposeText(): Promise<string | null> {
    this.note("readComposeText");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    return Promise.resolve(this.composeText);
  }

  readComposeRecipients(): Promise<string | null> {
    this.note("readComposeRecipients");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    return Promise.resolve(this.recipients);
  }

  setComposeText(text: string): Promise<void> {
    this.note("setComposeText");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    this.composeText = text;
    return Promise.resolve();
  }

  clickSend(): Promise<void> {
    this.note("clickSend");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    this.sent += 1;
    this.composeText = null;
    return Promise.resolve();
  }
}

export function sampleEmail(): EmailMessage {
  return {
    subject: "Tuesday sync",
    from: "alex@example.com",
    to: null,
    body: "Can you make the sync on Tuesday at 3pm?",
  };
}
