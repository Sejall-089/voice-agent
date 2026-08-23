// Failures the USER can do something about, as opposed to something breaking.
//
// The planner shows these verbatim and logs them as `refused` rather than wrapping them in
// "Something went wrong" — because they are not malfunctions, they are states of the world the
// user can change. It distinguishes them by TYPE, so it never has to know which tool threw.
export class UserFixableError extends Error {}

// A tool was asked to act on a reference memory could not resolve ("my dashboard", "the team").
// This is NOT a failure — it's an honest "I don't know that yet".
//
// Tools throw this instead of a bare Error so the planner can distinguish "I don't understand"
// from "something broke" WITHOUT knowing anything about the tool that threw it.
export class UnresolvedReferenceError extends UserFixableError {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedReferenceError";
  }
}

// The three ways Google Calendar can be un-callable through no fault of the code (M13).
//
// Named, not generic, on purpose: "I'm not connected to your calendar yet" and "Google revoked
// this app's access" are different facts with different fixes, and both are different again
// from a real API failure. Collapsing them into `Error` would hand the user "Something went
// wrong" for a problem they could fix in thirty seconds — the same reasoning that made a
// truncated `chooseTool` response its own outcome in M9 instead of a fake refusal.
export type CalendarAuthReason = "not-connected" | "expired" | "revoked";

export class CalendarAuthError extends UserFixableError {
  constructor(
    public readonly reason: CalendarAuthReason,
    message: string,
  ) {
    super(message);
    this.name = "CalendarAuthError";
  }
}

// The one place these are worded, so the app says the same thing wherever the failure surfaces.
// None of them ever contain a token, a refresh token, or the client secret (spec §10).
//
// All three end in the same instruction, and that is honest rather than lazy: the REMEDY is the
// same (reconnect), and what differs is the EXPLANATION — "I was never connected", "it aged
// out", "Google cut it off" are three different facts about the world, and a user who is told
// which one it is knows whether to expect it to happen again. The reconnect finishes with a
// paste into `.env`, so it needs a restart to take effect — saying "try again" alone would send
// someone round a loop that cannot work.
const RECONNECT = "run `npm run calendar:connect`, paste the token into .env, and restart me";

export function calendarAuthError(reason: CalendarAuthReason): CalendarAuthError {
  switch (reason) {
    case "not-connected":
      return new CalendarAuthError(
        reason,
        `I'm not connected to your Google Calendar yet — ${RECONNECT}.`,
      );
    case "expired":
      return new CalendarAuthError(
        reason,
        `My Google Calendar access expired and couldn't be renewed — ${RECONNECT}.`,
      );
    case "revoked":
      return new CalendarAuthError(
        reason,
        `Google revoked this app's access to your calendar — ${RECONNECT}.`,
      );
  }
}
