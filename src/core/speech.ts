// Turning what the SCREEN shows into what the app SAYS (M14).
//
// The milestone's load-bearing decision lives here: the app keeps two representations of every
// narration, result, and confirm — the existing on-screen text, unchanged, and a spoken one
// DERIVED from it by the pure functions below. Nobody authors the same message twice, so the
// two cannot drift apart when a tool's output changes; the spoken version can only be wrong,
// and wrong is testable.
//
// Why not one unified string for both: the confirm dialog settles it. sendReply's summary is
// deliberately the WHOLE draft ("never a preview: this is the last moment anyone can stop it")
// and createEvent names EVERY attendee, never "and 2 others". Rewriting everything to be terse
// enough to speak would force brevity onto the one text this project deliberately made
// exhaustive — a safety regression in the worst possible place. So the screen stays exhaustive
// and speech gets its own, shorter derivation.
//
// Everything here is pure — no synthesizer, no shell, no electron. Per M13's lesson, this is
// the half of TTS that is ordinary logic and therefore gets tested from day one; only the
// actual audio synthesis is live-only.

// One utterance, plus whatever was held back for an "and the rest?" follow-up.
export interface SpokenText {
  // Safe to hand to a SpeechSynthesizer. "" means SAY NOTHING — callers must not speak it
  // (an empty utterance produces no audio, and playback that never ends would wedge the queue).
  text: string;
  // Already speakable, held for the `elaborate` tool. null when nothing was withheld.
  remainder: string | null;
}

// Roughly two or three spoken sentences — Clicky's own "one or two sentences unless asked to
// elaborate" shape, in characters because that is what we can actually measure here.
export const MAX_SPOKEN_CHARS = 240;

// And a separate ceiling on how many list items get read out, because the character cap alone
// is the wrong measure for a list: five schedule lines fit inside 240 characters and are still
// four more than anyone wants read at them. "Brief unless asked" is a count, not a length.
export const MAX_SPOKEN_ITEMS = 3;

// What a truncated utterance offers. Deliberately plain words: no ellipsis and no dash, because
// how a phonemizer voices punctuation is exactly the kind of thing we have not verified yet
// (see scripts/tts-recon.mjs). Letters, digits, and `. , ? '` only.
const MORE_ITEMS = (n: number): string =>
  `Plus ${n} more. Want me to read them?`;
const MORE_PROSE = "There's more. Want me to read the rest?";
const SEE_DIALOG = "Check the dialog.";

// --- The three call points (one per thing the planner shows) ---

// A tool's result. The richest case, because a result can be a headline plus a body, a list, or
// one plain sentence, and each wants different speech.
//
// The paragraph rule comes first and does most of the work: this codebase already uses a blank
// line to mean "headline, then the bulk" — `Sent to #design-team.\n\n<the whole message>`,
// `Sent.\n\n<the whole reply>`. Speaking a message back at the person who just sent it is noise,
// so only the headline is spoken and the body becomes the remainder.
export function toSpokenResult(text: string): SpokenText {
  const [head, ...rest] = paragraphs(text);
  if (head === undefined) return { text: "", remainder: null };

  const tail = rest.length > 0 ? flatten(rest.join("\n")) : "";
  const spoken = speakParagraph(head);

  const held = [spoken.remainder, tail].filter(isPresent).join(" ");
  if (held.length === 0) return spoken;

  // The head fitted but there are further paragraphs: the offer has to be added here, since
  // speakParagraph could not see them.
  const offered =
    spoken.remainder === null ? join(spoken.text, MORE_PROSE) : spoken.text;
  return { text: offered, remainder: held };
}

// What a `caution` tool says BEFORE it acts. Capped but never offered — "I'm about to add
// Design review to your calendar" is not something anyone wants to hear more of, and by the
// time they could ask, the action has already happened. Narration is authored as one short
// sentence by design (see each tool's `narrate`); the cap here is defensive, not expected.
export function toSpokenNarration(text: string): SpokenText {
  const line = flatten(text);
  if (line.length === 0) return { text: "", remainder: null };
  const [head] = cut(line, MAX_SPOKEN_CHARS);
  return { text: sentence(head), remainder: null };
}

// The `dangerous` gate. Speaks the FIRST PARAGRAPH ONLY, and never offers to read the rest.
//
// Both existing summaries lead with the decisive fact and put the bulk after a blank line —
// sendReply's `Send this reply to alex@example.com?\n\n<the draft>`, sendMessage's
// `Send to #design-team?\n\n<the message>` — so the first paragraph is reliably the question
// itself. The draft body is never spoken, and there is deliberately no remainder: the dialog
// on screen IS the full text, so "want me to read the rest?" would be offering to duplicate
// the thing the user is already looking at, out loud, at the one moment they should be reading.
export function toSpokenConfirm(summary: string): SpokenText {
  const [head, ...rest] = paragraphs(summary);
  if (head === undefined) return { text: "", remainder: null };

  const line = flatten(head);
  const [spoken, held] = cut(line, MAX_SPOKEN_CHARS);
  const truncated = held.length > 0 || rest.length > 0;

  return {
    text: truncated ? join(sentence(spoken), SEE_DIALOG) : sentence(spoken),
    remainder: null,
  };
}

