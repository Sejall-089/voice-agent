import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { PillView } from "../core/jobs/pillView.ts";

// The status pill's bridge (M23). Its own preload, not the command bar's: the pill has no
// business with the microphone, the speaker or the instruction input, and a window that is on
// screen while other things happen should be holding as little as possible.
//
// One channel in, four out. Every outgoing message is a REQUEST that main checks again
// (PillController): the page is handed strings and booleans and cannot approve, send or run
// anything by sending one.
const pill = {
  // main → pill: draw this.
  onView(callback: (view: PillView) => void): () => void {
    const listener = (_e: IpcRendererEvent, view: PillView): void => callback(view);
    ipcRenderer.on("pill:view", listener);
    return () => ipcRenderer.removeListener("pill:view", listener);
  },
  // pill → main: a row's button. "review" asks main to OPEN the confirm dialog; nothing here
  // can answer it.
  action(id: string, action: string): void {
    ipcRenderer.send("pill:action", id, action);
  },
  // pill → main: open or close the list.
  expand(expanded: boolean): void {
    ipcRenderer.send("pill:expand", expanded);
  },
  // pill → main: mute or unmute the needs-you chime.
  mute(muted: boolean): void {
    ipcRenderer.send("pill:mute", muted);
  },
};

export type PillApi = typeof pill;

contextBridge.exposeInMainWorld("pill", pill);
