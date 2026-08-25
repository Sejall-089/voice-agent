import { ElementNotFoundError } from "../errors.ts";
import type { ElementSurface, WindowElements, WindowProbe } from "../types.ts";

// The default `ElementSurface` (M16) — the exact counterpart of `UnavailableScreen`,
// `UnavailableGmail`, `UnavailableNotion` and `UnavailableCalendar`.
//
// A Planner built without a way to read a window's controls gets this, so "pointing isn't turned
// on" is a missing capability that explains itself rather than a null that blows up somewhere
// deeper. In the running app `pointAt` is not even offered to the model when pointing is off
// (see registry.buildRegistry), so this is the second line of defence, not the first.
//
// It throws `ElementNotFoundError("unreadable")` rather than inventing a new error family. That
// is deliberate and it is the honest classification: from the caller's point of view "this build
// has no UIA surface" and "this window's controls could not be read" are the same fact — the
// controls are unreadable — and they want the same thing from the user, which is to click it
// themselves. The MESSAGE is what differs, because only one of them is fixed by a setting.
export class UnavailableElements implements ElementSurface {
  probe(): Promise<WindowProbe> {
    return Promise.reject(unavailable());
  }

  enumerate(): Promise<WindowElements> {
    return Promise.reject(unavailable());
  }
}

function unavailable(): ElementNotFoundError {
  return new ElementNotFoundError(
    "unreadable",
    "I can't read your windows' controls — set POINTING_ENABLED=1 in .env and restart me.",
  );
}
