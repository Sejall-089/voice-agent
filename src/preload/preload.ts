import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

// The only surface the renderer sees. No node/electron internals leak through
// (contextIsolation on). Channels mirror the WindowsShell IPC contract.
const api = {
  // main → renderer: the bar was opened; renderer should reset + focus its input.
  onShow(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on("commandbar:show", listener);
    return () => ipcRenderer.removeListener("commandbar:show", listener);
  },
  // main → renderer: echo text to display (M0), later the action result.
  onEcho(callback: (text: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, text: string): void => callback(text);
    ipcRenderer.on("commandbar:echo", listener);
    return () => ipcRenderer.removeListener("commandbar:echo", listener);
  },
  // main → renderer: clear the bar (it was hidden).
  onReset(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on("commandbar:reset", listener);
    return () => ipcRenderer.removeListener("commandbar:reset", listener);
  },
  // renderer → main: user submitted the typed text.
  submit(text: string): void {
    ipcRenderer.send("commandbar:submit", text);
  },
  // renderer → main: user dismissed the bar (Escape).
  close(): void {
    ipcRenderer.send("commandbar:close");
  },
};

export type CommandBarApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
