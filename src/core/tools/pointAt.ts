import { checkLocation } from "../vision/locate.ts";
import { describePosition, toScreenRect } from "../vision/geometry.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M15: show the user where something is on their screen, so THEY can click it.
//
// The one tool in the registry that acts on any application at all rather than on a specific
// one, and the reason it is allowed to is that it does not act on them — it draws a marker over
// them. spec §2 kept screenshot-driven control out of scope because "reading a page's real
// structure is checkable and refusable; guessing from pixels is not". That objection is about a
// guess DRIVING an irreversible action. Here the guess drives a suggestion and a person is the
// executor, so the app can be wrong the way a colleague pointing at your screen can be wrong.
//
// `risk: "caution"`, and the tier is about the CAPTURE, not the marker.
//   * Not `safe`: it draws, and it sends.
//   * Not `reversible`: `risk.ts` reserves that for things recoverable by mechanisms this app
//     owns. The overlay qualifies — `clearPointer()` un-draws it completely — but a screenshot
//     that has left the machine does not, and the tier has to describe the worst half.
//   * Not `dangerous`: nothing reaches another person, nothing is written anywhere, and a
//     confirm dialog in front of every "where's the send button?" would make the capability
//     unusable for the one thing it is for.
// So it narrates. Given this is the first capability in the project that sends a picture of the
// user's screen off their machine (spec §2), an announcement at the moment it happens is the
// point of the tier rather than a cost of it — narration is what stands in for the undo that
// does not exist.
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
  // Same reasoning as the memory-writing tools, different direction.
  resolvesReferences: false,
  // Announced BEFORE the screen is captured. Deliberately says "look at your screen" in plain
  // words rather than something softer: the whole gate on this capability is that the user knows
  // when it is happening. SAFE — it reads nothing and captures nothing.
  narrate: (args: ToolInput): string => {
    const target = asTarget(args);
    return `Looking at your screen to find ${target}…`;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const target = asTarget(input);

    // Take the picture, ask about it, and let the deterministic gate decide whether the answer
    // is one we will act on. Each step throws a UserFixableError of its own on failure — a
    // screen that cannot be captured, a model that cannot be reached, an answer that cannot be
    // trusted — and the planner shows each verbatim rather than wrapping it in "something went
    // wrong". Three different problems with three different fixes.
    const shot = await deps.screen.capture();
    const answer = await deps.vision.locate(shot, target);
    const located = checkLocation(answer, shot, target);

    // Image pixels -> screen DIP. The one silent-failure step in the milestone: a wrong mapping
    // does not throw, it points confidently at the wrong place. See core/vision/geometry.ts.
    const rect = toScreenRect(located.box, shot);
    await deps.screen.point({ rect, label: located.label });

    // The sentence stands on its own, because the marker is the disposable channel and the text
    // is the durable one (§4d). Spoken aloud, or read after the overlay has timed out, this
    // still tells the user where to look — and it names what the app THINKS it found, so a
    // marker sitting on "Discard" while the label says "Send" is visible as a disagreement
    // rather than trusted as an answer.
    return `Pointing at "${located.label}" — ${describePosition(located.box, shot)}.`;
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
