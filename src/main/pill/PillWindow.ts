import { pillBounds, pillSize } from "../../core/jobs/pill.ts";
import type { PillView, Rect } from "../../core/jobs/pill.ts";

// The status pill's window (M23).
//
// NO ELECTRON IMPORT. The window is made by a factory main.ts passes in, so everything this
// file decides — which options the window is created with, that it is only ever shown
// inactive, that it is excluded from capture, where it is put — is asserted in a test against
// a fake window, instead of living in main.ts where nothing can check it (CLAUDE.md).
//
// EVERY OPTION BELOW IS LOAD-BEARING, the same way the pointing overlay's are:
//
//   focusable: false + showInactive()
//       The pill appears while the user is typing, dictating, or working in another app. It
//       must never take the keyboard from any of them. Measured (scripts/pill-click-recon.cjs):
//       a real click on a window built this way reaches its page, and neither the window nor
//       this process takes focus or the foreground.
//   setContentProtection(true)
//       It lists the user's own instructions. Excluded from screen capture and screen
//       sharing, as the command bar and the overlay are.
//   alwaysOnTop, skipTaskbar, frameless, transparent, not resizable or movable
//       A status light, not an application window.
//
// UNLIKE THE OVERLAY IT TAKES CLICKS — there is no setIgnoreMouseEvents here — because it is
// where a waiting job is answered from. What a click can ask for is decided in
// PillController, and none of it is an approval.
export const PILL_WINDOW_OPTIONS = {
  show: false,
  frame: false,
  transparent: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,
  skipTaskbar: true,
  hasShadow: false,
  alwaysOnTop: true,
} as const;

export type PillWindowOptions = typeof PILL_WINDOW_OPTIONS;

// Just enough of a BrowserWindow to be a pill.
export interface PillBrowserWindow {
  setContentProtection(enable: boolean): void;
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

export interface PillWindowDeps<W extends PillBrowserWindow> {
  create: (options: PillWindowOptions) => W;
  // Load the pill's page into a new window. Resolves when it can receive a view.
  load: (window: W) => Promise<void>;
  // The work area (DIP) of the display the pill lives on, read each time it is placed — a
  // taskbar can move and a resolution can change while the app runs.
  workArea: () => Rect;
}

export class PillWindow<W extends PillBrowserWindow = PillBrowserWindow> {
  private win: W | null = null;
  private loaded = false;
  private latest: PillView | null = null;

  constructor(private readonly deps: PillWindowDeps<W>) {}

  // Draw this view. `hidden` takes the window off the screen; anything else places it,
  // sends the view and shows it WITHOUT activating it.
  render(view: PillView): void {
    this.latest = view;
    if (view.mode === "hidden") {
      if (this.win !== null && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
      return;
    }
    const win = this.ensure();
    win.setBounds(pillBounds(this.deps.workArea(), pillSize(view)));
    // Before the page has loaded there is nobody to receive it; `ensure` sends the latest
    // view once it has. Showing an empty frame in the meantime would be a flash of nothing.
    if (!this.loaded) return;
    win.webContents.send("pill:view", view);
    if (!win.isVisible()) win.showInactive();
  }

  // The window a detached job's confirm dialog hangs off, or null when there is none.
  window(): W | null {
    return this.win !== null && !this.win.isDestroyed() ? this.win : null;
  }

  // The display changed under it: put it back in its corner.
  reposition(): void {
    if (this.latest === null || this.latest.mode === "hidden") return;
    this.window()?.setBounds(pillBounds(this.deps.workArea(), pillSize(this.latest)));
  }

  dispose(): void {
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loaded = false;
  }

  private ensure(): W {
    if (this.win !== null && !this.win.isDestroyed()) return this.win;
    const win = this.deps.create(PILL_WINDOW_OPTIONS);
    win.setContentProtection(true);
    this.win = win;
    this.loaded = false;
    void this.deps.load(win).then(
      () => {
        if (this.win !== win || win.isDestroyed()) return;
        this.loaded = true;
        // Whatever the view is NOW — it may have changed, or gone to hidden, while loading.
        if (this.latest !== null) this.render(this.latest);
      },
      () => {
        // A page that will not load leaves no pill. Jobs are unaffected; they do not depend
        // on being drawn.
      },
    );
    return win;
  }
}
