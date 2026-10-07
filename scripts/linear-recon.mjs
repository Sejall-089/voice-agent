// M19 step 0 — reconnaissance against the REAL Linear MCP server, before any adapter, fixture
// or error message is written.
//
//   npm run linear:recon
//
// WHY THIS EXISTS. The same reason scripts/notion-recon.mjs, tts-recon.mjs and spotify-recon.mjs
// do: a fixture written from an assumption passes every test and matches nothing. It earned its
// keep on the first run. Linear's own docs list no tools, and the third-party directories that
// do said `create_issue` / `update_issue`. The live server has neither — it has ONE tool,
// `save_issue`, that creates when `id` is absent and UPDATES when it is present. An allowlist
// written from those directories would have exposed "edit any issue" under the name "create".
//
// STRICTLY READ-ONLY, AND THAT IS A RULE RATHER THAN A DEFAULT. This script never calls a tool
// that is not on READ_ONLY below, and there is deliberately no flag that widens it. The only
// real issue M19 ever creates is the one a person creates by hand from
// docs/M19-live-checklist.md. (The shape of a create result in tests/fixtures/linear/ was
// captured once, by hand, during the milestone's recon — it is the same JSON `get_issue`
// returns plus `createdBy`, which is why nothing here needs to create one again.)
//
// The questions, in the order they matter:
//   Q1  What are the real tool names, and what does each input schema accept and require?
//   Q2  What hints does the server attach (readOnlyHint / destructiveHint)? They are UNTRUSTED
//       — core/mcp/tiers.ts lets them make a tool stricter, never looser — but what they say
//       is still a fact worth recording.
//   Q3  Where does an issue's URL arrive: text, a resource_link, or structuredContent?
//   Q4  Does the real schema accept the arguments the adapter FIXES in code for a search
//       (`limit`, `fields`)? A pinned schema that drifted from the server fails here first.
//   Q5  What does a failure look like — thrown, or a result with isError? What is the text?
//   Q6  What does a rejected key look like, so "check LINEAR_API_KEY" is triggered by evidence?
//
// Output lands in linear-recon-out/ (gitignored: it holds the titles and descriptions of real
// issues). THE KEY IS NEVER PRINTED OR SAVED (spec §10).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { config } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

config();

const ENDPOINT = "https://mcp.linear.app/mcp";
const OUT = "linear-recon-out";

// Every tool this script may call. Checked in `call` below, so adding a write here by accident
// takes editing this list on purpose.
const READ_ONLY = new Set(["list_teams", "list_issues", "get_issue"]);

// The arguments core/mcp/connectors/linear.ts fixes in code for a search. Kept in step with it
// by hand; Q4 is what notices if the server stops accepting them.
const SEARCH_FIELDS = ["id", "title", "status", "url"];
const SEARCH_LIMIT = 5;

const key = process.env.LINEAR_API_KEY;
if (!key) {
  console.error("\nLINEAR_API_KEY must be set in .env before running this.\n");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const save = (name, value) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

function connect(authorization) {
  const client = new Client({ name: "voice-agent-recon", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: authorization } },
  });
  return client.connect(transport).then(() => client);
}

const client = await connect(`Bearer ${key}`);
console.log(`[recon] connected: ${JSON.stringify(client.getServerVersion())}`);

// --- Q1, Q2 ---
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : undefined);
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
save("tools", tools);
console.log(`[recon] Q1/Q2: ${tools.length} tools`);
for (const tool of tools) {
  const hints = tool.annotations ?? {};
  console.log(
    `  ${tool.name.padEnd(30)} readOnly=${hints.readOnlyHint ?? "-"} ` +
      `destructive=${hints.destructiveHint ?? "-"} required=${JSON.stringify(tool.inputSchema?.required ?? [])}`,
  );
}

async function call(label, name, args) {
  if (!READ_ONLY.has(name)) throw new Error(`${name} is not on the read-only list`);
  try {
    const result = await client.callTool({ name, arguments: args });
    save(label, { name, arguments: args, result });
    const kinds = (result.content ?? []).map((block) => block.type);
    console.log(
      `[recon] ${label}: isError=${result.isError ?? false} content=${JSON.stringify(kinds)} ` +
        `structuredContent=${result.structuredContent ? "yes" : "no"}`,
    );
    return result;
  } catch (error) {
    save(label, { name, arguments: args, thrown: describe(error) });
    console.log(`[recon] ${label}: THREW ${JSON.stringify(describe(error))}`);
    return null;
  }
}

function describe(error) {
  return {
    type: error?.constructor?.name ?? typeof error,
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 400),
  };
}

function firstText(result) {
  return result?.content?.find((block) => block.type === "text")?.text ?? "";
}

// --- Q3, Q4 ---
await call("list-teams", "list_teams", {});
const listed = await call("list-issues-default", "list_issues", { limit: 1 });
const searched = await call("list-issues-fixed-args", "list_issues", {
  query: "a",
  limit: SEARCH_LIMIT,
  fields: SEARCH_FIELDS,
});
console.log(`[recon] Q4: fixed search args ${searched?.isError ? "REJECTED" : "accepted"}`);

let identifier = null;
try {
  identifier = JSON.parse(firstText(listed)).issues?.[0]?.id ?? null;
} catch {
  // Left null: the default listing was not JSON, which is itself the finding.
}
if (identifier) {
  const issue = await call("get-issue", "get_issue", { id: identifier });
  let url = null;
  try {
    url = JSON.parse(firstText(issue)).url ?? null;
  } catch {
    // As above.
  }
  console.log(`[recon] Q3: url is ${url ? "a field inside the text block's JSON" : "NOT where expected"}`);
} else {
  console.log("[recon] Q3: no issue to read — the workspace is empty");
}

// --- Q5 ---
await call("get-issue-missing", "get_issue", { id: "ZZZNOPE-999999" });
await call("get-issue-no-id", "get_issue", {});
await call("list-issues-unknown-arg", "list_issues", { bogus: 1 });
await client.close();

// --- Q6 ---
try {
  const rejected = await connect("Bearer lin_api_not_a_real_key");
  await rejected.close();
  console.log("[recon] Q6: a junk key CONNECTED (unexpected)");
} catch (error) {
  save("bad-key", { thrown: describe(error) });
  console.log(`[recon] Q6: ${JSON.stringify(describe(error))}`);
}

console.log(`\n[recon] done — captures are in ${OUT}/`);
process.exit(0);