// One line of text, cleaned and given a terminal stop — the building block a tool reaches for
// when it writes its OWN spoken form (`Tool.speakResult`) instead of taking the derivation
// above. Exported so the stripping rules live in exactly ONE place: a fake synthesizer that
// rejects a stray bullet has to be able to assume every producer went through the same cleaner,
// or the rule catches honest tools instead of bugs.
export function toSpokenLine(text: string): string {
  return sentence(speakable(text));
}

// --- Internals ---

// One paragraph of a result, which may be a list or prose.
function speakParagraph(paragraph: string): SpokenText {
  const list = lines(paragraph);
  if (list.length === 0) return { text: "", remainder: null };
  if (list.length === 1) return speakProse(list[0] ?? "");

  // A list — formatSchedule's ten events are the case this exists for. Speak WHOLE items, never
  // a half-read event ("you have a meeting with" is worse than a count), stopping at whichever
  // ceiling comes first.
  const spoken: string[] = [];
  let used = 0;
  for (const item of list) {
    if (spoken.length >= MAX_SPOKEN_ITEMS) break;
    const next = sentence(item);
    if (spoken.length > 0 && used + next.length + 1 > MAX_SPOKEN_CHARS) break;
    spoken.push(next);
    used += next.length + 1;
  }

  // The first item is taken unconditionally above, so one enormous item (a schedule line with a
  // dozen guests on it) can still overflow. Cutting it is the lesser evil: the remainder carries
  // every word either way, and this is the only path that ever splits an item.
  const [head, overflow] = cut(spoken.join(" "), MAX_SPOKEN_CHARS);
  const left = list.slice(spoken.length);
  const held = [overflow, left.map(sentence).join(" ")]
    .filter((part) => part.length > 0)
    .join(" ");

  if (held.length === 0) return { text: head, remainder: null };
  return {
    text: join(head, left.length > 0 ? MORE_ITEMS(left.length) : MORE_PROSE),
    remainder: held,
  };
}

function speakProse(line: string): SpokenText {
  const [head, tail] = cut(line, MAX_SPOKEN_CHARS);
  if (tail.length === 0) return { text: sentence(head), remainder: null };
  return {
    text: join(sentence(head), MORE_PROSE),
    remainder: sentence(tail),
  };
}

// Split on blank lines, keeping each paragraph's own internal newlines (a list is one
// paragraph of several lines).
function paragraphs(text: string): string[] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// The speakable lines of one paragraph, in order, each already cleaned.
function lines(paragraph: string): string[] {
  return paragraph
    .split(/\r?\n/)
    .map(speakable)
    .filter((line) => line.length > 0);
}

// A whole block as ONE speakable line.
function flatten(text: string): string {
  return lines(text).map(sentence).join(" ").trim();
}

