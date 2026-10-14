import { UnresolvedReferenceError, UserFixableError } from "../errors.ts";
import { checkReference } from "../memory/checkReference.ts";
import { hasPlaceholder } from "../chain.ts";
import type {
  CapturedContext,
  ChannelDirectory,
  ChannelLookup,
  Memory,
  StepCheckDeps,
  PrepareDeps,
  Tool,
  ToolDeps,
  ToolInput,
} from "../types.ts";

// What the formatter says when it was handed nothing to format. A fixed word rather than a
// sentence, so it can be recognised exactly instead of guessed at.
const NO_NOTES = "NO_NOTES";

// Exported for tests/eval/sendFormatter.eval.test.ts, which puts it to the real model.
export const FORMAT_SYSTEM = [
  "You format rough notes into a clean message to post in a team chat channel.",
  "Keep every concrete detail (names, dates, numbers, decisions, owners). Add nothing new.",
  "Use short lines or bullets. No preamble, no sign-off, no commentary — output only the message.",
  // M21 live finding. Handed the user's own instruction instead of notes ("send these notes to
  // the bugs channel"), the formatter replied "Please paste the rough notes you want formatted
  // for the #bugs channel." — and that reply was posted to Slack. It has no one to ask: its
  // output IS the message.
  //
  // WORDED AROUND "NOTHING TO TELL ANYONE", after the first wording ("only an instruction to
  // send something") was measured refusing a real note: "remind everyone the deploy is at 5pm
  // today" came back NO_NOTES 2 of 2. That text is phrased as an order and still carries the
  // whole message. What makes the live input empty is that it names notes and does not GIVE
  // them (tests/eval/sendFormatter.eval.test.ts).
  "You cannot ask the user anything: whatever you output is posted as the message. Text phrased",
  "as a request — 'remind everyone the deploy is at 5', 'tell them standup moved' — still",
  "carries information: turn it into the message. Only when the text contains nothing to tell",
  "anyone — it is empty, or it merely says to send or post some notes without giving them, like",
  `'send these notes to the team' — output exactly ${NO_NOTES} and nothing else.`,
].join(" ");

// --- Is this a message, or the formatter asking for one? ---
//
// HOW IT DECIDES, in order. The reply is NOT a message when:
//
//   1. it is empty, or is the word the formatter is told to use (NO_NOTES, any case); or
//   2. it talks about the notes THEMSELVES as something missing or wanted. One sentence must
//      contain BOTH a word for the material — notes, text, content, message, details — and
//      either a request for it addressed to the reader (paste / provide / share / send / give /
//      supply … "you want", "you'd like", "to format", "to send"; or "what/which notes … would
//      you like / do you want / should I"), or a statement that there is none ("no notes
//      provided", "any notes to format", "don't see … notes").
//
// Deliberately NOT a rule: "it is a question" or "it says please". Real messages do both —
// "Can everyone review the PR by Friday?", "Please send your timesheets to Dana by 5." — and
// refusing those would make the tool useless for exactly what it is for. The rule is about the
// notes being asked FOR, which a message to a team is essentially never about.
//
// IT CAN BE WRONG IN ONE DIRECTION ON PURPOSE. A genuine message such as "Please share the
// notes you want reviewed" would be refused. That costs a rephrase and sends nothing; the other
// mistake posts the app's own confusion to a channel of people.
const MATERIAL = "(?:notes?|text|content|message|details)";
const ASKS_FOR_NOTES = [
  new RegExp(
    `\\b(?:paste|provide|share|send|give|supply)\\b[^.?!\\n]*\\b${MATERIAL}\\b[^.?!\\n]*\\b(?:you want|you'd like|you would like|to format|to send|to post|formatted)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:what|which)\\b[^.?!\\n]*\\b${MATERIAL}\\b[^.?!\\n]*\\b(?:would you like|do you want|you want|you'd like|should I)\\b`,
    "i",
  ),
  new RegExp(`\\b(?:no|any)\\b(?: rough)? ${MATERIAL}\\b[^.?!\\n]*\\b(?:provided|included|given|found|to format|to send)\\b`, "i"),
  new RegExp(`\\b(?:don't|do not|didn't|did not|can't|cannot) see\\b[^.?!\\n]*\\b${MATERIAL}\\b`, "i"),
];

