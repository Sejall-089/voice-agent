import { isChromeOnly } from "./elements.ts";
import type { Candidate } from "../types.ts";

// Telling "the tree is still populating" apart from "the tree is stable and there is nothing
// here" (M16).
//
// THE FAILURE THIS EXISTS TO PREVENT. Recon measured VS Code returning 13 elements on the first
// UIA touch and 613 a second later. Read it during that window and you get a small, real-looking,
// entirely un-fabricated list — and matching the user's words against it produces a confident
// answer over 2% of the window's controls. That is M15's failure class exactly, relocated out of
// vision's coordinate space and into enumeration timing, and it would be harder to spot because
// nothing about the answer looks wrong.
//
// AN EARLIER DESIGN GOT THIS WRONG IN A WAY WORTH RECORDING. It triggered a retry on MAGNITUDE —
// "if the list is short, wait and try again" — and then kept the largest result. Magnitude is a
// proxy for the thing that matters and it fails in both directions: a window mid-load returning
// 25 candidates skips the retry entirely, and "keep the largest" means a tree still in motion
// when the budget expires produces an answer instead of a refusal. The signal has to be
// STABILITY, and stability has to be measured rather than inferred from size.
//
// PURE, AND DRIVEN FROM OUTSIDE. This module decides; it never sleeps, never probes and never
// enumerates. The caller runs the loop and performs the effects. That split is deliberate: this
// is the branch most likely to be got wrong and the one with no live symptom when it is, so it
// has to be testable with no clock, no PowerShell and no desktop.

// How long one settle delay is, and how long the whole check may take.
//
// TWO-SAMPLE NUMBERS, labelled as such. VS Code's 13 -> 613 transition landed inside 1.5s;
// Claude desktop's did not land inside 9.4s (and, an hour later, had happened anyway — see
// R1a in the plan). There is no third measurement behind these, and the live test that revisits
// them is named in the plan's §10 item 4.
export const SETTLE_MS = 350;
export const SETTLE_BUDGET_MS = 1500;

// Window classes known to populate their accessibility tree lazily — TRIGGER A.
//
// Read from the window handle we already hold, so it costs nothing. An allowlist of one, and
// that is fine precisely because trigger B below does not depend on it: an unknown framework
// that populates lazily is caught by its CONTENT instead of by its class.
const LAZY_SHELL_CLASSES = new Set(["Chrome_WidgetWin_1"]);

// Below this many candidates a window is reported as `sparse` rather than `healthy`.
//
// A LABEL, NOT A GATE. It changes no decision — `sparse` and `healthy` both accept, and the
// tests assert that they do. It exists so that "six real controls in a dialog" stays
// distinguishable from "a full application window" in logs and messages, without smuggling a
// magnitude heuristic back into the branch that this whole file was written to remove.
export const SPARSE_CANDIDATES = 10;

// WHY A WINDOW LOOKED THIN. Four values, and keeping them apart is the point of this module:
// collapsing any two of them loses exactly the distinction the growing-vs-stuck investigation
// was built to preserve.
//
//   healthy      plenty of real candidates. Nothing to explain.
//   sparse       few candidates, but real ones — a Save/Don't Save/Cancel dialog. NOT a problem,
//                and must never be retried into the ground or refused. This is the counterweight
//                to every "the list is short, something must be wrong" instinct.
//   lazy-shell   TRIGGER A. The window class says this shell populates lazily, so a single read
//                is not trusted yet. Says nothing about the content — Brave is `lazy-shell` on
//                its first probe and fully populated.
//   chrome-only  TRIGGER B. There is genuinely nothing here but the window frame (or nothing at
//                all). Claude desktop as first measured: Minimize, Restore, Close, and no
//                content, across 14 probes over 9.4 seconds.
export type Thinness = "healthy" | "sparse" | "lazy-shell" | "chrome-only";

// What the caller should do next.
//
// Note which steps carry a `thinness` and which do not. `probe` and `enumerate` deliberately do
// not: at those points the classification is not known yet, and stamping a provisional one on
// them would be inventing knowledge. `wait` carries the TRIGGER that caused it, which is the
// field that makes the two-point timing observable from outside.
export type SettleStep =
  | { do: "probe" }
  | { do: "wait"; trigger: "lazy-shell" | "chrome-only" }
  | { do: "enumerate" }
  | { do: "accept"; thinness: "healthy" | "sparse" }
  | {
      do: "refuse";
      refusal: "unreadable" | "unsettled";
      thinness: "lazy-shell" | "chrome-only";
    };

export interface SettleState {
  // Known from the first probe onwards.
  windowClass: string;
  // Every count observed, in order. Two equal in a row is the settle signal.
  probeCounts: readonly number[];
  // The most recent enumerate's candidates, or null if we have not enumerated yet.
  candidates: readonly Candidate[] | null;
  // How many probes had been taken when `candidates` was produced. If more have been taken
  // since, the candidates are STALE and the tree has to be read again — otherwise a settle
  // round could confirm a count while the list being judged came from before it.
  enumeratedAfterProbes: number | null;
  // How many settle delays have been spent. Distinct from elapsedMs so that "have we given this
  // window a chance yet?" is a separate question from "are we out of time?".
  waits: number;
  elapsedMs: number;
}

