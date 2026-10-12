import type { MessageSender, SendResult } from "../types.ts";

// The one external connector in v0 (spec §2). Behind the MessageSender interface, exactly like
// the LLM sits behind LLMClient — so tests inject a fake and never touch real Slack.
//
// The webhook URL is a CONSTRUCTOR ARGUMENT: /core never reads process.env. main.ts injects it.
// The URL is a secret — it is never logged and never appears in an error message (spec §10).
//
// `webhookChannel` is a LABEL, and optional (SLACK_WEBHOOK_CHANNEL): the channel this webhook
// was created for, as the user knows it ("#social"). It changes nothing about where a message
// goes — the webhook decides that — only what the app is able to honestly SAY about it. Unset
// or blank means the app does not know, and says "via your Slack webhook" with no channel.
export interface SlackSenderOptions {
  // How long one post may take before it is given up on (M23-pre). A webhook that never answers
  // used to hold the send forever; now it ends as any other unanswered request does.
  requestTimeoutMs?: number;
  // Tests hand in a scripted fetch. Omitted → the runtime's own, looked up at call time.
  fetchFn?: typeof globalThis.fetch;
}

export class SlackSender implements MessageSender {
  readonly postsTo: string | null;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    private readonly webhookUrl: string | undefined,
    webhookChannel?: string,
    options: SlackSenderOptions = {},
  ) {
    const label = webhookChannel?.trim() ?? "";
    this.postsTo = label.length > 0 ? label : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn;
  }

  async send(channel: string, text: string): Promise<SendResult> {
    if (!this.webhookUrl) {
      return { ok: false, error: "SLACK_WEBHOOK_URL is not set in .env." };
    }

    // One post, cut off after `requestTimeoutMs`, never retried. A timeout ends in the same fixed
    // words as any other request that got no answer — the error itself is never read.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await (this.fetchFn ?? fetch)(this.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        // Note: a Slack *app* webhook always posts to the channel it was configured with.
        // `channel` is a legacy custom-integration override and is ignored by an app webhook.
        // It is still sent, and still logged, as what was ASKED for — but it is no longer
        // presented to the user as the destination (see `postsTo`).
        body: JSON.stringify({ text, channel }),
      });

      if (!response.ok) {
        // Deliberately reports only the status — never the URL.
        return { ok: false, error: `Slack rejected the message (HTTP ${response.status}).` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach Slack: the request did not get an answer." };
    } finally {
      clearTimeout(timer);
    }
  }
}

// What to say at startup about SLACK_WEBHOOK_CHANNEL, or null when there is nothing to say.
//
// PRESENT BUT BLANK is the one state worth a warning. Unset is an ordinary install. But a
// variable someone wrote and got "" for is almost always this: a `.env` value beginning with
// `#` that was not quoted, which dotenv reads as a comment — `SLACK_WEBHOOK_CHANNEL=#social`
// parses to the empty string. Nothing fails; the app just stops naming the channel, and the
// user has no way to tell their setting was thrown away.
//
// Pure, and here rather than in main.ts, because anything in main.ts has no test that could
// fail (CLAUDE.md). main.ts logs whatever this returns, once.
export function webhookChannelWarning(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim().length > 0) return null;
  return (
    "SLACK_WEBHOOK_CHANNEL is set but blank, so it is being ignored. In .env a value that " +
    'starts with # must be quoted, or it is read as a comment: SLACK_WEBHOOK_CHANNEL="#social". ' +
    'Until then the app says "via your Slack webhook" and names no channel.'
  );
}

// The safe default when no sender is configured: it never sends, and says so.
export class UnavailableSender implements MessageSender {
  send(_channel: string, _text: string): Promise<SendResult> {
    return Promise.resolve({ ok: false, error: "No message sender is configured." });
  }
}
