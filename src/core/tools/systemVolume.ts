import {
  DEFAULT_PERCENT,
  MAX_PERCENT,
  MIN_PERCENT,
  acceptsRepeat,
  pressesForPercent,
  sentDescription,
  volumeChangeDescription,
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
// because nothing here can ask. The result says what was SENT ("Volume up about 10%" is the
// size of the step, not a reading). That is also why the argument is
// a RELATIVE amount and not a target level — a `set to 50%` API would have to know where it
// started, and inventing that number would be M15's confidently wrong marker in a new costume.
//
// THE ARGUMENT IS A PERCENT, AND IT USED TO BE A PRESS COUNT. That was a units bug, found by
// live testing and invisible to every test in the suite: "turn the volume up by 10" had the
// model pass `presses: 10`, and ten presses moved the volume by 20%. Neither side was wrong on
// its own terms — they disagreed about the unit, and a press count is an implementation detail
// that had no business being in the model's vocabulary. Nobody says "turn it up by ten key
// presses". The conversion now lives in `core/media.ts`'s `pressesForPercent`.
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
    "'mute'. `percent` is HOW MUCH TO CHANGE IT BY, as a percentage of the whole range: if the " +
    "user says a number, pass that number here. 'Turn it up by 10' is `percent: 10`. Omit it " +
    `when they did not say an amount and it defaults to ${DEFAULT_PERCENT}%. The smallest ` +
    `change I can make is ${MIN_PERCENT}% and the largest in one go is ${MAX_PERCENT}% — a ` +
    `request above ${MAX_PERCENT}% still moves it by ${MAX_PERCENT}%, so for more than that, ` +
    "ask again. `percent` is a RELATIVE change, never a target level: I CANNOT read the " +
    "current volume, so 'set the volume to 50%' is not something I can do. `percent` is " +
    "ignored for mute, which is a toggle.",
  inputSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["up", "down", "mute"],
        description: "Which way: 'up', 'down', or 'mute' to toggle mute.",
      },
      percent: {
        type: "number",
        description:
          `How much to change the volume by, as a percentage of the whole range — ` +
          `${MIN_PERCENT}-${MAX_PERCENT}. This is a RELATIVE change, not a target level. ` +
          `Omit for the default of ${DEFAULT_PERCENT}%. Ignored for mute.`,
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

    // Percent in, presses out. `mute` takes no amount at all — it is a toggle, so a percent is
    // as meaningless on it as a press count was, and `acceptsRepeat` is the one place that
    // decides which keys a quantity applies to.
    //
    // The ACTION still carries a press count, deliberately: the shell presses keys, and
    // WindowsShell re-resolves every `mediaKey` through `pressesFor` as defence in depth. The
    // percent never crosses the portability contract, because "2% per press" is a fact about
    // this machine's Windows, which is exactly the kind of thing that belongs on the shell side
    // of that line — and the conversion has already happened by the time it gets there.
    const presses = acceptsRepeat(key) ? pressesForPercent(input["percent"]) : 1;

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

    // Up and down report the CHANGE that was sent, in percent; mute is a toggle with no amount.
    // Neither states a resulting level - see `volumeChangeDescription`.
    return key === "volumeUp" || key === "volumeDown"
      ? volumeChangeDescription(key, presses, input["percent"])
      : sentDescription(key);
  },
};
