// Shared writing primitives behind `compose.ts` (Gmail replies, M10) and `composeNote.ts`
// (Notion notes, M11). What lives here is genuinely app-neutral — sounding like the user,
// the standing rule against inventing content, and the guard against writing nothing into a
// real document.
//
// Everything about the SHAPE of what gets written stays in each app's own file, because M11
// found that shape does NOT transfer: a reply needs a greeting and a sign-off; a note appended
// to a page needs neither. Broadening one compose function to cover both would mean writing a
// single prompt that branches on which app it's for — exactly the coupling M10's original
// split (thinking/writing vs. finding/placing) was written to avoid.

// How the model is told to sound like the person it is writing for. Same fact `rewrite`,
// `compose.ts`, and `composeNote.ts` all use — a generated reply or note should not sound like
// a different person depending on which tool produced it.
export function voiceLine(tone: string): string {
  return `Write in this person's own voice: ${tone}.`;
}

// The standing rule against invention: never assert facts, names, dates, times, or
// commitments beyond what the source material and the instruction actually contain, and
// never invent the user's own opinions, feedback, requests, or stance either. `sourceLabel`
// names what "the source" is in the caller's own words (e.g. "email", "page's existing
// content or the material provided") so the rule reads naturally in either app's prompt.
export function noInventionClause(sourceLabel: string): string {
  return [
    "Do not invent facts, names, dates, times, or commitments that are not in the",
    `${sourceLabel} or the instruction: if a detail is missing, write around it rather than`,
    "guessing. Do not invent the user's opinions, feedback, requests, or stance either.",
  ].join(" ");
}

// Never write emptiness into a real document — that would silently erase whatever was there
// (a reply box, a page). Fail loudly instead, with a message the caller supplies so it can
// name the actual target, and leave that target exactly as it was.
export function requireNonEmpty(text: string, emptyMessage: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(emptyMessage);
  }
  return trimmed;
}
