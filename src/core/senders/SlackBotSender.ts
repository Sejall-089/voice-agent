import type { ChannelDirectory, ChannelId, MessageSender, SendResult } from "../types.ts";

// Posting with a Slack BOT TOKEN (M22): to the channel that was asked for, which a webhook could
// never do — a webhook posts to its own channel whatever it is told.
//
// THE CHANNEL ID COMES ONLY FROM THE DIRECTORY. `send` is handed a NAME and looks it up again in
// Slack's own list (`ChannelDirectory`), even though the caller will have checked it before its
// confirm dialog. Defence in depth: whatever reaches this class — a name the model wrote, one an
// email contained — is posted to only if Slack says a channel by exactly that name exists, and
// then to the ID Slack gave, never to anything the input said.
//
// IT IS A SEND, SO IT IS CONSERVATIVE about what a failure means. Slack's `ok: false` is a
// definitive refusal: nothing was posted (`not_sent`, safe to try again). Anything that leaves
// the answer unknown — a timeout, a dropped connection, a 5xx, a reply that cannot be read — is
// `maybe_sent`: the message may be in the channel, and posting again may post it twice. It is
// NEVER retried, for that reason.
//
// THE LEAK RULE, as in SlackChannelDirectory: the token goes in the Authorization header and
// nowhere else; no error's `.message`, no URL, header or response body reaches a returned value,
// a thrown value or a log line; and nothing is logged. Every `error` below is one of the fixed
// texts in SEND_ERRORS.

const POST_MESSAGE = "https://slack.com/api/chat.postMessage";

// Every `error` this sender can return. Fixed strings: the caller may show them as they are.
export const SEND_ERRORS = {
  notSetUp: "Slack is not set up.",
  channelNotFound: "That Slack channel was not found.",
  ambiguous: "More than one Slack channel has that name.",
  cannotCheck: "Could not reach Slack to check the channel.",
  notInChannel: "The bot is not in that channel.",
  archived: "That Slack channel is archived.",
  badToken: "Slack rejected the bot token.",
  rateLimited: "Slack is rate limiting. Try again shortly.",
  badText: "Slack rejected the message text.",
  rejected: "Slack rejected the message.",
  unconfirmed: "Slack did not confirm the message. It may have been sent.",
} as const;

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

export interface SlackBotSenderOptions {
  // The bot token (SLACK_BOT_TOKEN). Undefined or blank: nothing is ever sent.
  token: string | undefined;
  // Where channel IDs come from. The same instance the app uses to check names before a dialog,
  // so both see one cached list.
  directory: ChannelDirectory;
  // Tests hand in a scripted fetch. Omitted → the runtime's own.
  fetchFn?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

// `&`, `<` and `>` are the three characters Slack's message format gives meaning to: `<!channel>`
// and `<!here>` notify everyone, `<@U123>` pings a person, `<url|text>` disguises a link. Text
// that came from a model, a clipboard or an email must not be able to do any of that, so all
// three are escaped — `&` first, or the other two escapes would be escaped again.
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const notSent = (error: string): SendResult => ({ ok: false, outcome: "not_sent", error });
const maybeSent = (): SendResult => ({ ok: false, outcome: "maybe_sent", error: SEND_ERRORS.unconfirmed });

export class SlackBotSender implements MessageSender {
  readonly mode = "bot" as const;
  // No `postsTo`, deliberately: a bot posts where it is asked to, so there is no fixed channel
  // to name.

  private readonly token: string;
  private readonly directory: ChannelDirectory;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: SlackBotSenderOptions) {
    this.token = options.token?.trim() ?? "";
    this.directory = options.directory;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  // NEVER REJECTS. Each step below handles its own failures; this is the backstop for a bug, and
  // it says "maybe sent" because from here it cannot know how far the send got.
  async send(channel: string, text: string): Promise<SendResult> {
    try {
      return await this.deliver(channel, text);
    } catch {
      return maybeSent();
    }
  }

  private async deliver(channel: string, text: string): Promise<SendResult> {
    if (this.token.length === 0) return notSent(SEND_ERRORS.notSetUp);
    // A token no header could carry is refused here, before `fetch` builds an error that quotes it.
    if (!/^[\x21-\x7e]+$/.test(this.token)) return notSent(SEND_ERRORS.badToken);

    const id = await this.channelId(channel);
    if (typeof id !== "string") return id;

    return await this.post(id, text);
  }

  // The ID for this name, from the directory — or the refusal to send. Nothing has been posted on
  // any path through here, so every failure is `not_sent`.
  private async channelId(channel: string): Promise<ChannelId | SendResult> {
    let lookup: Awaited<ReturnType<ChannelDirectory["resolve"]>>;
    try {
      lookup = await this.directory.resolve(channel);
    } catch {
      // The contract says a directory never rejects. If one does, the channel is unchecked.
      return notSent(SEND_ERRORS.cannotCheck);
    }

    // Read defensively: a directory that broke its contract must not reach the post with
    // something that is not a channel ID.
    if (typeof lookup !== "object" || lookup === null) return notSent(SEND_ERRORS.cannotCheck);
    if (lookup.ok === true) {
      const id: unknown = lookup.channel?.id;
      return typeof id === "string" && id.length > 0 ? lookup.channel.id : notSent(SEND_ERRORS.cannotCheck);
    }
    if (lookup.reason === "not_found") return notSent(SEND_ERRORS.channelNotFound);
    if (lookup.reason === "unavailable" && lookup.failure === "ambiguous") return notSent(SEND_ERRORS.ambiguous);
    return notSent(SEND_ERRORS.cannotCheck);
  }

  // ONE request, never retried. The token travels only as the Authorization header.
  private async post(id: ChannelId, text: string): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(POST_MESSAGE, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel: id, text: escapeSlackText(text) }),
          signal: controller.signal,
        });
      } catch {
        // Timed out or dropped: the request may have reached Slack. Which of the two it was does
        // not change what the user must be told, so it is not distinguished.
        return maybeSent();
      }

      // A 429 is refused before anything is posted.
      if (response.status === 429) return notSent(SEND_ERRORS.rateLimited);
      // Any other non-2xx — a 5xx above all — says nothing certain about whether it posted.
      if (!response.ok) return maybeSent();

      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        return maybeSent();
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return maybeSent();

      const reply = body as Record<string, unknown>;
      if (reply["ok"] === true) return { ok: true };
      if (reply["ok"] === false) return notSent(refusal(reply["error"]));
      // Neither: a 200 that does not say what happened.
      return maybeSent();
    } finally {
      clearTimeout(timer);
    }
  }
}

// Slack's `error` code on a definitive refusal → the fixed text. Matched, never passed on.
function refusal(code: unknown): string {
  if (typeof code !== "string") return SEND_ERRORS.rejected;
  if (code === "channel_not_found") return SEND_ERRORS.channelNotFound;
  if (code === "not_in_channel") return SEND_ERRORS.notInChannel;
  if (code === "is_archived") return SEND_ERRORS.archived;
  if (AUTH_ERRORS.has(code)) return SEND_ERRORS.badToken;
  if (code === "ratelimited") return SEND_ERRORS.rateLimited;
  if (code === "msg_too_long" || code === "no_text") return SEND_ERRORS.badText;
  return SEND_ERRORS.rejected;
}
