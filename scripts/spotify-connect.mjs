// One-time Spotify consent (M18). Run it once per machine:
//
//   npm run spotify:connect
//
// It opens Spotify's consent page in your normal browser, catches the redirect on a loopback
// server, exchanges the code, and prints a refresh token to paste into .env.
//
// Same shape and same reasoning as scripts/calendar-connect.mjs — a loopback flow in a thing
// that runs once and exits, rather than a window, an IPC path and a hotkey added to the surface
// of a running assistant for an operation you do once. Plain ESM, no build step, no imports
// from /core; the app reads the token from .env like every other secret.
//
// THREE WAYS THIS DIFFERS FROM THE CALENDAR SCRIPT, each for a real reason:
//
// 1. PKCE, AND NO CLIENT SECRET. A desktop app cannot keep a secret — anything shipped with it
//    is readable by whoever has the binary — so the flow proves possession of a one-time
//    `code_verifier` instead. That is also why .env has no SPOTIFY_CLIENT_SECRET: there is
//    nothing to store, which is strictly better than storing something that cannot be secret.
//
// 2. THE REDIRECT URI IS A LOOPBACK IP LITERAL, NOT `localhost`. Spotify's rules changed on
//    2025-04-09 (migration deadline November 2025): `localhost` is explicitly rejected, and a
//    loopback redirect must be the literal `http://127.0.0.1:PORT` or `http://[::1]:PORT`.
//    Everything else must be HTTPS. Registering `http://localhost:PORT` in the dashboard will
//    now fail, and this is the single most likely thing to go wrong in setup.
//
// 3. THE PORT IS FIXED, NOT EPHEMERAL. calendar-connect asks the OS for any free port because
//    Google accepts any loopback port for a registered loopback redirect. Spotify requires the
//    redirect URI to match what is registered EXACTLY — it permits registering a loopback
//    without a port and supplying one dynamically, but that is an easy thing to get subtly
//    wrong in a dashboard field, so this script pins one port and tells you exactly what to
//    paste. Override with SPOTIFY_REDIRECT_PORT if 8724 is taken on your machine.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import { config } from "dotenv";

config();

const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

// EXACTLY the two scopes M18's tools need, and nothing more. `user-read-playback-state` is what
// lets `spotifyVolume` read the current level before changing it and what tells
// `playOnSpotify` whether any device is active at all; `user-modify-playback-state` is the
// write. Notably ABSENT: anything touching playlists, the library, or listening history —
// M18's out-of-scope list is enforced at the grant, not just in the code.
const SCOPES = ["user-read-playback-state", "user-modify-playback-state"];

const port = Number(process.env.SPOTIFY_REDIRECT_PORT ?? 8724);
const redirectUri = `http://127.0.0.1:${port}/callback`;

const clientId = process.env.SPOTIFY_CLIENT_ID;

if (!clientId) {
  console.error(
    "\nSPOTIFY_CLIENT_ID must be set in .env before running this.\n\n" +
      "One-time setup:\n" +
      "  1. https://developer.spotify.com/dashboard -> Create app\n" +
      "  2. Redirect URI: paste EXACTLY this, including the port and /callback:\n" +
      `       ${redirectUri}\n` +
      "     NOT http://localhost:... — Spotify rejects localhost as a redirect URI.\n" +
      '  3. Which API/SDKs: tick "Web API".\n' +
      "  4. Copy the Client ID into SPOTIFY_CLIENT_ID in .env. There is no client secret to\n" +
      "     copy: this uses PKCE.\n" +
      "  5. Settings -> User Management: make sure your own Spotify account is listed. An app\n" +
      "     in development mode only works for accounts on that list, and only if the app\n" +
      "     owner has Spotify Premium.\n\n" +
      "See the Spotify section of .env.example for the whole story.\n",
  );
  process.exit(1);
}

// --- PKCE ------------------------------------------------------------------------------------

// 64 random bytes, base64url — comfortably inside the spec's 43-128 character range for a
// verifier, and random from the OS rather than from Math.random.
const codeVerifier = base64Url(randomBytes(64));
const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
// Guards against a stray request to our loopback server being taken for the real callback.
const state = base64Url(randomBytes(16));

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- the flow --------------------------------------------------------------------------------

const server = createServer();
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
} catch (error) {
  console.error(
    `\nCould not listen on 127.0.0.1:${port} (${error.code ?? error.message}).\n` +
      "Something else is using that port. Set SPOTIFY_REDIRECT_PORT in .env to a free one —\n" +
      "and register the matching redirect URI in the Spotify dashboard.\n",
  );
  process.exit(1);
}

const authUrl =
  `${AUTH_ENDPOINT}?` +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  }).toString();

console.log("\nOpening Spotify's consent page in your browser.");
console.log("If it doesn't open, paste this in yourself:\n");
console.log(`  ${authUrl}\n`);
console.log(`It will ask for: ${SCOPES.join(", ")} — and nothing else.`);
console.log(
  "\nIf Spotify says INVALID_CLIENT: Invalid redirect URI, the dashboard does not have this\n" +
    `exact string registered:\n\n  ${redirectUri}\n`,
);

openInBrowser(authUrl);

const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Timed out waiting for consent (5 minutes).")),
    5 * 60_000,
  );

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    // Browsers ask for /favicon.ico unprompted; answering it as the callback would reject the
    // flow before the real redirect arrives.
    if (!url.pathname.startsWith("/callback")) {
      response.writeHead(404).end();
      return;
    }

    const received = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");

    const stateOk = returnedState === state;
    const good = Boolean(received) && stateOk;

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem">` +
        `<h2>${good ? "Connected." : "Consent was not granted."}</h2>` +
        `<p>${good ? "You can close this tab and go back to the terminal." : (error ?? "")}</p>`,
    );

    clearTimeout(timeout);
    if (!stateOk) reject(new Error("The redirect's `state` did not match. Run this again."));
    else if (received) resolve(received);
    else reject(new Error(`Spotify returned: ${error ?? "no code"}`));
  });
});

const response = await fetch(TOKEN_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }).toString(),
});

server.close();

if (!response.ok) {
  // The body is read for its error fields only, and only those are printed — the request
  // carried the authorization code and the verifier.
  let detail = "";
  try {
    const body = await response.json();
    detail = [body.error, body.error_description].filter(Boolean).join(": ");
  } catch {
    // Not JSON. The status is the whole message then.
  }
  console.error(
    `\nSpotify refused the token exchange (HTTP ${response.status})${detail ? `: ${detail}` : "."}\n`,
  );
  process.exit(1);
}

const body = await response.json();
const refreshToken = body.refresh_token;

if (!refreshToken) {
  console.error(
    "\nSpotify returned no refresh token, only an access token — which expires in an hour and\n" +
      "is no use to the app. Run this again; if it keeps happening, remove the app's access at\n" +
      "https://www.spotify.com/account/apps/ and retry.\n",
  );
  process.exit(1);
}

console.log("\n" + "─".repeat(72));
console.log("Add these lines to your .env, then restart the app:\n");
console.log(`SPOTIFY_CLIENT_ID=${clientId}`);
console.log(`SPOTIFY_REFRESH_TOKEN=${refreshToken}`);
console.log("\nTreat the refresh token like a password — it is the whole connection to your");
console.log("Spotify account. It is never logged and never appears in an error message.");
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
