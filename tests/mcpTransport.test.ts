import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/core/errors.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { bearerHttpTransport } from "../src/core/mcp/transport.ts";

// The one piece of the connector path that holds a key (M20). Until this file existed it was
// ten lines inside main.ts, which nothing can test.
//
// NO NETWORK: every test hands in its own `fetch`, which records the request and answers 401.
// That answer is the cheapest complete exchange there is — the SDK's real transport and real
// client run, the request is really built, and what comes back is the real rejection type
// (measured against both Linear and GitHub: `StreamableHTTPError`, code 401).

const KEY = "key-THAT-must-not-leak-0123456789";
const def = { label: "Example", url: "https://mcp.example.test/mcp" };

interface Seen {
  url: string;
  authorization: string | null;
  headers: string[];
}

function recorder(): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      authorization: headers.get("authorization"),
      headers: [...headers.keys()],
    });
    return Promise.resolve(new Response("unauthorized", { status: 401 }));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function connectionFor(fetchImpl: typeof fetch, key = KEY): SdkMcpConnection {
  return new SdkMcpConnection({
    app: def.label,
    keyName: "EXAMPLE_KEY",
    transport: bearerHttpTransport(def, key, fetchImpl),
    timeoutMs: 500,
  });
}

describe("bearerHttpTransport", () => {
  it("sends the key as a Bearer token to the definition's URL, and nowhere else", async () => {
    const { seen, fetchImpl } = recorder();
    await expect(connectionFor(fetchImpl).listTools()).rejects.toBeInstanceOf(ConnectorError);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url).toBe("https://mcp.example.test/mcp");
      expect(request.authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("puts the key in no header but Authorization", async () => {
    const { seen, fetchImpl } = recorder();
    await connectionFor(fetchImpl).listTools().catch(() => undefined);
    // The header NAMES, so a key copied into some other header would show up here by name.
    for (const request of seen) {
      for (const name of request.headers) {
        expect(["authorization", "accept", "content-type", "mcp-protocol-version"]).toContain(name);
      }
    }
  });

  it("never lets the key into the failure a person is shown", async () => {
    const { fetchImpl } = recorder();
    const error = await connectionFor(fetchImpl)
      .listTools()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    const shown = error as ConnectorError;
    expect(shown.reason).toBe("denied");
    expect(shown.message).not.toContain(KEY);
    expect(shown.message).toContain("EXAMPLE_KEY");
  });

  it("builds a fresh transport for every connection attempt", () => {
    const factory = bearerHttpTransport(def, KEY, recorder().fetchImpl);
    expect(factory()).not.toBe(factory());
  });

  it("uses each connector's own key", async () => {
    const { seen, fetchImpl } = recorder();
    await connectionFor(fetchImpl, "another-key").listTools().catch(() => undefined);
    expect(seen[0]?.authorization).toBe("Bearer another-key");
  });

  // The key would cross the network readable. A definition bug, refused at startup.
  it("refuses a URL that is not https", () => {
    for (const url of ["http://mcp.example.test/mcp", "ws://mcp.example.test/mcp"]) {
      expect(() => bearerHttpTransport({ label: "Example", url }, KEY)).toThrow(/must be https/);
    }
  });

  it("does not put the key in the refusal either", () => {
    try {
      bearerHttpTransport({ label: "Example", url: "http://x.test" }, KEY);
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
      return;
    }
    throw new Error("expected a refusal");
  });
});
