// Probe: will the DEV server serve a renderer import that lives outside src/renderer?
//
//   node scripts/vite-fs-probe.mjs
//
// The renderer's Vite root is src/renderer, and Vite's dev server refuses to serve files outside
// its allowed roots (`server.fs.strict`). A production BUILD has no such restriction, and neither
// does vitest — so an import like `../core/resultLinks.ts` from the renderer builds, passes every
// test, and could still be a 403 in `npm run dev`, which is where the app is actually used.
// Nothing but the dev server can answer that, so this starts it — the renderer config exactly as
// electron-vite resolves it, on a spare port, no Electron — and asks for the file over HTTP.
//
// Opens no window and touches nothing outside the repo. Measured 2026-10-10: 200 for the
// transformed module, so no `server.fs.allow` is needed (the allowed root is the project
// root, found from package.json's location, not the renderer's `root`).
import { resolveConfig } from "electron-vite";
import { createServer } from "vite";
import { resolve } from "node:path";

const resolved = await resolveConfig({ mode: "development", command: "serve" }, "serve", "development");
const rendererConfig = resolved.config?.renderer;
if (!rendererConfig) {
  console.error("could not resolve the renderer config");
  process.exit(2);
}

const server = await createServer({ ...rendererConfig, configFile: false, server: { ...rendererConfig.server, port: 5199, strictPort: false } });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? "http://localhost:5199/";

const targets = {
  "the bar itself": "CommandBar.tsx",
  "the component that imports core": "ResultText.tsx",
  "the core module, as the browser will request it": `@fs/${resolve("src/core/resultLinks.ts").replace(/\\/g, "/")}`,
};

let ok = true;
for (const [label, path] of Object.entries(targets)) {
  const response = await fetch(new URL(path, base));
  const body = await response.text();
  console.log(`${response.status}  ${label}  (${path.slice(0, 60)})  ${body.length} bytes`);
  if (response.status !== 200) ok = false;
}
console.log(`fs.allow in effect: ${JSON.stringify(server.config.server.fs.allow)}`);
await server.close();
// exitCode, not process.exit(): exiting while the server's handles are still closing trips a
// libuv assertion on Windows.
process.exitCode = ok ? 0 : 1;
