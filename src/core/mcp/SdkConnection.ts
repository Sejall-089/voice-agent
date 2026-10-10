import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectorError } from "../errors.ts";
import type { ToolInput } from "../types.ts";
import { classifyMcpFailure, type McpPhase } from "./failure.ts";
import type { McpConnection, RemoteResult, RemoteTool, ResultBlock } from "./types.ts";

// How long one request on an OPEN connection may take before we stop waiting — `tools/list`
// and every tool call. Linear answered every recon call in well under two seconds; this is a
// ceiling for a hung connection, not a typical duration.
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

// How long OPENING the connection may take (the `initialize` exchange) — a separate, longer
// budget, because it is a different wait: a cold start on someone else's server, behind DNS and
// a TLS handshake, on the first use of a session.
//
// Found live (M21): the session's first GitHub use took longer than the 20s it then shared with
// every other request, and a chain stopped at step 2 for it. Measured the same day, cold, four
// times each: GitHub 1.4-3.6s, Linear 2.9-7.1s — so 20s was not tight for a typical connect,
// and the live one was an outlier. 30s is room for an outlier — about four times the slowest
// connect measured — not a measured need. (It was 45s for one commit; brought down because the
// worst case before a dialog is this plus the tool list's 20s, and 65s was too long to wait.)
//
// Giving up here costs nothing but the wait: no tool call has been sent, and the failure says
// so (`connect-failed`). It is the tool call's own, shorter budget that guards against waiting
// on something that may already have happened.
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface SdkConnectionOptions {
  // The connector's display name and the NAME of its key variable — for wording failures.
  app: string;
  keyName: string;
  // Builds a FRESH transport per connection attempt (a transport cannot be reused once closed).
  // Injected so composition (main.ts) decides it is Streamable HTTP with a bearer key, and tests
  // decide it is the SDK's in-memory pair — this file never learns which, and never sees the key.
  transport: () => Transport;
  // The budget for a request on an open connection (default DEFAULT_REQUEST_TIMEOUT_MS)…
  timeoutMs?: number;
  // …and for opening it (default DEFAULT_CONNECT_TIMEOUT_MS). Two options, never one derived
  // from the other, so a test that shortens one cannot silently shorten both.
  connectTimeoutMs?: number;
  // Told "Connecting to <app>…" each time a connection is about to be OPENED — once per
  // attempt, before anything is sent, and not again while it stays open. Composition hands in
  // the shell's status line; this file never learns there is a screen. Omitted → said to nobody.
  onConnecting?: (line: string) => void;
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
  private readonly connectTimeoutMs: number;
  private connecting: Promise<Client> | null = null;
  private tools: readonly RemoteTool[] | null = null;

  constructor(private readonly options: SdkConnectionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
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
      // Reading the tool list is still CONNECTING: no tool call has been sent.
      throw this.fail(error, "connecting");
    }
  }

  async callTool(name: string, args: ToolInput): Promise<RemoteResult> {
    // Outside the `try` on purpose. If the link cannot be opened, the rejection is `open()`'s
    // own — already classified as a connecting failure — and it must reach the caller as that.
    // Inside the `try` it would be re-caught below and, were it not already ours, called a
    // failed CALL: "may or may not have gone through" about a call that was never sent.
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
      // THE ONE PLACE A FAILURE MEANS "IT MAY HAVE HAPPENED": the call was sent.
      throw this.fail(error, "calling");
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
    // Said BEFORE the transport is built or anything is sent, so the line is up for the whole
    // wait and not just the end of it. A listener that throws must not cost the connection.
    try {
      this.options.onConnecting?.(`Connecting to ${this.options.app}…`);
    } catch {
      // The status line is a courtesy.
    }

    const client = new Client({ name: "voice-agent", version: "0" });
    // The link dropped underneath us. Forget it, so the next call reconnects — and forget the
    // tool list with it, since a server that restarted may not be the server that was listed.
    client.onclose = () => {
      this.reset();
    };
    try {
      // Its own, longer budget (DEFAULT_CONNECT_TIMEOUT_MS): the SDK applies this to the
      // `initialize` request, and to nothing after it.
      await client.connect(this.options.transport(), { timeout: this.connectTimeoutMs });
      return client;
    } catch (error) {
      throw this.fail(error, "connecting");
    }
  }

  private reset(): void {
    this.connecting = null;
    this.tools = null;
  }

  // `phase` is where the error was CAUGHT — see classifyMcpFailure for why it has to be said.
  private fail(error: unknown, phase: McpPhase): Error {
    return classifyMcpFailure(error, this.options.app, this.options.keyName, phase);
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
