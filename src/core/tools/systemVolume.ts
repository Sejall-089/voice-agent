import {
  DEFAULT_PRESSES,
  MAX_PRESSES,
  MIN_PRESSES,
  pressesFor,
  sentDescription,
  type MediaKey,
} from "../media.ts";
import { UserFixableError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Task 18 (spec.md §6): change THIS MACHINE'S volume.
//
// NAMED FOR WHAT IT ACTUALLY DOES, which is the one decision in this file worth defending.
// M18 set out to build Spotify volume control over the Web API and could not: that endpoint
// needs Spotify Premium, twice over (see §9's parked note). What replaced it is a media key,
// which is not a Spotify feature at all — it moves the whole machine's output level, affecting
// every application at once. Calling it `spotifyVolume` would have been a lie told by an
// identifier, and the kind that survives for years because nothing contradicts it in code.
//
// WHAT IT CANNOT DO, AND SO NEVER CLAIMS: read the volume back. There is no "it's at 40% now",
// because nothing here can ask. The result says what was SENT. That asymmetry is the whole
// reason the input is a number of PRESSES rather than a target percentage — a `set to 50%` API
// would have to know where it started, and inventing that number would be M15's confidently
// wrong marker in a new costume.
const DIRECTIONS: Record<string, MediaKey> = {
  up: "volumeUp",
  down: "volumeDown",
  mute: "mute",
};

export const systemVolumeTool: Tool = {
  name: "systemVolume",
  description:
    "Change THIS COMPUTER'S system volume, or mute it. This is the whole machine's volume, not " +
    "one app's — it affects everything playing. Use it for 'turn the volume up', 'quieter', " +
    "'mute'. `presses` is how many volume-key presses to send: each one moves the volume about " +
    `2%, the default is ${DEFAULT_PRESSES} (roughly 10%), and it is capped at ${MAX_PRESSES}. ` +
    "For a bigger change, ask again rather than passing a huge number. `presses` is ignored for " +
    "mute, which is a toggle. I CANNOT read the current volume, so do not ask me to set it to a " +
    "particular level or percentage — I can only nudge it up or down.",
  inputSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["up", "down", "mute"],
        description: "Which way: 'up', 'down', or 'mute' to toggle mute.",
      },
      presses: {
        type: "number",
        description:
          `How many key presses to send, ${MIN_PRESSES}-${MAX_PRESSES}. Omit for the default ` +
          `of ${DEFAULT_PRESSES} (about 10%). Ignored for mute.`,
      },
    },
    required: ["direction"],
  },
  // Opening a window is recoverable because the user closes it; a volume change is recoverable
  // because the user changes it back, with the same key this tool just pressed. Nothing is
  // sent, written or destroyed, so there is nothing to announce and nothing to ask.
  risk: "reversible",
  // Both arguments are literals — a direction out of a fixed set, and a count. Memory
  // resolution exists to turn "my dashboard" into a URL and has nothing to contribute here;
  // the same call `pointAt` and `openApp` make about their own arguments.
  resolvesReferences: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const raw = typeof input["direction"] === "string" ? input["direction"].trim().toLowerCase() : "";
    const key = DIRECTIONS[raw];

    // Asked, not guessed. There is no sensible default direction, and picking one would mean
    // changing the volume in a direction nobody requested.
    if (key === undefined) {
      throw new UserFixableError("Up, down, or mute?");
    }

    // Resolved here AND again in the shell, through the same function, so the two can never
    // disagree about what a count means (core/media.ts).
    const presses = pressesFor(key, input["presses"]);

    const result = await deps.shell.executeAction({
      kind: "mediaKey",
      payload: key,
      count: presses,
    });

    // The shell's own words. A short write means the OS refused some of the presses — most
    // often a higher-privileged window holding the keyboard — which is a state of the machine
    // the user can act on, not a malfunction, so it is shown verbatim and logged `refused`.
    if (!result.ok) {
      throw new UserFixableError(result.error ?? "I couldn't change the volume.");
    }

    return sentDescription(key, presses);
  },
};
