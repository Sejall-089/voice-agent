// Shared contracts for the core brain. Everything the planner, registry, tools, LLM,
// memory, and action log agree on lives here so there are no import cycles.
//
// /core is OS-agnostic: it imports the OSShell contract TYPE-ONLY (OSShell.ts has no
// electron import), which keeps /core free of electron per spec.md §10.
import type {
  CapturedContext,
  LocalAction,
  OSShell,
} from "../main/shell/OSShell.ts";
import type { DraftStore } from "./draft.ts";
import type { SpokenText } from "./speech.ts";
import type { SpeechStore } from "./speechStore.ts";
import type { Risk, ToolRisk } from "./risk.ts";

export type { CapturedContext, LocalAction };
// Re-exported so a tool can name its own tier without reaching past this file for one type.
export type { Risk };

// --- Tool schemas (what the LLM sees) ---

// A minimal JSON Schema for a tool's input object. Kept typed (no `any`).
export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

// The public description of a tool, shown to the LLM for tool-calling.
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

// Arguments the LLM proposes for a tool call.
export type ToolInput = Record<string, unknown>;

// --- The LLM behind an interface (real: Anthropic; test: a fake) ---

export type ToolChoice =
  | { kind: "tool"; name: string; input: ToolInput }
  | { kind: "none"; text: string | null }
  // The model never reached an answer — it hit its token ceiling first. Distinct from
  // "none" on purpose: "I decline" and "I ran out of room" are different facts, and
  // collapsing them makes a budget failure look like a missing capability. Reasoning
  // models spend from the same budget the tool call has to fit in, so this is reachable.
  | { kind: "incomplete"; reason: string };

export interface LLMClient {
  // Pick one tool from the menu (or decline). `previousTurn` is the single most recent
  // logged action (or null) — the one piece of state the planner carries between
  // instructions, so a bare correction ("no, I meant...") has something to resolve against.
  chooseTool(
    instruction: string,
    context: CapturedContext,
    tools: ToolSchema[],
    previousTurn: ActionLogEntry | null,
  ): Promise<ToolChoice>;
  // Free-form generation used inside tool handlers (e.g. summarize).
  complete(system: string, user: string): Promise<string>;
}

// --- The one external connector (spec §2), behind an interface like LLMClient ---

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface MessageSender {
  send(channel: string, text: string): Promise<SendResult>;
}

// --- Speech to text, behind an interface like LLMClient / MessageSender (M7) ---

// A captured recording, already in the one format the transcriber wants: 16 kHz mono
// 16-bit PCM WAV. Normalizing at the capture site (the renderer) keeps every Transcriber
// implementation free of resampling concerns.
export interface AudioClip {
  wav: Uint8Array;
  durationMs: number;
}

export interface Transcriber {
  // Speech → text. Throws (never returns a sentinel) when transcription fails; returns
  // an empty string when the audio held no speech.
  transcribe(clip: AudioClip): Promise<string>;
}

// --- The browser surface (M10), behind an interface like MessageSender / Transcriber ---

// One email as the app sees it. Deliberately flat and app-neutral: nothing here says "Gmail",
// so the writing side (core/compose.ts) never learns which client the message came out of.
export interface EmailMessage {
  subject: string | null;
  from: string | null;
  fromName: string | null;
  to: string | null;
  body: string;
}

// Acting inside a live Gmail tab, split by what each operation costs if it goes wrong — the
// tiers in core/risk.ts. Implementations must fail loudly rather than guess: every method here
// either does exactly the named thing or throws with a human-readable reason.
export interface GmailSurface {
  readOpenEmail(): Promise<EmailMessage>; // SAFE — read-only
  openReplyBox(): Promise<void>; // CAUTION — no undo, low stakes
  readComposeText(): Promise<string | null>; // SAFE — null when no compose box is open
  // SAFE. Read from the COMPOSE box, not from the original email: the confirm dialog must name
  // who the reply will actually reach, which is not always who wrote to you.
  readComposeRecipients(): Promise<string | null>;
  setComposeText(text: string): Promise<void>; // CAUTION
  // DANGEROUS. The planner's confirm gate is the only thing that may lead here — no handler
  // calls this without having passed it.
  clickSend(): Promise<void>;
}

// --- The Notion surface (M11), behind an interface like GmailSurface ---

// One Notion page as the app sees it. Deliberately flat, like EmailMessage: nothing here says
// "Chrome" or "CDP", so the writing side (core/composeNote.ts) never learns which browser
// layer the page came out of.
export interface NotionPage {
  title: string | null;
  url: string;
  body: string;
}

// Acting inside a live Notion tab. Two methods, not six — the narrowness IS M11's finding:
// Notion has no staging area and no send action, so there is nothing corresponding to
// GmailSurface's openReplyBox/readComposeText/readComposeRecipients/clickSend. Appending is
// the only mutation this app gets a safe, honest shape for (core/risk.ts's `caution` tier;
// core/notion/notionScript.ts's append-only invariant).
export interface NotionSurface {
  readOpenPage(): Promise<NotionPage>; // SAFE — read-only
  // CAUTION. Appends only — MUST NEVER replace, delete, or reorder anything already on the
  // page. That is the one rule notionScript.ts exists to enforce.
  appendToPage(text: string): Promise<void>;
}

