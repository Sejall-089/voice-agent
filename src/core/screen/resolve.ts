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
    throw ambiguity(quoted, named, candidates);
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

  // FOUND, BUT NOT USABLE (M16.11).
  //
  // Checked before the ambiguity gate, because "it is greyed out" is the more specific and more
  // useful thing to say: if the user can see the control, telling them it is ambiguous or
  // missing are both worse answers than telling them why it will not work.
  //
  // No marker is drawn. Pointing at something the user cannot click would be answering a
  // question they did not ask, and the sentence already tells them where it is by naming the
  // window and the control.
  if (!candidate.enabled) {
    throw new ElementNotFoundError(
      "disabled",
      `${quoted} is there in ${windowTitle}, but it's greyed out right now — so there's ` +
        `nothing to click yet.`,
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
    throw ambiguity(quoted, twins, candidates);
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

function ambiguity(
  quoted: string,
  group: readonly Candidate[],
  all: readonly Candidate[],
): ElementNotFoundError {
  if (group.length === 0) {
    return new ElementNotFoundError(
      "ambiguous",
      `I can see more than one thing that could be ${quoted}. Can you be more specific?`,
    );
  }
  return new ElementNotFoundError(
    "ambiguous",
    `I can see ${group.length} things that could be ${quoted}: ` +
      `${list(describeGroup(group, all))}. Which one?`,
  );
}

// How a set of indistinguishable candidates is named back to the user.
//
// Three ways of telling them apart, in descending order of how easy they are to ACT on. The
// whole point of this sentence is that a person can answer it by looking at their screen, so the
// question at every step is "what would they actually use to pick one out".
//
//   1. THE POSITION PHRASE, when it separates them. "top left" vs "bottom right" needs no
//      counting and no reading.
//   2. A LANDMARK — the enclosing control each one sits in. Added at M16.11 after live testing
//      on a five-column Explorer window: the four "Filter dropdown" buttons each sit INSIDE
//      their own column header ("Name" spans 240-699, its filter 674-697), so "the one under
//      Date modified" names the thing a person is already looking at.
//   3. LEFT-TO-RIGHT ORDINAL, as the fallback that always works.
//
// Ordinals were the previous fallback and they are the weakest of the three: they make the
// reader count columns and match that count against their own view, which fails the moment the
// window is scrolled or their eye lands somewhere else. Correct, but work.
//
// ALL OR NOTHING PER GROUP. If any one candidate has no clean landmark, the whole group falls
// back to ordinals — a sentence that mixed "under Name" with "3rd from the left" would make the
// reader translate between two schemes mid-list.
function describeGroup(group: readonly Candidate[], all: readonly Candidate[]): string[] {
  const positions = new Set(group.map((c) => c.position));
  if (positions.size === group.length) {
    return group.map((c) => `"${c.name}" (${c.position})`);
  }

  const landmarks = group.map((c) => landmarkFor(c, all, group));
  const named = landmarks.filter((l): l is string => l !== null);
  // Every candidate resolved, and to a DIFFERENT landmark — two filters under one header would
  // read as a distinction and be none.
  if (named.length === group.length && new Set(named).size === group.length) {
    return group.map((c, index) => `"${c.name}" (under "${landmarks[index]!}")`);
  }

  const order = [...group].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  return group.map((c) => `"${c.name}" (${ordinal(order.indexOf(c) + 1)} from the left)`);
}

// The narrowest candidate that ENCLOSES this one and is not itself in the ambiguous group.
//
// Narrowest, because enclosure nests: Explorer's filter button sits inside its column header
// ("Name", 459 wide) which sits inside the whole header row ("Header", 1680 wide). The narrowest
// one is the most specific, and the only one that tells the columns apart.
function landmarkFor(
  candidate: Candidate,
  all: readonly Candidate[],
  group: readonly Candidate[],
): string | null {
  const encloses = (other: Candidate): boolean =>
    other !== candidate &&
    // A member of the same group cannot be the landmark for another — "the Filter dropdown
    // under Filter dropdown" distinguishes nothing.
    !group.includes(other) &&
    other.rect.width > candidate.rect.width &&
    enclosesHorizontally(other, candidate);

  // SAME ROW FIRST, AND THIS ORDERING IS LOAD-BEARING (found while building it).
  //
  // Searching both together got two of Explorer's four filters wrong: it answered "under Sort"
  // and "under More options" — toolbar buttons on the row ABOVE, which happen to be narrower
  // than the column headers (Sort is 126 wide, Name is 459) and so won the narrowest-wins test.
  // A control that shares your row and contains you is your container; something merely above
  // you is a weaker signal and must never outrank it.
  const sameRow = all.filter((other) => encloses(other) && overlapsVertically(other, candidate));
  const above = all.filter((other) => encloses(other) && sitsAbove(other, candidate));

  const pool = sameRow.length > 0 ? sameRow : above;
  // Narrowest wins: enclosure nests, and the tightest box is the most specific label.
  const best = pool.reduce<Candidate | null>(
    (winner, other) => (winner === null || other.rect.width < winner.rect.width ? other : winner),
    null,
  );

  return best?.name ?? null;
}

// Is `candidate` horizontally inside `outer`? Tolerant by a pixel or two at each edge — the
// Explorer filter ends at 697 against a header ending at 699, and a strict test would still pass
// there, but control edges are not guaranteed to line up that neatly.
function enclosesHorizontally(outer: Candidate, candidate: Candidate): boolean {
  const slack = 4;
  return (
    candidate.rect.x >= outer.rect.x - slack &&
    candidate.rect.x + candidate.rect.width <= outer.rect.x + outer.rect.width + slack
  );
}

function overlapsVertically(outer: Candidate, candidate: Candidate): boolean {
  return (
    outer.rect.y < candidate.rect.y + candidate.rect.height &&
    outer.rect.y + outer.rect.height > candidate.rect.y
  );
}

// Directly above, for the layouts where a header really is a separate row. Bounded, so a wide
// control far up the window cannot become the landmark for something near the bottom.
function sitsAbove(outer: Candidate, candidate: Candidate): boolean {
  const gap = candidate.rect.y - (outer.rect.y + outer.rect.height);
  return gap >= 0 && gap <= candidate.rect.height * 2;
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
