import type { GmailSurface } from "./types.ts";

// What the planner is told about the world before it plans, beyond what the shell captured (M19).
//
// WHY THIS EXISTS. The planner used to see the instruction and the clipboard and nothing else.
// Asked to "file this bug in Linear and tell the social channel" with a bug email open and
// unrelated text on the clipboard, it had exactly one candidate for "this bug" — the clipboard —
// and planned to file that. Measured, not guessed: 0 of 3 plans read the email with unrelated
// clipboard text, and 3 of 3 did once the model was told Gmail was open
// (tests/eval/planChoice.eval.test.ts). Wording alone had not been enough.
//
// ONE BARE FACT. "An email is open in Gmail." — not its subject, not its sender. Those are
// words written by whoever sent the email, and the planning prompt is the one place in this app
// where text is read as instruction. A subject line there would be an injection surface in
// exactly the spot the rest of the design keeps clean (spec §5b). The cost is accepted: the
// model still cannot write a specific issue title, because it still has not seen the email.
//
// IT MUST NEVER COST THE INSTRUCTION ANYTHING. This runs before EVERY planning call, including
// "turn the volume up". So it is bounded by a short deadline, it runs concurrently with context
// capture, and every way it can go wrong — Chrome slow, Chrome gone, a surface that throws —
// produces "no hint", which is exactly the state before this file existed.

// How long the Gmail check may take before planning proceeds without it. Measured against the
// real debug Chrome when this was written: the check answered in well under this. It is a
// ceiling for a hung or busy browser, on a path whose next step is a model call of several
// seconds — long enough that a healthy check always lands, short enough to go unnoticed.
export const EMAIL_HINT_TIMEOUT_MS = 800;

// True only when Gmail answered, in time, that a message is open.
export async function emailOpenHint(
  gmail: Pick<GmailSurface, "hasOpenEmail">,
  timeoutMs: number = EMAIL_HINT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  // `hasOpenEmail` is contracted never to throw, and the real one does not. Caught anyway: a
  // hint is not worth an unhandled rejection in the one function every instruction runs.
  const asked = Promise.resolve()
    .then(() => gmail.hasOpenEmail())
    .then((open) => open === true)
    .catch(() => false);
  try {
    return await Promise.race([asked, deadline]);
  } finally {
    // Whichever won, the timer must not keep a finished run (or a test process) alive.
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The line the planner model is shown. One sentence, fixed, with nothing interpolated into it.
export const EMAIL_OPEN_LINE = "An email is open in Gmail.";
