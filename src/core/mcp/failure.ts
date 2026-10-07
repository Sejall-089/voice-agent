import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorError, connectorError } from "../errors.ts";

// What does a failed MCP call MEAN? The classification half of the transport, kept apart from
// the transport itself so it can be tested without a network — CLAUDE.md's M13 lesson, where
// the untested half of GoogleCalendar.ts was the half deciding what a person gets told.
//
// Every shape here was measured against the real SDK and the real Linear endpoint
// (scripts/linear-recon.mjs), not recalled:
//
//   a rejected key            → StreamableHTTPError, code 401   (thrown by connect())
//   a server-side throw       → McpError, code -32603
//   a request that timed out  → McpError, code -32001 (RequestTimeout)
//   a closed connection       → a BARE Error("Not connected")
//   no network at all         → a TypeError from fetch
//
// The first is the only one a person can fix from .env, so it is the only one that names the
// key. Everything unrecognised is `unreachable` — the honest reading of "the call did not
// complete and I cannot say why" — with the error's own words attached.
export function classifyMcpFailure(
  error: unknown,
  app: string,
  keyName: string,
): ConnectorError {
  // Already ours: something upstream classified it. Passing it through unchanged is what stops
  // a "denied" being re-read as "unreachable" on its way out.
  if (error instanceof ConnectorError) return error;

  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403) {
      // DELIBERATELY NO DETAIL. The server's body is in the message, and nothing from an auth
      // failure belongs on screen beside the name of the variable to check.
      return connectorError("denied", app, "", keyName);
    }
    return connectorError("unreachable", app, `it answered HTTP ${error.code ?? "?"}`);
  }

  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return connectorError("timeout", app);
    if (error.code === ErrorCode.ConnectionClosed) {
      return connectorError("unreachable", app, "the connection closed");
    }
    return connectorError("tool-failed", app, clip(stripPrefix(error.message)));
  }

  const message = error instanceof Error ? error.message : String(error);
  return connectorError("unreachable", app, clip(message));
}

// The SDK prefixes its own messages ("MCP error -32603: ..."). The number means nothing to the
// person reading it.
function stripPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/i, "");
}

// Text from the far side is DATA that ends up on screen and in the log. Bounded where it
// enters, like `describe` in core/llm/plan.ts.
export const MAX_REMOTE_DETAIL = 300;

export function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REMOTE_DETAIL ? `${flat.slice(0, MAX_REMOTE_DETAIL).trimEnd()}…` : flat;
}
