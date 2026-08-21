import { CdpSession } from "../browser/CdpClient.ts";
import { pickTab } from "../browser/tabs.ts";
import {
  gmailAgent,
  type GmailOp,
  type ScriptEmail,
  type ScriptResult,
} from "./gmailScript.ts";
import type { EmailMessage, GmailSurface } from "../types.ts";

// The real `GmailSurface` (M10): Gmail in a Chrome the user launched with remote debugging on.
//
// It owns two things gmailScript can't: which TAB to act in, and waiting for Gmail to catch up
// after a click. Both follow the same default-deny rule as element lookup — if the answer is
// ambiguous, refuse and say why rather than pick one.

const GMAIL_URL = "mail.google.com";
// How long to wait for the reply box to exist after clicking Reply. Gmail animates it in; a
// straight-line read would race the animation and report "no reply box" on a working click.
const COMPOSE_WAIT_MS = 5_000;
const POLL_MS = 150;

export interface ChromeGmailOptions {
  baseUrl: string; // e.g. http://127.0.0.1:9222
  timeoutMs?: number;
}

export class ChromeGmail implements GmailSurface {
  private readonly baseUrl: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: ChromeGmailOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
  }

  async readOpenEmail(): Promise<EmailMessage> {
    return this.withTab("hasOpenMessage", async (session) => {
      const email = await this.run<ScriptEmail>(session, "readOpenEmail");
      return {
        subject: email.subject,
        from: email.from,
        fromName: email.fromName,
        to: email.to,
        body: email.body,
      };
    });
  }

  async openReplyBox(): Promise<void> {
    await this.withTab("hasOpenMessage", async (session) => {
      const outcome = await this.run<string>(session, "openReplyBox");
      if (outcome === "already-open") return;
      const appeared = await this.waitFor(session, "hasComposeBox");
      if (!appeared) {
        throw new Error(
          "Clicked Reply, but no reply box appeared — nothing was written. Open the reply " +
            "manually and try again.",
        );
      }
    });
  }

  async readComposeText(): Promise<string | null> {
    return this.withTab("hasComposeBox", (session) =>
      this.run<string | null>(session, "readComposeText"),
    );
  }

  async readComposeRecipients(): Promise<string | null> {
    return this.withTab("hasComposeBox", (session) =>
      this.run<string | null>(session, "readComposeRecipients"),
    );
  }

  async setComposeText(text: string): Promise<void> {
    await this.withTab("hasComposeBox", async (session) => {
      await this.run<string>(session, "focusComposeBox", text);
    });
  }

  async clickSend(): Promise<void> {
    await this.withTab("hasComposeBox", async (session) => {
      await this.run<string>(session, "clickSend");
    });
  }

  // --- internals ---

  // Pick the tab to act in. `predicate` is what makes a tab the RIGHT one — a message being
  // open for a read, a compose box being open for a revision — so the choice is made on what
  // the tab actually contains, not on tab order.
  //
  // The zero/many refusal logic itself lives in `pickTab` (core/browser/tabs.ts, M11): it was
  // lifted out of here so a second app surface (Notion) reuses the exact same "don't guess
  // which tab" safety rule instead of a second, driftable copy of it. Only the Gmail-specific
  // parts — which host counts, what "qualifies" means, and the wording of each refusal —
  // stay here.
  private async withTab<T>(
    predicate: Extract<GmailOp, "hasOpenMessage" | "hasComposeBox">,
    work: (session: CdpSession) => Promise<T>,
  ): Promise<T> {
    return pickTab(
      {
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        hostMatch: (url) => url.includes(GMAIL_URL),
        qualifies: (session) => this.run<boolean>(session, predicate),
        whenNoHost:
          "No Gmail tab is open in the Chrome I can see. Open Gmail in the Chrome you started " +
          "with remote debugging, then try again.",
        whenNoneQualify:
          predicate === "hasOpenMessage"
            ? "No email is open in Gmail — open the one you want to reply to first."
            : "There's no reply box open in Gmail right now.",
        whenMany: (count) =>
          `${String(count)} Gmail tabs match — I won't guess which one you mean. ` +
          "Leave one open and try again.",
      },
      work,
    );
  }

  // Ship gmailAgent into the page and unwrap its result. `toString()` is why that function may
  // not import or close over anything (see gmailScript.ts), and JSON.stringify on the op keeps
  // the injected source free of any string we did not build ourselves.
  private async run<T>(
    session: CdpSession,
    op: GmailOp,
    text?: string,
  ): Promise<T> {
    const expression = `(${gmailAgent.toString()})(document, ${JSON.stringify(op)}, ${
      text === undefined ? "undefined" : JSON.stringify(text)
    })`;
    const result = await session.evaluate<ScriptResult<T> | undefined>(
      expression,
    );
    if (result === undefined) {
      throw new Error(
        `Gmail returned nothing for "${op}" — the page may still be loading.`,
      );
    }
    if (!result.ok) {
      // The script's own wording, verbatim: it knows exactly what it could not find, and
      // rephrasing it here would only blur that.
      throw new Error(result.reason);
    }
    return result.value;
  }

  private async waitFor(
    session: CdpSession,
    op: Extract<GmailOp, "hasOpenMessage" | "hasComposeBox">,
  ): Promise<boolean> {
    const deadline = Date.now() + COMPOSE_WAIT_MS;
    for (;;) {
      if (await this.run<boolean>(session, op)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
