import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ElementSurface,
  TargetCheck,
  NativeRect,
  UiElement,
  WindowElements,
  WindowProbe,
} from "../src/core/types.ts";

// Deterministic stand-in for UI Automation (M16) — no PowerShell, no windows, no desktop.
//
// THE THING THIS MILESTONE BOUGHT BACK. M15's grounding could only be tested against a fake
// vision model, which meant the interesting failures (a box on the wrong control) were exactly
// the ones no fixture could reproduce. A UIA tree is just data, so every one of them is a
// literal here, and the three controls M15 got WRONG on a live desktop are asserted at their
// exact rects before any PowerShell exists.
//
// TRANSCRIBED, NOT AUTHORED. The rows in tests/fixtures/uia/*.json are the bytes the recon
// probes actually produced (scripts/uia-recon.ps1, and M15's grab.ps1 before it), reshaped into
// `UiElement` field names by a generator and otherwise untouched. CLAUDE.md's rule is that a
// fake written in terms of the code under test only proves the code agrees with itself; these
// were captured before core/screen/elements.ts existed.
//
// TWO HONEST CAVEATS, because a fixture that hides its own provenance is worse than no fixture:
//
//   1. M15's grab.ps1 recorded only type/name/rect. It did NOT record enabled/offscreen/
//      focusable/automationId, so in `notepad-m15.json` and `explorer-m15.json` those four are
//      defaulted (enabled: true, offscreen: false, focusable: false, automationId: ""). Those
//      two fixtures are used for the REGRESSION TARGETS, which are assertions about which
//      candidate survives dedup and at what rect — a question those four fields do not affect.
//      Every test that actually exercises enabled/offscreen uses a full-field fixture instead.
//   2. Names longer than 120 characters were truncated at fixture-generation time. No ROW was
//      dropped. This is because VS Code exposes an entire open file as one element's Name (the
//      longest real row was 10,973 characters) and the raw dump was 259KB of mostly that. The
//      rule that exists because of this — MAX_NAME_CHARS — is tested against an explicitly
//      synthetic long name below, never against a pre-truncated fixture.

