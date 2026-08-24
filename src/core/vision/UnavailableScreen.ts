import { screenCaptureError } from "../errors.ts";
import type { ScreenSurface, Screenshot } from "../types.ts";

// The default `ScreenSurface` (M15) — the exact counterpart of `UnavailableSender`,
// `UnavailableGmail`, `UnavailableNotion` and `UnavailableCalendar`.
//
// A Planner built without a screen gets this, so "vision isn't turned on" is a missing
// capability that explains itself rather than a null that blows up somewhere deeper. In the
// running app `pointAt` is not even offered to the model when vision is off (see
// registry.buildRegistry), so this is the second line of defence, not the first.
//
// `clearPointer` is the one method that succeeds here rather than throwing, and that is not an
// inconsistency: it is idempotent cleanup, called from the hotkey and Escape paths that run
// whether or not anything was ever pointed at. Making "take the marker away" fail on an install
// that has no marker would turn a no-op into an error report.
export class UnavailableScreen implements ScreenSurface {
  capture(): Promise<Screenshot> {
    return Promise.reject(screenCaptureError("unavailable"));
  }
  point(): Promise<void> {
    return Promise.reject(screenCaptureError("unavailable"));
  }
  clearPointer(): void {
    // Nothing is showing, because nothing can be.
  }
}
