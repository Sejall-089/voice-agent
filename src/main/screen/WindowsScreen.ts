import { desktopCapturer, screen } from "electron";
import { screenCaptureError } from "../../core/errors.ts";
import { PointerOverlay } from "./PointerOverlay.ts";
import type {
  DisplayBounds,
  PointerTarget,
  ScreenSurface,
  Screenshot,
} from "../../core/types.ts";
import type { NativeImage } from "electron";

// The Windows implementation of `ScreenSurface` (M15): take one picture, draw one marker.
//
// Every number here was measured by scripts/screen-recon.mjs rather than assumed, because the
// failure mode of getting this wrong is silent. A frame captured at the wrong size, or paired
// with the wrong display's bounds, does not throw — it produces a marker that lands confidently
// somewhere the user was not asking about.

// The long edge the model actually sees.
//
// Downscaling is not an optimisation, it is what makes the coordinate space OURS. Anthropic
// resizes images past roughly this size on its own, and a resize we did not perform is a scale
// factor we do not know — every coordinate that came back would be in a pixel space we could
// only guess at. Recon measured the resize at 14ms with the aspect ratio preserved exactly, so
// controlling it costs nothing.
const MAX_LONG_EDGE = 1568;

export class WindowsScreen implements ScreenSurface {
  private readonly overlay = new PointerOverlay();

  async capture(): Promise<Screenshot> {
    // The display the user is looking at. The cursor is the best available proxy — electron
    // cannot tell us which window another application has focused, and the alternative (always
    // the primary) is wrong every time someone works on their second monitor.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    // Ask at the display's true pixel size, then downscale ourselves. Recon confirmed
    // thumbnailSize is honoured exactly in both directions, so this is the one request that
    // cannot come back subtly rescaled by someone else's filter.
    const thumbnailSize = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };

    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize,
        fetchWindowIcons: false,
      });
    } catch (error) {
      throw screenCaptureError("failed", messageOf(error));
    }

    const source = pickSource(sources, display);
    // M11's rule, in a new place: an operation reporting success is not proof it did anything.
    // A locked session or a secure desktop is exactly the case that returns a source and an
    // empty picture.
    if (source.thumbnail.isEmpty()) throw screenCaptureError("no-display");

    const image = downscale(source.thumbnail);
    const size = image.getSize();
    const png = image.toPNG();
    if (png.length === 0 || size.width === 0 || size.height === 0) {
      throw screenCaptureError("failed", "the capture produced no image data");
    }

    return {
      png: new Uint8Array(png),
      // The ACTUAL dimensions of the image we are about to send, read back off the image rather
      // than assumed from what we asked for. This pair is one half of the coordinate mapping
      // (core/vision/geometry.ts); a number that disagreed with the bytes would put the marker
      // in the wrong place with no symptom.
      width: size.width,
      height: size.height,
      display: toBounds(display),
    };
  }

  point(target: PointerTarget): Promise<void> {
    return this.overlay.point(target);
  }

  clearPointer(): void {
    this.overlay.clear();
  }

  dispose(): void {
    this.overlay.dispose();
  }
}

// Which captured source is the display we chose?
//
// DEFAULT-DENY, like everything else in this milestone. A source paired with the wrong display's
// bounds yields a mapping that is wrong by exactly the difference between two monitors, and it
// fails silently — the marker simply appears on the other screen. So a join we cannot make
// confidently is a refusal, not a "close enough" fallback to the first source.
function pickSource(
  sources: Electron.DesktopCapturerSource[],
  display: Electron.Display,
): Electron.DesktopCapturerSource {
  if (sources.length === 0) throw screenCaptureError("no-display");

  // Recon (Q1) confirmed `display_id` carries the same identifier as `Display.id`, as a string.
  const matched = sources.find((s) => String(s.display_id) === String(display.id));
  if (matched) return matched;

  // No join available, but no ambiguity either: one screen, one source, and they can only be
  // each other.
  if (sources.length === 1 && screen.getAllDisplays().length === 1) return sources[0]!;

  throw screenCaptureError(
    "failed",
    "I couldn't work out which captured screen is the one you're looking at",
  );
}

function downscale(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  const longEdge = Math.max(width, height);
  // Never upscale. A small display is already in a pixel space the model can work in, and
  // enlarging it would invent detail while making the request bigger.
  if (longEdge <= MAX_LONG_EDGE) return image;
  return width >= height
    ? image.resize({ width: MAX_LONG_EDGE, quality: "best" })
    : image.resize({ height: MAX_LONG_EDGE, quality: "best" });
}

// Note what is dropped: `scaleFactor`. It is genuinely needed above, to ask for the right
// capture size — and genuinely misleading afterwards, because the downscale invalidates it. See
// core/types.ts's DisplayBounds for why the field does not exist on the other side of this line.
function toBounds(display: Electron.Display): DisplayBounds {
  return {
    id: display.id,
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
