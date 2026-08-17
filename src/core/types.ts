// Shared contracts for the core brain. Everything the planner, registry, tools, LLM,
// memory, and action log agree on lives here so there are no import cycles.
//
// /core is OS-agnostic: it imports the OSShell contract TYPE-ONLY (OSShell.ts has no
// electron import), which keeps /core free of electron per spec.md §10.
import type { CapturedContext, LocalAction, OSShell } from "../main/shell/OSShell.ts";

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
  | { kind: "none"; text: string | null };

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
}

// A handler returns the text to display; it throws on failure (planner catches).
// Side effects (clipboard, open URL, Slack) are performed via deps.shell.executeAction.
export type ToolHandler = (input: ToolInput, deps: ToolDeps) => Promise<string>;

export interface Tool extends ToolSchema {
  irreversible: boolean;
  handler: ToolHandler;
  // Whether the planner should run this tool's args through memory's reference resolution.
  // Defaults to true. Memory-WRITING tools set this false: their args are literals to store
  // ("the team" is the subject to write, not a reference to look up), so resolving them would
  // silently replace the subject with the fact's current value.
  resolvesReferences?: boolean;
  // How to describe this action to the user at the confirm gate. The planner calls this with the
  // RESOLVED args, so the user always approves the concrete action ("Send to #design-team?"),
  // never the vague one they typed ("send to the team"). Irreversible tools should define it.
  confirmSummary?: (args: ToolInput) => string;
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
