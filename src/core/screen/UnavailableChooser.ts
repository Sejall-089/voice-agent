import { ElementNotFoundError } from "../errors.ts";
import type { ChoiceResult, ElementChooser } from "../types.ts";

// The default `ElementChooser` (M16) — the other half of the capability, beside
// `UnavailableElements`.
//
// Two classes rather than one, for the reason `UnavailableScreen` and M15's now-deleted
// `UnavailableVisionLocator`
// were split in M15: reading a window and asking a model about it fail for different reasons and
// have different fixes. The controls can be perfectly readable while the model is unreachable,
// and vice versa. One class per surface means the message names the thing that is actually
// wrong instead of guessing.
export class UnavailableChooser implements ElementChooser {
  choose(): Promise<ChoiceResult> {
    return Promise.reject(
      new ElementNotFoundError(
        "unreadable",
        "I can read your windows' controls but I have no model to ask about them — check the " +
          "LLM settings in .env and restart me.",
      ),
    );
  }
}
