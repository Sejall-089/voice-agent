import { CdpSession, listPages, type PageTarget } from "./CdpClient.ts";
import { gmailAgent, type GmailOp, type ScriptEmail, type ScriptResult } from "./gmailScript.ts";
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
      return { subject: email.subject, from: email.from, to: email.to, body: email.body };
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
      // focus + select-all happen inside the page in ONE call, so insertText replaces the draft
      // rather than appending to it. Splitting them would leave a window where the box is
      // focused but the old text is unselected, and a slow frame there would duplicate the draft.
      await this.run<string>(session, "focusComposeBox");
      await session.insertText(text);
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
  // Exactly one must qualify. Zero and several are both refusals: with two Gmail tabs mid-reply
  // there is no honest way to know which draft the user meant, and picking wrong would put
  // their words in the wrong conversation.
  private async withTab<T>(
    predicate: Extract<GmailOp, "hasOpenMessage" | "hasComposeBox">,
    work: (session: CdpSession) => Promise<T>,
  ): Promise<T> {
    const pages = (await listPages(this.baseUrl, this.timeoutMs)).filter((page) =>
      page.url.includes(GMAIL_URL),
    );
    if (pages.length === 0) {
      throw new Error(
        "No Gmail tab is open in the Chrome I can see. Open Gmail in the Chrome you started " +
          "with remote debugging, then try again.",
      );
    }

    const candidates: { target: PageTarget; session: CdpSession }[] = [];
    try {
      for (const target of pages) {
        const session = await CdpSession.connect(target, this.timeoutMs);
        try {
          if (await this.run<boolean>(session, predicate)) {
            candidates.push({ target, session });
            continue;
          }
        } catch {
          // A Gmail tab that can't answer (still loading, a signed-out screen) is simply not a
          // candidate. Only the final zero/many verdict is worth telling the user about.
        }
        session.close();
      }

      const chosen = candidates[0];
      if (chosen === undefined) {
        throw new Error(
          predicate === "hasOpenMessage"
            ? "No email is open in Gmail — open the one you want to reply to first."
            : "There's no reply box open in Gmail right now.",
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `${String(candidates.length)} Gmail tabs match — I won't guess which one you mean. ` +
            "Leave one open and try again.",
        );
      }
      return await work(chosen.session);
    } finally {
      // Every session, including the one that did the work: nothing outlives the call.
      for (const candidate of candidates) candidate.session.close();
    }
  }

  // Ship gmailAgent into the page and unwrap its result. `toString()` is why that function may
  // not import or close over anything (see gmailScript.ts), and JSON.stringify on the op keeps
  // the injected source free of any string we did not build ourselves.
  private async run<T>(session: CdpSession, op: GmailOp): Promise<T> {
    const expression = `(${gmailAgent.toString()})(document, ${JSON.stringify(op)})`;
    const result = await session.evaluate<ScriptResult<T> | undefined>(expression);
    if (result === undefined) {
      throw new Error(`Gmail returned nothing for "${op}" — the page may still be loading.`);
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
