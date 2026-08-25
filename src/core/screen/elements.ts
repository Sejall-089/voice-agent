import { positionIn } from "./geometry.ts";
import type { Candidate, NativeRect, UiElement, WindowElements } from "../types.ts";

// Turning a window's raw UI Automation tree into the numbered list a model picks from (M16).
//
// This file is the deterministic half of the milestone and the direct counterpart of M15's
// core/vision/locate.ts — but note what changed about its JOB. `locate.ts` validated an answer
// the model had already committed to, manufacturing checkability out of properties a wrong box
// tends to violate, because pixels gave it nothing else to work with. This file does not
// validate an answer at all. It builds the only universe of answers that exist, BEFORE the model
// is asked. A control that is not in this list cannot be pointed at, and every control that is
// in it carries an exact rect that came from the OS.
//
// Every rule below was measured against real windows (scripts/uia-recon.ps1); the counts quoted
// are what those windows actually produced.

// THERE IS NO CONTROL-TYPE ALLOWLIST, and the reason is narrower than it first looked.
//
// The plan justified leaving one out by claiming an "interactive types only" rule would drop VS
// Code's activity-bar icons, which are `Group`s rather than `Button`s. CHECKED AGAINST THE
// FIXTURES, THAT CLAIM IS FALSE: every one of those icons is ALSO exposed as a `TabItem` at the
// identical rect, so an allowlist containing TabItem keeps them all.
//
// What an allowlist would really lose is container-shaped but genuinely pointable REGIONS —
// measured against the real dumps: Explorer's "Navigation Pane" and "View Modes", VS Code's
// "Agent Status" and "Tab actions" toolbars and its "Active View Switcher", Notepad's "Text
// editor" document area, Brave's "YouTube Video Player". "Point at the navigation pane" is an
// ordinary request and every one of those would simply stop working.
//
// That is a smaller argument than the one in the plan, and it is still sufficient, because the
// thing an allowlist would BUY is not needed: recon measured the permissive list at 26-97
// candidates, which already fits a prompt comfortably. There is no size problem to trade
// accuracy against. The control type is reported to the model as context and never used to
// exclude.

// The largest share of the WINDOW a single pointable control may occupy.
//
// Inherited in spirit from M15's MAX_FRAME_FRACTION, which caught a vision model hedging by
// boxing a whole window. The failure it catches here is different but the shape is the same: UIA
// windows are full of full-size containers — a `Pane` named after the window, a `Document`
// spanning the client area — and they are not places to send someone. Recon: this drops 5 rows
// from VS Code, 2 from Brave, 1 from Notepad. Deliberately generous, because a genuinely large
// target (a maximized editor area, a video player) is still a legitimate thing to point at.
export const MAX_WINDOW_FRACTION = 0.5;

// How far outside its own window a control's rect may sit before it is treated as not really
// there, in native pixels.
//
// NOT ZERO, and the reason is measured: top-level window rects come back INFLATED BY THE DWM
// DROP SHADOW — recon saw -11,-11 1942x1030 for a window whose client area is 1920x1008 — and
// individual controls routinely report a pixel or two past the client edge (Notepad's Document
// is 1924px wide inside a 1920px window). 24px absorbs both without coming close to admitting a
// control that belongs to a different window.
export const WINDOW_EDGE_SLACK = 24;

// The longest control name that reaches the model, in characters.
//
// A MEASURED HAZARD, not a tidiness rule. VS Code exposes an entire open FILE as one element's
// `Name` — the longest row in the recon dump was 10,973 characters of TypeScript. Most such rows
// are offscreen and dropped, but nothing guarantees that, and a handful of them would blow the
// choose prompt past any sensible size with document text that is not a control name at all.
//
// TRUNCATED RATHER THAN DROPPED. The rect is still exact and the element may still be a real
// target, so removing it would lose a pointable control to defend against a formatting problem.
// 100 characters is far longer than any real button, menu item or tab label measured (the
// longest legitimate one in the dumps was 46), and short enough that the whole list stays small.
export const MAX_NAME_CHARS = 100;

// Window chrome — the controls every window has and nobody means when they ask where something
// is. Matched by name, because the control TYPE is `Button` for all of them, exactly like the
// buttons that do matter.
//
// This set is not a filter. Chrome stays in the candidate list, because "point at the close
// button" is a perfectly reasonable request. It exists for `isChromeOnly` below.
const WINDOW_CHROME = new Set([
  "minimize",
  "maximize",
  "restore",
  "close",
  "system menu",
  "application",
]);

export function buildCandidates(window: WindowElements): Candidate[] {
  const kept = window.elements.filter((element) => isPointable(element, window.windowRect));
  const deduped = kept.filter((element, index) => !isRedundant(element, index, kept));

  // Numbered in UIA'S OWN ORDER, not sorted into reading order.
  //
  // That order is the application's own structure, so related controls stay adjacent — every tab
  // together, every toolbar button together — which reads far better in a prompt than a
  // spatial sort that would interleave a toolbar with the tab strip whenever they share a row.
  // It is also stable for a given tree, which is what the tests need.
  return deduped.map((element, index) => ({
    number: index + 1,
    name: truncateName(element.name.trim()),
    controlType: element.controlType,
    position: positionIn(element.rect, window.windowRect),
    rect: element.rect,
  }));
}

