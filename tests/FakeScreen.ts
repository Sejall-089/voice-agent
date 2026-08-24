import type {
  PointerTarget,
  ScreenSurface,
  Screenshot,
} from "../src/core/types.ts";

// Headless stand-in for the screen (M15) — the counterpart of MockShell, FakeCalendar and
// FakeNotion. Captures nothing, draws nothing, and imports no electron, so the whole pointing
// flow runs under vitest with no desktop.
//
// The frame it hands back is the one scripts/screen-recon.mjs actually measured on this machine:
// a 1568x882 downscale of a 1280x720 DIP display (scaleFactor 1.5, captured at 1920x1080). Using
// the real numbers rather than a tidy 1000x1000 is deliberate — a fake whose display is already
// in image coordinates would make the DPI mapping look like the identity function, which is
// precisely the bug this milestone is most likely to have.
export const RECON_SHOT: Screenshot = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // a PNG signature and nothing more
  width: 1568,
  height: 882,
  display: { id: 3136901802, x: 0, y: 0, width: 1280, height: 720 },
};

export interface FakeScreenOptions {
  shot?: Screenshot;
  // When set, capture() rejects with this instead of returning a frame.
  failCapture?: Error;
  // When set, point() rejects with this — an overlay that could not be shown.
  failPoint?: Error;
}

export class FakeScreen implements ScreenSurface {
  // Everything the app asked to have pointed at, in order. The assertion surface a pointing
  // test actually wants: on any refusal this must stay EMPTY, because the whole safety property
  // is that an answer we do not trust never becomes a marker.
  public readonly pointed: PointerTarget[] = [];
  public captures = 0;
  public clears = 0;

  private readonly shot: Screenshot;
  private readonly failCapture: Error | undefined;
  private readonly failPoint: Error | undefined;

  constructor(options: FakeScreenOptions = {}) {
    this.shot = options.shot ?? RECON_SHOT;
    this.failCapture = options.failCapture;
    this.failPoint = options.failPoint;
  }

  capture(): Promise<Screenshot> {
    this.captures += 1;
    if (this.failCapture) return Promise.reject(this.failCapture);
    return Promise.resolve(this.shot);
  }

  point(target: PointerTarget): Promise<void> {
    if (this.failPoint) return Promise.reject(this.failPoint);
    this.pointed.push(target);
    return Promise.resolve();
  }

  clearPointer(): void {
    this.clears += 1;
  }
}