const here = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/uia/${name}`, import.meta.url));

const rows = (name: string): UiElement[] =>
  JSON.parse(readFileSync(here(name), "utf8")) as UiElement[];

// A maximized window on the machine every one of these was captured on: 1920x1080 native, with
// the taskbar measured at y=1008 (recon saw Shell_TrayWnd at 0,1008 1920x72). DERIVED from that
// measurement rather than recorded by the probe, which did not dump window bounds — flagged
// because it is the one number here that was reasoned to rather than read off.
const MAXIMIZED: NativeRect = { x: 0, y: 0, width: 1920, height: 1008 };

function window(
  windowTitle: string,
  windowClass: string,
  elements: UiElement[],
  windowRect: NativeRect = MAXIMIZED,
): WindowElements {
  return { windowTitle, windowClass, windowRect, elements };
}

// --- The fixtures ---

export const TREES: Record<string, WindowElements> = {
  // M15's own ground truth, captured the night the vision approach was measured to failure.
  // Carries all three regression targets: the File menu, the Advice.txt tab, the New button.
  notepad: window("Advice.txt - Notepad", "Notepad", rows("notepad-m15.json")),
  explorer: window("Documents - File Explorer", "CabinetWClass", rows("explorer-m15.json")),

  // A real Electron window with a FULLY POPULATED tree — 613 raw rows. Its activity-bar icons
  // are `Group`, not `Button`, which is why elements.ts has no control-type allowlist: one would
  // have silently dropped the icons a user is most likely to point at.
  vscode: window(
    "M16: UIA-grounded pointAt - voice-agent - Visual Studio Code",
    "Chrome_WidgetWin_1",
    rows("vscode.json"),
  ),

  // THE BARE TREE. Claude desktop as first measured: 14 rows, all of them the native window
  // frame, flat across 14 probes over 9.4 seconds.
  claudeBare: window("Claude", "Chrome_WidgetWin_1", rows("claude-bare.json")),

  // THE SAME APP, AWAKE. Re-probed an hour later, same PID, no restart: 260 rows of real web
  // content. This fixture exists to stop the code — and anyone reading it — from encoding
  // "Claude desktop is unsupported". The refusal is about a window's state right now, never
  // about an application.
  claudeWoke: window("Claude", "Chrome_WidgetWin_1", rows("claude-woke.json")),

  // A MINIMIZED window. Every element reports `IsOffscreen = false` while sitting at roughly
  // (-31991, -31890) — the trap `IsOffscreen` alone walks straight into.
  notepadMinimized: window(
    "bugs to later.txt - Notepad",
    "Notepad",
    rows("notepad-minimized.json"),
  ),

  // --- Synthetic, and labelled as such ---

  // THE TRIGGER-A / TRIGGER-B SPLIT, which no real capture in the set covers.
  //
  // The two triggers fire at different MOMENTS: A off the cheap probe (window class says
  // Chromium), B off the first real enumerate (the candidates turn out to be chrome only). A
  // fixture that fires both proves nothing about the ordering, because either one alone would
  // produce the same outcome. This one fires ONLY B:
  //
  //   * windowClass is `SunAwtFrame` — a Java/Swing shell, not Chromium. Trigger A stays silent.
  //   * 31 raw elements, so a count-based check stays silent too. This is the case the old
  //     magnitude heuristic missed outright: 31 is comfortably above any "looks bare" threshold.
  //   * ...but 28 of them are unnamed containers, and the 3 that survive the filter are
  //     Minimize, Restore and Close.
  //
  // So the ONLY thing that catches it is evaluating `isChromeOnly` on real candidates, after an
  // enumerate. Synthetic because no lazily-populating non-Chromium app was available to capture;
  // the SHAPE is transcribed from claude-bare.json, which is the same failure in a Chromium
  // window.
  lazyNativeChromeOnly: window("Ledger", "SunAwtFrame", [
    ...Array.from({ length: 28 }, (_, i) => ({
      controlType: "Pane",
      name: "",
      rect: { x: 0, y: 0, width: 800, height: 600 },
      enabled: true,
      offscreen: false,
      focusable: false,
      automationId: `pane-${i}`,
    })),
    chrome("Minimize", 1715),
    chrome("Restore", 1782),
    chrome("Close", 1851),
  ]),

  // One legitimately small window: six real controls and nothing else. The counterweight to
  // every "the list is short, something must be wrong" instinct — this one is short and correct,
  // and must be answered from, never refused or retried into the ground.
  smallDialog: window(
    "Save changes?",
    "#32770",
    [
      control("Save", "Button", { x: 700, y: 520, width: 120, height: 40 }),
      control("Don't Save", "Button", { x: 830, y: 520, width: 120, height: 40 }),
      control("Cancel", "Button", { x: 960, y: 520, width: 120, height: 40 }),
      control("File name:", "Text", { x: 620, y: 440, width: 90, height: 24 }),
      control("File name", "Edit", { x: 720, y: 436, width: 360, height: 32 }),
      chrome("Close", 1050, 400),
    ],
    { x: 600, y: 400, width: 500, height: 200 },
  ),
};

// The 10,973-character finding, as a rule rather than as a wall of TypeScript. The LENGTH is the
// real datum; the specific source file it happened to be is not, so it is not reproduced here.
export const GIANT_NAME = "x".repeat(10_973);

export const TREE_WITH_GIANT_NAME: WindowElements = window("Editor", "Chrome_WidgetWin_1", [
  control("Save", "Button", { x: 10, y: 10, width: 80, height: 30 }),
  control(GIANT_NAME, "Text", { x: 10, y: 60, width: 600, height: 300 }),
]);

function control(name: string, controlType: string, rect: NativeRect): UiElement {
  return {
    controlType,
    name,
    rect,
    enabled: true,
    offscreen: false,
    focusable: true,
    automationId: "",
  };
}

// Window-frame buttons at the sizes recon measured them (68-69 x 51-60, top right).
function chrome(name: string, x: number, y = 0): UiElement {
  return control(name, "Button", { x, y, width: 68, height: 51 });
}

// --- The surface ---

export interface FakeElementsOptions {
  // Successive answers from enumerate(), so a test can replay a tree that GROWS — the cold
  // Chromium case. The last one repeats once exhausted.
  trees: WindowElements[];
  // Successive probe() counts. Defaults to each tree's own element count, which is the honest
  // relationship between the two calls on a real window.
  probeCounts?: number[];
  failEnumerate?: Error;
  failProbe?: Error;
  // M16.9. Set to make verifyTarget report the user has switched away, or that the window moved.
  switchedAway?: boolean;
  movedTo?: NativeRect;
}

export class FakeElements implements ElementSurface {
  // Call counts, so a test can prove the NATIVE path pays no settle cost — one probe, one
  // enumerate, and crucially zero sleeping.
  public probes = 0;
  public enumerations = 0;

  private readonly trees: WindowElements[];
  private readonly probeCounts: number[] | undefined;
  private readonly failEnumerate: Error | undefined;
  private readonly failProbe: Error | undefined;
  private readonly switchedAway: boolean;
  private readonly movedTo: NativeRect | undefined;
  public verifications = 0;

  constructor(options: FakeElementsOptions | WindowElements) {
    const opts: FakeElementsOptions =
      "trees" in options ? options : { trees: [options] };
    this.trees = opts.trees;
    this.probeCounts = opts.probeCounts;
    this.failEnumerate = opts.failEnumerate;
    this.failProbe = opts.failProbe;
    this.switchedAway = opts.switchedAway ?? false;
    this.movedTo = opts.movedTo;
  }

  probe(): Promise<WindowProbe> {
    if (this.failProbe) return Promise.reject(this.failProbe);
    const tree = this.at(this.probes);
    const count = this.probeCounts?.[Math.min(this.probes, this.probeCounts.length - 1)];
    this.probes += 1;
    return Promise.resolve({
      count: count ?? tree.elements.length,
      windowClass: tree.windowClass,
    });
  }

  enumerate(): Promise<WindowElements> {
    if (this.failEnumerate) return Promise.reject(this.failEnumerate);
    const tree = this.at(this.enumerations);
    this.enumerations += 1;
    return Promise.resolve(tree);
  }

  verifyTarget(): Promise<TargetCheck> {
    this.verifications += 1;
    const tree = this.at(Math.max(0, this.enumerations - 1));
    return Promise.resolve({
      stillCurrent: !this.switchedAway,
      rect: this.movedTo ?? tree.windowRect,
    });
  }

  private at(call: number): WindowElements {
    return this.trees[Math.min(call, this.trees.length - 1)]!;
  }
}
