import { toScreenRect } from "../screen/geometry.ts";
import { readSettledWindow } from "../screen/pointing.ts";
import { resolveChoice } from "../screen/resolve.ts";
import { ElementNotFoundError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M16: show the user where something is on their screen, so THEY can click it.
//
// The one tool in the registry that acts on any application at all rather than on a specific
// one, and the reason it is allowed to is that it does not act on them — it draws a marker over
// them. The guess drives a suggestion and a person is the executor, so the app can be wrong the
// way a colleague pointing at your screen can be wrong.
//
// WHAT M16 CHANGED, AND WHY IT IS THE WHOLE POINT. M15 shipped this on vision: a screenshot went
// to a model and the model returned a bounding box. Live testing found it localizing the WRONG
// CONTROL on real Windows chrome — one tab over on a tab label, ~208px onto a neighbouring
// toolbar icon — which is not imprecision, it is the wrong answer given confidently. That made
// this the single place in the codebase where "the LLM proposes, the planner disposes" was
// broken: vision both proposed (which control) and disposed (where it is).
//
// Now UI Automation enumerates the window's controls with exact rects, code numbers them, and
// the model's entire output surface is one integer. An integer cannot be off by 208 pixels. It
// can be the WRONG integer — a semantic error, which is the error class models are good at, and
// one the user can see in the label drawn beside the marker.
//
// A consequence worth stating plainly: NO SCREENSHOT IS TAKEN AND NOTHING IS SENT ANYWHERE
// EXCEPT A LIST OF CONTROL NAMES. The candidate list is text. M15's whole privacy gate existed
// because a picture of the user's screen left the machine; that no longer happens.
//
// `risk: "caution"`, and the tier is about READING ANOTHER WINDOW, not about the marker.
//   * Not `safe`: it reads the contents of whatever the user was last looking at, and it draws.
//   * Not `reversible`: `risk.ts` reserves that for things recoverable by mechanisms this app
//     owns. The overlay qualifies — `clearPointer()` un-draws it — but the control names have
//     already gone to a model by then, and the tier has to describe the worst half.
//   * Not `dangerous`: nothing reaches another person, nothing is written anywhere, and a
//     confirm dialog in front of every "where's the send button?" would make the capability
//     unusable for the one thing it is for.
export const pointAtTool: Tool = {
  name: "pointAt",
  description:
    "Show the user where something is on their screen by drawing a marker over it. Use this " +
    "when the user asks where something is, or asks to be shown, pointed at, or helped to find " +
    "a button, menu, field, link, or any other on-screen control — for example 'where's the " +
    "send button', 'point at the settings menu', 'show me how to attach a file'. Pass `target` " +
    "as the thing they are looking for, in their own words. This only POINTS: it never clicks " +
    "anything and never types anything, so the user still has to act on it themselves. Do not " +
    "use it to open a website (that is openTarget) or to act inside Gmail or Notion, which " +
    "have their own tools.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "What to point at, in the user's own words — e.g. \"the send button\", \"the " +
          'settings menu", "the attach file icon".',
      },
    },
    required: ["target"],
  },
  risk: "caution",
  // `target` is a literal description of something visible, not a reference to look up. Memory
  // resolution exists to turn "my dashboard" into a URL, and letting it near this argument would
  // rewrite "my inbox" into `https://mail.google.com/...` and then hunt the screen for a URL.
  resolvesReferences: false,
  // Announced BEFORE the window is read. It no longer says "looking at your screen", because
  // that would now be false in a specific and important way: nothing is photographed. What
  // happens is that the controls of one window are read and their NAMES are sent. The narration
  // says the true thing. SAFE — it reads nothing and enumerates nothing.
  narrate: (args: ToolInput): string => {
    const target = asTarget(args);
    return `Checking the controls on screen for ${target}…`;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const target = asTarget(input);

    // 1. Read the window, waiting for its control list to stop moving first. Refuses on its own
    //    terms when the tree is bare (`unreadable`) or still in motion (`unsettled`) — see
    //    core/screen/pointing.ts.
    const { window, candidates } = await readSettledWindow({
      elements: deps.elements,
      sleep: deps.sleep,
    });

    // 2. Ask which one. The model sees names, control types and code-computed position phrases —
    //    never a coordinate.
    const choice = await deps.chooser.choose(candidates, target, window.windowTitle);

    // 3. The deterministic gate. Out of range, "none of these", and two candidates the model
    //    could not have told apart all refuse here rather than becoming a marker.
    const chosen = resolveChoice(candidates, choice, target, window.windowTitle);

    // 4. IS THIS STILL ABOUT THE RIGHT WINDOW?
    //
    //    A DECISION, NOT AN ACCIDENT. Between the snapshot and this line the app has read a
    //    window, waited out a settle, and made a model call — measured at ~1.9s on a real
    //    Chromium window (M16.8). A user alt-tabbing, or a notification stealing focus, is
    //    comfortably inside that. So: DETECT AND REFUSE, rather than draw anyway.
    //
    //    The tempting alternative is "the rect is still geometrically correct for the window it
    //    came from, so draw it". That reasoning does not survive the overlay being ALWAYS ON
    //    TOP: if the user has switched to another app, the marker is drawn over THAT app, at
    //    coordinates that meant something in a window now hidden behind it. A confident marker
    //    labelled "File" sitting on a browser's tab bar is M15's exact failure mode let back in
    //    through a different door — and M15's asymmetry settles it. A refusal costs a rephrase;
    //    a marker on the wrong application costs a click the user did not intend.
    //
    //    Re-snapshotting instead was rejected too: it would answer a question about a window the
    //    user never asked about.
    //
    //    The window's own bounds are re-read at the same time, because a window DRAGGED since
    //    the enumerate invalidates every rect that came out of it just as thoroughly.
    const check = await deps.elements.verifyTarget();
    if (!check.stillCurrent) {
      throw new ElementNotFoundError(
        "stale",
        `You've switched away from ${window.windowTitle} — ask me again and I'll look at ` +
          `whatever's in front now.`,
      );
    }
    if (
      check.rect.x !== window.windowRect.x ||
      check.rect.y !== window.windowRect.y ||
      check.rect.width !== window.windowRect.width ||
      check.rect.height !== window.windowRect.height
    ) {
      throw new ElementNotFoundError(
        "stale",
        `${window.windowTitle} moved while I was looking — ask me again and I'll re-read it.`,
      );
    }

    // 5. Native screen pixels → DIP. Exact, not estimated: the rect came from the OS. This is
    //    still the one step that fails silently rather than loudly if it is wrong, which is why
    //    `ScreenRect` is branded so nothing else can reach the overlay.
    const display = await deps.screen.displayForNative(window.windowRect);
    const rect = toScreenRect(chosen.rect, display);
    await deps.screen.point({ rect, label: chosen.name });

    // The sentence stands on its own, because the marker is the disposable channel and the text
    // is the durable one (§4d). Spoken aloud, or read after the overlay has timed out, this
    // still tells the user where to look — and it names what the app THINKS it found, so a
    // marker sitting on "Discard" while the label says "Send" is visible as a disagreement
    // rather than trusted as an answer.
    return `Pointing at "${chosen.name}" — ${chosen.position} of ${window.windowTitle}.`;
  },
};

// The model is told to pass the user's own words; this is the guard for when it passes nothing.
// Thrown as a plain Error, not a UserFixableError: an empty required argument is a malfunction
// of the call, not a state of the world the user can fix.
function asTarget(input: ToolInput): string {
  const value = input["target"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Tell me what to look for, and I'll point at it.");
  }
  return value.trim();
}