export function isMessage(reply: string): boolean {
  const text = reply.trim();
  if (text.length === 0 || text.toUpperCase() === NO_NOTES) return false;
  return !ASKS_FOR_NOTES.some((pattern) => pattern.test(text));
}

export type ChannelCheck = { ok: true; channel: string } | { ok: false; reason: string };

// Is this somewhere we can name? THE ONE PLACE THAT DECIDES, asked by the confirm summary and
// again by the handler, so the dialog and the send cannot disagree about where a message goes.
//
// The rule is `checkReference`'s (core/memory/checkReference.ts) — a literal is taken as given,
// a reference must resolve. What this adds is the WORDING: when we do not know where this would
// go, say which words we could not place rather than send somewhere wrong.
//
// Inside the planner `channel` arrives already resolved (`referenceArgs` below), and this is
// then the check that it WAS: a resolved channel is a literal and passes; one memory did not
// know still reads like a reference, is looked up again, and is refused.
export function checkChannel(value: unknown, memory: Pick<Memory, "resolve">): ChannelCheck {
  const check = checkReference(value, memory);
  if (check.ok) return { ok: true, channel: check.value };
  if (check.why === "empty") {
    return { ok: false, reason: "I don't know which channel to send to." };
  }
  return {
    ok: false,
    reason: `I don't know which channel "${check.said}" means — teach me with: remember ${check.said} is #your-channel.`,
  };
}

// A memory with nothing in it: under it `checkChannel` accepts a literal and nothing else.
const NOTHING_KNOWN: Pick<Memory, "resolve"> = { resolve: () => null };

// The channel, or an honest "I don't know that yet" — a refusal the planner shows verbatim.
// Asks only for a memory it can READ, so `prepare` — which is handed nothing else — can use it.
function knownChannel(input: ToolInput, deps: { memory: Pick<Memory, "resolve"> }): string {
  const check = checkChannel(input["channel"], deps.memory);
  if (!check.ok) throw new UnresolvedReferenceError(check.reason);
  return check.channel;
}

// --- Saying where a message goes, honestly ---
//
// A Slack app webhook posts to the one channel it was created for and ignores the channel it is
// handed. So the channel the user ASKED for — resolved, checked, confirmed — is not where the
// message lands, and through M20 every text here said that it was: "Send to #help?" and then
// "Sent to #help." about a message that went to #social.
//
// The three functions below are the only places a destination is worded. They take the asked
// channel and what the sender says it really posts to (`MessageSender.postsTo`), and the rule
// is the same for the question, the result and the failure:
//
//   - the destination named is the webhook's own channel, or — when the app has not been told
//     what that is — no channel at all, only "your Slack webhook"
//   - the asked channel appears in ONE place: a parenthesised second line, present whenever it
//     is not the channel the message is actually going to
//
// Channel NAMES only start to mean something with one webhook per channel, which is the next
// milestone; until then this is the most that can be said truthfully.

// "to #social via your Slack webhook" — or, not knowing the channel, "via your Slack webhook".
function destination(postsTo: string | null): string {
  return postsTo === null ? "via your Slack webhook" : `to ${postsTo} via your Slack webhook`;
}