// --- The calendar surface (M13), behind an interface like GmailSurface / NotionSurface ---

// One calendar event as the app sees it. Flat and vendor-neutral, like EmailMessage and
// NotionPage: nothing here says "Google", so the tools never learn whose API it came out of.
//
// This is also the first surface that is an API rather than a browser. That is not a change of
// principle — it is the same reasoning that made Slack an API: there is no live, editable draft
// box to put words in, only structured data, so there is nothing a DOM would buy.
export interface CalendarEvent {
  id: string;
  title: string;
  // ISO instant with offset for a timed event; YYYY-MM-DD when `allDay`.
  start: string;
  // For an all-day event this is the INCLUSIVE last day. Google's wire format makes it
  // exclusive (a one-day event on the 26th ends on the 27th); that is normalized away at the
  // mapping boundary so this field means one thing everywhere above it.
  end: string;
  allDay: boolean;
  // OTHER people's email addresses — never the user's own. This is what decides the risk tier
  // of createEvent/moveEvent, so it has to mean "who would be emailed about this", not "who is
  // listed on it". Google includes the organizer in its own attendee list, so a naive mapping
  // would make every solo event look like it had a guest and quietly gate everything.
  attendees: string[];
  // An instance of a recurring series. M13 REFUSES to move one — instance-vs-series is a real
  // choice with a real wrong answer, and guessing it is worse than declining.
  recurring: boolean;
}

