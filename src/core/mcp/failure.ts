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
//
// --- The phase (M21) ---
//
// The same error means two different things depending on what was in flight when it happened,
// and only the CALLER knows that:
//
//   "connecting"  opening the link, or reading the tool list. No tool call has been sent, so
//                 whatever went wrong, nothing happened on the far side.
//   "calling"     a tool call was sent. If it then fails to answer, it may have been acted on.
//
// It is an ARGUMENT, passed from the `catch` that caught the error (SdkConnection.ts), and it is
// required — there is deliberately no default, so no call site can classify a failure without
// saying which it was. It is never inferred from the error's type or text: a connect timeout
// and a call timeout are the identical `McpError(-32001, "Request timed out")`.
export type McpPhase = "connecting" | "calling";

export function classifyMcpFailure(
  error: unknown,
  app: string,
  keyName: string,
  phase: McpPhase,
): ConnectorError {
  // Already ours: something upstream classified it. Passing it through unchanged is what stops
  // a "denied" being re-read as "unreachable" on its way out — and what lets a connection
  // failure raised while opening the link keep its phase when a tool call's `catch` sees it.
  if (error instanceof ConnectorError) return error;

  // A rejected key is the same fact in either phase, and "safe to try again" would be wrong
  // advice for it: trying again changes nothing until the key does.
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    // DELIBERATELY NO DETAIL. The server's body is in the message, and nothing from an auth
    // failure belongs on screen beside the name of the variable to check.
    return connectorError("denied", app, "", keyName);
  }

  const detail = describe(error);

  if (phase === "connecting") {
    // Nothing was sent, whatever this was. A timeout carries no detail — the server said
    // nothing — and reads "didn't answer"; everything else says what did happen.
    return connectorError("connect-failed", app, detail.kind === "timeout" ? "" : detail.text);
  }

  if (detail.kind === "timeout") return connectorError("timeout", app);
  if (detail.kind === "server") return connectorError("tool-failed", app, detail.text);
  return connectorError("unreachable", app, detail.text);
}

// What the error IS, in our own words — independent of the phase, which decides what it MEANS.
function describe(error: unknown): { kind: "timeout" | "server" | "link"; text: string } {
  if (error instanceof StreamableHTTPError) {
    return { kind: "link", text: `it answered HTTP ${error.code ?? "?"}` };
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return { kind: "timeout", text: "" };
    if (error.code === ErrorCode.ConnectionClosed) return { kind: "link", text: "the connection closed" };
    return { kind: "server", text: clip(stripPrefix(error.message)) };
  }
  return { kind: "link", text: clip(error instanceof Error ? error.message : String(error)) };
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