// Is there anything here except the window frame?
//
// TRIGGER B of the settle check (core/screen/settle.ts), and the test behind §5's bare-tree
// refusal. It is deliberately evaluated on CANDIDATES rather than on a raw count, because that
// is the only way to tell "this window has 14 elements and they are all its title bar" from
// "this window has 14 elements and they are its six real buttons".
//
// Recon measured exactly this: Claude desktop returned 14 elements that were Minimize, Restore,
// Close and a full-window Pane, while a dialog with six real controls looks identical to any
// count-based test. A magnitude threshold cannot separate them; this can.
//
// AN EMPTY LIST IS TRUE, and that is intended rather than an accident of `every`. A window whose
// controls all failed the filter — a minimized one, most commonly — is in the same position as
// one that only exposes its title bar: there is nothing here to point at, and the caller should
// refuse for the same reason. Stated here because vacuous truth is a thin thing to rest a
// user-visible branch on, and it is asserted in the tests so it cannot change silently.
export function isChromeOnly(candidates: Candidate[]): boolean {
  return candidates.every((candidate) => WINDOW_CHROME.has(candidate.name.toLowerCase()));
}

// Everything a candidate has to be. Order matters only for readability — all of these are cheap.
function isPointable(element: UiElement, windowRect: NativeRect): boolean {
  // A control with no name cannot be asked for by name. Recon: drops 15 of Notepad's 73 rows,
  // 187 of VS Code's 613.
  if (element.name.trim().length === 0) return false;

  // UIA reports (-inf, -inf, 0, 0) for elements with no screen presence at all.
  const { x, y, width, height } = element.rect;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;

  // A greyed-out control is not a place to send someone.
  if (!element.enabled) return false;

  // Scrolled out of view. Necessary and NOT SUFFICIENT — see the window check below.
  if (element.offscreen) return false;

  // THE CHECK `IsOffscreen` DOES NOT DO. Recon measured a MINIMIZED Notepad reporting
  // `IsOffscreen = false` on all 39 of its named elements, with rects around (-31991, -31890).
  // Without this, every one of them would be a candidate, and pointing at one would put a marker
  // 32,000 pixels off the left of the screen with complete confidence.
  if (!intersects(element.rect, windowRect, WINDOW_EDGE_SLACK)) return false;

  // A full-window container is not a target.
  if (width * height >= windowRect.width * windowRect.height * MAX_WINDOW_FRACTION) return false;

  return true;
}

// THE DEDUP RULE, and the one that earns its keep on real data. It collapses TWO different
// duplications, and the second was found by the fixtures rather than by reasoning.
//
// (1) NESTED LABEL. UIA emits a control's label as a child of the control itself: Notepad's
//     "Advice.txt" tab is a 120x48 `TabItem` (the actual hit area) containing a 79x23 `Text`
//     reading "Advice.txt". Both are named, enabled, on-screen and sensibly sized, so every
//     rule above keeps both — and the list would then offer the model two answers for one
//     thing, one of which is a label rather than the area a person clicks. Keep the LARGER: it
//     is the hit area, and the label is inside it by construction.
//
// (2) IDENTICAL TWIN. The same control exposed more than once at the SAME rect under different
//     control types. Every icon in VS Code's activity bar is both a `TabItem` and a `Group` at
//     exactly 9,57 54x54; "Source Control" appears three times. An earlier version of this
//     function required the survivor to be strictly LARGER, so it collapsed none of these — 13
//     redundant rows across 12 groups, each one an extra identical choice for the model to flip
//     a coin over. Equal-area duplicates now collapse to the FIRST in tree order, which is
//     deterministic and, in this data, also the more meaningful type.
//
// The name test is what stops all of this from being over-eager. Containment alone would
// collapse a toolbar into its first button. Requiring that one name contain the other means it
// only fires where the two elements are describing the SAME thing.
function isRedundant(element: UiElement, index: number, all: UiElement[]): boolean {
  const area = element.rect.width * element.rect.height;
  const name = element.name.trim().toLowerCase();

  return all.some((other, otherIndex) => {
    if (otherIndex === index) return false;

    const otherArea = other.rect.width * other.rect.height;
    // Strictly larger wins outright; an exact tie is broken by tree order so that exactly one of
    // a pair survives and the choice never depends on iteration direction.
    const survives = otherArea > area || (otherArea === area && otherIndex < index);
    if (!survives) return false;

    if (!contains(other.rect, element.rect)) return false;
    const otherName = other.name.trim().toLowerCase();
    return otherName.includes(name) || name.includes(otherName);
  });
}

function contains(outer: NativeRect, inner: NativeRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

// Do these rects overlap at all, once `slack` is added around the window?
function intersects(rect: NativeRect, window: NativeRect, slack: number): boolean {
  return (
    rect.x < window.x + window.width + slack &&
    rect.x + rect.width > window.x - slack &&
    rect.y < window.y + window.height + slack &&
    rect.y + rect.height > window.y - slack
  );
}

// Cut at a word boundary where there is one nearby, so a truncated label still reads as words
// rather than as a sliced token. The ellipsis is a plain "..." — M14 measured the speech engine
// mangling non-ASCII, and every string in this app that might be spoken stays ASCII.
function truncateName(name: string): string {
  if (name.length <= MAX_NAME_CHARS) return name;
  const cut = name.slice(0, MAX_NAME_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_NAME_CHARS - 20 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}...`;
}
