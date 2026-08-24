import { visionError } from "../errors.ts";
import type { LocateResult, VisionLocator } from "../types.ts";

// The default `VisionLocator` (M15) — same role as `UnavailableScreen` beside it, for the other
// half of the capability.
//
// The two are separate because they fail for different reasons and have different fixes: the
// screen can be un-capturable while the model is perfectly reachable, and vice versa. Keeping
// one class per surface means the message the user gets names the thing that is actually wrong.
export class UnavailableVisionLocator implements VisionLocator {
  locate(): Promise<LocateResult> {
    return Promise.reject(visionError("not-enabled"));
  }
}
