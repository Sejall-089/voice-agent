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

  // --- Voice (M7). Audio is captured here in the renderer; main only orchestrates. ---

  // main → renderer: begin/stop microphone capture.
  onVoiceStart(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on("voice:start", listener);
    return () => ipcRenderer.removeListener("voice:start", listener);
  },
  onVoiceStop(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on("voice:stop", listener);
    return () => ipcRenderer.removeListener("voice:stop", listener);
  },
  onVoiceCancel(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on("voice:cancel", listener);
    return () => ipcRenderer.removeListener("voice:cancel", listener);
  },
  // main → renderer: current voice state, for the recording indicator.
  onVoiceState(callback: (state: string, detail?: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, state: string, detail?: string): void =>
      callback(state, detail);
    ipcRenderer.on("voice:state", listener);
    return () => ipcRenderer.removeListener("voice:state", listener);
  },
  // renderer → main: capture is live (or couldn't start — blocked mic, no device).
  voiceStarted(error?: string): void {
    ipcRenderer.send("voice:started", error);
  },
  // renderer → main: the finished clip (or an error explaining why there isn't one).
  sendAudio(clip: { wav: Uint8Array; durationMs: number } | null, error?: string): void {
    ipcRenderer.send("voice:audio", clip, error);
  },
  // main → renderer: which combo the OS actually granted, for the "…to stop" hint.
  onVoiceHotkey(callback: (combo: string | null) => void): () => void {
    const listener = (_e: IpcRendererEvent, combo: string | null): void => callback(combo);
    ipcRenderer.on("voice:hotkey", listener);
    return () => ipcRenderer.removeListener("voice:hotkey", listener);
  },
  // renderer → main: Escape during recording asked to discard it.
  cancelVoice(): void {
    ipcRenderer.send("voice:cancelled");
  },
};

export type CommandBarApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
