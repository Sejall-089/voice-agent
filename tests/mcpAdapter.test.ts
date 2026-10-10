import { describe, expect, it } from "vitest";
import { ConnectorError, UserFixableError } from "../src/core/errors.ts";
import { SEPARATOR, buildConnectorTools } from "../src/core/mcp/adapter.ts";
import { parseConnectorsConfig, selectConnectors } from "../src/core/mcp/config.ts";
import { linearConnector } from "../src/core/mcp/connectors/linear.ts";
import { failureText, flattenResult } from "../src/core/mcp/flatten.ts";
import { CONNECTORS } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { baseTier, effectiveTier, looksDangerous, possibleTiers } from "../src/core/mcp/tiers.ts";
import type { ConnectorDef } from "../src/core/mcp/types.ts";
import { declaredTiers, resolveRisk } from "../src/core/risk.ts";
import type { Tool, ToolDeps, ToolInput } from "../src/core/types.ts";
import { FakeMcpServer, LINEAR_TOOLS, type FakeMcpServerOptions } from "./FakeMcpServer.ts";
import {
  CREATE_RESULT,
  ERROR_ISSUE_NOT_FOUND,
  ERROR_TEAM_REQUIRED,
  ERROR_TEAM_UNKNOWN,
  ERROR_UNKNOWN_KEY,
  GET_RESULT,
  SEARCH_RESULT,
  SEARCH_RESULT_EMPTY,
} from "./fixtures/linear/captured.ts";

// No connector tool reads anything but `deps.context` — the connection is captured when the
// tool is built. A real planner always supplies a context; this one has no clipboard and no
// open email.
const deps = {
  context: { selectedText: null, activeApp: null, activeWindowTitle: null },
} as unknown as ToolDeps;

const ISSUE = {
  id: "ENG-4",
  title: "Set up your teams",
  description: "Teams are how you organize people and work in Linear.",
  status: "Todo",
  team: "Engineering",
  url: "https://linear.app/acme/issue/ENG-4/set-up-your-teams",
};

function build(
  options: FakeMcpServerOptions = {},
  def: ConnectorDef = linearConnector,
  team = "Engineering",
): { server: FakeMcpServer; tools: Tool[]; tool: (name: string) => Tool } {
  const server = new FakeMcpServer({ issues: [ISSUE], ...options });
  const config = parseConnectorsConfig(
    JSON.stringify({
      connectors: {
        [def.id]: {
          enabled: true,
          tools: def.tools.map((tool) => tool.name),
          settings: { defaultTeam: team },
        },
      },
    }),
  );
  const selected = selectConnectors(config, [def], () => true).selected[0];
  if (selected === undefined) throw new Error("nothing selected");
  const connection = new SdkMcpConnection({
    app: def.label,
    keyName: def.keyName,
    transport: server.transport,
    timeoutMs: 200,
  });
  const tools = buildConnectorTools(selected, connection);
  const tool = (name: string): Tool => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  return { server, tools, tool };
}

async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw new Error(`expected a ConnectorError, got ${String(error)}`);
  }
  throw new Error("expected a refusal");
}

// The server's captured tool list with one entry altered — a server that has changed.
function serverTools(
  name: string,
  change: (tool: (typeof LINEAR_TOOLS)[number]) => void,
): (typeof LINEAR_TOOLS)[number][] {
  const copy = JSON.parse(JSON.stringify(LINEAR_TOOLS)) as typeof LINEAR_TOOLS;
  const target = copy.find((tool) => tool.name === name);
  if (target === undefined) throw new Error(`no ${name}`);
  change(target);
  return copy;
}

