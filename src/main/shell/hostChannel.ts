// The line protocol in front of a PowerShell host process: correlate replies to requests,
// time them out, and refuse to keep using a channel that has gone wrong.
//
// WHY THIS IS ITS OWN FILE. Until now this logic lived welded to a spawned child process inside
// `WindowsInputInjector`, which meant no test could reach it — and it was wrong. Replies were
// matched to requests by QUEUE POSITION (`waiters.shift()`), and a request that timed out
// removed its waiter while its reply was still in flight, so the next request received the
// PREVIOUS request's answer and every reply after that was off by one. A stale `KEY OK` could
// resolve a later key press as a success that never happened, in the one file whose entire
// premise is that a short write must never be swallowed.
//
// That is CLAUDE.md's standing lesson in its most expensive form: the half of the file that was
// ordinary branching — which reply belongs to which request, what a timeout means — was the
// half that had no test, because importing it meant spawning PowerShell. So the branching is
// here, with the transport injected, and the process management stays next door.
//
// Imports nothing but node types. No electron, no child_process.

// A request that got no reply inside its budget.
//
// A NAMED TYPE, because the two callers have to say genuinely different things about it: a key
// press that may or may not have landed is a different fact from a dictation that may have left
// half a sentence in someone's document. `WindowsInputInjector` maps this to that wording. It
// extends plain `Error` rather than introducing a new family, because that is what every other
// failure in this layer already throws and a fake has to be able to match it (CLAUDE.md on
// M16.7 — a fake that throws a bare Error where the real thing throws a typed one makes the
// failure-path test assert nothing).
export class HostTimeoutError extends Error {
  constructor(
    public readonly verb: string,
    public readonly elapsedMs: number,
    public readonly budgetMs: number,
  ) {
    super(`The input host did not respond in time (${verb}, ${elapsedMs}ms of ${budgetMs}ms).`);
    this.name = "HostTimeoutError";
  }
}

// What the channel needs from whatever is carrying the bytes. Two methods, so a test can be a
// pair of closures and the real thing can be a child process.
export interface HostTransport {
  write(line: string): void;
  // Called when the channel decides this host must not be used again. Must be safe to call
  // more than once.
  kill(): void;
}

export interface HostChannelHooks {
  // A line that carried no request id — the startup `READY`, or anything unexpected.
  onUntagged?: (line: string) => void;
  // Diagnostics. Receives VERBS ONLY, never arguments: a TYPE argument is the user's dictated
  // text and a KEY argument is a keycode, and neither belongs in a log.
  onLog?: (message: string) => void;
}

interface Pending {
  id: number;
  verb: string;
  startedAt: number;
  budgetMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

// The command word with every argument stripped. The only form a log or an error ever sees.
export function verbOf(command: string): string {
  const space = command.indexOf(" ");
  return space === -1 ? command : command.slice(0, space);
}

export class HostChannel {
  // Keyed by request id, NOT a queue. This is the whole point: a reply can only ever resolve
  // the request it names, so a late or duplicated reply has nowhere to go.
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;
  // Set once the channel must not be reused — a timeout, or the host exiting. Held as the
  // ERROR rather than a boolean so a later request can explain why it was refused.
  private poison: Error | null = null;

  constructor(
    private readonly transport: HostTransport,
    private readonly hooks: HostChannelHooks = {},
  ) {}

  // Is this channel finished? The owner reads this to decide whether to spawn a fresh host.
  isPoisoned(): boolean {
    return this.poison !== null;
  }

  request(command: string, budgetMs: number): Promise<string> {
    if (this.poison !== null) return Promise.reject(this.poison);

    const id = this.nextId++;
    const verb = verbOf(command);
    const startedAt = Date.now();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        this.pending.delete(id);
        const error = new HostTimeoutError(verb, elapsedMs, budgetMs);

        // KILL ON TIMEOUT, AND THIS IS THE PRIMARY GUARD rather than a tidy-up.
        //
        // A host that missed its budget is a host whose next reply, if it ever comes, belongs
        // to a request nobody is waiting for any more. Leaving it running was how the original
        // off-by-one desync became reachable. Killing it means the next command spawns a clean
        // process and starts from a known state — which is only SAFE because the `-File`
        // invocation no longer swallows a fresh host's first command (see
        // WindowsInputInjector's header).
        //
        // It explicitly does NOT retry. The request may already have taken effect — a key may
        // have been pressed, text may have been typed — and repeating a mute or a play/pause
        // would undo the thing the user asked for. The caller says so instead.
        this.hooks.onLog?.(
          `#${id} ${verb} TIMEOUT after ${elapsedMs}ms (budget=${budgetMs}ms) — killing the host`,
        );
        this.poisonWith(error);
        reject(error);
      }, budgetMs);

      this.pending.set(id, { id, verb, startedAt, budgetMs, timer, resolve, reject });

      try {
        this.transport.write(`#${id} ${command}`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        const wrapped =
          error instanceof Error ? error : new Error(`Could not write to the input host: ${String(error)}`);
        this.poisonWith(wrapped);
        reject(wrapped);
      }
    });
  }

  // Feed bytes in from the transport. Splits on newlines and routes by id.
  receive(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.route(line);
    }
  }

  private route(line: string): void {
    if (!line.startsWith("#")) {
      // No id: the startup handshake, or something the host said unprompted.
      this.hooks.onUntagged?.(line);
      return;
    }

    const space = line.indexOf(" ");
    const id = Number(line.slice(1, space === -1 ? undefined : space));
    const body = space === -1 ? "" : line.slice(space + 1);

    const waiting = this.pending.get(id);
    if (waiting === undefined) {
      // THE SECOND LINE OF DEFENCE. A reply for a request that is gone — timed out, or a
      // duplicate — is DISCARDED, loudly. Under the old queue-position matching this line
      // would have been handed to whatever request happened to be next, which is exactly the
      // bug. Kill-on-timeout should mean this never fires; it is here so that if it ever does,
      // it cannot corrupt an answer and it leaves a trace.
      this.hooks.onLog?.(
        `discarded a reply for request #${Number.isNaN(id) ? "?" : id} ` +
          `(verb=${verbOf(body)}) — nothing is waiting for it`,
      );
      return;
    }

    clearTimeout(waiting.timer);
    this.pending.delete(id);
    this.hooks.onLog?.(
      `#${id} ${waiting.verb} replied in ${Date.now() - waiting.startedAt}ms ` +
        `(replyVerb=${verbOf(body)})`,
    );
    waiting.resolve(body);
  }

  // The host died or is being shut down. Fail everything outstanding rather than making each
  // caller sit out its own budget waiting for a line that will never arrive.
  failAll(error: Error): void {
    this.poison ??= error;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  // Mark unusable, kill the transport, and fail everything else in flight. The request that
  // triggered this rejects with its own error; the rest learn the host is gone.
  private poisonWith(error: Error): void {
    this.poison ??= error;
    this.transport.kill();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error("The input host was stopped after another request timed out."));
    }
  }

  // Test and diagnostic visibility — how many requests are outstanding right now.
  pendingCount(): number {
    return this.pending.size;
  }
}
