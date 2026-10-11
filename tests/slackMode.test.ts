import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import {
  selectSlackMode,
  slackModeLine,
  slackModeWarningText,
  type SlackModeWarning,
} from "../src/core/senders/slackMode.ts";

// M22. Which Slack mode an install runs in, from its environment. The `.env` cases go through the
// REAL parser (dotenv), not a hand-built object: M21's `#social` bug was a value the parser read
// differently from how the file looked (CLAUDE.md).

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xyz";
const TOKEN = "xoxb-1111-2222-abcdef";

describe("selectSlackMode", () => {
  it("is webhook mode, with no warning, when SLACK_BOT_TOKEN is unset", () => {
    expect(selectSlackMode({ SLACK_WEBHOOK_URL: WEBHOOK })).toEqual({ mode: "webhook", warnings: [] });
    expect(selectSlackMode({})).toEqual({ mode: "webhook", warnings: [] });
  });

  it.each(["", "   ", "\t"])("is webhook mode, warning bot_token_blank, when the token is %j", (raw) => {
    expect(selectSlackMode({ SLACK_BOT_TOKEN: raw, SLACK_WEBHOOK_URL: WEBHOOK })).toEqual({
      mode: "webhook",
      warnings: ["bot_token_blank"],
    });
  });

  it("is bot mode with the token, trimmed", () => {
    expect(selectSlackMode({ SLACK_BOT_TOKEN: `  ${TOKEN}  ` })).toEqual({ mode: "bot", token: TOKEN, warnings: [] });
  });

  it("is bot mode, warning bot_overrides_webhook, when both are set", () => {
    expect(selectSlackMode({ SLACK_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: WEBHOOK })).toEqual({
      mode: "bot",
      token: TOKEN,
      warnings: ["bot_overrides_webhook"],
    });
  });

  it("does not warn about a webhook that is present but blank", () => {
    expect(selectSlackMode({ SLACK_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: " " }).warnings).toEqual([]);
  });

  describe("through the real .env parser", () => {
    it.each([
      { line: `SLACK_BOT_TOKEN="${TOKEN}"`, label: "double-quoted" },
      { line: `SLACK_BOT_TOKEN='${TOKEN}'`, label: "single-quoted" },
      { line: `SLACK_BOT_TOKEN=${TOKEN}`, label: "unquoted" },
      { line: `SLACK_BOT_TOKEN="${TOKEN}" # the bot`, label: "quoted, with a comment after" },
    ])("reads a $label token as the bare token", ({ line }) => {
      expect(selectSlackMode(parse(line))).toEqual({ mode: "bot", token: TOKEN, warnings: [] });
    });

    it("reads an empty assignment as present-but-blank", () => {
      expect(selectSlackMode(parse(`SLACK_BOT_TOKEN=\nSLACK_WEBHOOK_URL=${WEBHOOK}`))).toEqual({
        mode: "webhook",
        warnings: ["bot_token_blank"],
      });
    });

    it("reads both lines as bot mode overriding the webhook", () => {
      expect(selectSlackMode(parse(`SLACK_WEBHOOK_URL=${WEBHOOK}\nSLACK_BOT_TOKEN="${TOKEN}"`))).toEqual({
        mode: "bot",
        token: TOKEN,
        warnings: ["bot_overrides_webhook"],
      });
    });

    it("is webhook mode when only the webhook is in the file", () => {
      expect(selectSlackMode(parse(`SLACK_WEBHOOK_URL=${WEBHOOK}`))).toEqual({ mode: "webhook", warnings: [] });
    });
  });
});

describe("startup lines", () => {
  const bot = selectSlackMode({ SLACK_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: WEBHOOK });

  it("names the mode and the variable", () => {
    expect(slackModeLine(bot, true)).toBe("Slack: bot mode (SLACK_BOT_TOKEN)");
    expect(slackModeLine({ mode: "webhook", warnings: [] }, true)).toBe("Slack: webhook mode (SLACK_WEBHOOK_URL)");
    expect(slackModeLine({ mode: "webhook", warnings: [] }, false)).toBe(
      "Slack: webhook mode - SLACK_WEBHOOK_URL not set, nothing can be sent",
    );
  });

  it.each(["bot_token_blank", "bot_overrides_webhook"] as SlackModeWarning[])(
    "words %s with variable names",
    (warning) => {
      expect(slackModeWarningText(warning)).toContain("SLACK_BOT_TOKEN");
    },
  );

  it("never prints the token, any part of it, or the webhook URL", () => {
    const lines = [
      slackModeLine(bot, true),
      slackModeLine(bot, false),
      ...bot.warnings.map(slackModeWarningText),
      slackModeWarningText("bot_token_blank"),
    ];
    for (const line of lines) {
      expect(line).not.toContain("xoxb");
      expect(line).not.toContain("abcdef");
      expect(line).not.toContain("hooks.slack.com");
    }
  });
});
