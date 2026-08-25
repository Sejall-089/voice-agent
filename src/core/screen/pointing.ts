import { ElementNotFoundError } from "../errors.ts";
import { buildCandidates } from "./elements.ts";
import {
  afterEnumerate,
  afterProbe,
  afterWait,
  decide,
  initialState,
  SETTLE_MS,
} from "./settle.ts";
import type { Candidate, ElementSurface, WindowElements } from "../types.ts";

// The settle LOOP: the thin shell of effects around core/screen/settle.ts's pure decision (M16.7).
//
// Everything that decides anything lives in settle.ts and is tested with no clock. This file only
// performs what it is told — probe, wait, enumerate — and turns the two terminal verdicts into
// the refusals the user sees. Splitting it this way is CLAUDE.md's rule about `main.ts`, applied
// one layer earlier: a loop with the decision baked into it has branches no test can reach
// without a real desktop, and those are exactly the branches that ship broken.

export interface Settled {
  window: WindowElements;
  candidates: Candidate[];
}

export interface SettleDeps {
  elements: ElementSurface;
  // Injected so tests advance time without waiting. The real one is a setTimeout.
  sleep: (ms: number) => Promise<void>;
}

export async function readSettledWindow(deps: SettleDeps): Promise<Settled> {
  let state = initialState();
  let window: WindowElements | null = null;
  let candidates: Candidate[] = [];

  // A hard ceiling on iterations, independent of the time budget. The time budget is what
  // normally stops this; the counter is what stops a decide() bug from spinning forever in the
  // user's face rather than failing.
  for (let guard = 0; guard < 32; guard += 1) {
    const step = decide(state);

    switch (step.do) {
      case "probe": {
        const probe = await deps.elements.probe();
        state = afterProbe(state, probe.count, probe.windowClass);
        break;
      }
      case "wait": {
        await deps.sleep(SETTLE_MS);
        state = afterWait(state);
        const probe = await deps.elements.probe();
        state = afterProbe(state, probe.count, probe.windowClass);
        break;
      }
      case "enumerate": {
        window = await deps.elements.enumerate();
        candidates = buildCandidates(window);
        state = afterEnumerate(state, candidates);
        break;
      }
      case "accept":
        // `window` is necessarily set: `accept` is only reachable after an `enumerate`.
        return { window: window!, candidates };
      case "refuse":
        throw refusalFor(step.refusal, window);
    }
  }

  throw new ElementNotFoundError(
    "unsettled",
    "I couldn't get a stable read of that window's controls. Try again in a second.",
  );
}

// The two terminal refusals, in the user's terms.
//
// PRESENT TENSE, DELIBERATELY, for `unreadable`. An earlier draft said the app "doesn't expose
// its controls" — a permanent claim about the application. Recon disproved that on the very app
// it was written about: Claude desktop was flat at 14 elements across 9.4 seconds and fully
// populated an hour later, same process, no restart. The honest claim is about this window right
// now, and it comes with the thing to do about it.
function refusalFor(
  refusal: "unreadable" | "unsettled",
  window: WindowElements | null,
): ElementNotFoundError {
  const named = window?.windowTitle?.trim();
  const where = named && named.length > 0 ? `"${named}"` : "that window";

  if (refusal === "unsettled") {
    return new ElementNotFoundError(
      "unsettled",
      `${capitalise(where)} is still loading — I can't read its controls reliably yet. Ask me ` +
        `again in a second.`,
    );
  }
  return new ElementNotFoundError(
    "unreadable",
    `I can't read the controls in ${where} right now — it isn't exposing them to Windows' ` +
      `accessibility layer. You may need to find it yourself.`,
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
