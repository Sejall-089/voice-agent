import { isMediaKey, pressesFor, sentDescription } from "../media.ts";
import { UserFixableError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Task 19 (spec.md §6): play/pause, next, previous — as MEDIA KEYS, to whatever is playing.
//
// NOT A SPOTIFY TOOL, and the description says so to the model in as many words. A media key
// goes to whichever application currently owns the Windows media session. That is often
// Spotify, and it is just as often a YouTube tab, a video in another browser window, or
// nothing at all. The app cannot find out which, so it does not pretend to: there is no
// "paused Spotify" in any string here, only "sent play or pause".
//
// TWO THINGS THIS CANNOT KNOW, both stated in the description because a model that assumes
// otherwise will write a confident wrong sentence for the user to read:
//
//   1. WHETHER IT IS PLAYING NOW. `playPause` is a toggle with no readable state, so "pause
//      the music" and "resume the music" are the same key press, and if nothing was playing
//      this may START something. There is no API here to ask first.
//   2. WHAT IT WILL DO TO THE POSITION. `previous` is not an undo for `next`: on a podcast or
//      a long track it restarts rather than restores, so a skip loses your place for good.
//      That is why the description warns rather than relying on the tier to protect anyone —
//      the tier is `reversible` because a track change is routine and self-correcting in the
//      ordinary case, and narrating a key press would be noise on every one of them.
export const mediaControlTool: Tool = {
  name: "mediaControl",
  description:
    "Press a media key on this computer: play/pause, next track, or previous track. IMPORTANT: " +
    "this goes to whichever app currently owns the system media session — usually whatever " +
    "started playing most recently. That might be Spotify, a YouTube tab, or another video, " +
    "and I cannot tell which, so never say which app it affected. 'playPause' is a TOGGLE and " +
    "I cannot read whether anything is playing: use it for both pause and resume, and be aware " +
    "it may start something if nothing was playing. 'previous' does not undo 'next' — on a " +
    "podcast or long track it restarts rather than returning to where you were.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["playPause", "next", "previous"],
        description:
          "'playPause' to toggle, 'next' to skip forward one track, 'previous' to go back one.",
      },
    },
    required: ["action"],
  },
  risk: "reversible",
  // A fixed action name, not a reference to look up — same as `systemVolume`'s direction.
  resolvesReferences: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const raw = typeof input["action"] === "string" ? input["action"].trim() : "";

    // Deliberately NOT accepting every `MediaKey`: the volume keys are a different tool with a
    // different input, and letting this one press them would give the model two routes to the
    // same action with only one of them documented. So the membership check is narrowed to the
    // three this tool is about, and `isMediaKey` guards the name's shape before that.
    if (!isMediaKey(raw) || !["playPause", "next", "previous"].includes(raw)) {
      throw new UserFixableError("Play/pause, next, or previous?");
    }

    // Always one press for these three — `pressesFor` enforces it, because five `next`
    // presses skip five tracks and five toggles land back where they started.
    const presses = pressesFor(raw, 1);

    const result = await deps.shell.executeAction({ kind: "mediaKey", payload: raw, count: presses });

    if (!result.ok) {
      throw new UserFixableError(result.error ?? "I couldn't press that media key.");
    }

    // "Sent play or pause" / "Sent next track". What was SENT — never what is now playing,
    // which nothing here can know.
    return sentDescription(raw, presses);
  },
};
