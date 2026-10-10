import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ConnectorDef } from "./types.ts";

// How a connector's link is built (M20): Streamable HTTP to the definition's URL, with the key
// as a Bearer token and nothing else.
//
// This lived inline in main.ts through M19, which is the one place in this repo where nothing
// can have a test (CLAUDE.md: importing it boots electron). It is small, and it is also the
// only code that ever holds a connector's key — where it is sent, and under which header, is
// exactly the kind of fact that should not rest on someone having read ten lines correctly.
//
// Recon found a second connector needs nothing more: GitHub's hosted server accepts the same
// bare `Authorization: Bearer` header Linear's does (scripts/github-recon.mjs, Q1).
//
// Returns a FACTORY, because a transport cannot be reused once closed and `SdkMcpConnection`
// builds a fresh one per connection attempt.
export function bearerHttpTransport(
  def: Pick<ConnectorDef, "label" | "url">,
  key: string,
  // Tests hand in a recording `fetch`. Omitted → the runtime's own.
  fetchImpl?: typeof fetch,
): () => Transport {
  const url = new URL(def.url);
  if (url.protocol !== "https:") {
    // A definition bug, caught at startup like the ones buildConnectorTools refuses. Over plain
    // http the key would cross the network readable; no connector has a reason to ask for that.
    throw new Error(`${def.label}: a connector URL must be https.`);
  }
  return () =>
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
}
