import type {
  DisplayBounds,
  NativeRect,
  PointerTarget,
  ScreenSurface,
} from "../src/core/types.ts";

// Headless stand-in for the screen — the counterpart of MockShell, FakeCalendar and FakeNotion.
// Draws nothing and imports no electron, so the whole pointing flow runs under vitest with no
// desktop.
//
// TRIMMED AT M16.10, along with `capture()` itself. Through M15 this fake also served a
// screenshot; the vision grounding that consumed it is gone, and so is the frame. What remains
// is the assertion surface a pointing test actually wants.

// This machine as scripts/screen-recon.mjs measured it: 1280x720 DIP on a 1920x1080 panel,
// scaleFactor 1.5. Deliberately the SCALED display — a 1:1 fake would make the native→DIP
// conversion look like the identity function, which is the bug it is most likely to have.
export const RECON_DISPLAY: DisplayBounds = {
  id: 3136901802,
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
  nativeX: 0,
  nativeY: 0,
  nativeWidth: 1920,
  nativeHeight: 1080,
};

export interface FakeScreenOptions {
  display?: DisplayBounds;
  // When set, point() rejects with this — an overlay that could not be shown.
  failPoint?: Error;
}

export class FakeScreen implements ScreenSurface {
  // Everything the app asked to have pointed at, in order. The assertion surface a pointing test
  // actually wants: on any refusal this must stay EMPTY, because the whole safety property is
  // that an answer we do not trust never becomes a marker.
  public readonly pointed: PointerTarget[] = [];
  public readonly displayLookups: NativeRect[] = [];
  public clears = 0;

  private readonly display: DisplayBounds;
  private readonly failPoint: Error | undefined;

  constructor(options: FakeScreenOptions = {}) {
    this.display = options.display ?? RECON_DISPLAY;
    this.failPoint = options.failPoint;
  }

  point(target: PointerTarget): Promise<void> {
    if (this.failPoint) return Promise.reject(this.failPoint);
    this.pointed.push(target);
    return Promise.resolve();
  }

  clearPointer(): void {
    this.clears += 1;
  }

  displayForNative(rect: NativeRect): Promise<DisplayBounds> {
    this.displayLookups.push(rect);
    return Promise.resolve(this.display);
  }
}
