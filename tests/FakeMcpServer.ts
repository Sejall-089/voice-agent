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
  ERROR_ISSUE_NOT_FOUND,
  ERROR_TEAM_REQUIRED,
} from "./fixtures/linear/captured.ts";

// A Linear-shaped MCP server that exists only in memory (M19) — the role FakeGmail, FakeNotion
// and FakeCalendar play. The protocol half is real and lives in fakes/McpHarness.ts (split out
// in M20, when GitHub needed a fake of its own); what is here is LINEAR'S BEHAVIOUR and nothing
// else.
//
// THE RULES BELOW ARE WRITTEN FROM THE RECON CAPTURES, NOT FROM THE ADAPTER (CLAUDE.md: "a fake
// must never be more lenient than the real thing", and "write the fake's rules independently of
// the code under test"). Specifically:
//
//   - Unknown argument  → an isError RESULT, never a throw, in Linear's exact wording. The
//     accepted keys are read from tests/fixtures/linear/tools.json — the server's own captured
//     schema — and not from anything in core/mcp/.
//   - `save_issue` with an `id` UPDATES. That is the dangerous half of the real tool, and it is
//     implemented here precisely so a test can prove the connector cannot reach it.
//   - `save_issue` with no team → the captured "team is required" result.
//   - A missing issue → the captured JSON error, which is a DIFFERENT format from the others.
//
// What it does NOT model: search matching. Recon never established how `query` matches (one
// probe, "a", matched everything), so `list_issues` returns every configured issue and records
// the query it was sent. Inventing a matching rule here would be exactly M13's FakeCalendar bug.

export const LINEAR_TOOLS = JSON.parse(
  readFileSync(new URL("./fixtures/linear/tools.json", import.meta.url), "utf8"),
) as RemoteToolEntry[];

export interface FakeIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  team: string;
  url: string;
}

export interface FakeMcpServerOptions extends McpHarnessOptions {
  issues?: FakeIssue[];
  // The teams that exist. A create naming any other is refused in Linear's words.
  teams?: string[];
}

export class FakeMcpServer extends McpHarness {
  public readonly created: FakeIssue[] = [];
  public readonly updated: { id: string; arguments: Record<string, unknown> }[] = [];

  protected readonly serverName = "Fake Linear MCP";

  private readonly issues: FakeIssue[];
  private readonly teams: string[];

  constructor(options: FakeMcpServerOptions = {}) {
    super(options);
    this.issues = [...(options.issues ?? [])];
    this.teams = options.teams ?? ["Engineering"];
  }

  protected capturedTools(): RemoteToolEntry[] {
    return LINEAR_TOOLS;
  }

  protected badKey(): { status: number; message: string } {
    return { status: BAD_KEY_STATUS, message: BAD_KEY_MESSAGE };
  }

  protected handle(name: string, args: Record<string, unknown>): ToolResult {
    const unknown = this.unknownKey(name, args);
    if (unknown !== null) {
      return failed(
        `Input validation error: Invalid arguments for tool ${name}: Unrecognized key: "${unknown}"`,
      );
    }
    if (name === "save_issue") return this.saveIssue(args);
    if (name === "list_issues") return this.listIssues();
    if (name === "get_issue") return this.getIssue(args);
    return failed(`Unknown tool: ${name}`);
  }

  // Strictness taken from the SERVER's captured schema (additionalProperties: false).
  private unknownKey(name: string, args: Record<string, unknown>): string | null {
    const tool = LINEAR_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return null;
    const accepted = Object.keys(tool.inputSchema.properties ?? {});
    return Object.keys(args).find((key) => !accepted.includes(key)) ?? null;
  }

  private saveIssue(args: Record<string, unknown>): ToolResult {
    const id = args["id"];
    if (typeof id === "string") {
      // THE HALF THE CONNECTOR MUST NEVER REACH.
      this.updated.push({ id, arguments: args });
      return ok(JSON.stringify({ id, title: args["title"] ?? "", url: `https://linear.app/acme/issue/${id}` }));
    }
    const team = args["team"];
    if (typeof team !== "string") return failed(ERROR_TEAM_REQUIRED);
    if (!this.teams.includes(team)) return failed(`Error: Could not find team "${team}"`);
    const title = args["title"];
    if (typeof title !== "string" || title.length === 0) {
      return failed("Error: title is required when creating an issue");
    }
    const number = this.issues.length + this.created.length + 5;
    const issue: FakeIssue = {
      id: `ENG-${number}`,
      title,
      description: typeof args["description"] === "string" ? args["description"] : "",
      status: "Backlog",
      team,
      url: `https://linear.app/acme/issue/ENG-${number}/${slug(title)}`,
    };
    this.created.push(issue);
    // Field order as captured in CREATE_RESULT; the fields no formatter reads are omitted.
    return ok(
      JSON.stringify({
        id: issue.id,
        uuid: "00000000-0000-4000-8000-000000000005",
        title: issue.title,
        description: issue.description,
        priority: { value: 0, name: "No priority" },
        url: issue.url,
        status: issue.status,
        statusType: "backlog",
        labels: [],
        team: issue.team,
      }),
    );
  }

  private listIssues(): ToolResult {
    return ok(
      JSON.stringify({
        issues: this.issues.map(({ id, title, status, url }) => ({ id, title, status, url })),
        hasNextPage: false,
      }),
    );
  }

  private getIssue(args: Record<string, unknown>): ToolResult {
    const id = args["id"];
    if (typeof id !== "string") {
      return failed(
        "Input validation error: Invalid arguments for tool get_issue: id: Invalid input: expected string, received undefined",
      );
    }
    const issue = this.issues.find((entry) => entry.id === id);
    if (issue === undefined) return failed(ERROR_ISSUE_NOT_FOUND);
    return ok(
      JSON.stringify({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        status: issue.status,
        team: issue.team,
      }),
    );
  }
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