export interface SettleLimits {
  budgetMs: number;
}

export const DEFAULT_LIMITS: SettleLimits = { budgetMs: SETTLE_BUDGET_MS };

export function initialState(): SettleState {
  return {
    windowClass: "",
    probeCounts: [],
    candidates: null,
    enumeratedAfterProbes: null,
    waits: 0,
    elapsedMs: 0,
  };
}

export function isLazyShell(windowClass: string): boolean {
  return LAZY_SHELL_CLASSES.has(windowClass);
}

// Two consecutive identical counts. Recon measured a count-only probe at 46-80ms and stable to
// the element across five consecutive reads, so equality here is a real signal rather than a
// coincidence of rounding.
export function isStable(counts: readonly number[]): boolean {
  if (counts.length < 2) return false;
  return counts[counts.length - 1] === counts[counts.length - 2];
}

export function classify(
  candidates: readonly Candidate[],
): "healthy" | "sparse" | "chrome-only" {
  // Checked FIRST, and on candidates rather than on a count. That ordering is the whole reason
  // trigger B can tell "14 elements, all title bar" from "14 elements, six real buttons" — a
  // magnitude test cannot, and an empty list is chrome-only too (see isChromeOnly).
  if (isChromeOnly(candidates)) return "chrome-only";
  return candidates.length < SPARSE_CANDIDATES ? "sparse" : "healthy";
}

// The decision. Given everything observed so far, what next?
export function decide(state: SettleState, limits: SettleLimits = DEFAULT_LIMITS): SettleStep {
  const { probeCounts, candidates, windowClass, elapsedMs, waits } = state;

  // Nothing observed yet. The first probe is also the WAKE TOUCH for a cold Chromium tree — it
  // is what makes the 13 -> 613 transition start at all.
  if (probeCounts.length === 0) return { do: "probe" };

  const settled = isStable(probeCounts);
  const outOfTime = elapsedMs >= limits.budgetMs;
  const fresh = candidates !== null && state.enumeratedAfterProbes === probeCounts.length;

  // --- Before we have candidates matching the latest probe ---
  if (!fresh) {
    // TRIGGER A. A shell known to populate lazily is not believed on a single read, however
    // healthy that read looks. Note this fires on CLASS ALONE, so a Chromium window that was
    // never going to move still pays one settle — a known, accepted cost (see the plan's §4).
    if (isLazyShell(windowClass) && !settled) {
      if (outOfTime) return { do: "refuse", refusal: "unsettled", thinness: "lazy-shell" };
      return { do: "wait", trigger: "lazy-shell" };
    }
    // Native windows reach here on their very first probe: one probe, one enumerate, no delay.
    return { do: "enumerate" };
  }

  const thinness = classify(candidates);

  // Real content — sparse or not. `sparse` accepts on exactly the same terms as `healthy`; the
  // label is carried only so the two stay tellable apart afterwards.
  if (thinness !== "chrome-only") return { do: "accept", thinness };

  // --- TRIGGER B: nothing here but the window frame ---
  //
  // Reached only after a real enumerate, which is what separates it in TIME from trigger A. A
  // window can arrive here having never been suspected: a non-Chromium class and a healthy raw
  // element count both look fine, and only the candidates reveal it.
  if (!settled) {
    // Still moving. "Still loading" is a different fact from "nothing to point at", and the
    // user gets the honest one.
    if (outOfTime) return { do: "refuse", refusal: "unsettled", thinness: "chrome-only" };
    return { do: "wait", trigger: "chrome-only" };
  }

  // Stable and chrome-only. Spend at least one settle round before concluding it — the count can
  // be stable simply because nothing has started yet, which is precisely what a cold tree looks
  // like in the moment before it populates.
  if (waits === 0 && !outOfTime) return { do: "wait", trigger: "chrome-only" };

  return { do: "refuse", refusal: "unreadable", thinness: "chrome-only" };
}

// Applying a step's OBSERVATION to the state. Pure, so the loop in /main stays a thin shell of
// effects around it and every transition is testable without a clock.
export function afterProbe(state: SettleState, count: number, windowClass: string): SettleState {
  return { ...state, windowClass, probeCounts: [...state.probeCounts, count] };
}

export function afterWait(state: SettleState, delayMs: number = SETTLE_MS): SettleState {
  return { ...state, waits: state.waits + 1, elapsedMs: state.elapsedMs + delayMs };
}

export function afterEnumerate(
  state: SettleState,
  candidates: readonly Candidate[],
): SettleState {
  return {
    ...state,
    candidates,
    enumeratedAfterProbes: state.probeCounts.length,
  };
}
