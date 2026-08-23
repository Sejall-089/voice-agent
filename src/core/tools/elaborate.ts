import { UserFixableError } from "../errors.ts";
import type { SpokenText } from "../speech.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M14 task 2: "go on, read the rest."
//
// The other half of the terseness decision. Speech is deliberately brief — a ten-event schedule
// is spoken as a count and the first event — and that is only honest if there is a way to ask
// for the rest. This is that way, and it lives where every capability in this app lives: the
// registry, chosen by the model from a description, gated by a tier, logged like anything else.
// Handling "read them out" anywhere else would have made it the one thing the app does that
// the closed world does not describe.
//
// `safe`: it reads something the app already had in hand and says it. No network, no other
// app's GUI, nothing to undo. It runs with no dialog and no narration.
//
// Only on the menu when the app can actually speak (see registry.ts). With no synthesizer
// nothing ever fills the store, so offering this would be offering a capability that can only
// ever refuse — and a request logged as a miss on a machine with speech turned off is a real
// miss worth seeing, not a tool that "failed".
export const elaborateTool: Tool = {
  name: "elaborate",
  description:
    "Read out the part of the last answer that was summarized instead of read in full. Use " +
    "this when the user asks for the rest of something you just shortened — 'read them out', " +
    "'go on', 'what are the others', 'tell me the rest'. It takes no arguments: it always " +
    "refers to the most recent answer that was cut short. Do NOT use it to repeat an answer " +
    "that was given in full, and do not use it to look anything up again.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  handler: async (_input: ToolInput, deps: ToolDeps): Promise<string> => {
    const held = deps.speech.take();
    if (held === null) {
      // A refusal, not a failure: the request was understood, and "there is nothing more" is
      // the true answer to it. UserFixableError is what makes the planner show this wording
      // verbatim instead of wrapping it in "Something went wrong".
      throw new UserFixableError("There's nothing more to read out.");
    }
    return held;
  },
  // Verbatim, and this is the whole point of the hook here: the held text is ALREADY the
  // remainder of something that was shortened once. Letting the generic derivation shorten it
  // again would mean "read me the rest" could answer with another "want me to read the rest?",
  // which is the one thing this tool exists to make impossible.
  speakResult: (result: string): SpokenText => ({
    text: result,
    remainder: null,
  }),
};
