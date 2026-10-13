import type { CommandBarApi } from "./preload.ts";
import type { PillApi } from "./pill.ts";

// Makes `window.api` typed in the renderer — and `window.pill` in the status pill's page (M23),
// which is a different window with a different preload. Each exists only in its own window.
declare global {
  interface Window {
    api: CommandBarApi;
    pill: PillApi;
  }
}

export {};
