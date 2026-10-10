import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// The half of a fake MCP server that is about MCP and not about any app (M20) — split out of
// FakeMcpServer.ts when a second connector needed one.
//
// THE PROTOCOL IS NOT FAKED. This is the SDK's real `Server` on the SDK's real in-memory
// transport, talking to the real `Client` inside `SdkMcpConnection`. Framing, capability
// negotiation, request ids, timeouts and error codes are all the genuine article; only the
// thing with consequences — a real workspace — is swapped out.
//
// What an APP does with a call lives in a subclass (FakeMcpServer.ts is Linear,
// FakeGitHubServer.ts is GitHub), and each of those is written from that server's recon
// captures. Nothing in this file knows a tool name. In particular it does NOT decide what
// happens to an argument the server does not know: Linear refuses one and GitHub silently
// ignores it, and a shared rule here would make one of the two fakes more lenient, or
// stricter, than the thing it stands in for.
//
// ASYNC, WITH A REAL DELAY WHEN ASKED (CLAUDE.md, M16.9): `delayMs` makes every tool call
// genuinely take time, so an ordering test against this proves ordering and not call-sequence.

export interface RemoteToolEntry {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface ToolResult {
  // The SDK's result type is an open record.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function failed(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export interface McpHarnessOptions {
  // What `tools/list` answers. Defaults to the app's captured entries.
  tools?: RemoteToolEntry[];
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

export abstract class McpHarness {
  public readonly calls: { name: string; arguments: Record<string, unknown> }[] = [];
  public connections = 0;
  public listCalls = 0;

  private readonly servers: Server[] = [];

  constructor(private readonly harness: McpHarnessOptions = {}) {}

  // --- What a subclass says about its app. ---
  protected abstract readonly serverName: string;
  // The app's captured `tools/list`.
  protected abstract capturedTools(): RemoteToolEntry[];
  // What this server's rejection of a bad key was MEASURED to be.
  protected abstract badKey(): { status: number; message: string };
  // The app's own rules for one call, unknown arguments included.
  protected abstract handle(name: string, args: Record<string, unknown>): ToolResult;

  // Hand this to `SdkMcpConnection` as its `transport` option. A fresh linked pair — and a
  // fresh Server on the far end — per connection attempt, exactly as a real reconnect would get.
  readonly transport = (): Transport => {
    if (this.harness.rejectKey === true) {
      const [client] = InMemoryTransport.createLinkedPair();
      const { status, message } = this.badKey();
      client.start = () => Promise.reject(new StreamableHTTPError(status, message));
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
      { name: this.serverName, version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      this.listCalls += 1;
      return Promise.resolve({ tools: this.harness.tools ?? this.capturedTools() });
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      this.calls.push({ name, arguments: args });
      this.harness.timeline?.push(`mcp:${name}`);

      if (this.harness.hangOn === name) await new Promise(() => undefined);
      if (this.harness.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.harness.delayMs));
      }
      if (this.harness.throwOn === name) throw new Error("upstream exploded");
      if (this.harness.garble?.tool === name) return ok(this.harness.garble.text);

      return this.handle(name, args);
    });
    this.servers.push(server);
    await server.connect(transport);
  }
}
