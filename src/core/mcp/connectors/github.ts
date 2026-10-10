import type { ToolInput } from "../../types.ts";
import type { ConnectorDef, ConnectorSettings } from "../types.ts";

// GitHub issues, over GitHub's hosted MCP server (M20) — the second connector, added to find
// out what in core/mcp/ was really about Linear. Every name, description, schema, tier and
// sentence the app uses for GitHub is in this file, and none of it comes from the server.
//
// TRANSCRIBED FROM RECON, 2026-10-09/10 (scripts/github-recon.mjs, tests/fixtures/github/).
// The facts that shaped it, each one a way this server is NOT Linear's:
//
//   1. `issue_write` CREATES OR UPDATES DEPENDING ON THE VALUE OF `method`, and an update can
//      also close. Linear's write was narrowed by leaving a key out; this one is narrowed by
//      code FIXING a key. So `method` is fixed to "create", it is not in the schema below, and
//      core/mcp/adapter.ts refuses at startup any definition where a fixed key is also one the
//      model may send.
//   2. THE TOKEN READS EVERY PUBLIC REPOSITORY ON GITHUB, and writes wherever it was granted.
//      `owner` and `repo` are therefore fixed from connectors.json on EVERY tool, reads
//      included. The model never names a repository — which also means a stranger's issue text
//      can only arrive here if this install is pointed at a repository strangers can write to.
//   3. THE SERVER SILENTLY IGNORES AN ARGUMENT IT DOES NOT KNOW, and its schemas do not forbid
//      extras. Nothing on the far side would catch a renamed key; the adapter's drift check
//      (every sent key must be one the server names) is what does.
//   4. A LIST ITEM HAS NO URL, and `state` is "OPEN" in a list but "open" in a read. Links are
//      built here from the pinned owner and repository; states are lower-cased on the way out.
//   5. A CREATE ANSWERS `{id, url}` AND NOTHING ELSE — no title, no number. (From the server's
//      source: no script may create a real issue, so this one shape was never captured.)
//   6. A FAILURE'S TEXT CARRIES THE API URL, AND SOMETIMES A USER ID AND A REQUEST ID. None of
//      it is shown. Each tool has a `failure` below that recognises the measured cases and
//      answers in this file's words; anything else is the bare "GitHub said no."
//   7. The server's hints mark `issue_write` as not read-only and say NOTHING about destructive.
//      The tier below is `dangerous` because this file says so (core/mcp/tiers.ts).
//
// `search_issues` IS DELIBERATELY NOT HERE. It returned nothing for queries that had to match,
// a `repo:` qualifier typed into the query displaces the repository the arguments name, and it
// is limited to about ten calls a minute. `list_issues` requires owner and repo and has no free
// text for a model to widen.
//
// Also not here: comments, labels, assignees, pull requests, files, and the server's other 43
// tools. They get added one at a time, when something needs them.

const LIST_PER_PAGE = 5;
// Also listed in scripts/github-recon.mjs, which is what notices if the server stops accepting
// them. Without `fields` every item carries its whole body — other people's text this app has
// no use for in a list.
const LIST_FIELDS = ["number", "title", "state"];

