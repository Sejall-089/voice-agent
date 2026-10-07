import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BAD_KEY_MESSAGE,
  BAD_KEY_STATUS,
  ERROR_ISSUE_NOT_FOUND,
  ERROR_TEAM_REQUIRED,
} from "./fixtures/linear/captured.ts";

// A Linear-shaped MCP server that exists only in memory (M19) — the role FakeGmail, FakeNotion
// and FakeCalendar play, with one difference that matters: THE PROTOCOL IS NOT FAKED. This is
// the SDK's real `Server` on the SDK's real in-memory transport, talking to the real `Client`
// inside `SdkMcpConnection`. Framing, capability negotiation, request ids, timeouts and error
// codes are all the genuine article; only the thing with consequences — a real workspace — is
// swapped out.
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
//
// ASYNC, WITH A REAL DELAY WHEN ASKED (CLAUDE.md, M16.9): `delayMs` makes every tool call
// genuinely take time, so an ordering test against this proves ordering and not call-sequence.

interface RemoteToolEntry {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  [key: string]: unknown;
}

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

export interface FakeMcpServerOptions {
  // What `tools/list` answers. Defaults to the captured Linear entries.
  tools?: RemoteToolEntry[];
  issues?: FakeIssue[];
  // The teams that exist. A create naming any other is refused in Linear's words.
  teams?: string[];
  // Every tool call waits this long before answering.
  delayMs?: number;
  // The named tool THROWS server-side (→ McpError -32603 at the client).
  throwOn?: string;
  // The named tool never answers at all (→ the client's own timeout).
  hangOn?: string;
  // The named tool answers "success" with this text instead of a real result — a server that
  // changed its result shape, or exited 0 with nothing.
  garble?: { tool: string; text: string };
  // connect() is refused the way a bad key is: the REAL error type, code and message.
  rejectKey?: boolean;
  timeline?: string[];
}

export class FakeMcpServer {
  public readonly calls: { name: string; arguments: Record<string, unknown> }[] = [];
  public readonly created: FakeIssue[] = [];
  public readonly updated: { id: string; arguments: Record<string, unknown> }[] = [];
  public connections = 0;
  public listCalls = 0;

  private readonly issues: FakeIssue[];
  private readonly teams: string[];
  private readonly servers: Server[] = [];

  constructor(private readonly options: FakeMcpServerOptions = {}) {
    this.issues = [...(options.issues ?? [])];
    this.teams = options.teams ?? ["Engineering"];
  }

  // Hand this to `SdkMcpConnection` as its `transport` option. A fresh linked pair — and a
  // fresh Server on the far end — per connection attempt, exactly as a real reconnect would get.
  readonly transport = (): Transport => {
    if (this.options.rejectKey === true) {
      const [client] = InMemoryTransport.createLinkedPair();
      client.start = () =>
        Promise.reject(new StreamableHTTPError(BAD_KEY_STATUS, BAD_KEY_MESSAGE));
      return client;
    }
    this.connections += 1;
    const [client, server] = InMemoryTransport.createLinkedPair();
    void this.serve(server);
    return client;
  };

  // Drop every live connection from the server's side, as a restart would.
  async dropConnections(): Promise<void> {
    await Promise.all(this.servers.splice(0).map((server) => server.close()));
  }

  private async serve(transport: Transport): Promise<void> {
    const server = new Server(
      { name: "Fake Linear MCP", version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      this.listCalls += 1;
      return Promise.resolve({ tools: this.options.tools ?? LINEAR_TOOLS });
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      this.calls.push({ name, arguments: args });
      this.options.timeline?.push(`mcp:${name}`);

      if (this.options.hangOn === name) await new Promise(() => undefined);
      if (this.options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      }
      if (this.options.throwOn === name) throw new Error("upstream exploded");
      if (this.options.garble?.tool === name) return ok(this.options.garble.text);

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
    });
    this.servers.push(server);
    await server.connect(transport);
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

interface ToolResult {
  // The SDK's result type is an open record.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function failed(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
