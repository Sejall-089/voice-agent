import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { PointerTarget } from "../../core/types.ts";

// The on-screen marker (M15). A transparent, click-through, always-on-top window covering one
// display, with a highlight drawn over whatever the vision model identified.
//
// EVERY WINDOW OPTION BELOW IS LOAD-BEARING, and most of them exist to make the window as close
// to not-being-there as a window can be:
//
//   setIgnoreMouseEvents(true, { forward: true })
//       The premise of the milestone. The user clicks the thing we point at, so the marker must
//       not be able to receive that click. Without this the overlay eats it and the app appears
//       to be broken in the most confusing possible way.
//   focusable: false + showInactive()
//       Pointing at a control in another app must not steal focus from that app — a text field
//       the user was typing in has to still be the one receiving keystrokes.
//   setContentProtection(true)
//       So a SECOND question never photographs the answer to the first. Recon (Q3) measured
//       this excluding our own windows from our own desktopCapturer call, immediately and
//       completely; it is the same mechanism that lets the command bar stay on screen during a
//       capture.
//   alwaysOnTop at the "screen-saver" level
//       Plain alwaysOnTop loses to other topmost windows, and the thing being pointed at is very
//       often one of those.
//
// It also disappears on its own. A marker is an answer to a question asked at a moment, and a
// stale one pointing at a button that has since scrolled away is worse than none — the same
// reasoning that makes SpeechSession drop utterances older than 8s rather than say them late.
const DISMISS_AFTER_MS = 10_000;

export class PointerOverlay {
  private window: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic, so no two navigations ever share a URL. See `load()`.
  private nonce = 0;

  // THE BRAND ON `ScreenRect` IS COMPILE-TIME ONLY, so it is worth recording exactly where the
  // rect does and does not cross a boundary (checked at M16.7).
  //
  // It NEVER goes through IPC. There is no ipcMain/ipcRenderer channel for a position, so
  // structured clone — which would silently strip the phantom field — is not in the path at all.
  // Every consumer of `target.rect` below is a main-process Electron call.
  //
  // It DOES reach the renderer, as URL QUERY STRINGS (see `load` below), and the overlay page
  // parses them back with Number(). That is safe for a different and stronger reason than typing:
  // what crosses is already-converted, window-relative DIP, and the page uses it for nothing but
  // CSS `left/top/width/height`. It never reconstructs a rect, never casts anything back to
  // `ScreenRect`, and has no say in which coordinates are correct. The only code that decides
  // WHAT DIP RECT TO USE is on this side of the line, and it can only have obtained one from
  // core/screen/geometry.ts's `toScreenRect`.
  async point(target: PointerTarget): Promise<void> {
    // The display the marker actually falls on, which is not necessarily the one that was
    // captured: the rect came back in screen coordinates and a multi-monitor desktop is one
    // continuous space.
    const display = screen.getDisplayMatching(target.rect);
    const win = this.ensureWindow();

    // Cover the whole display. setBounds every time rather than only at creation, so a marker on
    // the second monitor after one on the first does not quietly draw off-screen.
    win.setBounds(display.bounds);

    // Window-relative coordinates. Done HERE because this is the only side that knows which
    // display the window was placed on — the page itself is handed numbers it can use directly.
    //
    // `n` IS A NONCE, AND IT IS LOAD-BEARING (M16.11). See `load()` below for the bug it fixes:
    // without a guaranteed-unique URL, two point() calls can be a SAME-DOCUMENT navigation, the
    // page script never re-runs, and the marker keeps the position it had for the PREVIOUS
    // question.
    this.nonce += 1;
    const params = overlayParams(target, display.bounds, this.nonce);

    await this.load(win, params);
    win.showInactive();
    // Re-asserted after every show: on Windows another app going full-screen can displace a
    // topmost window, and the marker is most often pointing at exactly such an app.
    win.setAlwaysOnTop(true, "screen-saver");

    this.arm();
  }

  clear(): void {
    this.cancelTimer();
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  // Called on app shutdown, so the window does not outlive the process the way the PowerShell
  // input host and the Piper process both once did.
  dispose(): void {
    this.cancelTimer();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const win = new BrowserWindow({
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
      // Nothing in the page needs node, a preload, or any bridge at all — it reads its position
      // out of the URL. The smallest possible surface for a window that floats over everything
      // the user is doing.
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    win.setAlwaysOnTop(true, "screen-saver");
    // The click goes to the app underneath, not to us. `forward: true` keeps move events flowing
    // so hover states in that app still behave normally while the marker is up.
    win.setIgnoreMouseEvents(true, { forward: true });
    // So one marker is never in the screenshot taken for the next question.
    win.setContentProtection(true);
    // A transparent window is still a window as far as the OS is concerned; excluding it from
    // window switching keeps Alt+Tab looking the way it did before.
    win.setSkipTaskbar(true);

    this.window = win;
    return win;
  }

  // THE MARKER USED TO BE ONE CALL BEHIND, AND THIS IS WHERE (M16.11).
  //
  // The position used to travel in the URL HASH. A hash-only change is a SAME-DOCUMENT
  // navigation: Chromium does not reload the page, so overlay.html's script — which reads its
  // position once, at load — never re-ran, and the marker kept the rectangle it had been given
  // for the PREVIOUS question. Found by hand, and the observed pattern is this mechanism's
  // signature exactly:
  //
  //     ask A  -> #A   first load, full navigation      -> A   correct
  //     ask B  -> #B   hash-only change, same document  -> A   the PREVIOUS answer
  //     ask B  -> #B   identical URL, treated as reload -> B   correct
  //     ask A  -> #A   hash-only change, same document  -> B   the PREVIOUS answer
  //
  // Every new question wrong, every repeat right. Worse than a marker that is always wrong,
  // because a first answer looks authoritative and there is nothing on screen to suggest it is
  // stale.
  //
  // The comment this replaces claimed "each point() is a fresh navigation, so the window cannot
  // end up displaying a position from a previous question". That was an assumption written as a
  // fact, and it was false.
  //
  // THE FIX: the position travels in the QUERY STRING, which makes every call a different
  // document and therefore a real load — plus a nonce, so that asking the SAME question twice is
  // also a distinct URL rather than relying on Chromium's same-URL-means-reload behaviour. Two
  // independent reasons the page must re-run, because this failed silently once already.
  private load(win: BrowserWindow, params: URLSearchParams): Promise<void> {
    const search = `?${params.toString()}`;
    if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
      return win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/overlay.html${search}`);
    }
    return win.loadFile(join(__dirname, "../renderer/overlay.html"), { search });
  }

  private arm(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.clear();
    }, DISMISS_AFTER_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// Building the overlay's URL parameters, extracted so the property that was violated is
// TESTABLE WITHOUT ELECTRON (M16.11).
//
// The stale-by-one bug lived in the difference between two URLs, and there was no test that
// could see a URL. This makes the two things that matter assertable: the coordinates are
// window-relative, and NO TWO CALLS EVER PRODUCE THE SAME QUERY STRING — which is what forces
// Chromium to load the document again instead of treating it as a same-page navigation.
export function overlayParams(
  target: PointerTarget,
  displayOrigin: { x: number; y: number },
  nonce: number,
): URLSearchParams {
  return new URLSearchParams({
    x: String(target.rect.x - displayOrigin.x),
    y: String(target.rect.y - displayOrigin.y),
    w: String(target.rect.width),
    h: String(target.rect.height),
    label: target.label,
    n: String(nonce),
  });
}