export const githubConnector: ConnectorDef = {
  id: "github",
  label: "GitHub",
  url: "https://api.githubcopilot.com/mcp/",
  keyName: "GITHUB_TOKEN",
  tools: [
    {
      name: "create_issue",
      remote: "issue_write",
      description:
        "Create a NEW issue in the user's GitHub repository. Use this ONLY when the user asks " +
        "for GitHub by name ('open a GitHub issue', 'file this on GitHub') — never for a " +
        "request that names another tracker or names none. Write `title` yourself: one short " +
        "line saying what the issue is, taken from what the user said. Put the detail in " +
        "`body` — in a plan this is normally an earlier step's whole result, e.g. {step1} " +
        "after reading an email. The body must be the user's own words or an earlier step's " +
        "result: NEVER make one up, and never fill it with a note about the instruction. If " +
        "there is genuinely nothing to put there, leave `body` out. The repository is already " +
        "chosen; you cannot name one. This cannot edit, comment on or close an existing issue. " +
        "The result is the new issue's number and its link.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "A short, specific title for the issue, in your own words.",
          },
          body: {
            type: "string",
            description:
              "The body of the issue, as plain text or Markdown. May contain {stepN} in a plan.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      // Something appears in a repository other people read, under the user's name, with no
      // undo this app can offer. The dialog shows the whole of it first.
      risk: "dangerous",
      requires: ["owner", "repo"],
      fixed: (settings) => ({ method: "create", ...pinned(settings) }),
      // The question first and on its own line: `toSpokenConfirm` says only the first paragraph,
      // and it should be the decision — including WHERE — not the body of an email.
      describe: (args, settings) => {
        const body = text(args["body"]);
        return [
          `Create this GitHub issue in ${repoOf(settings)}?`,
          `Title: ${text(args["title"])}`,
          body.length > 0 ? body : "(no description)",
        ].join("\n\n");
      },
      format: (raw, args, settings) => {
        const url = need(parseObject(raw), "url");
        // The title is OURS (it is the argument that was sent); the number is read out of the
        // link, which is the only place the server put it.
        return `Created #${numberIn(url, settings)}: ${text(args["title"])}\n${url}`;
      },
      failure: (said, _args, settings) => explain(said, settings),
    },
    {
      name: "list_issues",
      remote: "list_issues",
      description:
        "List the most recent issues in the user's GitHub repository: up to 5, newest first, " +
        "each with its number, title, state and link. Use this when the user asks what issues " +
        "are open (or closed) on GitHub. Set `state` to OPEN or CLOSED to list only those; leave " +
        "it out for both. It cannot search by words, and the repository is already chosen. " +
        "Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["OPEN", "CLOSED"],
            description: "OPEN for open issues, CLOSED for closed ones. Omit for both.",
          },
        },
        additionalProperties: false,
      },
      risk: "safe",
      requires: ["owner", "repo"],
      fixed: (settings) => ({
        ...pinned(settings),
        perPage: LIST_PER_PAGE,
        fields: LIST_FIELDS,
        orderBy: "CREATED_AT",
        direction: "DESC",
      }),
      describe: (args, settings) => `List the ${kind(args)}issues in ${repoOf(settings)}?`,
      format: (raw, args, settings) => {
        const listing = parseObject(raw);
        const issues = listing["issues"];
        if (!Array.isArray(issues)) throw new Error("no `issues` list");
        if (issues.length === 0) return `No ${kind(args)}issues in ${repoOf(settings)}.`;

        const lines = issues.map((entry) => {
          const issue = asObject(entry);
          const number = needNumber(issue, "number");
          return `${issueHead(issue, number)}\n${issueUrl(settings, number)}`;
        });
        const total = listing["totalCount"];
        if (typeof total === "number" && total > issues.length) {
          lines.push(`Showing ${issues.length} of ${total}.`);
        }
        return lines.join("\n\n");
      },
      failure: (said, _args, settings) => explain(said, settings),
    },
    {
      name: "get_issue",
      remote: "issue_read",
      description:
        "Read one issue in the user's GitHub repository by its number: its title, state, link " +
        "and full text. Use this when the user names a specific GitHub issue (like 'issue 12' " +
        "or '#12') and asks what it says or what state it is in. The repository is already " +
        "chosen. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          issue_number: {
            type: "integer",
            minimum: 1,
            description: "The issue's number, e.g. 12 for #12.",
          },
        },
        required: ["issue_number"],
        additionalProperties: false,
      },
      risk: "safe",
      requires: ["owner", "repo"],
      fixed: (settings) => ({ method: "get", ...pinned(settings) }),
      describe: (args, settings) =>
        `Read GitHub issue #${show(args["issue_number"])} in ${repoOf(settings)}?`,
      format: (raw, args, settings) => {
        const issue = parseObject(raw);
        const number = needNumber(issue, "number");
        const url = need(issue, "html_url");
        // Asked for #12 of the pinned repository; anything else is not the answer.
        if (number !== args["issue_number"] || numberIn(url, settings) !== number) {
          throw new Error("not the issue that was asked for");
        }
        const body = optional(issue, "body");
        const head = `${issueHead(issue, number)}\n${url}`;
        return body.trim().length > 0 ? `${head}\n\n${body}` : head;
      },
      failure: (said, args, settings) =>
        // Measured: a missing issue and a missing repository are the SAME 404 here, so the
        // sentence has to be true of both.
        said.includes(NOT_FOUND)
          ? `I couldn't find issue #${show(args["issue_number"])} in ${repoOf(settings)}.`
          : explain(said, settings),
    },
  ],
};

