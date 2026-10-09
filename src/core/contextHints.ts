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

// What the clipboard is called in the prompt WHEN an email is open. Without one it keeps its
// v0 name, "Selected text (clipboard):" — see renderRequest in core/llm/prompt.ts.
export const CLIPBOARD_LABEL_WITH_EMAIL =
  "Clipboard text (whatever was last copied — it may be unrelated to this request and to the " +
  "open email):";

// --- Where did this text come from? (M19) ---
//
// The model answers once, and nothing in code can make it choose the email over the clipboard.
// What code CAN do is know, exactly, when an argument it is about to act on IS the clipboard —
// and say so at the confirm gate, in the first line, where a person decides. The live failure
// this answers was caught only because someone read the body of the dialog and recognised their
// own clipboard in it.
//
// DELIBERATELY NOT A REFUSAL. "An email is open" is true with Gmail sitting in a background tab
// while the user copies notes from somewhere else and says "send these to the team". Refusing
// clipboard-based plans whenever an email is open would break that. This only labels.

// Below this, a "match" is noise: a clipboard holding "ok" is contained in half of all text.
export const MIN_CLIPBOARD_MATCH_CHARS = 20;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

// Does `value` carry the clipboard's text? True when, ignoring whitespace differences, the
// value contains the whole clipboard or the clipboard contains the whole value — the two ways a
// model passes a clipboard along (verbatim inside something longer, or a trimmed copy of it).
// Not fuzzy: a paraphrase does not match, and neither does text that merely shares words.
export function isClipboardText(value: unknown, clipboard: string | null): boolean {
  if (typeof value !== "string" || clipboard === null) return false;
  const text = squash(value);
  const clip = squash(clipboard);
  if (text.length < MIN_CLIPBOARD_MATCH_CHARS || clip.length < MIN_CLIPBOARD_MATCH_CHARS) {
    return false;
  }
  return text.includes(clip) || clip.includes(text);
}

// Is any top-level argument the clipboard's text, at a moment when an email is also open?
// Both conditions, because the label exists to resolve an AMBIGUITY: with no email open the
// clipboard is the only thing "this" could mean, and there is nothing to warn about.
export function usesClipboardBesideOpenEmail(
  args: Readonly<Record<string, unknown>>,
  context: { selectedText: string | null; emailOpen?: boolean },
): boolean {
  if (context.emailOpen !== true) return false;
  return Object.values(args).some((value) => isClipboardText(value, context.selectedText));
}

// Put the source into the QUESTION — the first line of a confirm summary, which is the line
// that is spoken and the one a person reads before deciding.
//   "Create this Linear issue in Engineering?" → "… in Engineering from your clipboard text?"
export const FROM_CLIPBOARD = "from your clipboard text";

export function markFromClipboard(summary: string): string {
  const breakAt = summary.indexOf("\n");
  const first = breakAt === -1 ? summary : summary.slice(0, breakAt);
  const rest = breakAt === -1 ? "" : summary.slice(breakAt);
  const question = first.trimEnd();
  const marked = question.endsWith("?")
    ? `${question.slice(0, -1).trimEnd()} ${FROM_CLIPBOARD}?`
    : `${question} (${FROM_CLIPBOARD})`;
  return `${marked}${rest}`;
}
