import { noInventionClause, requireNonEmpty, voiceLine } from "./composeShared.ts";
import type { LLMClient } from "./types.ts";

// Notion's half of the M11 split. `compose.ts` writes replies to an email; this writes
// content to append to a Notion page — the same shape as `composeReply` (instruction + tone
// + source material → text, guarded against emptiness) but with none of a reply's furniture.
// A note has no greeting and no sign-off, because it never had one to begin with: it is prose
// landing inside a document, not a message addressed to anyone.
//
// It knows nothing about Notion, browsers, or the CDP layer: content in, text out, exactly
// like compose.ts. Only the finding-and-placing half (core/notion/) is Notion-specific.
//
// This module was NOT produced by broadening compose.ts's `ComposeRequest` to cover both
// apps. `compose.ts`'s BASE_RULES mandates a greeting and sign-off and forbids a subject
// line — all meaningless for a page. Sharing one function would mean one prompt that
// branches on which app it's writing for, which is the coupling the M10 split (thinking/
// writing vs. finding/placing) was written to avoid. What genuinely IS shared — sounding
// like the user, refusing to invent content, refusing to write emptiness — lives in
// composeShared.ts and both files import it.

export interface NoteDestination {
  // The page's own title, when known, so the model writes IN CONTEXT of what page this is.
  title: string | null;
  // What is already on the page, so the model does not repeat or contradict it. Capped by
  // the caller (the tool handler) if needed — this module has no opinion on page size.
  existing: string;
}

export interface ComposeNoteRequest {
  // What the user actually said: "add a note that the launch is pushed to Friday".
  instruction: string;
  // From memory (subject `tone`). Same fact `compose.ts` and `rewrite` use, so a note sounds
  // like the user for the same reason a reply does.
  tone: string;
  // Clipboard content captured at trigger time (context.selectedText), when there is any —
  // the same source `summarize` and `rewrite` read. Null when nothing was selected.
  material: string | null;
  // The page being written to. There is deliberately no `previousDraft` field: unlike a
  // Gmail reply, a note has no revision path — see risk.ts / registry.ts for why.
  destination: NoteDestination | null;
}

// The SHAPE of a note specifically — no greeting, no sign-off, no repeating what is already
// there. What to avoid INVENTING lives in composeShared's `noInventionClause` instead.
const NOTE_FORM_RULES = [
  "Output only the content to add to the page — no greeting, no sign-off, no commentary",
  "about what you did, and never repeat or restate content that is already on the page.",
  "Write plain, natural prose, or a short list if a list genuinely fits the instruction",
  "better. Do not invent headings or structure the instruction did not ask for.",
].join(" ");

function systemFor(request: ComposeNoteRequest): string {
  const voice = voiceLine(request.tone);
  return [
    "You add content to the end of a Notion page on the user's behalf, following their",
    "instruction exactly. What you write is APPENDED after everything already on the page —",
    "it can never replace, rewrite, or remove anything that is already there.",
    voice,
    NOTE_FORM_RULES,
    noInventionClause("page's existing content or the material provided"),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function describeDestination(destination: NoteDestination): string {
  const header = destination.title ? `Page: ${destination.title}\n\n` : "";
  const existing = destination.existing.trim();
  return (
    `${header}EXISTING CONTENT ON THE PAGE (context only — do not repeat it, and never ` +
    `remove or rewrite it):\n${existing.length > 0 ? existing : "(the page is currently empty)"}`
  );
}

export async function composeNote(
  llm: LLMClient,
  request: ComposeNoteRequest,
): Promise<string> {
  const sections: string[] = [];
  if (request.destination !== null) {
    sections.push(describeDestination(request.destination));
  }
  if (request.material !== null && request.material.trim().length > 0) {
    sections.push(`MATERIAL TO DRAW ON (from the clipboard):\n${request.material}`);
  }
  sections.push(`THE USER'S INSTRUCTION:\n${request.instruction}`);

  const text = await llm.complete(systemFor(request), sections.join("\n\n---\n\n"));
  return requireNonEmpty(
    text,
    "The model returned an empty note — nothing was written to the page.",
  );
}
