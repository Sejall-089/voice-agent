import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Build targets map to spec.md §3's directory layout:
//   main    -> src/main/main.ts
//   preload -> src/preload/preload.ts
//   renderer-> src/renderer (React + Vite)
//
// externalizeDepsPlugin keeps `dependencies` out of the bundle and requires them at
// runtime. This is REQUIRED for native modules — better-sqlite3 loads a .node binary and
// cannot be bundled by rollup.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve("src/main/main.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve("src/preload/preload.ts") },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      rollupOptions: {
        // Two pages, not one (M15). `overlay.html` is the pointing marker — a separate top-level
        // entry rather than a route inside the command bar, because it is a separate WINDOW with
        // opposite requirements: transparent, click-through, never focused, and carrying no
        // preload or bridge at all. It is plain HTML with no React, so it adds an entry here and
        // nothing to the bundle.
        input: {
          index: resolve("src/renderer/index.html"),
          overlay: resolve("src/renderer/overlay.html"),
        },
      },
    },
    plugins: [react()],
  },
});
