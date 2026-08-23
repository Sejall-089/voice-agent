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
// `insufficient-scope` was added after the first live run, and it is the one that was learned
// rather than designed. A 403 was originally read as a revocation, which sent the user to
// reconnect — and reconnecting requests the SAME permissions, so it could never have helped.
// "Connected, but not permitted to do this" is a genuinely different state with a genuinely
// different fix, and collapsing it into "revoked" produced a loop instead of an answer.
export type CalendarAuthReason =
  | "not-connected"
  | "expired"
  | "revoked"
  | "insufficient-scope";

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
    case "insufficient-scope":
      // Deliberately does NOT say "reconnect and it'll work". The grant is missing a
      // permission this build asks for, and if the connect script requests the same scopes it
      // did last time, reconnecting changes nothing — so it says what is actually true and
      // points at the one thing that would.
      return new CalendarAuthError(
        reason,
        "I'm connected to your Google Calendar but not allowed to do that — the permission " +
          "granted doesn't cover it. If you connected before this app last changed what it " +
          `asks for, ${RECONNECT}.`,
      );
  }
}

// The four ways the speech engine can fail (M14).
//
// Named rather than generic, for M13's reason: "I can't find the engine" and "the engine ran
// and produced nothing" are different facts with different fixes, and both differ again from a
// real crash. What is deliberately NOT here is a reason derived from parsing the engine's
// stderr. M13's lesson was that error CLASSIFICATION is ordinary logic and must be tested — but
// testing it means having real captured output to test against, and hand-authoring stderr
// strings from an engine nobody has run yet would repeat M10's mistake of writing a fixture
// from an assumption. So every reason below is decided by something certain (a spawn failure,
// an exit code, a timer, the bytes actually on disk), and the engine's own words are surfaced
// verbatim instead of being interpreted. scripts/tts-recon.mjs now captures real stderr for the
// common failures; when that lands, this can get more specific with evidence behind it.
export type SpeechEngineReason =
  | "missing-binary" // the exe path is wrong — by far the most likely setup mistake
  | "failed" // it ran and exited non-zero; its own stderr is the explanation
  | "timeout"
  | "no-audio"; // exited 0 and produced nothing usable — see M11 on trusting success

export class SpeechEngineError extends UserFixableError {
  constructor(
    public readonly reason: SpeechEngineReason,
    message: string,
  ) {
    super(message);
    this.name = "SpeechEngineError";
  }
}

export function speechEngineError(
  reason: SpeechEngineReason,
  detail: string,
): SpeechEngineError {
  switch (reason) {
    case "missing-binary":
      return new SpeechEngineError(
        reason,
        `I couldn't run the speech engine at ${detail} — check PIPER_EXE_PATH in .env.`,
      );
    case "failed":
      // The engine's own words, verbatim, plus the one thing worth checking. Not a diagnosis:
      // we do not yet know what its stderr looks like, and guessing would send someone to fix
      // the wrong thing (exactly what M13's blanket "403 means revoked" did).
      return new SpeechEngineError(
        reason,
        `The speech engine failed: ${detail}. Check PIPER_MODEL_PATH points at a .onnx voice.`,
      );
    case "timeout":
      return new SpeechEngineError(
        reason,
        `The speech engine didn't finish within ${detail} and was stopped.`,
      );
    case "no-audio":
      // M11's rule, in a new place: an operation that reports success is not proof it did
      // anything. Notion could save nothing and say it worked; a synthesizer can exit 0 and
      // leave an empty file, and playing silence would look exactly like the app ignoring you.
      return new SpeechEngineError(
        reason,
        `The speech engine reported success but produced no audio (${detail}).`,
      );
  }
}