// What createEvent asks for. No `allDay`: M13 writes timed events only, so `start`/`end` are
// always ISO instants here. Reading handles all-day events; writing declines them (spec §6c).
export interface EventDraft {
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

// Acting on the user's primary calendar. Every method either does exactly the named thing or
// throws with a human-readable reason — same contract as GmailSurface and NotionSurface.
//
// The tiers on the two writing methods are NOT fixed: they depend on whether that particular
// event has guests (core/risk.ts's RiskPolicy). Both read methods exist partly to answer that
// question before anything is gated.
export interface CalendarSurface {
  // SAFE. The calendar's OWN timezone, used to display times the way the user sees them in
  // Google Calendar. Not the same thing as the user's local zone, which is what the planner
  // prompt carries (spec §5) — usually identical, never assumed to be.
  calendarTimeZone(): Promise<string>;
  listUpcoming(from: string, to: string, limit: number): Promise<CalendarEvent[]>; // SAFE
  // SAFE. Zero or many matches is not an answer — the caller REFUSES rather than picking one,
  // the same default-deny rule gmailScript.ts applies to buttons.
  findEvent(query: string, from: string, to: string): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent>; // SAFE
  // CAUTION with no attendees, DANGEROUS with them — there is no separate "send" step to gate,
  // because guests are emailed the moment this returns.
  createEvent(draft: EventDraft): Promise<CalendarEvent>;
  // Same split, decided by the guests on the event BEING MOVED.
  moveEvent(id: string, start: string, end: string): Promise<CalendarEvent>;
}

// --- Memory resolve seam (M1 no-op; M3 becomes SQLite-backed) ---

export interface MemoryResolver {
  // Replace vague argument references with concrete values. M1: returns input unchanged.
  resolveArgs(input: ToolInput): Promise<ToolInput>;
}

// A stored fact with its epistemic metadata (spec.md §7).
export interface Fact {
  id: number;
  subject: string;
  value: string;
  confidence: number;
  source: string | null;
  version: number;
  active: number; // 0 when superseded
  created_at: string;
  updated_at: string;
}

export interface ResolvedFact {
  value: string;
  confidence: number;
}

export interface WriteOptions {
  confidence?: number;
  source?: string;
}

// The full memory engine (spec.md §7). It IS a MemoryResolver, so it drops straight into
// the planner's existing seam — the planner never learns memory got smarter.
export interface Memory extends MemoryResolver {
  resolve(reference: string): ResolvedFact | null;
  write(subject: string, value: string, opts?: WriteOptions): void;
  query(subjectLike: string): Fact[];
}

// --- Tools ---

// Dependencies handed to every tool handler (injected, never global — spec §10).
export interface ToolDeps {
  context: CapturedContext;
  llm: LLMClient;
  shell: OSShell;
  memory: Memory;
  sender: MessageSender;
  // M10 / M11. Both have "unavailable"/empty defaults at the planner, so a tool can never
  // reach a browser the app was not configured to drive.
  gmail: GmailSurface;
  notion: NotionSurface;
  draft: DraftStore;
  // M13. Same idea again — an unconnected default, so a tool can never reach a calendar the
  // app was not configured to use.
  calendar: CalendarSurface;
  // M14. What the app held back the last time it spoke a summary instead of the whole thing.
  // Scratch state owned by the planner (one per app run), handed down like `draft` — see
  // core/speechStore.ts for why it deliberately never reaches SQLite.
  speech: SpeechStore;
  // What tier THIS call resolved to (core/risk.ts). `null` only inside a `RiskPolicy.resolve`,
  // which is the thing that decides it and therefore runs before it exists; by the time
  // `narrate`, `confirmSummary` or the handler sees it, it is always set.
  //
  // A handler needs this for one specific job: a tier decided by reading the world can go stale
  // between the reading and the acting. `moveEvent` classifies an event as guest-free, and a
  // second later someone else adds a guest to it — without this, the handler would email a
  // person the user was never asked about. Knowing the tier lets it refuse instead.
  tier: Risk | null;
}

// A handler returns the text to display; it throws on failure (planner catches).
// Side effects (clipboard, open URL, Slack) are performed via deps.shell.executeAction.
export type ToolHandler = (input: ToolInput, deps: ToolDeps) => Promise<string>;

export interface Tool extends ToolSchema {
  // What this tool costs if it goes wrong (M10, core/risk.ts). Replaced the earlier
  // `irreversible: boolean` — see that file for why a boolean stopped being enough once tools
  // could act inside another app's GUI. The planner reads it generically: it never knows which
  // tool it is gating.
  //
  // Usually a plain tier, exactly as it has been since M10. M13 widened it to allow a
  // `RiskPolicy` — a tool whose cost depends on the ARGUMENTS of the particular call rather
  // than on the tool itself (a calendar event with guests emails them; the same event without
  // guests touches nobody). See core/risk.ts for why calendar needed this and Gmail did not.
  risk: ToolRisk<ToolInput, ToolDeps>;
  handler: ToolHandler;
  // Whether the planner should run this tool's args through memory's reference resolution.
  // Defaults to true. Memory-WRITING tools set this false: their args are literals to store
  // ("the team" is the subject to write, not a reference to look up), so resolving them would
  // silently replace the subject with the fact's current value.
  resolvesReferences?: boolean;
  // How to describe this action to the user at the confirm gate. The planner calls this with the
  // RESOLVED args, so the user always approves the concrete action ("Send to #design-team?"),
  // never the vague one they typed ("send to the team"). `dangerous` tools should define it.
  //
  // It also gets `deps`, and may be async, so a GUI action can describe what is ACTUALLY there
  // — the real recipient chips, the real text in the reply box — instead of the arguments the
  // model guessed. Read-only (SAFE, core/risk.ts) work only: this runs BEFORE the user has
  // agreed to anything, so it must never change the world it is describing. If it throws, the
  // planner treats that as "we can't say what would happen" and nothing runs.
  confirmSummary?: (
    args: ToolInput,
    deps: ToolDeps,
  ) => string | Promise<string>;
  // What to tell the user BEFORE a `caution` tool acts. Same shape and same reasoning as
  // confirmSummary — built from the resolved args — but it announces rather than asks, because
  // a caution action runs on its own. Narration is what stands in for the undo that doesn't exist.
  //
  // Widened in M11, the same way confirmSummary widened in M10 and for the identical reason:
  // a GUI action's concrete facts — which Notion page this would write to, say — live in the
  // app being acted on, not in the arguments the model proposed, so narration that could not
  // read them would be announcing a guess. It may do SAFE work only: it runs before the tool
  // acts, so it must never change the world it is describing. If it throws, the planner treats
  // that as "we can't say what we're about to do" and nothing runs — same as confirmSummary.
  narrate?: (args: ToolInput, deps: ToolDeps) => string | Promise<string>;
  // How to SAY this tool's result (M14). The fourth optional hook, and the same shape and
  // reasoning as `narrate` and `confirmSummary`: the planner asks the tool how to describe
  // itself and never learns which tool it is asking.
  //
  // Optional because the default is good: `core/speech.ts` derives a spoken line from the
  // displayed result generically, and most tools return one short sentence that needs nothing
  // else. A tool defines this only when the generic derivation would say something a person
  // would not — `readSchedule`'s formatted list is the case that justified the hook, because
  // the generic head-of-list reads attendees' email addresses out loud, character by
  // character, and there is no fixing that from outside the tool that knows they are addresses.
  //
  // Takes the result the handler already produced rather than re-deriving from the world: the
  // spoken and displayed versions must describe the same answer, and a second read of a
  // calendar could legitimately return something different.
  speakResult?: (
    result: string,
    args: ToolInput,
    deps: ToolDeps,
  ) => SpokenText | Promise<SpokenText>;
}

// --- Action log seam (M1 in-memory; M3 becomes SQLite action_log) ---

export type ActionStatus = "ok" | "refused" | "no_tool" | "error" | "cancelled";

export interface ActionLogEntry {
  ts: string;
  instruction: string;
  tool: string | null; // null when no tool matched
  arguments: ToolInput | null;
  result: string | null;
  status: ActionStatus;
}

export interface ActionLog {
  logAction(entry: ActionLogEntry): void;
  logMiss(instruction: string): void; // records a "no_tool" miss
  // The single most recently logged entry, or null on a fresh session — the planner's
  // one turn of state, fed back into the next chooseTool call.
  getLast(): ActionLogEntry | null;
}

// --- Planner result ---

export interface PlannerOutcome {
  status: ActionStatus;
  tool: string | null;
  result: string | null;
}