// The actual cleaning, and the reason a strict fake can catch a bug here: everything removed
// or rewritten below is something a phonemizer either voices as a word ("asterisk", "hash"),
// silently drops, or — the dashes and curly quotes — GARBLES, because the bytes are being
// mis-decoded somewhere in the engine's stdin path (see the dash rule).
//
// Dates and times are rewritten here rather than by the tool that produced them. That was the
// other way round for one commit: `calendar/format.ts` had its own `speakableWhen`, and
// `readSchedule` had to split its formatted line apart to apply it. Recon killed that design by
// showing the problem was not calendar-shaped at all — `createEvent`'s narration and its confirm
// dialog run the same `formatWhen` output through the same engine, and would have been garbled
// in exactly the same way while only the schedule listing was fixed. One cleaner, every path.
function speakable(line: string): string {
  return (
    line
      // A leading list marker of any of the shapes this codebase actually emits.
      .replace(/^\s*[•*+\-–—]\s+/, "")
      // A markdown heading marker.
      .replace(/^\s*#{1,6}\s+/, "")
      // A URL read character by character is unbearable ("Opened https colon slash slash
      // github dot com slash dashboard"). The host is the part a person would say out loud.
      .replace(/\bhttps?:\/\/([^\s/]+)(\/\S*)?/gi, (_all, host: string) =>
        String(host).replace(/^www\./i, ""),
      )
      // "Wed 26 Aug" is read as "wed twenty six aug" — two of those are ordinary English words
      // and neither is the one meant. Anchored to the full weekday-day-month shape `formatDay`
      // emits, which is what makes it safe to apply to arbitrary text: a bare "Sun" or "Mar" in
      // a sentence is left alone, because "the Sun is out" must not become "the Sunday is out".
      .replace(
        /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/g,
        (all, day: string, date: string, month: string) => {
          const weekday = WEEKDAYS[day];
          const name = MONTHS[month];
          return weekday === undefined || name === undefined ? all : `${weekday} ${date} ${name}`;
        },
      )
      // A RANGE is said "to" — the one context where a dash's meaning is unambiguous, and so
      // the only one that gets a word rather than a comma.
      //
      // All three rules below match the EN dash (–) and deliberately not the em dash (—),
      // because calendar/format.ts uses the two for different jobs and the distinction turns
      // out to be load-bearing: `formatWhen` joins the ends of a range with an en dash, while
      // `formatSchedule` separates a time from its title, and a title from its guests, with an
      // em dash. Matching both turned "3 to 4 PM — Design review" into "3 to 4 PM to Design
      // review". An em dash is a field separator here, so it falls through to the comma rule.
      .replace(
        /(\d{1,2}(?::\d{2})?(?:\s*[AP]M)?)\s*–\s*(\d{1,2}(?::\d{2})?\s*[AP]M)/g,
        "$1 to $2",
      )
      // "3:00" is said "three", not "three oh oh". Half past keeps its minutes.
      .replace(/\b(\d{1,2}):00\b/g, "$1")
      // The other two range shapes `formatWhen` produces: a dash straight after a meridiem
      // (a meeting crossing midnight) or after a day and month (a multi-day all-day event).
      .replace(/\b([AP]M)\s*–\s*/g, "$1 to ")
      .replace(
        /(\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December))\s*–\s*/g,
        "$1 to ",
      )
      // Parentheses are not voiced; a comma is how the aside is actually said.
      .replace(/\s*\(([^)]*)\)/g, ", $1")
      // A SPACED dash is a written pause; a comma is how it is said.
      .replace(/\s+[–—-]\s+/g, ", ")
      // And every REMAINING en or em dash, which the rules above leave behind. This was
      // originally the opposite rule — unspaced dashes were KEPT, on the theory that
      // "3:00–4:00 PM" would be voiced as "3 to 4". Recon proved that false in a way worth
      // recording: Piper does not mispronounce the character, it receives it as MOJIBAKE and
      // says the pieces. U+2013 is the bytes E2 80 93, and read as Windows-1252 that is
      // "â" + "€" + a quote — which is exactly the "a circumflex, euros" heard on the probe.
      // The encoding is the synthesizer's own bug to fix (spawn with PYTHONUTF8=1 and prove
      // it); this line is the belt to those braces, because a producer that forgets is
      // otherwise one character away from garbling a whole utterance.
      .replace(/[–—]/g, ", ")
      // The rest of the typographic punctuation this codebase and the model can emit, mapped to
      // ASCII for the same reason. NOT letters: mangling a name like "José" is worse than
      // risking its pronunciation, and the encoding fix is what actually solves that.
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, "")
      .replace(/ /g, " ")
      // The ellipsis every `narrate` string ends with ("Adding ... to your calendar…").
      .replace(/…/g, ".")
      // Emphasis, code ticks, and stray hashes (including "#design-team", which reads better
      // as "design team" than as "hash design team").
      .replace(/[*_`#]/g, "")
      // Emoji and pictographs: voiced inconsistently at best, and never part of the message.
      .replace(/\p{Extended_Pictographic}/gu, " ")
      // Straight quotes around a title add nothing spoken and can be voiced as "quote".
      .replace(/["]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.?!])/g, "$1")
      .replace(/(,\s*){2,}/g, ", ")
      .replace(/^[,\s]+/, "")
      .trim()
  );
}

const WEEKDAYS: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

// "Sep" and "Sept" are both real Intl en-GB output depending on the ICU version in the runtime,
// so both are listed rather than assuming this machine's.
const MONTHS: Record<string, string> = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  May: "May",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Sept: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};

// Give a fragment a terminal stop, so joined items are spoken as separate sentences instead of
// running together into one breathless line.
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return /[.?!,:;]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function join(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

// Split at the last sentence end that fits, else the last word break, else hard. Returns
// [head, tail]; tail is "" when the whole thing fitted.
function cut(text: string, max: number): [string, string] {
  if (text.length <= max) return [text, ""];

  const window = text.slice(0, max);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentenceEnd > 0) {
    return [text.slice(0, sentenceEnd + 1).trim(), text.slice(sentenceEnd + 1).trim()];
  }

  const wordEnd = window.lastIndexOf(" ");
  if (wordEnd > 0) {
    return [text.slice(0, wordEnd).trim(), text.slice(wordEnd).trim()];
  }
  return [window.trim(), text.slice(max).trim()];
}

function isPresent(value: string | null): value is string {
  return value !== null && value.length > 0;
}
