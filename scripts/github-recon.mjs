// M20 step 0 — reconnaissance against the REAL GitHub MCP server, before the connector
// definition, its fake or any error wording is written. The counterpart of linear-recon.mjs.
//
//   npm run github:recon                      (owner/repo from connectors.json)
//   npm run github:recon -- <owner> <repo>    (before connectors.json has a github entry)
//   npm run github:recon -- --tools-fixture   (also rewrite tests/fixtures/github/tools.json)
//
// WHY THIS EXISTS. CLAUDE.md, M19: ask the real server what it offers before pinning anything,
// and recon the FAILURE shapes, not just the happy path. What it found the first time round,
// none of which the docs say:
//   - the server SILENTLY IGNORES an argument it does not know (Linear rejects one), and none of
//     its schemas set `additionalProperties: false`;
//   - `issue_write` creates or updates depending on the VALUE of `method`, and can also close;
//   - a `list_issues` item has NO url, and `state` is "OPEN" in a list but "open" in a read;
//   - every failure is an `isError` result whose text carries API URLs, and for a rate limit a
//     user ID and a request ID.
//
// STRICTLY READ-ONLY, AND THAT IS A RULE RATHER THAN A DEFAULT. Every call is checked against
// READ_ONLY below and there is no flag that widens it — `--tools-fixture` changes what is
// written to THIS disk, never what is sent. Nothing here calls `issue_write`. The only real
// issue M20 creates is the one a person creates by hand from docs/M20-live-checklist.md, which
// is also why the shape of a create result is taken from the server's source and not from a
// capture.
//
// `search_issues` is deliberately not probed: it is out of scope (M20 chose `list_issues`), and
// its semantic search is limited to about ten calls a minute.
//
// The questions:
//   Q1  Which protocol version is negotiated, and did the bare Bearer header suffice?
//   Q2  The real names, hints and input schemas of the three remote tools the connector pins.
//   Q3  Does `list_issues` accept the arguments the connector FIXES in code?
//   Q4  What does a list / a single issue look like — text, structuredContent, or both?
//   Q5  What do failures look like: a missing issue, a missing repo, an unknown argument?
//   Q6  What does a rejected token look like?
//
// Output lands in github-recon-out/ (gitignored: it holds the text of real issues). THE TOKEN
// IS NEVER PRINTED OR SAVED (spec §10).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { config } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

config();

const ENDPOINT = "https://api.githubcopilot.com/mcp/";
const OUT = "github-recon-out";
const TOOLS_FIXTURE = join("tests", "fixtures", "github", "tools.json");

// Every tool this script may call. Checked in `call` below, so adding a write here by accident
// takes editing this list on purpose.
const READ_ONLY = new Set(["get_me", "list_issues", "issue_read"]);

// The remote tools core/mcp/connectors/github.ts pins. `issue_write` is LISTED (its schema is
// what the drift check reads) and never called.
const PINNED = ["issue_write", "issue_read", "list_issues"];

// The arguments core/mcp/connectors/github.ts fixes in code for a list. Kept in step with it by
// hand; Q3 is what notices if the server stops accepting them.
const LIST_FIELDS = ["number", "title", "state"];
const LIST_PER_PAGE = 5;
const LIST_ORDER = { orderBy: "CREATED_AT", direction: "DESC" };

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("\nGITHUB_TOKEN must be set in .env before running this.\n");
  process.exit(1);
}

function target() {
  if (positional.length >= 2) return { owner: positional[0], repo: positional[1] };
  try {
    const settings = JSON.parse(readFileSync("connectors.json", "utf8")).connectors?.github?.settings;
    if (settings?.owner && settings?.repo) return { owner: settings.owner, repo: settings.repo };
  } catch {
    // Reported below.
  }
  console.error("\nNo repository: pass <owner> <repo>, or set them under github.settings in connectors.json.\n");
  process.exit(1);
}
const { owner, repo } = target();

mkdirSync(OUT, { recursive: true });
const save = (name, value) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

// The `initialize` exchange as the wire shows it — the SDK does not expose what was asked for.
let negotiated = null;
async function recordingFetch(url, init) {
  const response = await fetch(url, init);
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (body?.method === "initialize") {
      const answered = (await response.clone().text()).match(/"protocolVersion":"([^"]+)"/);
      negotiated = { requested: body.params.protocolVersion, answered: answered?.[1] ?? null };
    }
  } catch {
    // Recording only: never let it cost the request.
  }
  return response;
}

function connect(authorization) {
  const client = new Client({ name: "voice-agent-recon", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: authorization } },
    fetch: recordingFetch,
  });
  return client.connect(transport).then(() => client);
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

function parsed(result) {
  try {
    return JSON.parse(firstText(result));
  } catch {
    return null;
  }
}

// --- Q1 ---
const client = await connect(`Bearer ${token}`);
const server = client.getServerVersion();
console.log(`[recon] Q1: connected with the Bearer header alone - ${server?.name} ${server?.version}`);
console.log(`[recon] Q1: protocol ${JSON.stringify(negotiated)}`);

