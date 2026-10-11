// Which way this install posts to Slack (M22): with a bot token, or through a webhook.
//
// Pure, and here rather than in main.ts, because anything in main.ts has no test that could fail
// (CLAUDE.md). main.ts hands it `process.env`, builds whichever sender it says, and prints the
// lines below — which name VARIABLES, never a value or any part of one.

export type SlackModeWarning =
  // SLACK_BOT_TOKEN is present but blank: almost always a value lost in editing. Webhook mode.
  | "bot_token_blank"
  // Both are set. The bot wins; the webhook is not used for anything.
  | "bot_overrides_webhook";

export type SlackMode =
  | { mode: "bot"; token: string; warnings: SlackModeWarning[] }
  | { mode: "webhook"; warnings: SlackModeWarning[] };

export function selectSlackMode(env: Readonly<Record<string, string | undefined>>): SlackMode {
  const raw = env["SLACK_BOT_TOKEN"];
  const token = raw?.trim() ?? "";

  if (token.length === 0) {
    return { mode: "webhook", warnings: raw === undefined ? [] : ["bot_token_blank"] };
  }

  const webhook = env["SLACK_WEBHOOK_URL"]?.trim() ?? "";
  return { mode: "bot", token, warnings: webhook.length > 0 ? ["bot_overrides_webhook"] : [] };
}

// The startup line. `webhookConfigured` only changes what is said in webhook mode: a webhook
// mode with no URL can send nothing, and the line should not sound like it can.
export function slackModeLine(mode: SlackMode, webhookConfigured: boolean): string {
  if (mode.mode === "bot") return "Slack: bot mode (SLACK_BOT_TOKEN)";
  return webhookConfigured
    ? "Slack: webhook mode (SLACK_WEBHOOK_URL)"
    : "Slack: webhook mode - SLACK_WEBHOOK_URL not set, nothing can be sent";
}

export function slackModeWarningText(warning: SlackModeWarning): string {
  switch (warning) {
    case "bot_token_blank":
      return (
        "SLACK_BOT_TOKEN is set but blank, so it is being ignored and Slack is in webhook mode. " +
        "Put the bot token after the = (quotes are fine), or remove the line."
      );
    case "bot_overrides_webhook":
      return (
        "SLACK_BOT_TOKEN and SLACK_WEBHOOK_URL are both set. Using the bot token; " +
        "SLACK_WEBHOOK_URL is ignored."
      );
  }
}
