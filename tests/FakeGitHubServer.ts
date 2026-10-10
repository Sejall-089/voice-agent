import { readFileSync } from "node:fs";
import {
  McpHarness,
  failed,
  ok,
  type McpHarnessOptions,
  type RemoteToolEntry,
  type ToolResult,
} from "./fakes/McpHarness.ts";
import {
  BAD_KEY_MESSAGE,
  BAD_KEY_STATUS,
  ERROR_MISSING_NUMBER,
  ERROR_RATE_LIMIT,
  FORM_HANDOFF_STRUCTURED,
  OWNER,
  REPO,
  errorIssueNotFound,
  errorNoPermission,
  errorRepoNotFound,
  formHandoffText,
} from "./fixtures/github/captured.ts";

// A GitHub-shaped MCP server that exists only in memory (M20). The protocol half is real
// (fakes/McpHarness.ts); this is GITHUB'S BEHAVIOUR, written from the recon captures and the
// server's source — not from core/mcp/, and not by copying the Linear fake, which differs from
// it in exactly the places that matter:
//
//   - AN UNKNOWN ARGUMENT IS SILENTLY IGNORED (measured: `bogus: 1` came back as a normal
//     success). Linear refuses one. So nothing here ever rejects a key — and that leniency is
//     the point: the app's own checks are the only thing between a wrong key and the server.
//   - `issue_write` DOES WHATEVER `method` SAYS. "update" really edits and really closes, on
//     purpose, so "the connector cannot reach it" is a test that could fail (CLAUDE.md, M19).
//   - IT WILL WRITE TO, AND READ FROM, ANY REPOSITORY IT HOLDS. The real token reads every
//     public repository on GitHub; a fake that only knew one would make "owner and repo are
//     fixed in code" pass by having nowhere else to go.
//   - A create answers `{id,url}` and nothing else (server source — see fixtures/github/README).
//   - A list item has no url, and `state` is upper-case there and lower-case in a read.
//   - Failures are `isError` results in the measured wording, API URL and all.
//
// WHAT WAS NEVER MEASURED IS NOT INVENTED. A call recon has no answer for — a create against a
// repository that does not exist, a `state` in a spelling the connector does not send — THROWS
// `unmeasured`, which reaches the test as a server-side error instead of a made-up result that
// a test could quietly come to depend on (M13's FakeCalendar).

export const GITHUB_TOOLS = JSON.parse(
  readFileSync(new URL("./fixtures/github/tools.json", import.meta.url), "utf8"),
) as RemoteToolEntry[];

export interface FakeGitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
}

export interface FakeGitHubOptions extends McpHarnessOptions {
  // Every repository this server holds, keyed "owner/repo". Defaults to the pinned one, empty.
  repos?: Record<string, FakeGitHubIssue[]>;
  // Every call is refused the way a token without the permission is.
  noPermission?: boolean;
  // Every call is refused the way a rate limit is.
  rateLimited?: boolean;
  // `issue_write` answers that it showed a form instead of writing (never seen live).
  formHandoff?: boolean;
  // Every call is refused with THIS text, as an `isError` result — for a failure recon never
  // produced. The shape (a normal result, one text block) is the measured one; the words are
  // the test's.
  failWith?: string;
}

export interface GitHubWrite {
  owner: string;
  repo: string;
  number: number;
  arguments: Record<string, unknown>;
}

export class FakeGitHubServer extends McpHarness {
  public readonly created: GitHubWrite[] = [];
  public readonly updated: GitHubWrite[] = [];

  protected readonly serverName = "Fake GitHub MCP";

  private readonly repos: Map<string, FakeGitHubIssue[]>;

  constructor(private readonly options: FakeGitHubOptions = {}) {
    super(options);
    this.repos = new Map(
      Object.entries(options.repos ?? { [`${OWNER}/${REPO}`]: [] }).map(([name, issues]) => [
        name.toLowerCase(),
        issues.map((issue) => ({ ...issue })),
      ]),
    );
  }

  // The issues a repository holds now, after any writes.
  issuesIn(owner: string, repo: string): FakeGitHubIssue[] {
    return this.repos.get(`${owner}/${repo}`.toLowerCase()) ?? [];
  }

  protected capturedTools(): RemoteToolEntry[] {
    return GITHUB_TOOLS;
  }

  protected badKey(): { status: number; message: string } {
    return { status: BAD_KEY_STATUS, message: BAD_KEY_MESSAGE };
  }

  // NOTE WHAT IS MISSING: no check for unknown keys. Each handler reads the arguments it knows
  // and never looks at the rest, which is what the real server was measured to do.
  protected handle(name: string, args: Record<string, unknown>): ToolResult {
    const owner = text(args["owner"]);
    const repo = text(args["repo"]);
    if (this.options.noPermission === true) return failed(errorNoPermission(owner, repo));
    if (this.options.rateLimited === true) return failed(ERROR_RATE_LIMIT);
    if (this.options.failWith !== undefined) return failed(this.options.failWith);

    if (name === "list_issues") return this.listIssues(owner, repo, args);
    if (name === "issue_read") return this.issueRead(owner, repo, args);
    if (name === "issue_write") return this.issueWrite(owner, repo, args);
    throw new Error(`unmeasured: recon never called ${name}`);
  }

