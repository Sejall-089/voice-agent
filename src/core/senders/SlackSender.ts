import type { MessageSender, SendResult } from "../types.ts";

// The one external connector in v0 (spec §2). Behind the MessageSender interface, exactly like
// the LLM sits behind LLMClient — so tests inject a fake and never touch real Slack.
//
// The webhook URL is a CONSTRUCTOR ARGUMENT: /core never reads process.env. main.ts injects it.
// The URL is a secret — it is never logged and never appears in an error message (spec §10).
export class SlackSender implements MessageSender {
  constructor(private readonly webhookUrl: string | undefined) {}

  async send(channel: string, text: string): Promise<SendResult> {
    if (!this.webhookUrl) {
      return { ok: false, error: "SLACK_WEBHOOK_URL is not set in .env." };
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Note: a Slack *app* webhook always posts to the channel it was configured with.
        // `channel` is a legacy custom-integration override and may be ignored — but it is
        // still the channel we resolved, confirmed, and logged.
        body: JSON.stringify({ text, channel }),
      });

      if (!response.ok) {
        // Deliberately reports only the status — never the URL.
        return { ok: false, error: `Slack rejected the message (HTTP ${response.status}).` };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not reach Slack: ${message}` };
    }
  }
}

// The safe default when no sender is configured: it never sends, and says so.
export class UnavailableSender implements MessageSender {
  send(_channel: string, _text: string): Promise<SendResult> {
    return Promise.resolve({ ok: false, error: "No message sender is configured." });
  }
}
