// M22 step 0 — reconnaissance against the REAL Slack Web API, before ChannelDirectory, its
// fixtures or any of its failure mappings are written.
//
//   node scripts/slack-recon.mjs
//
// WHY THIS EXISTS. The same reason linear-recon.mjs and github-recon.mjs do (CLAUDE.md, "Recon
// before fixtures" and "Recon the failure shapes, not just the happy path"): a fake Slack built
// from the docs passes every test and matches nothing. The questions:
//
//   Q1  What does auth.test say, and which scopes does the token actually carry?
//   Q2  What does conversations.list return — top-level fields, per-channel fields, paging
//       fields — and which private channels appear (only ones the bot is a member of?)
//   Q3  What does a rejected token look like: HTTP status, ok flag, error code?
//   Q4  What does a network failure look like, and a timeout: error class and code?
//
// STRICTLY READ-ONLY, AND THAT IS A RULE RATHER THAN A DEFAULT. Only the methods on READ_ONLY
// are ever called; `call` refuses anything else, and there is no flag that widens it. Nothing is
// posted, joined, created or changed.
//
// THE TOKEN IS NEVER PRINTED. It goes in the Authorization header and nowhere else — not in a
// URL, not in a log line. No error message, URL, header value or response body is printed
// either: an HTTP client is entitled to quote the request it failed to send (measured: undici
// echoes an invalid header value whole). What is printed is codes, counts, field NAMES, at most
// three channel names, and whether a channel called "social" exists. Writes no files.

import process from "node:process";
import { config } from "dotenv";

config();

const API = "https://slack.com/api";
const READ_ONLY = new Set(["auth.test", "conversations.list"]);
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const TIMEOUT_MS = 8000;

// Error CLASS and CODE only — never `.message`, which can carry the URL or the header.
function describeError(error) {
  const cls = error?.constructor?.name ?? typeof error;
  const name = error?.name ?? "-";
  const cause = error?.cause;
  const code = cause?.code ?? error?.code ?? "-";
  const causeCls = cause?.constructor?.name ?? "-";
  return `class=${cls} name=${name} cause=${causeCls} code=${code}`;
}

const RATE_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

function rateHeaders(response) {
  const found = RATE_HEADERS.filter((h) => response.headers.get(h) !== null).map(
    (h) => `${h}=${response.headers.get(h)}`,
  );
  return found.length > 0 ? found.join(" ") : "(none)";
}

// One GET. The token travels ONLY as the Authorization header; params are the method's own.
async function call(base, method, token, params = {}, timeoutMs = TIMEOUT_MS) {
  if (!READ_ONLY.has(method)) throw new Error("refused: not a read-only method");
  const query = new URLSearchParams(params).toString();
  const url = `${base}/${method}${query ? `?${query}` : ""}`;
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    const elapsed = Date.now() - started;
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // reported below as "not JSON"; the text itself is never printed
    }
    return { kind: "response", response, body, elapsed };
  } catch (error) {
    return { kind: "thrown", error, elapsed: Date.now() - started };
  }
}

function report(label, result) {
  if (result.kind === "thrown") {
    console.log(`  ${label}: THREW ${describeError(result.error)} elapsed=${result.elapsed}ms`);
    return;
  }
  const { response, body, elapsed } = result;
  const ok = body === null ? "(not JSON)" : String(body.ok);
  const error = body?.error ?? "-";
  console.log(
    `  ${label}: HTTP ${response.status} content-type=${response.headers.get("content-type") ?? "-"} ` +
      `ok=${ok} error=${error} elapsed=${elapsed}ms`,
  );
  console.log(`    rate-limit headers: ${rateHeaders(response)}`);
  if (body !== null) console.log(`    top-level fields: ${Object.keys(body).sort().join(", ")}`);
}

