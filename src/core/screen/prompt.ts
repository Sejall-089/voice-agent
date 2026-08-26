import { chooserError } from "../errors.ts";
import type { Candidate, ChoiceResult } from "../types.ts";

// What the model is asked, and the only shapes of answer it may give (M16).
//
// THE PROMPT AND ITS PARSER LIVE IN ONE FILE, exactly as M15's core/vision/prompt.ts did, and
// for the same reason: they are two halves of one contract, and the way this goes wrong is one
// being edited without the other. A form added to the prompt but not the parser reads as "the
// model answered off-contract" on every single call.
//
// WHAT CHANGED FROM M15, AND WHY IT IS THE WHOLE MILESTONE. The vision prompt asked for a
// bounding box — a measurement. This one asks for a NUMBER FROM A LIST WE WROTE. The model is
// doing semantic matching ("which of these is 'the New button'"), which is what models are good
// at, instead of spatial localization, which is what M15 measured them failing at. There is no
// coordinate anywhere in this contract, so there is no coordinate to get wrong.
//
// A NOTE ON WHAT THE TESTS FOR THIS FILE DO AND DO NOT PROVE. They prove the parser handles a
// given reply correctly. They cannot prove the model reliably produces good replies — that the
// semantic match is actually reliable is the hypothesis this redesign rests on, and only live
// verification can speak to it. A green suite here is a proven parser, not a proven premise.

// The answer forms. Deliberately terse rather than JSON: the reply is a few tokens, this rides
// on `LLMClient.complete()` (which both providers already implement and both are already tested
// on), and a one-line grammar is far easier to state unambiguously in a prompt than a schema.
export const CHOOSE_CONTROL_SYSTEM = [
  "You are helping someone find a control in a window on their screen.",
  "You will be given the exact list of controls that window contains, numbered.",
  "Your ONLY job is to say which numbered entry the person means.",
  "You never say where anything is on screen — the positions in the list are already exact,",
  "and a marker is drawn from them. You are choosing, not measuring.",
  "",
  "Answer with EXACTLY ONE LINE, in one of these three forms and nothing else:",
  "  PICK <number>          - one entry clearly matches",
  "  NONE                   - nothing in the list is what they asked for",
  "  AMBIGUOUS <n>,<n>      - several entries match and you cannot tell which was meant",
  "",
  "No explanation, no punctuation, no other text.",
  "",
  "Some entries are marked `disabled`. Prefer an enabled entry when one matches. If the only",
  "thing that matches is disabled, still pick it — the app will tell them it is greyed out,",
  "which is a better answer than pretending it is not there.",
  "Answer NONE rather than offering the closest thing you can see — a confident wrong answer",
  "sends someone to the wrong part of their own screen, which is worse in every case than",
  "saying it is not here.",
].join("\n");

// The list, plus what they asked for.
//
// Each line carries the three things the model can choose on: the visible NAME, the CONTROL TYPE
// (context only — it is never used to filter), and a POSITION PHRASE that code computed from the
// exact rect. The position is what lets "the button next to the address bar" or "the one on the
// far right" work at all, and note the direction of travel: the model READS position and never
// REPORTS it. M15 had that backwards and paid for it.
export function renderChooseRequest(
  candidates: readonly Candidate[],
  target: string,
  windowTitle: string,
): string {
  // Disabled controls are LISTED, marked. They are still the answer to "where is X" — the app
  // just will not point at one, and it needs to know which entry the person meant in order to
  // say so. See core/screen/elements.ts for the live finding behind this.
  const lines = candidates.map(
    (c) =>
      `${c.number}. "${c.name}" (${c.controlType}, ${c.position}${c.enabled ? "" : ", disabled"})`,
  );
  return [
    `Window: ${windowTitle}`,
    "",
    "Controls:",
    ...lines,
    "",
    `They are looking for: ${target.trim()}`,
  ].join("\n");
}

// Turn the reply into a `ChoiceResult`, or refuse.
//
// STRICTLY SYNTAX ONLY. Whether a picked number actually EXISTS is not this function's business
// — it does not know how many candidates there were, and range checking lives in the
// deterministic gate beside the list it can check against (core/screen/resolve.ts). Same split
// M15 drew between prompt.ts and locate.ts: shape here, meaning there.
//
// Tolerant of whitespace and of a trailing full stop, because those are formatting noise rather
// than a different answer. NOT tolerant of prose around the answer: a model that explains itself
// has not followed the contract, and quietly digging a number out of a sentence would mean
// accepting an answer whose form we cannot verify.
export function parseChoice(reply: string): ChoiceResult {
  const text = reply.trim();
  if (text.length === 0) throw chooserError("empty");

  // One line only. A reply with more is prose, whatever else it contains.
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw chooserError("unparseable");

  const line = lines[0]!.trim().replace(/[.\s]+$/, "");

  if (/^NONE$/i.test(line)) return { kind: "none" };

  const pick = /^PICK\s+(\d+)$/i.exec(line);
  if (pick) {
    const number = Number(pick[1]);
    // A syntactically fine but nonsensical index. Zero and negatives cannot come out of the
    // regex; this catches the overflow case rather than trusting Number().
    if (!Number.isSafeInteger(number) || number < 1) throw chooserError("unparseable");
    return { kind: "picked", number };
  }

  const ambiguous = /^AMBIGUOUS\s+([\d\s,]+)$/i.exec(line);
  if (ambiguous) {
    const numbers = ambiguous[1]!
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map(Number);
    if (numbers.length === 0 || !numbers.every((n) => Number.isSafeInteger(n) && n >= 1)) {
      throw chooserError("unparseable");
    }
    // "AMBIGUOUS 4" is a contradiction in terms — one candidate is a PICK. Treated as
    // off-contract rather than silently promoted, because guessing which one the model meant is
    // exactly the kind of helpfulness this whole design removes.
    if (numbers.length < 2) throw chooserError("unparseable");
    return { kind: "ambiguous", numbers };
  }

  throw chooserError("unparseable");
}