// --- Q2 ---
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : undefined);
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
// The icons are base64 PNGs, two per tool — nine tenths of the listing and no use to anyone.
const stripped = tools.map(({ icons: _icons, ...rest }) => rest);
save("tools", stripped);
console.log(`[recon] Q2: ${tools.length} tools`);
for (const name of PINNED) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    console.log(`  ${name.padEnd(14)} MISSING`);
    continue;
  }
  const hints = tool.annotations ?? {};
  console.log(
    `  ${name.padEnd(14)} readOnly=${hints.readOnlyHint ?? "-"} destructive=${hints.destructiveHint ?? "-"} ` +
      `required=${JSON.stringify(tool.inputSchema?.required ?? [])} ` +
      `additionalProperties=${JSON.stringify(tool.inputSchema?.additionalProperties ?? "(unset)")}`,
  );
}
if (flags.includes("--tools-fixture")) {
  // The pinned three, plus `delete_file` as the specimen of a tool the server marks destructive.
  const pinned = stripped.filter((entry) => [...PINNED, "delete_file"].includes(entry.name));
  writeFileSync(TOOLS_FIXTURE, `${JSON.stringify(pinned, null, 2)}\n`);
  console.log(`[recon] Q2: wrote ${pinned.length} entries to ${TOOLS_FIXTURE}`);
}

async function call(label, name, args) {
  if (!READ_ONLY.has(name)) throw new Error(`${name} is not on the read-only list`);
  try {
    const result = await client.callTool({ name, arguments: args });
    save(label, { name, arguments: args, result });
    const kinds = (result.content ?? []).map((block) => block.type);
    console.log(
      `[recon] ${label}: isError=${result.isError ?? false} content=${JSON.stringify(kinds)} ` +
        `structuredContent=${result.structuredContent !== undefined ? "yes" : "no"}`,
    );
    if (result.isError) console.log(`         ${JSON.stringify(firstText(result).slice(0, 300))}`);
    return result;
  } catch (error) {
    save(label, { name, arguments: args, thrown: describe(error) });
    console.log(`[recon] ${label}: THREW ${JSON.stringify(describe(error))}`);
    return null;
  }
}

await call("get-me", "get_me", {});

// --- Q3, Q4 ---
const fixed = { owner, repo, perPage: LIST_PER_PAGE, fields: LIST_FIELDS, ...LIST_ORDER };
const listed = await call("list-fixed-args", "list_issues", fixed);
console.log(`[recon] Q3: fixed list args ${listed === null || listed.isError ? "REJECTED" : "accepted"}`);
const body = parsed(listed);
const issues = Array.isArray(body?.issues) ? body.issues : [];
console.log(
  `[recon] Q4: list keys ${JSON.stringify(body && Object.keys(body))}, ${issues.length} of ${body?.totalCount ?? "?"} issues, ` +
    `item keys ${JSON.stringify(issues[0] ? Object.keys(issues[0]) : [])}, ` +
    `numbers ${JSON.stringify(issues.map((issue) => issue.number))}, states ${JSON.stringify(issues.map((issue) => issue.state))}`,
);
await call("list-open", "list_issues", { ...fixed, state: "OPEN" });
await call("list-closed", "list_issues", { ...fixed, state: "CLOSED" });
// What the model would send if it guessed the lowercase spelling a read returns.
await call("list-lowercase-state", "list_issues", { ...fixed, state: "open" });

// Every listed issue, not just the first: an open and a closed issue do not have the same keys
// (a closed one adds `state_reason`, `closed_at` and `closed_by`).
const numbers = issues.map((issue) => issue.number).filter((number) => typeof number === "number");
for (const number of numbers) {
  const read = parsed(
    await call(`issue-read-${number}`, "issue_read", { method: "get", owner, repo, issue_number: number }),
  );
  console.log(
    `[recon] Q4: #${number} keys ${JSON.stringify(read && Object.keys(read))}, state ${JSON.stringify(read?.state)}, ` +
      `html_url ${typeof read?.html_url === "string" ? "present" : "ABSENT"}`,
  );
}
if (numbers.length === 0) console.log("[recon] Q4: no issue to read - the repository has none");

// --- Q5 ---
await call("issue-missing", "issue_read", { method: "get", owner, repo, issue_number: 999999 });
await call("issue-no-number", "issue_read", { method: "get", owner, repo });
await call("repo-missing-list", "list_issues", { owner, repo: "zzz-no-such-repo-m20" });
await call("repo-missing-read", "issue_read", { method: "get", owner, repo: "zzz-no-such-repo-m20", issue_number: 1 });
const ignored = await call("list-unknown-arg", "list_issues", { owner, repo, perPage: 1, bogus: 1 });
console.log(`[recon] Q5: an unknown argument is ${ignored?.isError ? "REJECTED" : "silently accepted"}`);
await client.close();

// --- Q6 ---
try {
  const rejected = await connect("Bearer github_pat_not_a_real_token");
  await rejected.close();
  console.log("[recon] Q6: a junk token CONNECTED (unexpected)");
} catch (error) {
  save("bad-token", { thrown: describe(error) });
  console.log(`[recon] Q6: ${JSON.stringify(describe(error))}`);
}

console.log(`\n[recon] done - captures are in ${OUT}/`);
process.exit(0);
