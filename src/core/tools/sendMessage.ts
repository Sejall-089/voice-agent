import { UnresolvedReferenceError, UserFixableError } from "../errors.ts";
import { checkReference } from "../memory/checkReference.ts";
import type { Memory, Tool, ToolDeps, ToolInput } from "../types.ts";

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
function knownChannel(input: ToolInput, deps: ToolDeps): string {
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

// The text this call is about: `notes` when there are any, otherwise what the user "selected" —
// which in this app means the CLIPBOARD (spec §4), so it is rarely empty and not always
// relevant. ONE function, used by `prepare`, the confirm summary and the handler, so they cannot
// disagree about what is being sent.
function sourceText(input: ToolInput, deps: ToolDeps): string | null {
  const notes = input["notes"];
  return typeof notes === "string" && notes.trim().length > 0 ? notes : deps.context.selectedText;
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
    "instruction; otherwise the user's selected text is used. As a step in a plan, `notes` is " +
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
        description: "The raw notes to send. Omit to use the user's selected text.",
      },
    },
    required: ["channel"],
  },
  risk: "dangerous",
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
      accept: (answer) => {
        const check = checkChannel(answer, NOTHING_KNOWN);
        return check.ok ? check.channel : null;
      },
    },
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
  //   2. there IS something to send
  //   3. the formatter's reply is a message, not a request for one (`isMessage`)
  // and returns the arguments with `notes` REPLACED by the exact text to post. The planner
  // hands those to the dialog and the handler, which show and send `notes` as they find it.
  //
  // The cost, accepted on purpose: the dialog appears one model call later than it used to,
  // and a send that is then cancelled has still paid for that call.
  //
  // IN A CHAIN it does nothing at all. There `notes` is written by the plan and filled from
  // earlier steps ("New bug filed: {step2}"); it is already the exact text, and is shown in
  // full and sent verbatim exactly as it has been since M19.
  prepare: async (args: ToolInput, deps: ToolDeps): Promise<ToolInput> => {
    if (deps.chained) return args;

    knownChannel(args, deps);

    const raw = sourceText(args, deps);
    if (raw === null || raw.trim().length === 0) throw new UserFixableError(NOTHING_TO_SEND);

    const formatted = (await deps.llm.complete(FORMAT_SYSTEM, raw)).trim();
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
  confirmSummary: (args: ToolInput, deps: ToolDeps): string => {
    const channel = knownChannel(args, deps);
    const where = postsTo(deps);
    const question = withNote(`Send ${destination(where)}?`, channel, where);
    const text = sourceText(args, deps);
    return text ? `${question}\n\n${text}` : question;
  },
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
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
