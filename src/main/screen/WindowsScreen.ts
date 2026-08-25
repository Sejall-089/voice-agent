import { screen } from "electron";
import { PointerOverlay } from "./PointerOverlay.ts";
import type {
  DisplayBounds,
  NativeRect,
  PointerTarget,
  ScreenSurface,
} from "../../core/types.ts";

// The Windows implementation of `ScreenSurface`: draw one marker, and say which display a
// rectangle falls on.
//
// IT NO LONGER TAKES PICTURES (M16.10). Through M15 this class also owned screen capture —
// `desktopCapturer`, a downscale, and a frame-size policy chosen to match whichever vision
// provider was configured. All of it existed for one caller, the vision grounding M16 replaced,
// and all of it went with that caller. What is left is the half the new pipeline actually uses.
//
// `setContentProtection` stays, on the overlay window (see PointerOverlay). It was introduced to
// keep the app's own windows out of its own screenshots, but that was never the only reason for
// it: it also keeps a marker out of screenshots ANY other application takes, which is a property
// worth having on an always-on-top window that floats over the user's work.

export class WindowsScreen implements ScreenSurface {
  private readonly overlay = new PointerOverlay();

  point(target: PointerTarget): Promise<void> {
    return this.overlay.point(target);
  }

  clearPointer(): void {
    this.overlay.clear();
  }

  // Which display does a NATIVE-pixel rectangle fall on? (M16)
  //
  // Asked in native pixels because that is the only space the caller has: UIA reports a window's
  // bounds in physical pixels, and electron's own `getDisplayMatching` wants DIP — which is the
  // very thing we are trying to work out. So the search is done in physical space instead, by
  // converting each display's DIP bounds to physical via the OS and testing containment there.
  //
  // Falls back to the display nearest the cursor rather than to the primary. A window that
  // straddles two monitors, or sits fractionally outside every reported bound, still has to
  // produce SOME mapping — and "where the user is working" is a better guess than "monitor one".
  displayForNative(rect: NativeRect): Promise<DisplayBounds> {
    const displays = screen.getAllDisplays().map(toBounds);

    const containing = displays.find(
      (d) =>
        rect.x >= d.nativeX &&
        rect.y >= d.nativeY &&
        rect.x < d.nativeX + d.nativeWidth &&
        rect.y < d.nativeY + d.nativeHeight,
    );
    if (containing) return Promise.resolve(containing);

    const nearest = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return Promise.resolve(toBounds(nearest));
  }

  dispose(): void {
    this.overlay.dispose();
  }
}

// THE PHYSICAL RECTANGLE COMES FROM THE OS, NOT FROM MULTIPLICATION (M16.6).
//
// `bounds.x * scaleFactor` is the obvious way to write this and it is the trap. On this machine
// there is one display at DIP (0,0) and `0 * 1.5 === 0`, so the wrong formula agrees with the
// right one on every measurement that can be taken here — and disagrees on a second monitor,
// where each display has its own scale factor and the physical origin of the one on the right is
// not its DIP origin times its own scale. That is M15's `x / scaleFactor` wearing new clothes:
// correct where it was written, silently wrong elsewhere, and it fails by placing a confident
// marker on the wrong screen rather than by throwing.
//
// `dipToScreenPoint` asks Windows, which knows. Recon confirmed it round-trips exactly on this
// display: DIP (100,100) -> physical (150,150) -> DIP (100,100).
function toBounds(display: Electron.Display): DisplayBounds {
  const { bounds } = display;
  const origin = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
  const far = screen.dipToScreenPoint({
    x: bounds.x + bounds.width,
    y: bounds.y + bounds.height,
  });

  return {
    id: display.id,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    nativeX: origin.x,
    nativeY: origin.y,
    // Derived from the two corners rather than from the size times the scale, so the physical
    // rectangle is internally consistent with the origin above even if Windows rounds.
    nativeWidth: far.x - origin.x,
    nativeHeight: far.y - origin.y,
  };
}

