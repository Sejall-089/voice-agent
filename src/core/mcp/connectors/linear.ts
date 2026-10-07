import type { ConnectorDef, ConnectorSettings } from "../types.ts";

// Linear, over its hosted MCP server (M19) — the first connector, and the worked example of
// what a connector definition is: every name, description, schema and tier the app uses for
// Linear is in this file, and none of it comes from the server.
//
// TRANSCRIBED FROM RECON, 2026-10-07 (scripts/linear-recon.mjs, tests/fixtures/linear/). The
// three facts that shaped it:
//
//   1. THERE IS NO `create_issue`. The server has `save_issue`, which creates when `id` is
//      absent and UPDATES ANY ISSUE when it is present — and also takes `patch`, `removeLabels`,
//      `state`, `assignee` and thirty other fields. What this app exposes is `create_issue`
//      with exactly two model-supplied arguments, and `additionalProperties: false`. `id` is
//      not in the schema, so it cannot be sent, so update is unreachable. The capability is
//      defined by the schema below, not by the reach of the remote tool.
//   2. A result is ONE text block holding a JSON string. No structuredContent, no
//      resource_link. The issue's link is the `url` field inside it — so every tool here has a
//      formatter, because the raw text handed to a later chain step as `{stepN}` would post a
//      JSON blob into Slack.
//   3. The server marks `save_issue` destructive and the two reads read-only. Those hints are
//      not what set the tiers below (core/mcp/tiers.ts explains why they cannot be), but they
//      agree with them.
//
// `team` IS NOT THE MODEL'S TO CHOOSE. Linear requires one on create, and the planner has no way
// to know what teams exist — it answers once, from a spoken sentence. So it comes from
// `defaultTeam` in connectors.json, is merged in by code, and is named in the confirm dialog.
//
// Deliberately NOT here at launch: priority, labels, assignee, comments, projects, and every
// other one of the server's 59 tools. Each is one more thing the model can get wrong in a
// tracker other people read; they get added one at a time, when something needs them.

const SEARCH_LIMIT = 5;
// Also listed in scripts/linear-recon.mjs, which is what notices if the server stops accepting them.
const SEARCH_FIELDS = ["id", "title", "status", "url"];

export const linearConnector: ConnectorDef = {
  id: "linear",
  label: "Linear",
  url: "https://mcp.linear.app/mcp",
  keyName: "LINEAR_API_KEY",
  tools: [
    {
      name: "create_issue",
      remote: "save_issue",
      description:
        "Create a NEW issue (a ticket, a bug report, a task) in the user's Linear workspace. " +
        "Use this when the user asks to file, create, open or log an issue, ticket or bug in " +
        "Linear. Write `title` yourself: one short line saying what the issue is, taken from " +
        "what the user said. Put the detail in `description` — in a plan this is normally an " +
        "earlier step's whole result, e.g. {step1} after reading an email. This cannot edit or " +
        "close an existing issue. The result is the new issue's identifier and its link.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "A short, specific title for the issue, in your own words.",
          },
          description: {
            type: "string",
            description:
              "The body of the issue, as plain text or Markdown. May contain {stepN} in a plan.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      // Something appears in a tracker other people read, under the user's name, with no undo
      // this app can offer. The dialog shows the whole of it first.
      risk: "dangerous",
      requires: ["defaultTeam"],
      fixed: (settings) => ({ team: settings["defaultTeam"] ?? "" }),
      // The question first and on its own line: `toSpokenConfirm` says only the first paragraph,
      // and it should be the decision, not the body of an email.
      describe: (args, settings) => {
        const description = text(args["description"]);
        return [
          `Create this Linear issue in ${teamOf(settings)}?`,
          `Title: ${text(args["title"])}`,
          description.length > 0 ? description : "(no description)",
        ].join("\n\n");
      },
      format: (raw) => {
        const issue = parseObject(raw);
        return `Created ${need(issue, "id")}: ${need(issue, "title")}\n${need(issue, "url")}`;
      },
    },
    {
      name: "search_issues",
      remote: "list_issues",
      description:
        "Search the user's Linear workspace for existing issues whose title or description " +
        "matches some words. Use this when the user asks to find, look up or check for an issue " +
        "or ticket in Linear. Returns up to 5 results, each with its identifier, title, status " +
        "and link. The matching is approximate: results may be only loosely related. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            description: "The words to search issue titles and descriptions for.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "safe",
      // LIVE FINDING (scripts/linear-live-check.ts): the server's `query` is a FUZZY search. A
      // nonsense string still returned an issue, so an empty result is rare and a non-empty one
      // is not proof of a match — which is why the description above says "approximate".
      //
      // A fixed, small page and only the four fields the formatter prints. Without `fields` the
      // server sends each issue's (truncated) description too, which is other people's text
      // this app has no use for in a list.
      fixed: () => ({ limit: SEARCH_LIMIT, fields: SEARCH_FIELDS }),
      describe: (args) => `Search Linear for "${text(args["query"])}"?`,
      format: (raw, args) => {
        const issues = parseObject(raw)["issues"];
        if (!Array.isArray(issues)) throw new Error("no `issues` list");
        if (issues.length === 0) {
          return `No Linear issues matched "${text(args["query"])}".`;
        }
        return issues.map((entry) => issueLine(asObject(entry))).join("\n\n");
      },
    },
    {
      name: "get_issue",
      remote: "get_issue",
      description:
        "Read one Linear issue by its identifier (like ENG-123): its title, status, link and " +
        "full description. Use this when the user names a specific issue and asks what it says " +
        "or what state it is in. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            description: "The issue identifier, e.g. ENG-123.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "safe",
      describe: (args) => `Read Linear issue ${text(args["id"])}?`,
      format: (raw) => {
        const issue = parseObject(raw);
        const description = optional(issue, "description");
        return description.length > 0
          ? `${issueLine(issue)}\n\n${description}`
          : issueLine(issue);
      },
    },
  ],
};

// "ENG-4: Set up your teams (Todo)" then the link on its own line, so it survives being
// dropped whole into a message.
function issueLine(issue: Record<string, unknown>): string {
  const status = optional(issue, "status");
  const head = `${need(issue, "id")}: ${need(issue, "title")}`;
  return `${status.length > 0 ? `${head} (${status})` : head}\n${need(issue, "url")}`;
}

function teamOf(settings: ConnectorSettings): string {
  return settings["defaultTeam"] ?? "(no team set)";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// --- Reading a result. Everything below THROWS on anything unexpected, and the adapter turns
// that into `bad-result`: "Linear reported success but I couldn't read what it sent back". A
// formatter that shrugged and printed "Created undefined" would be reporting a ticket nobody
// can find. ---

function parseObject(raw: string): Record<string, unknown> {
  return asObject(JSON.parse(raw) as unknown);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not an object");
  }
  return value as Record<string, unknown>;
}

function need(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`no \`${key}\``);
  }
  return value;
}

function optional(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