  private listIssues(owner: string, repo: string, args: Record<string, unknown>): ToolResult {
    const issues = this.repos.get(`${owner}/${repo}`.toLowerCase());
    if (issues === undefined) return failed(errorRepoNotFound(owner, repo));

    const state = args["state"];
    if (state !== undefined && state !== "OPEN" && state !== "CLOSED") {
      throw new Error(`unmeasured: list_issues with state ${JSON.stringify(state)}`);
    }
    const matching = issues
      .filter((issue) => state === undefined || issue.state === String(state).toLowerCase())
      // Newest first. Measured on a real repository with and without an explicit order.
      .sort((a, b) => b.number - a.number);
    const perPage = typeof args["perPage"] === "number" ? args["perPage"] : 30;
    const page = matching.slice(0, perPage);
    const fields = Array.isArray(args["fields"]) ? args["fields"] : null;

    // Key order as captured: number, state, title — the server's, whatever `fields` listed.
    const items = page.map((issue) => {
      const full: Record<string, unknown> = {
        number: issue.number,
        state: issue.state.toUpperCase(),
        title: issue.title,
        body: issue.body,
      };
      if (fields === null) return full;
      return Object.fromEntries(Object.entries(full).filter(([key]) => fields.includes(key)));
    });
    const pageInfo: Record<string, unknown> = {
      hasNextPage: matching.length > page.length,
      hasPreviousPage: false,
    };
    if (page.length > 0) {
      pageInfo["startCursor"] = "Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAc=";
      pageInfo["endCursor"] = "Y3Vyc29yOnYyOpK0AAAAAAAAAAAAAAAAAAAAAAY=";
    }
    return ok(JSON.stringify({ issues: items, pageInfo, totalCount: matching.length }));
  }

  private issueRead(owner: string, repo: string, args: Record<string, unknown>): ToolResult {
    const number = args["issue_number"];
    if (typeof number !== "number") return failed(ERROR_MISSING_NUMBER);
    if (args["method"] !== "get") {
      throw new Error(`unmeasured: issue_read with method ${JSON.stringify(args["method"])}`);
    }
    // A missing repository and a missing issue are the SAME text — measured.
    const issue = this.repos
      .get(`${owner}/${repo}`.toLowerCase())
      ?.find((entry) => entry.number === number);
    if (issue === undefined) return failed(errorIssueNotFound(owner, repo, number));
    // Field order as captured in GET_RESULT / GET_RESULT_CLOSED, including the three keys only
    // a closed issue has, where the server puts them. Fields no formatter reads are shortened.
    const closed = issue.state === "closed";
    return ok(
      JSON.stringify({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        ...(closed ? { state_reason: "completed" } : {}),
        html_url: issueUrl(owner, repo, issue.number),
        user: { login: "sam-example", id: 100000001 },
        author_association: "OWNER",
        assignees: [],
        created_at: "2026-10-10T12:38:54Z",
        updated_at: "2026-10-10T12:38:54Z",
        ...(closed ? { closed_at: "2026-10-10T12:40:03Z", closed_by: "sam-example" } : {}),
        has_parent: false,
        has_children: false,
      }),
    );
  }

  private issueWrite(owner: string, repo: string, args: Record<string, unknown>): ToolResult {
    if (this.options.formHandoff === true) {
      return {
        content: [{ type: "text", text: formHandoffText(owner, repo) }],
        structuredContent: FORM_HANDOFF_STRUCTURED,
        isError: true,
      };
    }
    const issues = this.repos.get(`${owner}/${repo}`.toLowerCase());
    if (issues === undefined) {
      throw new Error("unmeasured: issue_write against a repository that does not exist");
    }
    const method = args["method"];

    if (method === "update") {
      // THE HALF THE CONNECTOR MUST NEVER REACH. It edits, and it closes.
      const number = args["issue_number"];
      const issue = issues.find((entry) => entry.number === number);
      if (typeof number !== "number" || issue === undefined) {
        throw new Error("unmeasured: issue_write update of a missing issue");
      }
      if (typeof args["title"] === "string") issue.title = args["title"];
      if (typeof args["body"] === "string") issue.body = args["body"];
      if (args["state"] === "open" || args["state"] === "closed") issue.state = args["state"];
      this.updated.push({ owner, repo, number, arguments: args });
      return ok(JSON.stringify({ id: String(4000000000 + number), url: issueUrl(owner, repo, number) }));
    }

    if (method === "create") {
      const title = args["title"];
      // The server's own words for this (issues.go, `createIssue`).
      if (typeof title !== "string" || title.length === 0) {
        return failed("missing required parameter: title");
      }
      const number = issues.reduce((highest, issue) => Math.max(highest, issue.number), 0) + 1;
      issues.push({
        number,
        title,
        body: typeof args["body"] === "string" ? args["body"] : "",
        state: "open",
      });
      this.created.push({ owner, repo, number, arguments: args });
      // `MinimalResponse`: the database id as a string, the html url, and NOTHING ELSE.
      return ok(JSON.stringify({ id: String(4000000000 + number), url: issueUrl(owner, repo, number) }));
    }

    throw new Error(`unmeasured: issue_write with method ${JSON.stringify(method)}`);
  }
}

function issueUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
