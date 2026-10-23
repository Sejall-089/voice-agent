import { statusAnswer } from "../jobs/statusAnswer.ts";
import { toSpokenLine } from "../speech.ts";
import type { SpokenText } from "../speech.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// "Are my agents done yet?" (M23). The one tool the milestone adds.
//
// It reads the app's own job records and says what they hold. It starts nothing, stops
// nothing and answers nothing on the user's behalf — approving a waiting job happens in the
// native confirm dialog and nowhere else.
//
// `statusOnly` is what keeps a question about the jobs from being one: the planner admits it
// without a slot, and the job machinery never lists it or counts it in its own answer.
//
// The answer is a template (core/jobs/statusAnswer.ts). No model call is made here, and the
// spoken form is that template's own one-sentence version rather than the generic head of the
// displayed text — the list underneath quotes instructions back, and reading those out is not
// what "are they done yet" asked for.
export const jobStatusTool: Tool = {
  name: "jobStatus",
  description:
    "Report on the user's own background jobs in THIS app — the instructions they gave earlier " +
    "that are still running, waiting for their approval, finished or failed. Use it when the " +
    "user ASKS about that work: 'are my agents done yet?', 'what's running?', 'is anything " +
    "waiting on me?', 'did that finish?', 'how are my jobs doing?'. It only reports. Do NOT " +
    "use it when the user wants to tell someone else something about agents or jobs ('tell " +
    "the team the agents are done' is a message to send), or wants new work started ('start " +
    "an agent to…'), or is asking about anything outside this app.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "safe",
  background: "ok",
  planPhrase: "check your background jobs",
  statusOnly: true,
  // Nothing to look up: it takes no arguments.
  resolvesReferences: false,
  handler: (_input: ToolInput, deps: ToolDeps): Promise<string> => {
    return Promise.resolve(statusAnswer(deps.jobs?.list() ?? []).shown);
  },
  // The first paragraph of what the handler ALREADY produced — the template's one sentence —
  // and never a second reading of the records, which could have moved in between: the voice
  // and the screen must describe the same answer. Nothing is held back for "read the rest".
  speakResult: (result: string): SpokenText => {
    const sentence = result.split("\n\n")[0] ?? "";
    // Through the one cleaner every spoken line goes through (core/speech.ts).
    return { text: toSpokenLine(sentence), remainder: null };
  },
};
