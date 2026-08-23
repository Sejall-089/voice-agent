// One-time Google Calendar consent (M13). Run it once per machine:
//
//   npm run calendar:connect
//
// It opens Google's consent page in your normal browser, catches the redirect on a loopback
// server, exchanges the code, and prints a refresh token to paste into .env.
//
// WHY THIS IS A SCRIPT AND NOT PART OF THE APP
//
// Google blocks OAuth in embedded webviews, so an Electron BrowserWindow is not an option —
// that is a policy of theirs, not a preference of ours. What remains is the loopback flow,
// which needs the system browser and a throwaway HTTP server. Both belong in a thing that runs
// once and exits, rather than in the app's runtime: no new window, no new IPC, no new hotkey
// path, nothing added to the surface of a running assistant for an operation you do once.
//
// Plain ESM with no build step and no imports from /core, exactly like scripts/notion-recon.mjs.
// The only thing it shares with the app is the shape of what it prints, and the app reads that
// from .env like every other secret.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import { config } from "dotenv";

config();

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Read AND write. `moveEvent` and `createEvent` both need write; nothing here needs more than
// the user's own calendars, so nothing more is asked for.
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env before running this.\n" +
      "See the Google Calendar section of .env.example for how to create them.\n",
  );
  process.exit(1);
}

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl =
  `${AUTH_ENDPOINT}?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    // Both are required to get a refresh token at all. `prompt=consent` forces Google to issue
    // a new one even if this app was authorized before — without it, a second run returns an
    // access token and no refresh token, which looks like a bug in this script.
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\nOpening Google's consent page in your browser.");
console.log("If it doesn't open, paste this in yourself:\n");
console.log(`  ${authUrl}\n`);
console.log(
  "Expect an 'unverified app' warning: Calendar is a sensitive scope, and clearing it needs\n" +
    "full Google verification (domain ownership, privacy policy review) that isn't worth it for\n" +
    "a personal project. Click Advanced, then 'Go to <your app name>'. This is expected, not a\n" +
    "broken flow.\n",
);

openInBrowser(authUrl);

const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Timed out waiting for consent (5 minutes).")),
    5 * 60_000,
  );

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    const received = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem">` +
        `<h2>${received ? "Connected." : "Consent was not granted."}</h2>` +
        `<p>${received ? "You can close this tab and go back to the terminal." : error ?? ""}</p>`,
    );

    clearTimeout(timeout);
    if (received) resolve(received);
    else reject(new Error(`Google returned: ${error ?? "no code"}`));
  });
});

const response = await fetch(TOKEN_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }).toString(),
});

server.close();

if (!response.ok) {
  // Status only. The request body carried the client secret and the authorization code.
  console.error(`\nGoogle refused the token exchange (HTTP ${response.status}).\n`);
  process.exit(1);
}

const { refresh_token: refreshToken } = await response.json();

if (!refreshToken) {
  console.error(
    "\nGoogle returned no refresh token. That usually means this app was already authorized\n" +
      "and Google reused the existing grant. Revoke it at\n" +
      "https://myaccount.google.com/permissions and run this again.\n",
  );
  process.exit(1);
}

console.log("\n" + "─".repeat(72));
console.log("Add this line to your .env, then restart the app:\n");
console.log(`GOOGLE_REFRESH_TOKEN=${refreshToken}`);
console.log("\nTreat it like a password — it is the whole connection to your calendar.");
console.log("─".repeat(72) + "\n");

// Give the "Connected." page a moment to render before the process exits under it.
await new Promise((resolve) => setTimeout(resolve, 250));
process.exit(0);

function openInBrowser(url) {
  // `start` is a cmd builtin, hence the shell; the empty "" is its title argument, without
  // which a quoted URL is taken as the window title and nothing opens.
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}
