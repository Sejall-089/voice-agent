import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectorError } from "../errors.ts";
import type { ToolInput } from "../types.ts";
import { classifyMcpFailure } from "./failure.ts";
import type { McpConnection, RemoteResult, RemoteTool, ResultBlock } from "./types.ts";

// How long one request may take before we stop waiting. Linear answered every recon call in
// well under two seconds; this is a ceiling for a hung connection, not a typical duration.
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface SdkConnectionOptions {
  // The connector's display name and the NAME of its key variable — for wording failures.
  app: string;
  keyName: string;
  // Builds a FRESH transport per connection attempt (a transport cannot be reused once closed).
  // Injected so composition (main.ts) decides it is Streamable HTTP with a bearer key, and tests
  // decide it is the SDK's in-memory pair — this file never learns which, and never sees the key.
  transport: () => Transport;
  timeoutMs?: number;
}

// The real `McpConnection`: the official SDK's client over whatever transport it is handed.
//
// Thin on purpose. Everything that DECIDES anything lives elsewhere and is tested there —
// what a failure means (failure.ts), whether a call may happen and what its result becomes
// (adapter.ts). What is left here is connection lifetime, and one rule about it:
//
// A FAILED CALL IS NEVER RETRIED. A dropped connection is reopened by the NEXT call, not by
// re-sending this one. The call that failed may have been a create that reached the server
// before the link died, and sending it again is how one instruction becomes two tickets.
export class SdkMcpConnection implements McpConnection {
  private readonly timeoutMs: number;
  private connecting: Promise<Client> | null = null;
  private tools: readonly RemoteTool[] | null = null;

  constructor(private readonly options: SdkConnectionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async listTools(): Promise<readonly RemoteTool[]> {
    if (this.tools !== null) return this.tools;
    const client = await this.client();
    try {
      const found: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.timeoutMs,
        });
        for (const tool of page.tools) {
          found.push({
            name: tool.name,
            inputSchema: tool.inputSchema,
            readOnlyHint: tool.annotations?.readOnlyHint,
            destructiveHint: tool.annotations?.destructiveHint,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      this.tools = found;
      return found;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async callTool(name: string, args: ToolInput): Promise<RemoteResult> {
    const client = await this.client();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: this.timeoutMs,
      });
      return {
        isError: result.isError === true,
        content: toBlocks(result.content),
        structuredContent: result.structuredContent,
      };
    } catch (error) {
      throw this.fail(error);
    }
  }

  // Connect on first use, once. The PROMISE is cached rather than the client, so two calls
  // arriving together share one connection attempt instead of racing two.
  private client(): Promise<Client> {
    if (this.connecting === null) {
      const attempt = this.open();
      this.connecting = attempt;
      // A failed attempt must not be remembered: the next call tries again from scratch.
      attempt.catch(() => {
        if (this.connecting === attempt) this.reset();
      });
    }
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const client = new Client({ name: "voice-agent", version: "0" });
    // The link dropped underneath us. Forget it, so the next call reconnects — and forget the
    // tool list with it, since a server that restarted may not be the server that was listed.
    client.onclose = () => {
      this.reset();
    };
    try {
      await client.connect(this.options.transport(), { timeout: this.timeoutMs });
      return client;
    } catch (error) {
      throw classifyMcpFailure(error, this.options.app, this.options.keyName);
    }
  }

  private reset(): void {
    this.connecting = null;
    this.tools = null;
  }

  private fail(error: unknown): Error {
    return classifyMcpFailure(error, this.options.app, this.options.keyName);
  }
}

// The SDK types `content` loosely (it also covers a legacy result shape). Read defensively and
// keep only what the flattener uses.
function toBlocks(content: unknown): ResultBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ResultBlock[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw["type"] !== "string") continue;
    const block: ResultBlock = { type: raw["type"] };
    if (typeof raw["text"] === "string") block.text = raw["text"];
    if (typeof raw["uri"] === "string") block.uri = raw["uri"];
    if (typeof raw["name"] === "string") block.name = raw["name"];
    blocks.push(block);
  }
  return blocks;
}

// The safe default when a connector has no connection built for it. Same role as
// UnavailableGmail / UnavailableCalendar: the second line of defence, since a connector that is
// not configured is never on the menu in the first place (core/mcp/load.ts).
export class UnavailableConnection implements McpConnection {
  constructor(private readonly app: string) {}

  listTools(): Promise<readonly RemoteTool[]> {
    return Promise.reject(connectorError("not-configured", this.app));
  }

  callTool(_name: string, _args: ToolInput): Promise<RemoteResult> {
    return Promise.reject(connectorError("not-configured", this.app));
  }
}
