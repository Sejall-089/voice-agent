// M18 task 4a — reconnaissance against the REAL Spotify Web API, before any transport,
// fixture or error message is written.
//
// WHY THIS EXISTS. The same reason scripts/notion-recon.mjs and scripts/tts-recon.mjs do, and
// it has now cost this repo three debugging sessions to learn: a fixture written from an
// assumption passes every test and matches nothing. M10 hand-authored Gmail's markup from a
// guess (`role="button"`; it was `role="link"`). M13 shipped GoogleCalendar.ts untested on the
// argument that only a live run could prove it — and both bugs the first live run found were in
// the half that was ordinary branching: deciding what a person gets TOLD when something breaks.
//
// Spotify's error classification is exactly that half, and the published docs are not enough to
// write it from. The reference pages for the player endpoints document `status`, `message` and
// an optional `reason` whose only listed value is QUOTA_EXCEEDED. The reasons this app actually
// has to tell apart — no active device, Premium required, volume not controllable on this
// device — are real but not on those pages, and `Retry-After` on a 429 is not documented at
// all. So every reason string and every status/body pairing used by core/spotify/ is
// TRANSCRIBED from what this script captures, never from a name anyone recalled.
//
// The open questions, in the order they matter:
//   Q1  What does a PKCE refresh return, and does it rotate the refresh token? (If it does,
//       a token pasted into .env has a limited life and the app has to say so.)
//   Q2  What does search return, and what does `limit` actually accept? The docs now say
//       0-10 with a default of 5 — much smaller than it once was, so this is worth confirming
//       against the live endpoint rather than trusting either number.
//   Q3  GET /v1/me/player WITH a device active: what is in `device`? Specifically
//       `volume_percent` (documented nullable) and `supports_volume` — spotifyVolume's whole
//       behaviour depends on both.
//   Q4  GET /v1/me/player WITH NO device: the docs say 204 No Content. An EMPTY BODY, not a
//       JSON error — so the no-device signal is a status, and a classifier keyed only on error
//       bodies would miss it entirely. Confirm, and capture the exact body (``? whitespace?).
//   Q5  PUT /v1/me/player/play with a device active: status, and is there a body at all?
//   Q6  PUT /v1/me/player/play with NO device: the exact status, `reason`, and `message`. This
//       is the single most important capture in the file — it is the one refusal a user will
//       hit most often, and "Open Spotify first" has to be triggered by something real.
//   Q7  PUT /v1/me/player/volume: status, and what it says when the device cannot do it.
//   Q8  A deliberately BAD token: the 401 shape, so "reconnect" is triggered by evidence.
//   Q9  Is this account Premium? A development-mode app requires the OWNER's account to be
//       Premium to function at all — not merely for playback — so a 403 here decides whether
//       M18's Spotify half can be live-verified at all. Q5-Q7 answer it by failing.
//
// RUN IT TWICE. The device-active and no-device halves cannot both be captured in one run:
//
//     node scripts/spotify-recon.mjs open     # with the Spotify desktop app open and PLAYING
//                                             # something at least once, so a device is active
//     node scripts/spotify-recon.mjs closed   # with Spotify fully quit
//
// Output lands in spotify-recon-out/<label>/ as one .json per call plus a summary.md.
//
// NO TOKEN IS EVER PRINTED OR SAVED. The refresh token is the entire connection to the account
// and the access token is a live credential; both are redacted on the way to disk (spec §10).
// Read `redact()` before changing anything about what gets written.
//
// Plain ESM, node built-ins plus dotenv, no build step, no imports from /core — the same shape
// as scripts/notion-recon.mjs and scripts/calendar-connect.mjs.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { config } from "dotenv";

config();

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

// What to search for. A deliberately ordinary two-word query: the point is to see the response
// SHAPE and how the terms are matched, not to find anything in particular.
const SEARCH_QUERY = process.env.SPOTIFY_RECON_QUERY ?? "bohemian rhapsody";

const label = (process.argv[2] ?? "").trim();
if (label !== "open" && label !== "closed") {
  console.error(
    "\nUsage: node scripts/spotify-recon.mjs <open|closed>\n\n" +
      "  open    Spotify desktop app running, and it has PLAYED something this session\n" +
      "          (an app that has never played has no active device, which is the `closed` case)\n" +
      "  closed  Spotify fully quit\n\n" +
      "Run both. The device-active and no-device responses are the two halves of the error\n" +
      "classification and cannot be captured in one run.\n",
  );
  process.exit(1);
}

const clientId = process.env.SPOTIFY_CLIENT_ID;
const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

if (!clientId || !refreshToken) {
  console.error(
    "\nSPOTIFY_CLIENT_ID and SPOTIFY_REFRESH_TOKEN must be set in .env before running this.\n" +
      "Run `npm run spotify:connect` first (M18 step 5), or see the Spotify section of\n" +
      ".env.example.\n",
  );
  process.exit(1);
}

const outDir = join("spotify-recon-out", label);
await mkdir(outDir, { recursive: true });

// --- redaction -------------------------------------------------------------------------------

