import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// M10, task 10: send the reply that is sitting in the Gmail reply box.
//
// THE `dangerous` TOOL OF THIS MILESTONE (core/risk.ts). An email cannot be unsent, and unlike
// the Slack webhook it goes out under the user's own name to a real person. So:
//
//   - the planner's confirm gate is mandatory and is the ONLY route here — the handler is never
//     reached without an explicit yes;
//   - the dialog shows the ENTIRE draft and the ACTUAL recipients read off the compose box, not
//     a truncated preview and not the model's idea of who this is for;
//   - it makes no difference whether "send it" was typed or spoken. Voice and text converge on
//     one planner call site (§4a), and the gate reads the tool's risk tier, never the input
//     method. Dictation is not a way around this.
export const sendReplyTool: Tool = {
  name: "sendReply",
  description:
    "Send the reply that is currently in the Gmail reply box. Use this ONLY when the user " +
    "explicitly asks to send it ('send it', 'send that reply'). It sends exactly what is in " +
    "the box — it does not write or change anything first. The user is always asked to confirm " +
    "before anything is sent.",
  inputSchema: { type: "object", properties: {}, required: [] },
  risk: "dangerous",
  // Reads the live compose box (SAFE) so the user approves the words that will actually go out.
  // Throwing here means the planner never opens a dialog and nothing is sent.
  confirmSummary: async (_args: ToolInput, deps: ToolDeps): Promise<string> => {
    const text = await deps.gmail.readComposeText();
    if (text === null || text.trim().length === 0) {
      throw new Error("There's no reply open in Gmail to send.");
    }
    const to = await deps.gmail.readComposeRecipients();
    const who = to === null ? "" : ` to ${to}`;
    // The whole draft, deliberately not a preview: this is the last moment anyone can stop it.
    return `Send this reply${who}?\n\n${text}`;
  },
  handler: async (_input: ToolInput, deps: ToolDeps): Promise<string> => {
    // Re-read after the confirm rather than trusting the summary's copy — this is the text that
    // is about to leave, and it is also what gets reported back and logged.
    const text = await deps.gmail.readComposeText();
    if (text === null || text.trim().length === 0) {
      throw new Error("The reply box is empty now — nothing was sent.");
    }

    await deps.gmail.clickSend();

    // The draft is gone from the world, so it must be gone from here too: a later "make it
    // shorter" must not quietly reopen and rewrite something already delivered.
    deps.draft.clear();

    return `Sent.\n\n${text}`;
  },
};
