import { UserFixableError } from "../errors.ts";
import type { EmailMessage, Tool, ToolDeps, ToolInput } from "../types.ts";

// M19: read the email open in Gmail, and hand its text back.
//
// The capability is not new — `GmailSurface.readOpenEmail()` has been there since M10, and
// `draftReply` has called it on every run. What is new is that it is a TOOL: until a chain could
// pass one step's result to the next (M17) there was nothing to do with an email's text except
// reply to it, so nothing needed it on the menu. "File this bug report in Linear" does — step 1
// has to produce the email so step 2 can put it in a ticket.
//
// `safe` (core/risk.ts): it reads one message the user already has open and changes nothing. No
// reply box, no click, no draft. What happens to the text afterwards is the business of the
// step it is passed to, and that step has its own gate — creating the ticket is `dangerous`.
//
// THE RESULT IS SOMEONE ELSE'S WORDS, AND IT IS TREATED AS DATA. An email can say anything,
// including things phrased as instructions. Nothing here or downstream interprets it: a chain
// substitutes it into a later step's argument in one pass (core/chain.ts), the model that wrote
// the plan is never shown it, and it lands in the confirm dialog in full before anything is
// created from it.
export const readEmailTool: Tool = {
  name: "readEmail",
  description:
    "Read the email currently open in Gmail and return its sender, subject and full text. Use " +
    "this when the user asks what the open email says, or as the FIRST step of a plan that " +
    "needs the email's content for a later step — for example filing it as an issue, or adding " +
    "it to a page. When the user points at what they are looking at — 'this email', 'this " +
    "bug', 'this report', 'this message' — and another tool needs its content, plan readEmail " +
    "as the first step and pass its result on as {step1}; do not ask them to paste it and do " +
    "not write the content yourself. When the request says an email is open in Gmail and the " +
    "user asks to FILE, LOG or FORWARD 'this', they mean THAT EMAIL, even if clipboard text is " +
    "also shown — the clipboard always holds something and is often unrelated. Do NOT use " +
    "readEmail when the user asks to summarize, rewrite, translate, explain or fix 'this': " +
    "those act on the clipboard text. 'This text', 'what I copied' and 'these notes' always " +
    "mean the clipboard. Do NOT use this before draftReply: that tool reads the email itself. " +
    "This only reads; it changes nothing in Gmail.",
  inputSchema: { type: "object", properties: {} },
  risk: "safe",
  handler: async (_input: ToolInput, deps: ToolDeps): Promise<string> => {
    const email = await deps.gmail.readOpenEmail();
    if (email.body.trim().length === 0) {
      // An empty result would otherwise travel on as "" and stop a chain one step later with a
      // message about step 1 producing nothing. Said here, it names the actual problem.
      throw new UserFixableError(
        "The open email has no text I can read — it may be images only, or still loading.",
      );
    }
    return formatEmail(email);
  },
};

// Headers, a blank line, the body — the shape a person would paste into a ticket. Only the
// fields that exist are printed: Gmail does not always expose a subject or a sender name.
export function formatEmail(email: EmailMessage): string {
  const sender =
    email.fromName && email.from
      ? `${email.fromName} <${email.from}>`
      : (email.fromName ?? email.from);
  const headers: string[] = [];
  if (sender) headers.push(`From: ${sender}`);
  if (email.subject) headers.push(`Subject: ${email.subject}`);
  const body = email.body.trim();
  return headers.length > 0 ? `${headers.join("\n")}\n\n${body}` : body;
}
