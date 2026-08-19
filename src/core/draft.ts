import type { EmailMessage } from "./types.ts";

// Short-lived state for the reply being worked on (M10). Without it, "make it shorter" would
// start from the original email again instead of from what was just written — every tweak
// would silently discard the previous one.
//
// Deliberately NOT in the memory engine: memory holds facts that should outlive the session
// and be versioned. A draft is neither — it is scratch state that should evaporate. Storing it
// in SQLite would make it a fact about the user, which it isn't.

export interface Draft {
  text: string; // what we last wrote into the compose box
  source: EmailMessage; // the email being replied to — a revision still needs the original
  updatedAt: number; // epoch ms; drives the TTL below
}

export interface DraftStore {
  // Returns null once the draft has gone stale, so a caller cannot distinguish "expired" from
  // "never existed" — both mean "there is nothing to revise", which is the only useful answer.
  get(now?: number): Draft | null;
  set(draft: Draft): void;
  clear(): void;
}

// Long enough to iterate on a reply, short enough that yesterday's draft never resurfaces when
// a follow-up instruction is ambiguous.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// One slot, not a list: the flow is "one open reply at a time", and a stack of drafts would
// invite the planner to guess which one "make it shorter" meant.
export class InMemoryDraftStore implements DraftStore {
  private draft: Draft | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  get(now: number = Date.now()): Draft | null {
    if (this.draft === null) return null;
    if (now - this.draft.updatedAt > this.ttlMs) {
      this.draft = null;
      return null;
    }
    return this.draft;
  }

  set(draft: Draft): void {
    this.draft = draft;
  }

  clear(): void {
    this.draft = null;
  }
}
