// A tool was asked to act on a reference memory could not resolve ("my dashboard", "the team").
// This is NOT a failure — it's an honest "I don't know that yet". The planner shows the message
// verbatim and logs the action as `refused` rather than wrapping it in a generic error.
//
// Tools throw this instead of a bare Error so the planner can distinguish "I don't understand"
// from "something broke" WITHOUT knowing anything about the tool that threw it.
export class UnresolvedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedReferenceError";
  }
}
