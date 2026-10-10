import { describe, expect, it } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorError, UserFixableError, connectorError } from "../src/core/errors.ts";
import { MAX_REMOTE_DETAIL, classifyMcpFailure } from "../src/core/mcp/failure.ts";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SdkMcpConnection,
  UnavailableConnection,
} from "../src/core/mcp/SdkConnection.ts";
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
      "calling",
    );
    expect(error.reason).toBe("denied");
    expect(error).toBeInstanceOf(UserFixableError);
    expect(error.message).toContain("LINEAR_API_KEY");
    expect(error.message).not.toContain("invalid_token");
  });

  it("treats 403 the same way, and any other HTTP status as unreachable", () => {
    expect(classifyMcpFailure(new StreamableHTTPError(403, "no"), "Linear", "K", "calling").reason).toBe("denied");
    const down = classifyMcpFailure(new StreamableHTTPError(503, "down"), "Linear", "K", "calling");
    expect(down.reason).toBe("unreachable");
    expect(down.message).toContain("503");
    expect(down.message).not.toContain("K in .env");
  });

  it("separates a timeout from a server-side throw", () => {
    const timeout = classifyMcpFailure(
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      "Linear",
      "K",
      "calling",
    );
    expect(timeout.reason).toBe("timeout");
    // The honest part: a timed-out write may have landed.
    expect(timeout.message).toContain("may or may not");

    const thrown = classifyMcpFailure(
      new McpError(ErrorCode.InternalError, "upstream exploded"),
      "Linear",
      "K",
      "calling",
    );
    expect(thrown.reason).toBe("tool-failed");
    expect(thrown.message).toBe("Linear said no: upstream exploded");
  });

  it("reads a bare Error — a closed link, a failed fetch — as unreachable", () => {
    expect(classifyMcpFailure(new Error("Not connected"), "Linear", "K", "calling").reason).toBe("unreachable");
    expect(classifyMcpFailure(new TypeError("fetch failed"), "Linear", "K", "calling").message).toBe(
      "I couldn't reach Linear: fetch failed",
    );
  });

  it("passes an already-classified error through untouched", () => {
    const original = connectorError("denied", "Linear", "", "LINEAR_API_KEY");
    expect(classifyMcpFailure(original, "Linear", "LINEAR_API_KEY", "calling")).toBe(original);
  });

  it("bounds text that came from the far side", () => {
    const error = classifyMcpFailure(new Error("x".repeat(5000)), "Linear", "K", "calling");
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

// LIVE FINDING (M21). The first GitHub use of a session timed out while CONNECTING — before any
// dialog, before any create — and the user was told "it may or may not have gone through". Nothing
// had been sent. Whether something MIGHT have happened on the far side is the one thing that
// message is for, and it depends entirely on which request was in flight:
//
//   connecting  (initialize, tools/list)   nothing was sent → safe to try again
//   calling     (tools/call)               the call WAS sent → "may or may not"
//
// The phase is decided by WHERE the error is caught, never by reading its text.
describe("failures are worded by the phase they happened in", () => {
  const NOTHING_SENT = "Linear didn't answer while I was connecting, so nothing was sent. It is safe to try again.";
  const timedOut = (): McpError => new McpError(ErrorCode.RequestTimeout, "Request timed out");

  describe("classifyMcpFailure", () => {
    it("says nothing was sent for a timeout while connecting", () => {
      const error = classifyMcpFailure(timedOut(), "Linear", "K", "connecting");
      expect(error.reason).toBe("connect-failed");
      expect(error.message).toBe(NOTHING_SENT);
      expect(error.message).not.toContain("may or may not");
      expect(error).toBeInstanceOf(UserFixableError);
    });

    it("keeps the 'may or may not' warning for the SAME error while calling", () => {
      // One error object's worth of difference: identical type, code and text, other phase.
      const error = classifyMcpFailure(timedOut(), "Linear", "K", "calling");
      expect(error.reason).toBe("timeout");
      expect(error.message).toContain("it may or may not have gone through");
      expect(error.message).not.toContain("nothing was sent");
    });

    it.each([
      ["no network", new TypeError("fetch failed"), "fetch failed"],
      ["a server error", new StreamableHTTPError(503, "down"), "it answered HTTP 503"],
      ["a closed link", new McpError(ErrorCode.ConnectionClosed, "Connection closed"), "the connection closed"],
      // The SDK's McpError puts "MCP error -32603: " in front of this itself; it is stripped.
      ["a server-side throw", new McpError(ErrorCode.InternalError, "boom"), "boom"],
    ])("says nothing was sent for %s while connecting, and why", (_label, raw, detail) => {
      const error = classifyMcpFailure(raw, "Linear", "K", "connecting");
      expect(error.reason).toBe("connect-failed");
      expect(error.message).toBe(
        `I couldn't reach Linear while I was connecting (${detail}), so nothing was sent. It is safe to try again.`,
      );
    });

    it("still reads a rejected key as `denied` in either phase — trying again would not help", () => {
      for (const phase of ["connecting", "calling"] as const) {
        const error = classifyMcpFailure(new StreamableHTTPError(401, "nope"), "Linear", "LINEAR_API_KEY", phase);
        expect(error.reason, phase).toBe("denied");
        expect(error.message, phase).not.toContain("safe to try again");
      }
    });
  });

  describe("SdkMcpConnection", () => {
    const quick = (server: FakeMcpServer, extra: { timeoutMs?: number; connectTimeoutMs?: number } = {}) =>
      new SdkMcpConnection({
        app: "Linear",
        keyName: "LINEAR_API_KEY",
        transport: server.transport,
        timeoutMs: 40,
        connectTimeoutMs: 40,
        ...extra,
      });

    it("reports a connection that never answers as nothing sent — from listTools", async () => {
      const server = new FakeMcpServer({ hangOnConnect: true });
      const error = await reasonOf(quick(server).listTools());
      expect(error.reason).toBe("connect-failed");
      expect(error.message).toBe(NOTHING_SENT);
    });

    it("reports it the same way from callTool — the call was never sent", async () => {
      // A create whose connection never opened. This is the live case, one layer down.
      const server = new FakeMcpServer({ hangOnConnect: true });
      const error = await reasonOf(quick(server).callTool("save_issue", { title: "x", team: "Engineering" }));
      expect(error.message).toBe(NOTHING_SENT);
      expect(server.calls).toEqual([]); // the server never saw a tool call
    });

    it("reports a tool list that never answers as nothing sent", async () => {
      const server = new FakeMcpServer({ hangOnList: true });
      const error = await reasonOf(quick(server).listTools());
      expect(error.reason).toBe("connect-failed");
      expect(error.message).toBe(NOTHING_SENT);
      expect(server.calls).toEqual([]);
    });

    it("reports no network while connecting as nothing sent", async () => {
      const server = new FakeMcpServer({ unreachable: true });
      const error = await reasonOf(quick(server).listTools());
      expect(error.reason).toBe("connect-failed");
      expect(error.message).toContain("so nothing was sent");
      expect(error.message).toContain("fetch failed");
    });

    it("keeps the warning for a CALL that never answers", async () => {
      const server = new FakeMcpServer({ hangOn: "save_issue" });
      const error = await reasonOf(quick(server).callTool("save_issue", { title: "x", team: "Engineering" }));
      expect(error.reason).toBe("timeout");
      expect(error.message).toBe(
        "Linear didn't answer in time, so I stopped waiting. If I was changing something, check Linear before trying again — it may or may not have gone through.",
      );
      expect(server.calls).toHaveLength(1); // this one WAS sent
    });

    it("never retries: a failed connection is one attempt, and the next call starts a new one", async () => {
      let hang = true;
      const stuck = new FakeMcpServer({ hangOnConnect: true });
      const good = new FakeMcpServer();
      const connection = new SdkMcpConnection({
        app: "Linear",
        keyName: "LINEAR_API_KEY",
        transport: () => (hang ? stuck.transport() : good.transport()),
        timeoutMs: 40,
        connectTimeoutMs: 40,
      });

      await reasonOf(connection.callTool("save_issue", { title: "x", team: "Engineering" }));
      expect(stuck.connections).toBe(1); // one attempt, not two
      expect(good.connections).toBe(0); // and nothing was re-sent anywhere

      hang = false;
      await expect(connection.listTools()).resolves.toHaveLength(4);
      expect(good.connections).toBe(1);
    });
  });
});

// Two budgets, because the two waits are different things. Connecting is a cold start on
// someone else's server and was measured live taking longer than 20s once; a request on an open
// connection that takes 20s is hung.
describe("SdkMcpConnection — timeouts", () => {
  it("defaults to 30 seconds to connect and 20 for every other request", () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it("gives `initialize` the CONNECT budget, not the request one", async () => {
    // The server takes 120ms to answer `initialize`. The request budget (30ms) would have
    // given up; the connect budget (2s) does not.
    const server = new FakeMcpServer({ connectDelayMs: 120 });
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: server.transport,
      timeoutMs: 30,
      connectTimeoutMs: 2_000,
    });
    // tools/list itself is quick once connected, so the 30ms request budget is not what fails.
    await expect(connection.listTools()).resolves.toHaveLength(4);
  });

  it("gives `tools/list` the REQUEST budget, not the connect one", async () => {
    const server = new FakeMcpServer({ hangOnList: true });
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: server.transport,
      timeoutMs: 40,
      connectTimeoutMs: 10_000,
    });
    const started = Date.now();
    await reasonOf(connection.listTools());
    expect(Date.now() - started).toBeLessThan(2_000); // 40ms, not ten seconds
  });

  it("gives a tool call the REQUEST budget too", async () => {
    const server = new FakeMcpServer({ hangOn: "save_issue" });
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: server.transport,
      timeoutMs: 40,
      connectTimeoutMs: 10_000,
    });
    const started = Date.now();
    await reasonOf(connection.callTool("save_issue", { title: "x", team: "Engineering" }));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// "Connecting to Linear…" — said while the wait is happening, to whoever is listening.
describe("SdkMcpConnection — says when it is connecting", () => {
  function watched(server: FakeMcpServer | (() => FakeMcpServer)) {
    const events: string[] = [];
    const pick = typeof server === "function" ? server : () => server;
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: () => {
        events.push("transport opened");
        return pick().transport();
      },
      timeoutMs: 40,
      connectTimeoutMs: 40,
      onConnecting: (line) => events.push(`said: ${line}`),
    });
    return { connection, events };
  }

  it("says so once, BEFORE the connection is opened, and names the connector", async () => {
    const { connection, events } = watched(new FakeMcpServer());
    await connection.listTools();
    expect(events).toEqual(["said: Connecting to Linear…", "transport opened"]);
  });

  it("says nothing more while the connection is open", async () => {
    const { connection, events } = watched(new FakeMcpServer());
    await connection.listTools();
    await connection.callTool("list_issues", {});
    await connection.listTools();
    expect(events.filter((event) => event.startsWith("said:"))).toHaveLength(1);
  });

  it("says it once for calls that arrive together", async () => {
    const { connection, events } = watched(new FakeMcpServer());
    await Promise.all([connection.listTools(), connection.callTool("list_issues", {})]);
    expect(events.filter((event) => event.startsWith("said:"))).toHaveLength(1);
  });

  it("says it again when a later call has to connect afresh", async () => {
    let hang = true;
    const stuck = new FakeMcpServer({ hangOnConnect: true });
    const good = new FakeMcpServer();
    const { connection, events } = watched(() => (hang ? stuck : good));

    await reasonOf(connection.listTools());
    hang = false;
    await connection.listTools();

    expect(events.filter((event) => event.startsWith("said:"))).toHaveLength(2);
  });

  it("is not stopped from connecting by a listener that throws", async () => {
    const server = new FakeMcpServer();
    const connection = new SdkMcpConnection({
      app: "Linear",
      keyName: "LINEAR_API_KEY",
      transport: server.transport,
      onConnecting: () => {
        throw new Error("the status line is gone");
      },
    });
    await expect(connection.listTools()).resolves.toHaveLength(4);
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
