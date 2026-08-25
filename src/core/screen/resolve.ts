import { ElementNotFoundError } from "../errors.ts";
import type { Candidate, ChoiceResult } from "../types.ts";

// The deterministic gate between what the model chose and what the app will point at (M16).
//
// M15's core/vision/locate.ts is the ancestor, and the contrast says what the milestone bought.
// That file had to MANUFACTURE checkability: given a bounding box, it could only look for
// properties a wrong answer tends to violate — off-frame, hedging over half the screen,
// degenerate — none of which prove an answer right. Here the answer is an index into a list this
// process wrote, so every check below is exact. "Is this a real candidate" is a lookup, not an
// inference.

// Validate the model's answer against the list it was given, or refuse.
//
// `target` is the user's own wording, so every refusal quotes the thing they actually asked for
// rather than a paraphrase — M15's rule, kept.
export function resolveChoice(
  candidates: readonly Candidate[],
  choice: ChoiceResult,
  target: string,
  windowTitle: string,
): Candidate {
  const quoted = JSON.stringify(target.trim());

  // --- The model says it is not here ---
  //
  // A LEGITIMATE OUTCOME AND A SUCCESS OF THE DESIGN, not a failure of anything. It gets its own
  // refusal kind and its own message, and it is deliberately NOT routed through the same path as
  // an unparseable reply: a model correctly declining is the behaviour we asked for, and telling
  // the user "I couldn't make sense of the answer" would be both wrong and unactionable.
  //
  // NOTE WHAT THIS MESSAGE CAN NOW SAY. Under vision, "I couldn't find it" was the model's word
  // taken on trust. Here the app has read the window's controls and can say how many it saw and
  // where it looked, which makes the claim checkable by the person reading it.
  if (choice.kind === "none") {
    throw new ElementNotFoundError(
      "not-found",
      `I couldn't find ${quoted} among the ${candidates.length} controls I can see in ` +
        `${windowTitle}.`,
    );
  }

  // --- The model says several match ---
  //
  // The model volunteering ambiguity. Kept as a real branch even though the deterministic check
  // below is the actual guarantee, because the model can see ambiguity the names do not reveal —
  // two differently-named controls that are both plausibly "the settings button".
  if (choice.kind === "ambiguous") {
    const named = choice.numbers
      .map((number) => candidates.find((c) => c.number === number))
      .filter((c): c is Candidate => c !== undefined);
    throw ambiguity(quoted, named);
  }

  // --- The model picked a number ---
  const candidate = candidates.find((c) => c.number === choice.number);

  // OUT OF RANGE. Its own message, because it is its own fact: the model understood the format
  // and named an entry that does not exist. A real risk rather than a theoretical one — VS Code's
  // list runs to 83 entries and Explorer's to 48, and an index hallucinated just past the end of
  // a long list is exactly the shape of mistake to expect.
  //
  // NEVER CLAMPED to the nearest valid index. Clamping would turn "the model lost track of the
  // list" into a confident marker on whatever happened to be last, which is the entire failure
  // class this milestone exists to remove.
  if (candidate === undefined) {
    throw new ElementNotFoundError(
      "untrustworthy",
      `I got an answer about ${quoted} that doesn't match anything I can see — I'd rather not ` +
        `point at the wrong thing.`,
    );
  }

  // THE DUPLICATE-NAME GATE, and the reason it is here rather than left to the model.
  //
  // The model answers with a NUMBER, so unlike M13's moveEvent — where a NAME was searched for
  // and could match several events — there is no possibility of code silently taking the first
  // of several matches. The number is unambiguous. What is NOT settled is whether the model had
  // any basis for choosing between entries the user could not have told apart either.
  //
  // Measured on real windows: Explorer shows FOUR controls named "Filter dropdown", all of them
  // `Button`s, and the coarse position phrase puts all four at "top". If someone asks for "the
  // filter dropdown", there genuinely are four and picking one is a decision they did not
  // delegate.
  //
  // SO CODE DECIDES, NOT THE MODEL. Refusing here is deterministic and does not depend on the
  // model choosing to be honest about its own uncertainty, which is the same reason M13's
  // resolveTargetEvent refuses on multiple matches rather than asking the model to behave.
  //
  // THE RULE IS "INDISTINGUISHABLE IN EVERY FIELD THE MODEL WAS SHOWN" — name, control type and
  // position — AND IT WAS NARROWED FROM "SHARED NAME" BY MEASUREMENT (M16.5).
  //
  // The first version refused on the name alone, on the argument that a refusal is cheaper than
  // a wrong marker. scripts/choose-recon.ts then produced a case that argument does not cover:
  // asked for "the column header for when things were last changed", the model correctly picked
  // Explorer's "Date modified" — and the gate refused it, because Explorer ALSO has an "Date
  // modified" filter box. The two are a `SplitButton` at 699,193 and an `Edit` at 699,248: same
  // name, DIFFERENT control type, and the user's own words named one of them unambiguously.
  // Refusing there is not caution, it is discarding information the model used correctly.
  //
  // The narrowed rule is not a heuristic. It says exactly one thing: refuse when the model had
  // NO INFORMATION with which to tell two entries apart. Where a discriminator existed and the
  // model used it, the answer stands; where none existed, a confident PICK is a coin flip and is
  // refused. The four "Filter dropdown" buttons are still caught — identical on all three fields.
  const twins = candidates.filter((c) => indistinguishable(c, candidate));
  if (twins.length > 1) {
    throw ambiguity(quoted, twins);
  }

  return candidate;
}

// Are these two entries the same as far as the model could tell? Compares exactly the three
// fields renderChooseRequest puts on the line, and nothing else — the rect is deliberately not
// consulted, because the model never saw it.
function indistinguishable(a: Candidate, b: Candidate): boolean {
  return (
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    a.controlType === b.controlType &&
    a.position === b.position
  );
}

function ambiguity(quoted: string, candidates: readonly Candidate[]): ElementNotFoundError {
  if (candidates.length === 0) {
    return new ElementNotFoundError(
      "ambiguous",
      `I can see more than one thing that could be ${quoted}. Can you be more specific?`,
    );
  }
  return new ElementNotFoundError(
    "ambiguous",
    `I can see ${candidates.length} things that could be ${quoted}: ` +
      `${list(candidates.map(describe))}. Which one?`,
  );
}

// How a candidate is named back to the user when we decline to choose between several.
//
// The position phrase alone is not always enough — Explorer's four "Filter dropdown" buttons are
// all "top" — so where it does not separate them, fall back to left-to-right ordering, which
// always does. A list that reads "the 1st, 2nd, 3rd and 4th from the left" is something a person
// can answer; four identical phrases is not.
function describe(candidate: Candidate, _index: number, all: readonly Candidate[]): string {
  const positions = new Set(all.map((c) => c.position));
  if (positions.size === all.length) return `"${candidate.name}" (${candidate.position})`;

  const order = [...all].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  const place = order.indexOf(candidate) + 1;
  return `"${candidate.name}" (${ordinal(place)} from the left)`;
}

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

// "A", "A and B", "A, B and C".
function list(items: string[]): string {
  if (items.length === 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}
