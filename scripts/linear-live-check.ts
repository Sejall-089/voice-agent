// M19 — a READ-ONLY live check of the real adapter against the real Linear workspace.
//
//   npx vite-node scripts/linear-live-check.ts
//
// scripts/linear-recon.mjs asks the SERVER what it does. This asks whether OUR code agrees with
// it: the same `selectConnectors` → `SdkMcpConnection` → `buildConnectorTools` path the app
// runs, with the real Streamable HTTP transport and the real key, driving the two tools the
// connector declares `safe`.
//
// What a pass establishes that no fixture can:
//   - the pinned schemas and the arguments code FIXES (`limit`, `fields`) are accepted by the
//     live server's schema — the drift check runs for real, against a real `tools/list`;
//   - the formatters read what Linear actually sends today;
//   - the server's live hints leave both reads at `safe`.
//
// STRICTLY READ-ONLY. It runs ONLY tools whose pinned tier is `safe`, selects them by that tier
// rather than by name, and refuses to continue if one resolves to anything else. It never calls
// `linear__create_issue` and has no option that would. The one real create in this milestone is
// done by a person, from docs/M19-live-checklist.md.

import { readFileSync } from "node:fs";
import process from "node:process";
import { config } from "dotenv";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildConnectorTools } from "../src/core/mcp/adapter.ts";
import { parseConnectorsConfig, selectConnectors } from "../src/core/mcp/config.ts";
import { linearConnector } from "../src/core/mcp/connectors/linear.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { baseTier } from "../src/core/mcp/tiers.ts";
import { resolveRisk } from "../src/core/risk.ts";
import type { ToolDeps, ToolInput } from "../src/core/types.ts";

config();

const key = process.env["LINEAR_API_KEY"];
if (!key) {
  console.error("\nLINEAR_API_KEY must be set in .env before running this.\n");
  process.exit(1);
}

const parsed = parseConnectorsConfig(readFileSync("connectors.json", "utf8"));
const selection = selectConnectors(parsed, [linearConnector], () => true);
for (const note of selection.notes) console.log(`[check] note: ${note}`);
const selected = selection.selected.find((entry) => entry.def.id === "linear");
if (selected === undefined) {
  console.error("[check] Linear is not enabled in connectors.json.");
  process.exit(1);
}

// Only the pinned-safe tools are even BUILT here, so the create tool does not exist in this
// process to be called by mistake.
const readOnly = {
  ...selected,
  tools: selected.tools.filter((tool) => baseTier(tool) === "safe"),
};
console.log(`[check] tools under test: ${readOnly.tools.map((tool) => tool.name).join(", ")}`);

const connection = new SdkMcpConnection({
  app: linearConnector.label,
  keyName: linearConnector.keyName,
  transport: () =>
    new StreamableHTTPClientTransport(new URL(linearConnector.url), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
});
const tools = buildConnectorTools(readOnly, connection);
const deps = {} as unknown as ToolDeps;

let failures = 0;

async function run(name: string, args: ToolInput): Promise<string | null> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    console.log(`[check] ${name}: not enabled - skipped`);
    return null;
  }
  const tier = await resolveRisk(tool.risk, args, deps);
  if (tier !== "safe") {
    failures += 1;
    console.log(`[check] ${name}: FAIL - resolved to "${tier}", expected "safe". Not run.`);
    return null;
  }
  try {
    const result = await tool.handler(args, deps);
    console.log(`[check] ${name} ${JSON.stringify(args)}: ok (tier safe)\n${indent(result)}`);
    return result;
  } catch (error) {
    failures += 1;
    console.log(`[check] ${name} ${JSON.stringify(args)}: FAIL - ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// "a" matched every issue during recon; a workspace with any issues at all returns some.
const found = await run("linear__search_issues", { query: "a" });
await run("linear__search_issues", { query: "zzz-no-such-issue-qqq" });

const identifier = found?.match(/^([A-Z][A-Z0-9]*-\d+):/m)?.[1];
if (identifier !== undefined) {
  await run("linear__get_issue", { id: identifier });
} else {
  console.log("[check] linear__get_issue: skipped - the search returned no issue to read");
}

// One expected refusal, to see the live wording of a failure through the adapter.
const getIssue = tools.find((candidate) => candidate.name === "linear__get_issue");
if (getIssue !== undefined) {
  try {
    await getIssue.handler({ id: "ZZZNOPE-999999" }, deps);
    failures += 1;
    console.log("[check] missing issue: FAIL - expected a refusal");
  } catch (error) {
    console.log(`[check] missing issue: refused as expected - ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(failures === 0 ? "\n[check] PASS" : `\n[check] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