// Every credential this script could possibly hold, longest first so a token that CONTAINS
// another string is replaced whole rather than leaving a fragment behind.
const secrets = [refreshToken];

function redact(text) {
  let out = String(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret && secret.length > 0) out = out.split(secret).join("<REDACTED>");
  }
  // Belt and braces: anything that LOOKS like a token field is flattened regardless of whether
  // we happen to know its value. A rotated refresh token arriving in Q1's response would
  // otherwise be a secret this script had never seen and so could not match above.
  out = out.replace(
    /("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]*(")/g,
    "$1<REDACTED>$2",
  );
  return out;
}

// Headers worth keeping. The full set carries request ids and cookies that are noise at best;
// these four are the ones any decision could turn on.
const HEADERS_OF_INTEREST = ["content-type", "retry-after", "www-authenticate", "content-length"];

function headersOfInterest(response) {
  const kept = {};
  for (const name of HEADERS_OF_INTEREST) {
    const value = response.headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

const captures = [];

// One captured call. The body is kept as a RAW STRING as well as parsed, because the parsed
// form is a lossy view of exactly the thing in question: a 204 with no body and a 200 with
// `{}` both parse to nothing useful and mean completely different things.
async function capture(id, question, request) {
  const { method = "GET", url, headers = {}, body } = request;
  const started = Date.now();

  let record;
  try {
    const response = await fetch(url, { method, headers, body });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // not JSON — recorded as such, which is itself a finding
    }
    record = {
      id,
      question,
      request: { method, url: redact(url), sentBody: body ? redact(String(body)) : null },
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: headersOfInterest(response),
      bodyLength: raw.length,
      bodyIsEmpty: raw.length === 0,
      rawBody: redact(raw),
      parsedBody: parsed === null ? null : JSON.parse(redact(JSON.stringify(parsed))),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    // A transport failure is a finding too — it is what `unreachable` has to be written from.
    record = {
      id,
      question,
      request: { method, url: redact(url) },
      transportError: redact(error instanceof Error ? error.message : String(error)),
      elapsedMs: Date.now() - started,
    };
  }

  captures.push(record);
  await writeFile(join(outDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const summary = record.transportError
    ? `THREW: ${record.transportError}`
    : `${record.status} ${record.statusText}` +
      (record.bodyIsEmpty ? " (empty body)" : ` (${record.bodyLength} bytes)`);
  console.log(`  ${id.padEnd(28)} ${summary}`);
  return record;
}

function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

// --- the run ---------------------------------------------------------------------------------

console.log(`\nSpotify recon — "${label}" run. Writing to ${outDir}/\n`);

// Q1. The PKCE refresh. No client secret: that is the whole point of PKCE for a desktop app,
// and it is why SpotifyAuth will not have one to hold.
const refresh = await capture("q1-token-refresh", "What does a PKCE refresh return?", {
  method: "POST",
  url: TOKEN_ENDPOINT,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString(),
});

const accessToken = refresh.parsedBody?.access_token ?? null;
if (accessToken === null) {
  console.error(
    "\nThe refresh did not return an access token, so nothing below can run. " +
      `See ${outDir}/q1-token-refresh.json for exactly what came back.\n`,
  );
  await writeSummary();
  process.exit(1);
}
// The live access token joins the redaction list the moment it exists, so it cannot reach disk
// through a later response that happens to echo it.
secrets.push(accessToken);

// Whether the refresh ROTATED the token matters for whether a pasted .env value keeps working.
// Recorded as a boolean, never as either value.
const rotated =
  typeof refresh.parsedBody?.refresh_token === "string" &&
  refresh.parsedBody.refresh_token !== "<REDACTED>";

// Q9 (asked early, because every write below depends on the answer): is this account Premium?
await capture("q9-me", "Is this account Premium? (product field)", {
  url: `${API}/me`,
  headers: authHeader(accessToken),
});

// Q2. Search, at the documented maximum. If `limit=10` is rejected the docs are wrong about the
// ceiling, which is exactly the kind of thing to find out here rather than in a handler.
const search = await capture("q2-search-limit-10", "What does search return, and is limit<=10?", {
  url: `${API}/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=track&limit=10`,
  headers: authHeader(accessToken),
});

// And one over the ceiling, to see HOW it refuses — a 400 with a message, or a silent clamp.
await capture("q2b-search-limit-50", "Does limit=50 error, or clamp silently?", {
  url: `${API}/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=track&limit=50`,
  headers: authHeader(accessToken),
});

// A query that should match nothing, so the empty-results shape is captured rather than assumed
// (an empty `items` array vs. a missing key vs. a 404 are three different handlers).
await capture("q2c-search-no-results", "What does a search with no matches look like?", {
  url: `${API}/search?q=${encodeURIComponent("zzzqqxnosuchtrackanywhere12345")}&type=track&limit=10`,
  headers: authHeader(accessToken),
});

const topTrack = search.parsedBody?.tracks?.items?.[0] ?? null;
const topTrackUri = topTrack?.uri ?? null;

// Q3/Q4. The same call, and which one this is depends on how the script was invoked. Both
// filenames say which, because the pair is the finding.
await capture(
  `q3-player-${label}`,
  label === "open"
    ? "With a device active: what is in `device`? (volume_percent, supports_volume)"
    : "With NO device: is it really 204 with an empty body?",
  { url: `${API}/me/player`, headers: authHeader(accessToken) },
);

// The device list, which is a different endpoint with a different empty-case. Worth having:
// if `supports_volume` is only reliable here, spotifyVolume has to read it here.
await capture(`q3b-devices-${label}`, "What does the devices list look like?", {
  url: `${API}/me/player/devices`,
  headers: authHeader(accessToken),
});

// Q5/Q6. THE PLAY CALL — the most important capture in the file. In the `closed` run this is
// the no-active-device refusal that "Open Spotify first" must be triggered by.
if (topTrackUri === null) {
  console.log("  q5-play                      SKIPPED — search returned no track to play");
} else {
  await capture(
    `q5-play-${label}`,
    label === "open"
      ? "Play with a device active: status, and is there a body?"
      : "Play with NO device: the exact status, reason and message",
    {
      method: "PUT",
      url: `${API}/me/player/play`,
      headers: { ...authHeader(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [topTrackUri] }),
    },
  );
}

// Q7. Volume. 50 is deliberately mid-range: loud enough to be audible if it works, not a
// surprise if the user is wearing headphones.
await capture(`q7-volume-50-${label}`, "Setting volume: status, and what it says on refusal", {
  method: "PUT",
  url: `${API}/me/player/volume?volume_percent=50`,
  headers: authHeader(accessToken),
});

// Out of range, to see whether the API validates or clamps. Decides whether the clamp in
// spotifyVolume is a convenience or a requirement.
await capture("q7b-volume-200", "Does an out-of-range volume error, or clamp?", {
  method: "PUT",
  url: `${API}/me/player/volume?volume_percent=200`,
  headers: authHeader(accessToken),
});

// Q8. A bad token, on a read and a write, so the 401 shape is captured from both.
const BAD_TOKEN = "BQD-this-is-not-a-real-access-token-0000000000";
await capture("q8-bad-token-read", "What does a rejected token look like on a read?", {
  url: `${API}/me/player`,
  headers: authHeader(BAD_TOKEN),
});
await capture("q8b-bad-token-write", "And on a write?", {
  method: "PUT",
  url: `${API}/me/player/volume?volume_percent=50`,
  headers: authHeader(BAD_TOKEN),
});

// A bad REFRESH token, which is a different failure at a different endpoint — this is the one
// "I'm not connected / reconnect" has to be written from.
await capture("q8c-bad-refresh-token", "What does a rejected REFRESH token look like?", {
  method: "POST",
  url: TOKEN_ENDPOINT,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: "AQD-definitely-not-a-real-refresh-token-000",
    client_id: clientId,
  }).toString(),
});

await writeSummary();

async function writeSummary() {
  const product = captures.find((c) => c.id === "q9-me")?.parsedBody?.product ?? "unknown";
  const lines = [
    `# Spotify recon — "${label}" run`,
    "",
    `Captured ${captures.length} calls. Account product: **${product}**.`,
    `Refresh rotated the refresh token: **${rotated ? "YES" : "no"}**.`,
    "",
    "No token appears in any file in this directory — see `redact()` in the script.",
    "",
    "| id | status | body | question |",
    "|---|---|---|---|",
    ...captures.map((c) => {
      const status = c.transportError ? "THREW" : `${c.status}`;
      const body = c.transportError
        ? c.transportError
        : c.bodyIsEmpty
          ? "(empty)"
          : `${c.bodyLength}B`;
      return `| \`${c.id}\` | ${status} | ${body} | ${c.question} |`;
    }),
    "",
    "## Reason codes seen",
    "",
    ...(() => {
      const reasons = new Set();
      for (const c of captures) {
        const reason = c.parsedBody?.error?.reason;
        if (typeof reason === "string") reasons.add(`${c.status} → \`${reason}\``);
      }
      return reasons.size === 0
        ? ["None of the captured errors carried a `reason` field."]
        : [...reasons].sort().map((r) => `- ${r}`);
    })(),
    "",
    "## Messages seen",
    "",
    ...(() => {
      const messages = new Set();
      for (const c of captures) {
        const message = c.parsedBody?.error?.message ?? c.parsedBody?.error_description;
        if (typeof message === "string") messages.add(`${c.status} → "${message}"`);
      }
      return messages.size === 0 ? ["No error messages captured."] : [...messages].sort().map((m) => `- ${m}`);
    })(),
    "",
  ];
  await writeFile(join(outDir, "summary.md"), `${lines.join("\n")}\n`, "utf8");
  console.log(`\nAccount product: ${product}`);
  console.log(`Summary written to ${join(outDir, "summary.md")}`);
  console.log(
    label === "open"
      ? "\nNow quit Spotify completely and run:  node scripts/spotify-recon.mjs closed\n"
      : "\nIf you have not done the other half yet: open Spotify, play something, then run:\n" +
          "  node scripts/spotify-recon.mjs open\n",
  );
}
