// Shared contracts for the core brain. Everything the planner, registry, tools, LLM,
// memory, and action log agree on lives here so there are no import cycles.
//
// /core is OS-agnostic: it imports the OSShell contract TYPE-ONLY (OSShell.ts has no
// electron import), which keeps /core free of electron per spec.md §10.
import type { CapturedContext, LocalAction, OSShell } from "../main/shell/OSShell.ts";
import type { DraftStore } from "./draft.ts";
import type { Risk } from "./risk.ts";

export type { CapturedContext, LocalAction };

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
  // M10. Both have "unavailable"/empty defaults at the planner, so a tool can never reach a
  // browser the app was not configured to drive.
  gmail: GmailSurface;
  draft: DraftStore;
}

// A handler returns the text to display; it throws on failure (planner catches).
// Side effects (clipboard, open URL, Slack) are performed via deps.shell.executeAction.
export type ToolHandler = (input: ToolInput, deps: ToolDeps) => Promise<string>;

export interface Tool extends ToolSchema {
  // What this tool costs if it goes wrong (M10, core/risk.ts). Replaced the earlier
  // `irreversible: boolean` — see that file for why a boolean stopped being enough once tools
  // could act inside another app's GUI. The planner reads it generically: it never knows which
  // tool it is gating.
  risk: Risk;
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
  confirmSummary?: (args: ToolInput, deps: ToolDeps) => string | Promise<string>;
  // What to tell the user BEFORE a `caution` tool acts. Same shape and same reasoning as
  // confirmSummary — built from the resolved args — but it announces rather than asks, because
  // a caution action runs on its own. Narration is what stands in for the undo that doesn't exist.
  narrate?: (args: ToolInput) => string;
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
