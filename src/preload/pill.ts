import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { PillView } from "../core/jobs/pillView.ts";

// The status pill's bridge (M23). Its own preload, not the command bar's: the pill has no
// business with the microphone, the speaker or the instruction input, and a window that is on
// screen while other things happen should be holding as little as possible.
//
// One channel in, seven out. Every outgoing message is a REQUEST that main checks again
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
  // pill → main: "Dismiss all", beside the chime toggle (M27). No arguments: main decides which
  // rows it covers from what it is showing, so nothing the page sends can widen it.
  dismissAll(): void {
    ipcRenderer.send("pill:dismiss-all");
  },
  // pill → main: open or close the list.
  expand(expanded: boolean): void {
    ipcRenderer.send("pill:expand", expanded);
  },
  // pill → main: the pointer entered or left this window. The window cannot take focus, so
  // this is what an open list uses in place of a blur to know it has been left.
  hover(inside: boolean): void {
    ipcRenderer.send("pill:hover", inside);
  },
  // pill → main: how tall the open list's content is, so the window can be sized to it.
  contentHeight(height: number): void {
    ipcRenderer.send("pill:height", height);
  },
  // pill → main: how wide each way of writing the label is, so the pill can be sized to the
  // one that fits (M27). The labels are sent back with the widths, so main can tell a
  // measurement of the label it is showing from one of a label that has since changed.
  labelWidths(labels: string[], widths: number[]): void {
    ipcRenderer.send("pill:label-widths", labels, widths);
  },
  // pill → main: mute or unmute the needs-you chime.
  mute(muted: boolean): void {
    ipcRenderer.send("pill:mute", muted);
  },
};

export type PillApi = typeof pill;

contextBridge.exposeInMainWorld("pill", pill);