// The same channel, however it was typed: "#Social", "social" and " #social " are one place.
function sameChannel(a: string, b: string): boolean {
  const bare = (name: string): string => name.trim().replace(/^#/, "").toLowerCase();
  return bare(a) === bare(b);
}

// The second line, or null when there is nothing to correct.
function askedNote(asked: string, postsTo: string | null): string | null {
  if (postsTo === null) {
    return `(You asked for ${asked}. A webhook posts to its own channel and ignores this.)`;
  }
  return sameChannel(asked, postsTo)
    ? null
    : `(You asked for ${asked}; the webhook posts to its own channel.)`;
}

function withNote(headline: string, asked: string, postsTo: string | null): string {
  const note = askedNote(asked, postsTo);
  return note === null ? headline : `${headline}\n${note}`;
}

// Where this sender really posts, as far as it can say.
function postsTo(deps: ToolDeps): string | null {
  return deps.sender.postsTo ?? null;
}

// --- Bot mode (M22): the channel asked for is the channel posted to ---
//
// With a bot token the message goes to the channel that was asked for, so the texts can finally
// say "Send to #help?" and mean it — but only for a channel Slack itself says exists. Every bot-
// mode path asks the directory (Slack's own channel list) and refuses, BEFORE any dialog, a name
// it does not have. The name shown and handed to the sender is SLACK'S name for the channel, never
// the words typed.
//
// Bot mode is exactly `sender.mode === "bot"`. A sender that says nothing is a webhook, as every
// sender was before M22 — so the webhook texts above are reached by exactly the paths that
// reached them in M21, and are not touched.
function isBotMode(deps: ToolDeps): boolean {
  return deps.sender.mode === "bot";
}

// Fails closed: bot mode with no directory to ask is not a reason to send unchecked.
const NO_DIRECTORY = "I couldn't check Slack channels, so nothing was sent.";

// Said by a chain's pre-flight (M22) when the plan would take the channel from an earlier step's
// result — an email's words, a summary's. In bot mode that would let something the user never
// typed choose where a message goes, so the plan is refused before step 1.
const CHANNEL_FROM_A_STEP =
  "In bot mode I need you to name the Slack channel yourself, not take it from an earlier step, so nothing was done.";

// The channel as the user will recognise it: "#help", whether "help", "#help" or " #help " was
// given. One "#" is stripped, as the directory does.
function hashed(channel: string): string {
  const trimmed = channel.trim();
  return `#${trimmed.startsWith("#") ? trimmed.slice(1) : trimmed}`;
}

// The closest real names, as a STATEMENT, not a question (M22 prompt 6). A refusal ending in
// "Did you mean …?" read as a question waiting for an answer — to the user, and to the model, which
// is shown the refusal as the previous turn — when nothing was waiting. Only the app's own
// question (`askUser`) may ask anything.
function similarChannels(suggestions: readonly string[]): string {
  const names = suggestions.slice(0, 3).map((name) => `#${name}`);
  return names.length === 0 ? "" : ` Similar channels: ${names.join(", ")}.`;
}

// THE ONE PLACE these refusals are worded (M22), for every caller: a send's checks, a chain's
// pre-flight, the answer to "which channel do you mean?", and `remember`. `typed` is the channel as
// it was given; the lookup is the directory's answer for it. `nothing` is what did not happen:
// "sent" for a send (the default, and every send path's words), "saved" for `remember`.
//
// One fixed sentence per outcome. Nothing Slack or an HTTP client said reaches it — the directory
// hands over a code and names, never text.
export function slackRefusalText(
  lookup: Exclude<ChannelLookup, { ok: true }>,
  typed: string,
  nothing: "sent" | "saved" = "sent",
): string {
  if (lookup.reason === "not_found") {
    return (
      `I couldn't find a Slack channel called ${hashed(typed)}. I can post to public channels and ` +
      `to private channels the bot has been added to.${similarChannels(lookup.suggestions)}`
    );
  }
  const tail = `so nothing was ${nothing}.`;
  switch (lookup.failure) {
    case "no_token":
    case "auth":
      return `Slack rejected the bot token, ${tail}`;
    case "network":
    case "timeout":
    case "slack_error":
    case "bad_response":
      return `I couldn't reach Slack to check the channel, ${tail}`;
    case "rate_limited":
      return `Slack is rate limiting me, ${tail}`;
    case "ambiguous":
      return `More than one Slack channel is called ${hashed(typed)}, ${tail}`;
  }
}

// "social channel" → "social"; "#social channel" → "#social" (M22 prompt 7). Only a trailing
// standalone word "channel" is dropped, whatever its case, and a leading "#" is kept. Null when
// there is no such word, or nothing would be left ("channel" on its own). "social chanel" is not
// touched: a near spelling is never corrected.
export function withoutChannelSuffix(name: string): string | null {
  const trimmed = name.trim();
  const bare = trimmed.replace(/\s+channel$/i, "");
  if (bare === trimmed) return null;
  return bare.replace(/^#/, "").trim().length > 0 ? bare : null;
}

// "new channel" → "new-channel"; "all wicky micky" → "all-wicky-micky" (M22 prompt 11). Slack
// channel names cannot contain spaces, so every run of whitespace becomes one hyphen. Null when
// there is no whitespace to turn: nothing to retry.
export function hyphenated(name: string): string | null {
  const trimmed = name.trim();
  return /\s/.test(trimmed) ? trimmed.replace(/\s+/g, "-") : null;
}

// Slack's answer for a channel NAME, as every bot-mode check asks it (M22 prompts 7 and 11).
//
//   1. Exactly as given. A channel, or Slack unable to answer, is the answer.
//   2. Only when Slack has no such channel: the other ways people write a channel name, each
//      looked up EXACTLY — without a trailing word "channel" ("social channel" → #social), with
//      spaces as hyphens ("new channel" → #new-channel), and both ("all wicky micky channel").
//      ALL of them are asked, and:
//        - none is a channel: the FIRST answer stands, with suggestions for what was typed;
//        - they lead to ONE channel (however many spellings reach it): that channel;
//        - they lead to TWO different channels: refused as ambiguous — "social channel" with both
//          #social and #social-channel is a choice between two real channels, never made for you;
//        - Slack could not answer one of them: that, never a guess.
//
// Nothing is saved by a retry, and nothing near is ever taken: every check is an exact match.
export async function resolveSlackName(directory: ChannelDirectory, name: string): Promise<ChannelLookup> {
  const first = await directory.resolve(name);
  if (first.ok || first.reason !== "not_found") return first;

  const withoutSuffix = withoutChannelSuffix(name);
  const spellings = [
    withoutSuffix,
    hyphenated(name),
    withoutSuffix === null ? null : hyphenated(withoutSuffix),
  ].filter((spelling): spelling is string => spelling !== null && spelling !== name.trim());

  const found = new Map<string, Extract<ChannelLookup, { ok: true }>>();
  for (const spelling of new Set(spellings)) {
    const lookup = await directory.resolve(spelling);
    if (lookup.ok) found.set(lookup.channel.id, lookup);
    else if (lookup.reason === "unavailable") return lookup;
  }

  const [only, ...others] = [...found.values()];
  if (only === undefined) return first;
  if (others.length > 0) return { ok: false, reason: "unavailable", failure: "ambiguous" };
  return only;
}

// Slack's own name for this channel, or a refusal in the same class `checkChannel` refuses with
// (`UnresolvedReferenceError`), so the planner shows it as the tool's words and logs `refused`.
async function slackChannelName(channel: string, directory: ChannelDirectory | undefined): Promise<string> {
  if (directory === undefined) throw new UserFixableError(NO_DIRECTORY);
  const lookup = await resolveSlackName(directory, channel);
  if (lookup.ok) return lookup.channel.name;
  throw new UnresolvedReferenceError(slackRefusalText(lookup, channel));
}

// "the help channel" → "help channel"; "my design channel" → "design channel". Only a leading
// the / my / our is dropped; `resolveSlackName` then tries the rest as written, without
// "channel", and with spaces as hyphens (M22 prompt 11 — so "the new channel" can be
// #new-channel). Null when nothing is left.
export function withoutArticle(reference: string): string | null {
  const bare = reference
    .trim()
    .replace(/^(?:the|my|our)\s+/i, "")
    .trim();
  return bare.length > 0 ? bare : null;
}

// The channel a value means IN BOT MODE, as Slack names it (M22) — or a refusal.
//
//   1. Memory first, by the M21 rule (`checkReference`): a literal is taken as given, a "the …"
//      phrase memory knows becomes what memory says. Either way the result is then checked in
//      Slack: a saved name Slack no longer has is refused with suggestions, and is NOT forgotten.
//   2. A "the …" phrase memory does NOT know is tried in Slack, EXACTLY, with "the" dropped and
//      the spellings `resolveSlackName` tries — "the help channel" is #help if Slack has #help,
//      "the new channel" is #new-channel. Never a near match, and never saved: the dialog still
//      names the channel before anything is sent.
//   3. Otherwise the M21 refusal ("teach me with: remember …"), unchanged.
async function botChannelName(
  value: unknown,
  memory: Pick<Memory, "resolve">,
  directory: ChannelDirectory,
): Promise<string> {
  const check = checkReference(value, memory);
  if (check.ok) return await slackChannelName(check.value, directory);
  if (check.why === "unresolved") {
    const bare = withoutArticle(check.said);
    if (bare !== null) {
      const lookup = await resolveSlackName(directory, bare);
      if (lookup.ok) return lookup.channel.name;
      // Slack could not be asked: refuse rather than guess. A plain "no such channel" falls through
      // to the M21 words, which say how to teach it.
      if (lookup.reason === "unavailable") throw new UnresolvedReferenceError(slackRefusalText(lookup, bare));
    }
  }
  const refusal = checkChannel(value, memory);
  throw new UnresolvedReferenceError(refusal.ok ? NO_DIRECTORY : refusal.reason);
}

// The directory, when this install is in bot mode — a bot sender AND a directory — else null.
function botDirectory(deps: StepCheckDeps): ChannelDirectory | null {
  return deps.senderMode === "bot" && deps.channelDirectory !== undefined ? deps.channelDirectory : null;
}

// The confirm question in bot mode: the real destination, then the whole message. No note: the
// channel asked for IS the channel posted to.
async function botConfirmSummary(args: ToolInput, deps: ToolDeps): Promise<string> {
  if (deps.channelDirectory === undefined) throw new UserFixableError(NO_DIRECTORY);
  const name = await botChannelName(args["channel"], deps.memory, deps.channelDirectory);
  const question = `Send to #${name}?`;
  const text = sourceText(args, deps);
  return text ? `${question}\n\n${text}` : question;
}

// The send in bot mode. The channel is checked again — the dialog's answer does not travel here —
// and the sender is handed Slack's name for it, which it resolves to an ID once more itself.
//
// Inside a chain this is reached only for a channel the pre-flight checked AS WRITTEN: a channel
// that would have come from an earlier step was refused before step 1 (`preflight` below).
async function botHandler(input: ToolInput, deps: ToolDeps): Promise<string> {
  if (deps.channelDirectory === undefined) throw new UserFixableError(NO_DIRECTORY);
  const name = await botChannelName(input["channel"], deps.memory, deps.channelDirectory);

  const text = sourceText(input, deps);
  if (!text || text.trim().length === 0) throw new UserFixableError(NOTHING_TO_SEND);

  const result = await deps.sender.send(`#${name}`, text);
  if (result.ok) return `Sent to #${name}.\n\n${text}`;
  // Slack said no outright: nothing was posted, and its reason is one of the sender's fixed texts.
  if (result.outcome === "not_sent") {
    throw new Error(`Could not send to #${name}: ${result.error ?? "Slack rejected the message."}`);
  }
  // Unknown — and a failure that does not say is treated as unknown. It may be in the channel, so
  // the user is told to look before doing anything, and never invited to send it again.
  throw new Error(
    `Could not confirm the message to #${name}. It may have been sent. Check Slack before trying again.`,
  );
}

// The text this call is about: `notes` when there are any, otherwise what the user "selected" —
// which in this app means the CLIPBOARD (spec §4), so it is rarely empty and not always
// relevant. ONE function, used by `prepare`, the confirm summary and the handler, so they cannot
// disagree about what is being sent.
function sourceText(input: ToolInput, deps: { context: CapturedContext }): string | null {
  const notes = input["notes"];
  return typeof notes === "string" && notes.trim().length > 0 ? notes : deps.context.selectedText;
}

// The message the user gave IN THE INSTRUCTION, or null when they gave none.
//
// `notes` is where the model puts words the user asked to have sent — `send "helluuu" to the
// team`, `tell them saying we ship friday`. Those are the user's message, and are returned
// exactly as written.
//
// One thing can be in `notes` that is not a message: the INSTRUCTION ITSELF. Asked to "send
// these notes to the bugs channel" with nothing to send, the model has copied that whole
// sentence into `notes` (action-log rows 417 and 419). That is recognised here, by comparing
// the two — case, spacing, surrounding quotes and a closing run of `.`, `!` or `?` aside — and
// treated as no notes at all. Only the WHOLE instruction is an echo: a part of it is exactly
// what a quoted message is.
//
// Quotes are stripped first, then the closing punctuation, once each. Two echoes are therefore
// NOT recognised, and are known and left alone (spec §6): punctuation after a closing quote
// (`"send these notes to the bugs channel"!`) and the single ellipsis character (`…`). Both
// would be shown in the dialog as the message, where the user can cancel.
//
// A comparison, not a judgement. Nothing here asks what the words mean or whether they look
// like notes, a question or a command — that is the user's business, and they will see them in
// the dialog before anything is sent.
function messageFromInstruction(input: ToolInput, instruction: string): string | null {
  const notes = input["notes"];
  if (typeof notes !== "string" || notes.trim().length === 0) return null;
  const bare = (text: string): string =>
    text
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/[.!?]+$/, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return bare(notes) === bare(instruction) ? null : notes;
}

const NOTHING_TO_SEND =
  "There's nothing to send. Copy the notes first (select them and press Ctrl+C), or put them in " +
  'the instruction — for example: send "standup moved to 3pm" to the team.';

// Said when the formatter did not produce a message. Its own words are NOT repeated: they are a
// model's, addressed to nobody, and showing them as the app's would be the bug in a new place.
const NOT_A_MESSAGE =
  "I didn't send anything: what I was given to send wasn't notes, so there was no message to " +
  "make from it. Copy the notes you want sent (select them and press Ctrl+C), or put them in " +
  "the instruction, then ask again.";

// Task 5 (spec.md §6): format notes and send them to Slack. THE FIRST `dangerous` TOOL (§risk) —
// it cannot be undone, so the planner forces it through shell.confirm() before the handler runs.
// The Slack call goes through the injected MessageSender, so tests never touch real Slack.
export const sendMessageTool: Tool = {
  name: "sendMessage",
  description:
    "Format the user's notes into a clean message and send it to a team chat channel. Use this " +
    "when the user asks to send, post, share, or message notes to a channel or a group of people. " +
    "Pass `channel` exactly as the user referred to it (e.g. 'the team', '#design-team') — it will " +
    "be resolved against their saved facts. Put the raw notes in `notes` if they are in the " +
    "instruction; otherwise the user's selected text is used. When the user gives the message " +
    "itself — in quotes, or after 'say' or 'saying' — put exactly those words in `notes`, " +
    "unchanged and without the quotes: they are sent as written, whatever else is on screen " +
    "(an open email, the clipboard). Never put the instruction itself in `notes`, and never " +
    "copy clipboard text into it. As a step in a plan, `notes` is " +
    "sent EXACTLY as written once any {stepN} is filled in — nothing reformats it — so write " +
    "the whole message you want posted, e.g. 'New bug filed: {step2}'.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description:
          "The destination channel, as the user referred to it (e.g. 'the team', '#design-team').",
      },
      notes: {
        type: "string",
        description:
          "The message or notes the user gave in the instruction, word for word. Omit to use " +
          "the user's selected text.",
      },
    },
    required: ["channel"],
  },
  risk: "dangerous",
  background: "ok",
  confirmLabel: "Send",
  // Only `channel` is a reference. `notes` is the user's message, to be sent as written — left
  // undeclared, a body that read "the team" was swapped for the fact it named.
  referenceArgs: ["channel"],
  // And the one reference worth ASKING about rather than refusing: a chain that names a channel
  // nobody has taught the app is one typed word away from being runnable.
  //
  // `accept` is `checkChannel` with a memory that knows NOTHING, on purpose. The question asked
  // for the channel's name, so the answer has to be one — an empty line is not, and neither is
  // another reference ("the team"), even one memory could resolve: saving one reference as the
  // meaning of another is how a fact goes stale without anyone noticing.
  askForReference: {
    channel: {
      question: (reference) => `Before I start: which channel do you mean by '${reference}'?`,
      retry: (reference) =>
        `I need the channel's own name, like #bugs. Which channel do you mean by '${reference}'?`,
      // In bot mode (M22) the answer must also be a channel Slack has, and what is saved is
      // Slack's own name for it, "#help" — checked BEFORE the planner saves anything. A name Slack
      // does not have is asked about again, with what it does have; an answer that cannot be
      // checked at all refuses the plan and saves nothing. In webhook mode: M21 exactly.
      accept: async (answer, reference, deps) => {
        const check = checkChannel(answer, NOTHING_KNOWN);
        if (!check.ok) return { kind: "rejected" };
        const directory = botDirectory(deps);
        if (directory === null) return { kind: "accepted", value: check.channel };
        const lookup = await resolveSlackName(directory, check.channel);
        if (lookup.ok) return { kind: "accepted", value: `#${lookup.channel.name}` };
        if (lookup.reason === "not_found") {
          return {
            kind: "rejected",
            retry: `${slackRefusalText(lookup, check.channel)} Which channel do you mean by '${reference}'?`,
          };
        }
        return { kind: "refused", reason: slackRefusalText(lookup, check.channel) };
      },
      // Bot mode (M22): "the help channel", unknown to memory, is #help when Slack has exactly
      // #help — found without asking, and NOT saved. Anything less than an exact match is asked
      // about as before; Slack unreachable refuses rather than guesses.
      // Bot mode (M22 prompt 7): a LONE send asks too — "send these notes to the second channel"
      // gets the same question a chain would, instead of "teach me with: remember …". In webhook
      // mode it does not, and the lone send is refused in its own words as in M21.
      askWhenAlone: (deps) => botDirectory(deps) !== null,
      lookup: async (reference, deps) => {
        const directory = botDirectory(deps);
        const bare = withoutArticle(reference);
        if (directory === null || bare === null) return { kind: "unknown" };
        const lookup = await resolveSlackName(directory, bare);
        if (lookup.ok) return { kind: "found", value: `#${lookup.channel.name}` };
        if (lookup.reason === "not_found") return { kind: "unknown" };
        return { kind: "refused", reason: slackRefusalText(lookup, bare) };
      },
    },
  },
  // A chain's own check of this step, on the plan AS WRITTEN, before step 1 (M22, bot mode only).
  //
  //   - A channel taken from an earlier step (`{stepN}`) is refused: an email's or a summary's
  //     words must not choose where a message goes. This is the one place that can still see the
  //     placeholder — by the time the step runs, it has been filled in.
  //   - Any other channel is resolved exactly as the step will resolve it (`botChannelName`) and
  //     must be one Slack has. A plan that would create an issue and then fail to say so is
  //     refused before the issue exists.
  //
  // In webhook mode it does nothing, and the chain runs as in M21.
  preflight: async (args: ToolInput, deps: StepCheckDeps): Promise<string | null> => {
    if (deps.senderMode !== "bot") return null;
    const directory = botDirectory(deps);
    if (directory === null) return NO_DIRECTORY;
    const channel = args["channel"];
    if (typeof channel === "string" && hasPlaceholder(channel)) return CHANNEL_FROM_A_STEP;
    try {
      await botChannelName(channel, deps.memory, directory);
      return null;
    } catch (error) {
      if (error instanceof UserFixableError) return error.message;
      throw error;
    }
  },
  // THE MESSAGE IS SETTLED HERE, BEFORE ANYONE IS ASKED (M21, `Tool.prepare`).
  //
  // A lone send formats rough notes with a model. Through M20 that happened in the handler —
  // AFTER the dialog — so the dialog could only show a 140-character preview of the input (or
  // nothing, when the text came from the clipboard), and whatever the model produced was posted
  // unseen. Found live: with nothing useful to send, it produced "Please paste the rough notes
  // you want formatted for the #bugs channel." and Slack received that, twice.
  //
  // So for a lone send this does, in order, and refuses at the first that fails:
  //   1. the channel is one we can name (the same check the confirm and the handler make)
  //   2. a message the user GAVE IN THE INSTRUCTION is taken as written, and that is all
  //   3. otherwise the text is the clipboard's: there must be some
  //   4. and the formatter's reply to it must be a message, not a request for one (`isMessage`)
  // and returns the arguments with `notes` set to the exact text to post. The planner hands
  // those to the dialog and the handler, which show and send `notes` as they find it.
  //
  // WHERE THE TEXT CAME FROM DECIDES WHETHER IT IS FORMATTED (2026-10-11, live regression).
  // The first version formatted everything, `notes` included — so `send "helluuu" to social
  // channel` put the user's own quoted word through the formatter, which called it "nothing to
  // tell anyone" (NO_NOTES, 3 of 3) and the send was refused. A message the user dictated is
  // not rough notes: it is sent AS WRITTEN, with no model call and no opinion about what it
  // says. Formatting, and the judgement of the formatter's reply, are for clipboard text only —
  // text the user copied from somewhere and asked to have tidied.
  //
  // The cost, accepted on purpose: for clipboard text the dialog appears one model call later
  // than it used to, and a send that is then cancelled has still paid for that call.
  //
  // IN A CHAIN it does nothing at all. There `notes` is written by the plan and filled from
  // earlier steps ("New bug filed: {step2}"); it is already the exact text, and is shown in
  // full and sent verbatim exactly as it has been since M19.
  //
  // THE ORDER IS PART OF THE CONTRACT. The channel is checked FIRST, so a send that was never
  // going anywhere costs no model call; then that there is something to send; and only then is
  // the formatter asked. And it does nothing but ask: it is handed `PrepareDeps`, which holds no
  // sender, no shell and no way to write to memory.
  prepare: async (args: ToolInput, deps: PrepareDeps): Promise<ToolInput> => {
    if (deps.chained) return args;

    // Bot mode (M22): a channel Slack does not have is refused HERE — before the formatter is paid
    // for and before any dialog — and "the help channel", unknown to memory, may be Slack's #help.
    // The directory is handed to a prepare only in bot mode, so its presence is the signal; with
    // none, this is the M21 prepare exactly.
    if (deps.channelDirectory !== undefined) {
      await botChannelName(args["channel"], deps.memory, deps.channelDirectory);
    } else {
      knownChannel(args, deps);
    }

    // The user's own message: as written. `args` already carries it in `notes`, untouched.
    if (messageFromInstruction(args, deps.instruction) !== null) return args;

    // No message in the instruction (or only the instruction echoed back), so this is about
    // what was copied. Read from the clipboard directly — never through `notes`, which at this
    // point is either absent or the echo.
    const raw = deps.context.selectedText;
    if (raw === null || raw.trim().length === 0) throw new UserFixableError(NOTHING_TO_SEND);

    const formatted = (await deps.llm.complete(FORMAT_SYSTEM, raw, "format")).trim();
    if (!isMessage(formatted)) throw new UserFixableError(NOT_A_MESSAGE);

    return { ...args, notes: formatted };
  },
  // The planner has resolved `channel` by now, so the user approves the real destination — and
  // one it could NOT resolve is refused here, BEFORE the dialog (`checkChannel` asks memory
  // again and gets the same answer). Throwing from a confirm summary means nothing runs
  // and nothing is asked: the user is never shown "Send to the bugs channel?" and then told,
  // after pressing Send, that there is no such place.
  //
  // IT SHOWS THE WHOLE MESSAGE, AND THE HANDLER SENDS EXACTLY THAT — lone or chained. By the
  // time this runs, `notes` is the exact text to post (see `prepare`); nothing is previewed,
  // truncated or reformatted between this dialog and the send.
  //
  // WHAT THE QUESTION NAMES is where the message is really going — the webhook's channel, or
  // just "your Slack webhook" — and the channel that was asked for only as a note beneath it
  // (see "Saying where a message goes, honestly" above). The message stays after a blank line,
  // so the first paragraph, which is what gets spoken, is still the whole question.
  //
  // In bot mode (M22) the question is `botConfirmSummary`'s instead: Slack's own name for the
  // channel, checked against Slack's list before the dialog, and no webhook note. The webhook
  // path below is exactly M21's, and still synchronous.
  confirmSummary: (args: ToolInput, deps: ToolDeps): string | Promise<string> => {
    if (isBotMode(deps)) return botConfirmSummary(args, deps);
    const channel = knownChannel(args, deps);
    const where = postsTo(deps);
    const question = withNote(`Send ${destination(where)}?`, channel, where);
    const text = sourceText(args, deps);
    return text ? `${question}\n\n${text}` : question;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    // Bot mode (M22) checks the channel against Slack once more and words its own result.
    if (isBotMode(deps)) return await botHandler(input, deps);

    // Asked again rather than trusted: the confirm summary's answer does not travel here, and a
    // handler must not depend on a gate having run to know where it is sending.
    const channel = knownChannel(input, deps);

    // SENT AS IT IS FOUND. No model is called here, ever: the text the dialog showed is the
    // text that is posted. Formatting, when there is any, already happened in `prepare`.
    const formatted = sourceText(input, deps);

    if (!formatted || formatted.trim().length === 0) {
      throw new UserFixableError(NOTHING_TO_SEND);
    }

    const where = postsTo(deps);
    const result = await deps.sender.send(channel, formatted);
    if (!result.ok) {
      // Fail loudly. The planner logs this as an error and shows it — the user is never told
      // the message went out when it did not. Nor WHERE it did not go: the same rule as above.
      throw new Error(
        withNote(
          `Could not send ${destination(where)}: ${result.error ?? "unknown error"}`,
          channel,
          where,
        ),
      );
    }

    return `${withNote(`Sent ${destination(where)}.`, channel, where)}\n\n${formatted}`;
  },
};