// --- Where. `owner` and `repo` come from connectors.json and nowhere else. ---

function pinned(settings: ConnectorSettings): ToolInput {
  return { owner: settings["owner"] ?? "", repo: settings["repo"] ?? "" };
}

function repoOf(settings: ConnectorSettings): string {
  return `${settings["owner"] ?? "(no owner set)"}/${settings["repo"] ?? "(no repo set)"}`;
}

function issueUrl(settings: ConnectorSettings, number: number): string {
  const owner = encodeURIComponent(settings["owner"] ?? "");
  const repo = encodeURIComponent(settings["repo"] ?? "");
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

// The issue number in a link the SERVER sent — which must be a link to an issue in the pinned
// repository, or this throws. A create that "succeeded" somewhere else is not a success to
// report (M11: an operation reporting success is not proof it did anything, or did it here).
// GitHub treats owner and repository names case-insensitively, so this does too.
const ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/;

function numberIn(url: string, settings: ConnectorSettings): number {
  const match = ISSUE_URL.exec(url);
  const same = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  if (match === null || !same(match[1], settings["owner"]) || !same(match[2], settings["repo"])) {
    throw new Error("its link is not to an issue in this repository");
  }
  return Number(match[3]);
}

// "#7: Login button does nothing on Safari (open)". The state is lower-cased because the server
// spells it "OPEN" in a list and "open" in a read.
function issueHead(issue: Record<string, unknown>, number: number): string {
  const state = optional(issue, "state").toLowerCase();
  const head = `#${number}: ${need(issue, "title")}`;
  return state.length > 0 ? `${head} (${state})` : head;
}

// "open ", "closed " or "" — for "List the open issues" / "No closed issues".
function kind(args: ToolInput): string {
  const state = args["state"];
  return state === "OPEN" ? "open " : state === "CLOSED" ? "closed " : "";
}

// --- What a failure means. Matched on the status and reason the server was MEASURED to send
// (tests/fixtures/github/captured.ts), as narrowly as that allows; the sentence that comes back
// is built from settings and never from the server's text, which carries URLs and IDs. Null
// means "not one I recognise", and the adapter then says only that GitHub said no. ---

const NOT_FOUND = ": 404 Not Found";

function explain(said: string, settings: ConnectorSettings): string | null {
  if (said.includes(": 403 API rate limit exceeded")) {
    return "it is rate-limiting me. Try again in a minute.";
  }
  if (said.includes(": 403 Resource not accessible by personal access token")) {
    return `GITHUB_TOKEN isn't allowed to do that in ${repoOf(settings)} — check its Issues permission.`;
  }
  if (said.includes(NOT_FOUND) || said.includes("Could not resolve to a Repository")) {
    return `I couldn't find ${repoOf(settings)} — check connectors.json, and that GITHUB_TOKEN can see it.`;
  }
  // From the server's source, never seen live: it showed a form to a client that can render
  // one, and wrote nothing. This app cannot render one, so the honest report is what did NOT
  // happen.
  if (said.startsWith("An interactive form has been shown")) {
    return "it showed a form instead of creating the issue. Nothing was created.";
  }
  return null;
}

// --- Reading a result. Everything below THROWS on anything unexpected, and the adapter turns
// that into `bad-result`: "GitHub reported success but I couldn't read what it sent back". ---

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function show(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "?";
}

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

function needNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`no \`${key}\``);
  }
  return value;
}

function optional(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}