describe("what the model is shown", () => {
  it("namespaces every tool, so none can clash with a hand-built one", () => {
    const { tools } = build();
    expect(tools.map((tool) => tool.name)).toEqual([
      "linear__create_issue",
      "linear__search_issues",
      "linear__get_issue",
    ]);
    expect(SEPARATOR).toBe("__");
  });

  // The server's descriptions are text from somewhere else. Not one word of them may reach the
  // planner prompt — asserted against the REAL captured descriptions.
  it("uses this repo's descriptions and schemas, never the server's", () => {
    const { tools, server } = build();
    for (const tool of tools) {
      for (const remote of LINEAR_TOOLS) {
        expect(tool.description).not.toBe(remote["description"]);
        expect(tool.inputSchema).not.toEqual(remote.inputSchema);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    // And building the menu asked the network nothing.
    expect(server.connections).toBe(0);
  });

  it("never names the remote tool: the model cannot ask for save_issue", () => {
    const { tools } = build();
    expect(JSON.stringify(tools.map(({ name, description, inputSchema }) => [name, description, inputSchema])))
      .not.toContain("save_issue");
  });

  it("opts every tool out of memory resolution", () => {
    for (const tool of build().tools) expect(tool.resolvesReferences).toBe(false);
  });

  it("refuses to build a tool whose schema would let unlisted arguments through", () => {
    const leaky: ConnectorDef = {
      ...linearConnector,
      tools: [
        {
          name: "get_issue",
          remote: "get_issue",
          description: "d",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
    };
    expect(() => build({}, leaky)).toThrow(/additionalProperties/);
  });
});

describe("linear__create_issue", () => {
  it("creates through save_issue, with the team from config, and returns the id and link as text", async () => {
    const { server, tool } = build();
    const result = await tool("linear__create_issue").handler(
      { title: "Login button does nothing on Safari", description: "From: Dana\n\nIt is broken." },
      deps,
    );

    expect(server.calls).toEqual([
      {
        name: "save_issue",
        arguments: {
          title: "Login button does nothing on Safari",
          description: "From: Dana\n\nIt is broken.",
          team: "Engineering",
        },
      },
    ]);
    expect(result).toBe(
      "Created ENG-6: Login button does nothing on Safari\n" +
        "https://linear.app/acme/issue/ENG-6/login-button-does-nothing-on-safari",
    );
  });

  // THE NARROWING. `save_issue` updates when given an id, and the fake implements that half on
  // purpose. Nothing the model proposes may reach it.
  it("cannot update: an `id` is refused HERE and never sent", async () => {
    const { server, tool } = build();
    const error = await refusal(
      tool("linear__create_issue").handler({ id: "ENG-4", title: "Hijacked" }, deps),
    );
    expect(error.reason).toBe("invalid-arguments");
    expect(error.message).toContain('"id" is not something it accepts');
    expect(server.calls).toEqual([]);
    expect(server.updated).toEqual([]);
    expect(server.connections).toBe(0);
  });

  it("refuses every other field the remote tool would have accepted", async () => {
    const { server, tool } = build();
    for (const extra of ["team", "assignee", "state", "patch", "removeLabels", "parentId"]) {
      const error = await refusal(
        tool("linear__create_issue").handler({ title: "t", [extra]: "x" }, deps),
      );
      expect(error.reason).toBe("invalid-arguments");
    }
    expect(server.calls).toEqual([]);
  });

  it("refuses a missing, empty or non-text title before any call", async () => {
    const { server, tool } = build();
    const create = tool("linear__create_issue");
    expect((await refusal(create.handler({}, deps))).message).toContain('"title" is missing');
    expect((await refusal(create.handler({ title: "" }, deps))).reason).toBe("invalid-arguments");
    expect((await refusal(create.handler({ title: 7 }, deps))).reason).toBe("invalid-arguments");
    expect(server.calls).toEqual([]);
  });

  it("is `dangerous` as a constant — no connection is needed to know it", async () => {
    const { server, tool } = build({ rejectKey: true });
    const create = tool("linear__create_issue");
    expect(create.risk).toBe("dangerous");
    expect(await resolveRisk(create.risk, { title: "t" }, deps)).toBe("dangerous");
    expect(server.connections).toBe(0);
  });

  it("shows the team, the whole title and the WHOLE description in the confirm text", async () => {
    const { server, tool } = build();
    // Far longer than any preview would keep, with a marker at the very end.
    const description = `${"A line of the bug report that goes on for a while. ".repeat(400)}LAST-WORD`;
    expect(description.length).toBeGreaterThan(20_000);

    const summary = await tool("linear__create_issue").confirmSummary?.(
      { title: "Login button does nothing on Safari", description },
      deps,
    );
    expect(summary).toBeDefined();
    const [question] = (summary ?? "").split("\n\n");
    // The first paragraph is the decision — it is the only part spoken (core/speech.ts).
    expect(question).toBe("Create this Linear issue in Engineering?");
    expect(summary).toContain("Title: Login button does nothing on Safari");
    expect(summary).toContain(description);
    expect(summary?.endsWith("LAST-WORD")).toBe(true);
    // Describing it changed nothing.
    expect(server.calls).toEqual([]);
  });

  it("puts every text value it would send into the confirm text", async () => {
    const { server, tool } = build();
    const args = { title: "A title", description: "A body" };
    const summary = (await tool("linear__create_issue").confirmSummary?.(args, deps)) ?? "";
    await tool("linear__create_issue").handler(args, deps);
    const sent = server.calls[0]?.arguments ?? {};
    for (const value of Object.values(sent)) {
      expect(typeof value).toBe("string");
      expect(summary).toContain(value as string);
    }
  });

  it("will not show a confirm dialog for a call it could not make", async () => {
    const { tool } = build();
    const error = await refusal(
      Promise.resolve(tool("linear__create_issue").confirmSummary?.({ id: "ENG-4", title: "x" }, deps)),
    );
    expect(error.reason).toBe("invalid-arguments");
  });

  it("reports the server's refusal in its own words — an isError result is a FAILURE", async () => {
    const { server, tool } = build({ teams: [] }, linearConnector, "No Such Team ZZZ");
    const error = await refusal(tool("linear__create_issue").handler({ title: "t" }, deps));
    expect(error.reason).toBe("tool-failed");
    expect(error.message).toBe('Linear said no: Could not find team "No Such Team ZZZ"');
    expect(error).toBeInstanceOf(UserFixableError);
    expect(server.created).toEqual([]);
  });

  it("does not report success on a result it cannot read", async () => {
    for (const text of ["{}", "created!", '{"id":"ENG-9","title":"t"}', "[]", " "]) {
      const { tool } = build({ garble: { tool: "save_issue", text } });
      const error = await refusal(tool("linear__create_issue").handler({ title: "t" }, deps));
      expect(error.reason).toBe("bad-result");
      expect(error.message).toContain("Check Linear before trying again");
    }
  });
});

describe("linear__search_issues and linear__get_issue", () => {
  it("searches with the limit and fields fixed in code, whatever the model proposed", async () => {
    const { server, tool } = build();
    const result = await tool("linear__search_issues").handler({ query: "teams" }, deps);
    expect(server.calls).toEqual([
      {
        name: "list_issues",
        arguments: { query: "teams", limit: 5, fields: ["id", "title", "status", "url"] },
      },
    ]);
    expect(result).toBe(
      "ENG-4: Set up your teams (Todo)\nhttps://linear.app/acme/issue/ENG-4/set-up-your-teams",
    );
  });

  it("does not let the model choose the limit or the fields", async () => {
    const { server, tool } = build();
    for (const extra of [{ limit: 250 }, { fields: ["description"] }, { team: "x" }]) {
      const error = await refusal(
        tool("linear__search_issues").handler({ query: "q", ...extra }, deps),
      );
      expect(error.reason).toBe("invalid-arguments");
    }
    expect(server.calls).toEqual([]);
  });

  // THE RULE THIS TEST PINS CHANGED IN M20, so the test was rewritten rather than re-run.
  //
  // M19's version built a definition whose schema ALLOWED `limit` while code also fixed it, and
  // asserted the fixed value won the merge — the only arrangement in which merge order was what
  // stood between the model and the server. It was needed because no real definition could
  // tell which side won: Linear's schemas reject the key before the merge is reached, and the
  // mutation "model arguments win" survived every other test.
  //
  // M20 removes the question instead of answering it: a key is the model's or code's, never
  // both, and a definition where one is both does not build. With no shared key the merge has
  // nothing to decide. (GitHub is why it matters more now — there a fixed key, `method`, is the
  // whole difference between creating an issue and editing or closing one.)
  const sharing = (fixed: ToolInput): ConnectorDef => ({
    ...linearConnector,
    tools: [
      {
        name: "search_issues",
        remote: "list_issues",
        description: "d",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
        risk: "safe",
        fixed: () => fixed,
      },
    ],
  });

  it("refuses to build a tool whose fixed key is also one the model may send", () => {
    expect(() => build({}, sharing({ limit: 5 }))).toThrow(
      'linear__search_issues: "limit" is fixed in code, so it must not be in inputSchema.',
    );
  });

  // The precondition: the same definition builds, and works, once the keys do not overlap — so
  // the refusal above is about the SHARED key and not about this definition in general.
  it("builds the same tool once no key is shared, and sends both sides' arguments", async () => {
    const { server, tool } = build({}, sharing({ fields: ["id", "title", "status", "url"] }));
    await tool("linear__search_issues").handler({ query: "q", limit: 2 }, deps);
    expect(server.calls[0]?.arguments).toEqual({
      query: "q",
      limit: 2,
      fields: ["id", "title", "status", "url"],
    });
  });

  // Every REAL definition obeys it — checked from the definitions, so a connector added later
  // is covered without anyone remembering to add it here.
  it("holds for every pinned tool of every connector this build ships", () => {
    for (const def of CONNECTORS) {
      for (const pinned of def.tools) {
        const settings = Object.fromEntries((pinned.requires ?? []).map((key) => [key, "x"]));
        const fixedKeys = Object.keys(pinned.fixed?.(settings) ?? {});
        const modelKeys = Object.keys(pinned.inputSchema.properties);
        expect(
          fixedKeys.filter((key) => modelKeys.includes(key)),
          `${def.id}__${pinned.name}`,
        ).toEqual([]);
      }
    }
  });

  it("says so plainly when nothing matched", async () => {
    const { tool } = build({ issues: [] });
    expect(await tool("linear__search_issues").handler({ query: "nothing" }, deps)).toBe(
      'No Linear issues matched "nothing".',
    );
  });

  it("reads one issue, link and description included", async () => {
    const { tool } = build();
    expect(await tool("linear__get_issue").handler({ id: "ENG-4" }, deps)).toBe(
      "ENG-4: Set up your teams (Todo)\n" +
        "https://linear.app/acme/issue/ENG-4/set-up-your-teams\n\n" +
        "Teams are how you organize people and work in Linear.",
    );
  });

  it("reports a missing issue from the JSON-format error", async () => {
    const { tool } = build();
    const error = await refusal(tool("linear__get_issue").handler({ id: "ZZZNOPE-999999" }, deps));
    expect(error.message).toBe("Linear said no: Could not find referenced Issue.");
  });
});

// The formatters against the LITERAL captured text, not against anything the fake produced —
// the fake's JSON is written by this repo, the captures are written by Linear.
describe("formatters, against what Linear really sent", () => {
  const format = (name: string, text: string, args: ToolInput = {}): string => {
    const tool = linearConnector.tools.find((candidate) => candidate.name === name);
    if (tool?.format === undefined) throw new Error(`no formatter for ${name}`);
    return tool.format(text, args, { defaultTeam: "Engineering" });
  };

  it("create → the identifier, the title, and the link on its own line", () => {
    expect(format("create_issue", CREATE_RESULT)).toBe(
      "Created ENG-5: Login button does nothing on Safari\n" +
        "https://linear.app/acme/issue/ENG-5/login-button-does-nothing-on-safari",
    );
  });

  it("search → one block per issue", () => {
    expect(format("search_issues", SEARCH_RESULT, { query: "x" })).toBe(
      "ENG-3: Import your data (Todo)\nhttps://linear.app/acme/issue/ENG-3/import-your-data\n\n" +
        "ENG-4: Set up your teams (Todo)\nhttps://linear.app/acme/issue/ENG-4/set-up-your-teams",
    );
    expect(format("search_issues", SEARCH_RESULT_EMPTY, { query: "x" })).toBe(
      'No Linear issues matched "x".',
    );
  });

  it("get → the same head, then the description untouched", () => {
    const text = format("get_issue", GET_RESULT);
    expect(text.startsWith("ENG-4: Set up your teams (Todo)\nhttps://linear.app/acme/issue/ENG-4/set-up-your-teams\n\n")).toBe(true);
    expect(text).toContain("* [Learn about Teams](<https://linear.app/docs/teams>)");
  });

  it("an error body is not mistaken for an issue", () => {
    expect(() => format("create_issue", ERROR_ISSUE_NOT_FOUND)).toThrow();
    expect(() => format("create_issue", ERROR_TEAM_REQUIRED)).toThrow();
  });
});

describe("drift — the server changed under what this build pinned", () => {
  it("refuses when the remote tool is gone", async () => {
    const { server, tool } = build({
      tools: LINEAR_TOOLS.filter((entry) => entry.name !== "save_issue"),
    });
    const error = await refusal(tool("linear__create_issue").handler({ title: "t" }, deps));
    expect(error.reason).toBe("drift");
    expect(error.message).toContain('it no longer has "save_issue"');
    expect(server.calls).toEqual([]);
  });

  it("refuses when the server stops accepting an argument code fixes", async () => {
    const { server, tool } = build({
      tools: serverTools("list_issues", (entry) => {
        delete entry.inputSchema.properties?.["fields"];
      }),
    });
    const error = await refusal(tool("linear__search_issues").handler({ query: "q" }, deps));
    expect(error.reason).toBe("drift");
    expect(error.message).toContain('"fields" is not something it accepts');
    expect(server.calls).toEqual([]);
  });

  it("refuses when the server starts requiring something this build does not send", async () => {
    const { server, tool } = build({
      tools: serverTools("get_issue", (entry) => {
        (entry.inputSchema as { required?: string[] }).required = ["id", "workspace"];
      }),
    });
    const error = await refusal(tool("linear__get_issue").handler({ id: "ENG-4" }, deps));
    expect(error.reason).toBe("drift");
    expect(error.message).toContain('"workspace" is missing');
    expect(server.calls).toEqual([]);
  });

  it("never echoes an argument's VALUE in a drift message", async () => {
    const { tool } = build({
      tools: serverTools("save_issue", (entry) => {
        (entry.inputSchema.properties as Record<string, unknown>)["description"] = { type: "number" };
      }),
    });
    const error = await refusal(
      tool("linear__create_issue").handler({ title: "t", description: "PRIVATE EMAIL BODY" }, deps),
    );
    expect(error.reason).toBe("drift");
    expect(error.message).not.toContain("PRIVATE EMAIL BODY");
  });
});

describe("a connector that cannot be reached", () => {
  it("fails the handler with a user-fixable reason", async () => {
    const { tool } = build({ rejectKey: true });
    const error = await refusal(tool("linear__get_issue").handler({ id: "ENG-4" }, deps));
    expect(error.reason).toBe("denied");
    expect(error).toBeInstanceOf(UserFixableError);
  });

  // Fail-closed twice (core/risk.ts): the tier cannot be read, so it escalates to the worst one
  // declared — and the confirm summary then fails on the same connection, so nothing is asked.
  it("escalates the tier of a `safe` tool, then refuses at the gate", async () => {
    const { tool } = build({ rejectKey: true });
    const search = tool("linear__search_issues");
    expect(await resolveRisk(search.risk, { query: "q" }, deps)).toBe("dangerous");
    const error = await refusal(Promise.resolve(search.confirmSummary?.({ query: "q" }, deps)));
    expect(error.reason).toBe("denied");
  });

  it("reports a timeout without claiming anything about the outcome", async () => {
    const { tool } = build({ hangOn: "save_issue" });
    const error = await refusal(tool("linear__create_issue").handler({ title: "t" }, deps));
    expect(error.reason).toBe("timeout");
  });
});

describe("tiers", () => {
  it("classifies names by whole words", () => {
    for (const name of ["delete_comment", "remove_label", "send_message", "send_invite", "deleteIssue", "purge-all"]) {
      expect(looksDangerous(name)).toBe(true);
    }
    for (const name of ["sender_name", "removed_at", "list_issues", "save_issue", "undelete"]) {
      expect(looksDangerous(name)).toBe(false);
    }
  });

  it("defaults an unclassified tool to caution, and a declared one to what was declared", () => {
    expect(baseTier({ name: "do_thing", remote: "do_thing" })).toBe("caution");
    expect(baseTier({ name: "search", remote: "list", risk: "safe" })).toBe("safe");
  });

  it("makes a dangerous-sounding name dangerous whatever was declared — on EITHER name", () => {
    expect(baseTier({ name: "delete_comment", remote: "delete_comment" })).toBe("dangerous");
    expect(baseTier({ name: "tidy_up", remote: "delete_comment", risk: "safe" })).toBe("dangerous");
    expect(baseTier({ name: "send_update", remote: "save_status_update", risk: "safe" })).toBe("dangerous");
  });

  it("lets a server hint RAISE a tier", () => {
    expect(effectiveTier("safe", { readOnlyHint: false })).toBe("caution");
    expect(effectiveTier("safe", { destructiveHint: true })).toBe("dangerous");
    expect(effectiveTier("caution", { destructiveHint: true })).toBe("dangerous");
  });

  it("never lets a server hint LOWER one", () => {
    const reassuring = { readOnlyHint: true, destructiveHint: false };
    expect(effectiveTier("caution", reassuring)).toBe("caution");
    expect(effectiveTier("dangerous", reassuring)).toBe("dangerous");
    expect(effectiveTier("safe", reassuring)).toBe("safe");
  });

  it("treats a missing hint as no hint", () => {
    expect(effectiveTier("safe", {})).toBe("safe");
    expect(effectiveTier("caution", {})).toBe("caution");
  });

  it("declares every tier a tool could reach", () => {
    expect(possibleTiers("safe")).toEqual(["safe", "caution", "dangerous"]);
    expect(possibleTiers("caution")).toEqual(["caution", "dangerous"]);
    expect(possibleTiers("dangerous")).toEqual(["dangerous"]);
  });

  it("resolves the pinned reads to `safe` under the hints Linear really sends", async () => {
    const { tool } = build();
    expect(await resolveRisk(tool("linear__search_issues").risk, { query: "q" }, deps)).toBe("safe");
    expect(await resolveRisk(tool("linear__get_issue").risk, { id: "ENG-4" }, deps)).toBe("safe");
    expect(declaredTiers(tool("linear__search_issues").risk)).toEqual(["safe", "caution", "dangerous"]);
  });

  it("raises a pinned read when the server starts calling it destructive", async () => {
    const { tool } = build({
      tools: serverTools("list_issues", (entry) => {
        entry["annotations"] = { readOnlyHint: false, destructiveHint: true };
      }),
    });
    expect(await resolveRisk(tool("linear__search_issues").risk, { query: "q" }, deps)).toBe("dangerous");
  });

  // An unclassified tool on a server that swears it is harmless.
  it("keeps an unclassified tool at caution even when the server says read-only", async () => {
    const acme: ConnectorDef = {
      id: "acme",
      label: "Acme",
      url: "https://example.com/mcp",
      keyName: "ACME_KEY",
      tools: [
        {
          name: "peek",
          remote: "get_issue",
          description: "d",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "tidy",
          remote: "delete_comment",
          description: "d",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          risk: "safe",
        },
      ],
    };
    const { tool } = build(
      {
        tools: serverTools("delete_comment", (entry) => {
          entry["annotations"] = { readOnlyHint: true, destructiveHint: false };
        }),
      },
      acme,
    );
    expect(await resolveRisk(tool("acme__peek").risk, {}, deps)).toBe("caution");
    // Declared safe, told it is read-only by the server, and STILL dangerous: the remote name.
    expect(tool("acme__tidy").risk).toBe("dangerous");
  });

  it("gives every tool a confirm summary and a narration, whatever its tier", () => {
    for (const tool of build().tools) {
      expect(tool.confirmSummary).toBeDefined();
      expect(tool.narrate).toBeDefined();
    }
  });
});

describe("flattenResult", () => {
  it("joins text blocks in order", () => {
    expect(
      flattenResult({
        isError: false,
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("keeps a link that arrives as a resource_link rather than as text", () => {
    expect(
      flattenResult({
        isError: false,
        content: [
          { type: "text", text: "Created ENG-1" },
          { type: "resource_link", uri: "https://linear.app/x/issue/ENG-1", name: "ENG-1" },
        ],
      }),
    ).toBe("Created ENG-1\nENG-1: https://linear.app/x/issue/ENG-1");
  });

  it("falls back to structuredContent only when there is no text at all", () => {
    const structured = { id: "ENG-1", url: "https://linear.app/x/issue/ENG-1" };
    expect(flattenResult({ isError: false, content: [], structuredContent: structured })).toBe(
      JSON.stringify(structured),
    );
    expect(
      flattenResult({
        isError: false,
        content: [{ type: "text", text: "Created" }],
        structuredContent: structured,
      }),
    ).toBe("Created");
  });

  it("is empty for a result with nothing usable in it", () => {
    expect(flattenResult({ isError: false, content: [{ type: "image" }] })).toBe("");
  });
});

describe("failureText, against the captured error formats", () => {
  it("reads the message out of the JSON format", () => {
    expect(failureText(ERROR_ISSUE_NOT_FOUND)).toBe("Could not find referenced Issue.");
  });

  it("drops the bare-sentence format's prefix", () => {
    expect(failureText(ERROR_TEAM_REQUIRED)).toBe("team is required when creating an issue");
    expect(failureText(ERROR_TEAM_UNKNOWN)).toBe('Could not find team "No Such Team ZZZ"');
  });

  it("leaves a validation error as it is", () => {
    expect(failureText(ERROR_UNKNOWN_KEY)).toBe(ERROR_UNKNOWN_KEY);
  });
});
