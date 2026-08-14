import type { CommandBarApi } from "./preload.ts";

// Makes `window.api` typed in the renderer.
declare global {
  interface Window {
    api: CommandBarApi;
  }
}

export {};
