import { noInventionClause, requireNonEmpty, voiceLine } from "./composeShared.ts";
import type { EmailMessage, LLMClient } from "./types.ts";

// The generalization of `rewrite` (M10). `rewrite` takes text and one fixed transform: "say
// this again, in this tone". This takes text, a FREE-FORM instruction, and a tone, and writes
// something new — a reply that answers the email rather than a restatement of it.
//
// It knows nothing about Gmail, browsers, or the clipboard: content in, text out. That is
// deliberate. Update 3's split says the thinking/writing half of this feature is app-agnostic
// and the "find the reply box" half is not, so the app-agnostic half lives here, alone, and a
// future clipboard-only compose tool can call it unchanged.
//
// M11 split what was genuinely shared with `composeNote.ts` (Notion notes) into
// `composeShared.ts` — sounding like the user, the standing rule against inventing content,
// the empty-output guard. What stays HERE is a reply's own shape: a greeting, a sign-off, no
// subject line, and the judgment call about vague instructions on a one-way notification
// email. None of that transfers to a Notion note, which has no greeting or sign-off to begin
// with — see composeNote.ts's own comment for why that shape was not generalized.

export interface ComposeRequest {
  // What the user actually said: "reply and say I can't make Tuesday, propose Thursday".
  instruction: string;
  // From memory (subject `tone`). Same fact `rewrite` uses, so a reply sounds like the user
  // for the same reason a rewrite does.
  tone: string;
  // The email being answered.
  source: EmailMessage;
  // Set on a revision. When present the instruction edits THIS text rather than starting over
  // from the email — which is what makes "make it shorter" mean shorter *than the last draft*.
  previousDraft?: string;
  // Real names, when available, so the greeting/sign-off can use them instead of falling back
  // to the neutral wording below. Never required — absent means "stay neutral," not "guess".
  recipientName?: string | null;
  userName?: string | null;
}

// The SHAPE of a reply specifically — greeting, sign-off, no subject line, no quoted
// original. What to avoid INVENTING lives in composeShared's `noInventionClause` instead:
// M11 found that part really is app-neutral, but this part is not — a Notion note has
// neither a greeting nor a sign-off to include or omit.
const REPLY_FORM_RULES = [
  "Output only the reply body — no subject line, no quoted original, no commentary about",
  "what you did. Include a brief, natural greeting at the start and a brief sign-off at the",
  "end, the way a person would open and close a real email — but never invent a name for",
  "either one (not the recipient's, not the user's own) unless it is explicitly given in the",
  "email or the instruction. Use a neutral greeting like 'Hi,' or 'Hello,' and a neutral",
  "sign-off like 'Thanks,' or 'Best regards,' when no real name is available.",
].join(" ");

// What to do when the instruction gives no specific content: an email-specific judgment call
// (is this a one-way notification with nothing to actually answer?) that has no Notion
// equivalent, so it stays here rather than in composeShared.
const VAGUE_INSTRUCTION_RULE = [
  "If the instruction gives no specific content and the email is a one-way notification,",
  "newsletter, digest, or automated message with no direct question or request aimed at the",
  "user, write a brief, neutral acknowledgment only. Save substantive, specific content for",
  "emails that actually ask the user something, or instructions that actually say what to",
  "write.",
].join(" ");

const BASE_RULES = [
  REPLY_FORM_RULES,
  noInventionClause("email"),
  VAGUE_INSTRUCTION_RULE,
].join(" ");

function namesFor(request: ComposeRequest): string {
  const parts: string[] = [];
  if (request.recipientName)
    parts.push(`Address the recipient as ${request.recipientName}.`);
  if (request.userName) parts.push(`Sign off as ${request.userName}.`);
  return parts.join(" ");
}

function systemFor(request: ComposeRequest): string {
  const voice = voiceLine(request.tone);
  const names = namesFor(request);
  if (request.previousDraft !== undefined) {
    // Revision framing. The model is told plainly that a draft already exists and that the new
    // instruction is an EDIT — without this it tends to answer the original email again, which
    // reads to the user as "my tweak was ignored".
    return [
      "You are revising a reply the user has already drafted to an email.",
      "Apply their change to the existing draft. Keep everything they did not ask you to change,",
      "including any wording they edited themselves.",
      voice,
      names,
      BASE_RULES,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }
  return [
    "You write a reply to an email on the user's behalf, following their instruction exactly.",
    voice,
    names,
    BASE_RULES,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function describe(email: EmailMessage): string {
  const header = [
    email.from ? `From: ${email.from}` : null,
    email.to ? `To: ${email.to}` : null,
    email.subject ? `Subject: ${email.subject}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return header.length > 0 ? `${header}\n\n${email.body}` : email.body;
}

export async function composeReply(
  llm: LLMClient,
  request: ComposeRequest,
): Promise<string> {
  const sections = [`THE EMAIL BEING REPLIED TO:\n${describe(request.source)}`];
  if (request.previousDraft !== undefined) {
    sections.push(`THE CURRENT DRAFT REPLY:\n${request.previousDraft}`);
  }
  sections.push(`THE USER'S INSTRUCTION:\n${request.instruction}`);

  const text = await llm.complete(
    systemFor(request),
    sections.join("\n\n---\n\n"),
  );
  return requireNonEmpty(
    text,
    "The model returned an empty reply — nothing was written to the reply box.",
  );
}
