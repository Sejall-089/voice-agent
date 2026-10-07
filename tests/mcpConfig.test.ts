import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConnectorsConfig, selectConnectors } from "../src/core/mcp/config.ts";
import { linearConnector } from "../src/core/mcp/connectors/linear.ts";

const ALL = JSON.stringify({
  connectors: {
    linear: {
      enabled: true,
      tools: ["create_issue", "search_issues", "get_issue"],
      settings: { defaultTeam: "Engineering" },
    },
  },
});

const withKey = (): boolean => true;
const noKey = (): boolean => false;

function names(text: string | null, hasKey = withKey): string[] {
  const { selected } = selectConnectors(parseConnectorsConfig(text), [linearConnector], hasKey);
  return selected.flatMap((entry) => entry.tools.map((tool) => `${entry.def.id}__${tool.name}`));
}

describe("parseConnectorsConfig", () => {
  it("treats a missing file as an ordinary install: nothing loaded, nothing to report", () => {
    expect(parseConnectorsConfig(null)).toEqual({ connectors: {}, notes: [] });
  });

  it("never throws on a file it cannot read — it loads nothing and says why", () => {
    for (const broken of ["{ not json", "[]", '"linear"', "{}", '{"connectors": []}']) {
      const parsed = parseConnectorsConfig(broken);
      expect(parsed.connectors).toEqual({});
      expect(parsed.notes).toHaveLength(1);
    }
  });

  it("is OFF unless `enabled` is literally true", () => {
    for (const value of [false, "true", 1, null, undefined]) {
      const parsed = parseConnectorsConfig(
        JSON.stringify({ connectors: { linear: { enabled: value, tools: ["get_issue"] } } }),
      );
      expect(parsed.connectors["linear"]?.enabled).toBe(false);
    }
  });

  it("drops a connector whose allowlist is malformed rather than salvaging half of it", () => {
    const parsed = parseConnectorsConfig(
      JSON.stringify({ connectors: { linear: { enabled: true, tools: ["get_issue", 7] } } }),
    );
    expect(parsed.connectors).toEqual({});
    expect(parsed.notes[0]).toContain('"tools" must be a list of names');
  });
});

describe("selectConnectors", () => {
  it("offers exactly the allowlisted tools when the connector is on and the key is set", () => {
    expect(names(ALL)).toEqual([
      "linear__create_issue",
      "linear__search_issues",
      "linear__get_issue",
    ]);
  });

  it("offers nothing when the connector is disabled", () => {
    const off = JSON.stringify({
      connectors: { linear: { enabled: false, tools: ["get_issue"] } },
    });
    expect(names(off)).toEqual([]);
  });

  it("offers nothing when there is no config file at all", () => {
    expect(names(null)).toEqual([]);
  });

  it("offers nothing without the key, and says which variable is missing — by name only", () => {
    const selection = selectConnectors(parseConnectorsConfig(ALL), [linearConnector], noKey);
    expect(selection.selected).toEqual([]);
    expect(selection.notes).toEqual(["Linear tools disabled - LINEAR_API_KEY not set"]);
  });

  it("narrows: a tool that is not listed is not offered", () => {
    const readOnly = JSON.stringify({
      connectors: { linear: { enabled: true, tools: ["get_issue"] } },
    });
    expect(names(readOnly)).toEqual(["linear__get_issue"]);
  });

  it("exposes NOTHING for an enabled connector with no tools list", () => {
    const bare = JSON.stringify({ connectors: { linear: { enabled: true } } });
    const selection = selectConnectors(parseConnectorsConfig(bare), [linearConnector], withKey);
    expect(selection.selected).toEqual([]);
    expect(selection.notes).toContain("Linear is enabled but exposes no tools");
  });

  // The closed world, through the config file. `save_issue` and `delete_comment` are REAL tools
  // on Linear's server (tests/fixtures/linear/tools.json); naming them here must do nothing.
  it("cannot be used to reach a remote tool this build does not define", () => {
    const greedy = JSON.stringify({
      connectors: {
        linear: {
          enabled: true,
          tools: ["get_issue", "save_issue", "delete_comment", "linear__get_issue"],
        },
      },
    });
    const selection = selectConnectors(parseConnectorsConfig(greedy), [linearConnector], withKey);
    expect(selection.selected[0]?.tools.map((tool) => tool.name)).toEqual(["get_issue"]);
    expect(selection.notes).toContain('Linear: "save_issue" is not a tool this build defines - ignored');
    expect(selection.notes).toContain('Linear: "delete_comment" is not a tool this build defines - ignored');
  });

  it("cannot be used to add a connector this build does not define", () => {
    const stranger = JSON.stringify({
      connectors: { evil: { enabled: true, tools: ["anything"], url: "https://example.com/mcp" } },
    });
    const selection = selectConnectors(parseConnectorsConfig(stranger), [linearConnector], withKey);
    expect(selection.selected).toEqual([]);
    expect(selection.notes[0]).toContain('connector "evil"');
  });

  it("leaves create off the menu when no default team is set, instead of offering a tool that can only refuse", () => {
    const noTeam = JSON.stringify({
      connectors: { linear: { enabled: true, tools: ["create_issue", "get_issue"] } },
    });
    const selection = selectConnectors(parseConnectorsConfig(noTeam), [linearConnector], withKey);
    expect(selection.selected[0]?.tools.map((tool) => tool.name)).toEqual(["get_issue"]);
    expect(selection.notes[0]).toContain("settings.defaultTeam");
  });

  it("does not offer a tool twice because it was listed twice", () => {
    const twice = JSON.stringify({
      connectors: { linear: { enabled: true, tools: ["get_issue", "get_issue"] } },
    });
    expect(names(twice)).toEqual(["linear__get_issue"]);
  });
});

// The committed file is the one the app actually reads. A typo in it would silently cost the
// whole connector, so it is parsed here with the real definitions.
describe("the committed connectors.json", () => {
  const text = readFileSync(new URL("../connectors.json", import.meta.url), "utf8");

  it("parses cleanly and enables Linear's three tools", () => {
    const parsed = parseConnectorsConfig(text);
    expect(parsed.notes).toEqual([]);
    const selection = selectConnectors(parsed, [linearConnector], withKey);
    expect(selection.notes).toEqual([]);
    expect(selection.selected[0]?.tools.map((tool) => tool.name)).toEqual([
      "create_issue",
      "search_issues",
      "get_issue",
    ]);
  });

  it("holds no secret", () => {
    expect(text).not.toMatch(/lin_api_|api[_-]?key|token|secret/i);
  });
});
