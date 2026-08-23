// What the app held back when it spoke (M14).
//
// Speech is terse by decision: a ten-event schedule is spoken as a count and the first event,
// with the rest offered rather than read ("plus 7 more, want me to read them?"). That offer is
// only honest if the rest is still somewhere when the answer comes back, which is what this is.
//
// Deliberately NOT in the memory engine, for the same reason `core/draft.ts` isn't: memory
// holds facts that should outlive the session and be versioned. What the app didn't get around
// to saying is neither — it is scratch state that should evaporate. Writing it to SQLite would
// make "the second half of Tuesday's schedule" a fact about the user, which it is not.

export interface SpeechStore {
  // Remember what was withheld. Replaces whatever was there — a new result supersedes an older
  // one, so "read them out" can only ever mean the most recent thing that was cut short.
  hold(text: string): void;
  // Read it AND clear it. One slot, delivered once: "read them out" twice in a row should not
  // read the same list twice, it should tell you there is nothing more. Returns null once the
  // hold has gone stale, so a caller cannot tell "expired" from "never existed" — both mean
  // "there is nothing more to read", which is the only useful answer (DraftStore's own rule).
  take(now?: number): string | null;
  clear(): void;
}

// Short. A remainder answers a follow-up that arrives in the next breath ("go on"), not one
// that arrives after lunch — and reading out a schedule the user asked about twenty minutes ago
// would be answering a question they have stopped asking. Deliberately shorter than
// DraftStore's 15 minutes, which holds something the user is actively working ON rather than
// something they declined to hear.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class InMemorySpeechStore implements SpeechStore {
  private held: { text: string; at: number } | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  hold(text: string): void {
    const trimmed = text.trim();
    // Holding an empty remainder would make `elaborate` offerable with nothing to offer.
    if (trimmed.length === 0) {
      this.held = null;
      return;
    }
    this.held = { text: trimmed, at: Date.now() };
  }

  take(now: number = Date.now()): string | null {
    const held = this.held;
    this.held = null;
    if (held === null) return null;
    return now - held.at > this.ttlMs ? null : held.text;
  }

  clear(): void {
    this.held = null;
  }
}
