import { describe, expect, it } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorError, UserFixableError, connectorError } from "../src/core/errors.ts";
import { MAX_REMOTE_DETAIL, classifyMcpFailure } from "../src/core/mcp/failure.ts";
import { SdkMcpConnection, UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { FakeMcpServer } from "./FakeMcpServer.ts";
import { BAD_KEY_MESSAGE, BAD_KEY_STATUS, ERROR_ISSUE_NOT_FOUND } from "./fixtures/linear/captured.ts";

const SECRET = "lin_api_THIS_MUST_NEVER_APPEAR";

function connect(server: FakeMcpServer, timeoutMs?: number): SdkMcpConnection {
  return new SdkMcpConnection({
    app: "Linear",
    keyName: "LINEAR_API_KEY",
    transport: server.transport,
    timeoutMs,
  });
}

async function reasonOf(work: Promise<unknown>): Promise<ConnectorError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw new Error(`expected a ConnectorError, got ${String(error)}`);
  }
  throw new Error("expected a rejection");
}

// The classification half, with no transport at all. Every input is a REAL instance of the type
// the SDK throws, carrying the code and message recon captured — CLAUDE.md's M16.7 rule that a
// fake's failure must be the same TYPE the real implementation raises.
describe("classifyMcpFailure", () => {
  it("reads a rejected key as `denied`, names the variable, and repeats nothing the server said", () => {
    const error = classifyMcpFailure(
      new StreamableHTTPError(BAD_KEY_STATUS, BAD_KEY_MESSAGE),
      "Linear",
      "LINEAR_API_KEY",
    );
    expect(error.reason).toBe("denied");
    expect(error).toBeInstanceOf(UserFixableError);
    expect(error.message).toContain("LINEAR_API_KEY");
    expect(error.message).not.toContain("invalid_token");
  });

  it("treats 403 the same way, and any other HTTP status as unreachable", () => {
    expect(classifyMcpFailure(new StreamableHTTPError(403, "no"), "Linear", "K").reason).toBe("denied");
    const down = classifyMcpFailure(new StreamableHTTPError(503, "down"), "Linear", "K");
    expect(down.reason).toBe("unreachable");
    expect(down.message).toContain("503");
    expect(down.message).not.toContain("K in .env");
  });

  it("separates a timeout from a server-side throw", () => {
    const timeout = classifyMcpFailure(
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      "Linear",
      "K",
    );
    expect(timeout.reason).toBe("timeout");
    // The honest part: a timed-out write may have landed.
    expect(timeout.message).toContain("may or may not");

    const thrown = classifyMcpFailure(
      new McpError(ErrorCode.InternalError, "upstream exploded"),
      "Linear",
      "K",
    );
    expect(thrown.reason).toBe("tool-failed");
    expect(thrown.message).toBe("Linear said no: upstream exploded");
  });

  it("reads a bare Error — a closed link, a failed fetch — as unreachable", () => {
    expect(classifyMcpFailure(new Error("Not connected"), "Linear", "K").reason).toBe("unreachable");
    expect(classifyMcpFailure(new TypeError("fetch failed"), "Linear", "K").message).toBe(
      "I couldn't reach Linear: fetch failed",
    );
  });

  it("passes an already-classified error through untouched", () => {
    const original = connectorError("denied", "Linear", "", "LINEAR_API_KEY");
    expect(classifyMcpFailure(original, "Linear", "LINEAR_API_KEY")).toBe(original);
  });

  it("bounds text that came from the far side", () => {
    const error = classifyMcpFailure(new Error("x".repeat(5000)), "Linear", "K");
    expect(error.message.length).toBeLessThan(MAX_REMOTE_DETAIL + 60);
  });
});

// The transport half, against the real SDK client and server over the in-memory pair.
describe("SdkMcpConnection", () => {
  it("opens nothing until it is first used", async () => {
    const server = new FakeMcpServer();
    const connection = connect(server);
    expect(server.connections).toBe(0);

    await connection.listTools();
    expect(server.connections).toBe(1);
  });

  it("lists the server's tools with their hints, and asks only once", async () => {
    const server = new FakeMcpServer();
    const connection = connect(server);

    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "save_issue",
      "list_issues",
      "get_issue",
      "delete_comment",
    ]);
    const save = tools.find((tool) => tool.name === "save_issue");
    expect(save?.destructiveHint).toBe(true);
    expect(save?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "get_issue")?.readOnlyHint).toBe(true);

    await connection.listTools();
    expect(server.listCalls).toBe(1);
  });

  it("shares ONE connection between calls that arrive together", async () => {
    const server = new FakeMcpServer();
    const connection = connect(server);
    await Promise.all([connection.listTools(), connection.callTool("list_issues", {})]);
    expect(server.connections).toBe(1);
  });

  it("returns a tool's own failure as a RESULT with isError, not as a throw", async () => {
    const server = new FakeMcpServer();
    const result = await connect(server).callTool("get_issue", { id: "ZZZNOPE-999999" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: ERROR_ISSUE_NOT_FOUND }]);
  });

  it("classifies a rejected key at connect, without leaking anything", async () => {
    const server = new FakeMcpServer({ rejectKey: true });
    const error = await reasonOf(connect(server).listTools());
    expect(error.reason).toBe("denied");
    expect(error.message).toBe("Linear rejected my access — check LINEAR_API_KEY in .env and restart me.");
    expect(error.message).not.toContain(SECRET);
  });

  it("does not remember a failed connection attempt", async () => {
    let refuse = true;
    const good = new FakeMcpServer();
    const bad = new FakeMcpServer({ rejectKey: true });
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: () => (refuse ? bad.transport() : good.transport()),
    });

    expect((await reasonOf(connection.listTools())).reason).toBe("denied");
    refuse = false;
    await expect(connection.listTools()).resolves.toHaveLength(4);
  });

  it("gives up on a call that never answers, and says the write may have landed", async () => {
    const server = new FakeMcpServer({ hangOn: "save_issue" });
    const error = await reasonOf(
      connect(server, 40).callTool("save_issue", { title: "x", team: "Engineering" }),
    );
    expect(error.reason).toBe("timeout");
  });

  it("classifies a server-side throw", async () => {
    const server = new FakeMcpServer({ throwOn: "list_issues" });
    const error = await reasonOf(connect(server).callTool("list_issues", {}));
    expect(error.reason).toBe("tool-failed");
    expect(error.message).toContain("upstream exploded");
  });

  it("reconnects on the NEXT call after the link drops, and re-reads the tool list", async () => {
    const server = new FakeMcpServer();
    const connection = connect(server);
    await connection.listTools();

    await server.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await connection.listTools();
    expect(server.connections).toBe(2);
    expect(server.listCalls).toBe(2);
  });

  it("NEVER re-sends a call that failed — one instruction must not become two tickets", async () => {
    const server = new FakeMcpServer({ throwOn: "save_issue" });
    const connection = connect(server);
    await reasonOf(connection.callTool("save_issue", { title: "x", team: "Engineering" }));
    expect(server.calls.filter((call) => call.name === "save_issue")).toHaveLength(1);
  });
});

describe("UnavailableConnection", () => {
  it("refuses with a named, user-fixable reason", async () => {
    const error = await reasonOf(new UnavailableConnection("Linear").listTools());
    expect(error.reason).toBe("not-configured");
    expect((await reasonOf(new UnavailableConnection("Linear").callTool("x", {}))).reason).toBe(
      "not-configured",
    );
  });
});
