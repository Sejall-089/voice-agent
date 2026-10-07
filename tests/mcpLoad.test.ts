import { describe, expect, it } from "vitest";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { linearConnector } from "../src/core/mcp/connectors/linear.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import type { ConnectorDef, McpConnection } from "../src/core/mcp/types.ts";
import type { ToolDeps } from "../src/core/types.ts";
import { FakeMcpServer } from "./FakeMcpServer.ts";

const SECRET = "lin_api_THIS_MUST_NEVER_APPEAR";
const deps = {} as unknown as ToolDeps;

const ON = JSON.stringify({
  connectors: {
    linear: {
      enabled: true,
      tools: ["create_issue", "search_issues", "get_issue"],
      settings: { defaultTeam: "Engineering" },
    },
  },
});

function load(configText: string | null, env: Record<string, string> = { LINEAR_API_KEY: SECRET }) {
  const server = new FakeMcpServer();
  const connected: { id: string; key: string }[] = [];
  const loaded = loadConnectorTools({
    configText,
    readKey: (name) => env[name],
    connect: (def: ConnectorDef, key: string): McpConnection => {
      connected.push({ id: def.id, key });
      return new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: server.transport });
    },
  });
  return { ...loaded, server, connected };
}

describe("loadConnectorTools", () => {
  it("puts the allowlisted tools on the menu without opening a connection", () => {
    const { tools, notes, server, connected } = load(ON);
    expect(tools.map((tool) => tool.name)).toEqual([
      "linear__create_issue",
      "linear__search_issues",
      "linear__get_issue",
    ]);
    expect(notes).toEqual([]);
    // A connection OBJECT was built; nothing was dialled.
    expect(connected).toEqual([{ id: "linear", key: SECRET }]);
    expect(server.connections).toBe(0);
  });

  it("connects on first use — and the tools then really work", async () => {
    const { tools, server } = load(ON);
    const create = tools.find((tool) => tool.name === "linear__create_issue");
    const result = await create?.handler({ title: "From the loader" }, deps);
    expect(server.connections).toBe(1);
    expect(result).toContain("Created ENG-5: From the loader");
  });

  it("offers nothing, and builds no connection, with no config file", () => {
    const { tools, notes, connected } = load(null);
    expect(tools).toEqual([]);
    expect(notes).toEqual([]);
    expect(connected).toEqual([]);
  });

  it("offers nothing, and builds no connection, for a disabled connector", () => {
    const off = JSON.stringify({
      connectors: { linear: { enabled: false, tools: ["get_issue"] } },
    });
    const { tools, connected } = load(off);
    expect(tools).toEqual([]);
    expect(connected).toEqual([]);
  });

  it("offers nothing without the key — missing, empty, or blank", () => {
    const envs: Record<string, string>[] = [{}, { LINEAR_API_KEY: "" }, { LINEAR_API_KEY: "   " }];
    for (const env of envs) {
      const { tools, notes, connected } = load(ON, env);
      expect(tools).toEqual([]);
      expect(connected).toEqual([]);
      expect(notes).toEqual(["Linear tools disabled - LINEAR_API_KEY not set"]);
    }
  });

  it("never puts the key in a note", () => {
    const broken = JSON.stringify({
      connectors: {
        linear: { enabled: true, tools: ["create_issue", "nope"], settings: {} },
        other: { enabled: true },
      },
    });
    const { notes } = load(broken);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join("\n")).not.toContain(SECRET);
  });

  it("ignores a second definition that would produce the same tool names", () => {
    const server = new FakeMcpServer();
    const { tools, notes } = loadConnectorTools({
      configText: ON,
      readKey: () => SECRET,
      connect: (def) =>
        new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: server.transport }),
      definitions: [linearConnector, { ...linearConnector, label: "Impostor" }],
    });
    expect(tools).toHaveLength(3);
    expect(notes).toContain("linear__create_issue is defined twice - the second was ignored");
  });
});
