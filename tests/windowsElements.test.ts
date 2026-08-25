import { describe, expect, it } from "vitest";
import { parseWindow } from "../src/main/uia/WindowsElements.ts";
import { buildCandidates } from "../src/core/screen/elements.ts";
import { ElementNotFoundError } from "../src/core/errors.ts";

// The half of the host that does not need a desktop (M16.8).
//
// M13's split, applied again: the `spawn` is live-only and deliberately thin, but turning the
// host's JSON into a `WindowElements` is ordinary branching that decides what the app BELIEVES
// about a window — so it is tested against literal payloads rather than waiting for a real
// desktop to produce a malformed one. The live half is measured by
// scripts/uia-host-bench.ts instead.

const ok = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    windowTitle: "bugs to later.txt - Notepad",
    windowClass: "Notepad",
    windowRect: { x: -11, y: -11, width: 1942, height: 1030 },
    elements: [
      {
        controlType: "MenuItem",
        name: "File",
        rect: { x: 4, y: 49, width: 62, height: 48 },
        enabled: true,
        offscreen: false,
        focusable: true,
        automationId: "",
      },
    ],
    ...over,
  });

describe("parseWindow", () => {
  it("reads a well-formed payload", () => {
    const window = parseWindow(ok());
    expect(window.windowTitle).toBe("bugs to later.txt - Notepad");
    expect(window.windowClass).toBe("Notepad");
    // The DWM-inflated window rect the real host actually reports — see the drift note below.
    expect(window.windowRect).toEqual({ x: -11, y: -11, width: 1942, height: 1030 });
    expect(window.elements[0]!.rect).toEqual({ x: 4, y: 49, width: 62, height: 48 });
  });

  it("refuses a payload that is not JSON at all", () => {
    expect(() => parseWindow("not json")).toThrowError(ElementNotFoundError);
  });

  it("refuses a payload that is not an object", () => {
    expect(() => parseWindow("42")).toThrowError(ElementNotFoundError);
    expect(() => parseWindow("null")).toThrowError(ElementNotFoundError);
  });

  it("survives a missing elements array rather than throwing", () => {
    // A window with nothing in it is a real state of the world, and the settle gate has a
    // refusal for it. A parser crash here would turn that into a malfunction.
    const window = parseWindow(JSON.stringify({ windowTitle: "x", windowClass: "y" }));
    expect(window.elements).toEqual([]);
  });

  it("fills in missing element fields rather than producing undefined", () => {
    const window = parseWindow(ok({ elements: [{}] }));
    const element = window.elements[0]!;
    expect(element.name).toBe("");
    expect(element.controlType).toBe("");
    expect(element.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // `enabled` defaults TRUE and `offscreen` defaults FALSE — the permissive direction, so a
    // control the host could not describe fully still gets filtered on its rect rather than
    // being silently dropped for a reason that was never measured.
    expect(element.enabled).toBe(true);
    expect(element.offscreen).toBe(false);
  });

  it("turns a non-finite or missing coordinate into a zero-size rect", () => {
    // The host already maps UIA's (-inf,-inf,0,0) to zeroes, since JSON cannot carry infinity.
    // This is the second line: whatever arrives, a rect is four finite numbers.
    const window = parseWindow(ok({ elements: [{ name: "X", rect: { x: null, y: "q" } }] }));
    expect(window.elements[0]!.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // And such an element is dropped by the filter, not pointed at.
    expect(buildCandidates(window)).toHaveLength(0);
  });

  it("carries a control name containing quotes and newlines intact", () => {
    // Base64 framing exists for exactly this: recon found VS Code exposing an entire source file
    // as one element's Name, quotes and line breaks included.
    const nasty = 'He said "go"\nthen left';
    const window = parseWindow(ok({ elements: [{ name: nasty, rect: { x: 1, y: 1, width: 9, height: 9 } }] }));
    expect(window.elements[0]!.name).toBe(nasty);
  });
});

// MEASURED AGAINST THE REAL HOST AT M16.8, and pinned here so the fixtures and reality cannot
// drift apart silently again.
describe("what the live host actually reports", () => {
  it("gives the DWM-inflated window rect, not the client area", () => {
    // The fixtures use a DERIVED 0,0 1920x1008 (reasoned from the measured taskbar position).
    // The real host reports -11,-11 1942x1030 — the drop-shadow rectangle. Verified at M16.8
    // that this changes no candidate on Notepad (26 both ways) or Explorer, because
    // WINDOW_EDGE_SLACK already absorbs the overhang and the area check has ample headroom.
    const window = parseWindow(ok());
    expect(buildCandidates(window)).toHaveLength(1);
    expect(buildCandidates(window)[0]!.name).toBe("File");
  });

  it("still places Notepad's File menu at the fixture's exact rect", () => {
    // Re-verified live against Notepad at M16.8: rect 4,49 62x48, candidate #15, "top left" —
    // identical to what the M15-derived fixture says.
    const candidate = buildCandidates(parseWindow(ok()))[0]!;
    expect(candidate.rect).toEqual({ x: 4, y: 49, width: 62, height: 48 });
    expect(candidate.position).toBe("top left");
  });
});