async function realToken(token) {
  console.log("\n[Q1] auth.test with SLACK_BOT_TOKEN");
  const auth = await call(API, "auth.test", token);
  report("auth.test", auth);
  if (auth.kind === "response") {
    // Scope NAMES are not secret, and they are the one thing that says whether the four scopes
    // M22 asks for were actually granted.
    console.log(`    x-oauth-scopes: ${auth.response.headers.get("x-oauth-scopes") ?? "(header absent)"}`);
  }

  console.log("\n[Q2] conversations.list, every page");
  const channels = [];
  const perChannelFields = new Set();
  const metadataFields = new Set();
  let cursor = "";
  let pages = 0;
  let totalMs = 0;
  for (;;) {
    pages += 1;
    const params = {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    };
    const page = await call(API, "conversations.list", token, params);
    totalMs += page.elapsed;
    report(`page ${pages}`, page);
    if (page.kind !== "response" || page.body?.ok !== true) break;
    const list = Array.isArray(page.body.channels) ? page.body.channels : [];
    console.log(`    channels on this page: ${list.length}`);
    for (const channel of list) {
      for (const key of Object.keys(channel)) perChannelFields.add(key);
      channels.push(channel);
    }
    const metadata = page.body.response_metadata;
    if (metadata && typeof metadata === "object") {
      for (const key of Object.keys(metadata)) metadataFields.add(key);
    }
    const next = typeof metadata?.next_cursor === "string" ? metadata.next_cursor : undefined;
    console.log(
      `    response_metadata.next_cursor: ${next === undefined ? "ABSENT" : next === "" ? 'present, ""' : "present, non-empty"}`,
    );
    if (!next || pages >= MAX_PAGES) break;
    cursor = next;
  }

  const count = (pred) => channels.filter(pred).length;
  console.log(`\n  pages: ${pages}, total channels: ${channels.length}, total elapsed: ${totalMs}ms`);
  console.log(`  per-channel fields: ${[...perChannelFields].sort().join(", ")}`);
  console.log(`  response_metadata fields: ${[...metadataFields].sort().join(", ") || "(none)"}`);
  console.log(
    `  is_private: true=${count((c) => c.is_private === true)} false=${count((c) => c.is_private === false)} ` +
      `absent=${count((c) => !("is_private" in c))}`,
  );
  console.log(
    `  is_member: true=${count((c) => c.is_member === true)} false=${count((c) => c.is_member === false)} ` +
      `absent=${count((c) => !("is_member" in c))}`,
  );
  console.log(
    `  is_archived: true=${count((c) => c.is_archived === true)} false=${count((c) => c.is_archived === false)} ` +
      `absent=${count((c) => !("is_archived" in c))}`,
  );
  console.log(
    `  private AND not a member: ${count((c) => c.is_private === true && c.is_member !== true)}`,
  );
  console.log(`  is_channel / is_group / is_mpim / is_im true: ${["is_channel", "is_group", "is_mpim", "is_im"]
    .map((k) => `${k}=${count((c) => c[k] === true)}`)
    .join(" ")}`);
  const names = channels.map((c) => c.name).filter((n) => typeof n === "string");
  const lower = names.map((n) => n.toLowerCase());
  console.log(`  names that are not already lower-case: ${names.filter((n) => n !== n.toLowerCase()).length}`);
  console.log(`  duplicate names: ${lower.length - new Set(lower).size}`);
  console.log(`  "name_normalized" differs from "name": ${count((c) => typeof c.name_normalized === "string" && c.name_normalized !== c.name)}`);
  console.log(`  first names (max 3): ${names.slice(0, 3).join(", ") || "(none)"}`);
  console.log(`  a channel named "social" exists: ${lower.includes("social")}`);
  const idShapes = new Set(channels.map((c) => (typeof c.id === "string" ? `${c.id[0]}+${c.id.length - 1}` : typeof c.id)));
  console.log(`  id shapes (first letter + length of the rest): ${[...idShapes].join(", ")}`);
}

async function invalidToken() {
  console.log('\n[Q3] the literal fake token "xoxb-invalid"');
  report("auth.test", await call(API, "auth.test", "xoxb-invalid"));
  report(
    "conversations.list",
    await call(API, "conversations.list", "xoxb-invalid", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1",
    }),
  );
  console.log("\n[Q3b] no Authorization header at all");
  report("conversations.list", await call(API, "conversations.list", null, { limit: "1" }));
}

async function networkFailures() {
  // No token is sent to either host: there is no reason to hand one to somewhere that is not
  // Slack, even somewhere that does not exist.
  console.log("\n[Q4] network failure: a host that does not resolve (.invalid is reserved)");
  report("dns", await call("https://slack-recon.invalid/api", "auth.test", null));
  console.log("\n[Q4b] timeout: a non-routable address, with a 2s AbortSignal.timeout");
  report("timeout", await call("https://10.255.255.1/api", "auth.test", null, {}, 2000));
}

const token = process.env.SLACK_BOT_TOKEN;
console.log(`[recon] node ${process.version}`);
if (token === undefined || token.trim() === "") {
  console.log("\n[Q1/Q2] SKIPPED: SLACK_BOT_TOKEN is not set in .env.");
} else {
  await realToken(token.trim());
}
await invalidToken();
await networkFailures();
console.log("\n[recon] done. Nothing was written.");
