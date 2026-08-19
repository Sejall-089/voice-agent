import WebSocket from "ws";

// A minimal Chrome DevTools Protocol client (M10) — the transport that lets the app read and
// act inside a real Chrome tab.
//
// Why hand-rolled rather than puppeteer: this is ~150 lines against a stable, documented
// protocol, `ws` is pure JavaScript (no native rebuild to sit alongside better-sqlite3, which
// this repo already rebuilds twice per install), and nothing about *which element gets clicked*
// hides inside a library — that logic is ours, in gmailScript.ts, where it is tested.
//
// This file knows nothing about Gmail. It finds pages, evaluates an expression in one, and
// types. ChromeGmail is what turns that into "open the reply box".

export interface PageTarget {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Chrome will not open the debugging port on the default profile any more (Chrome 136+), so
// the setup instructions have to name a separate --user-data-dir. When the port is simply not
// there, that is by far the most likely reason, and saying so beats "ECONNREFUSED".
function unreachable(baseUrl: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Couldn't reach Chrome at ${baseUrl}. Start it with ` +
      `--remote-debugging-port and a dedicated --user-data-dir, then try again. (${detail})`,
  );
}

// The list of open tabs, straight off Chrome's HTTP endpoint — no WebSocket needed just to look.
export async function listPages(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PageTarget[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/list`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Chrome answered ${String(response.status)}`);
    }
    const targets: unknown = await response.json();
    if (!Array.isArray(targets)) return [];
    return targets.filter(isPageTarget);
  } catch (error) {
    throw unreachable(baseUrl, error);
  } finally {
    clearTimeout(timer);
  }
}

function isPageTarget(value: unknown): value is PageTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    target["type"] === "page" &&
    typeof target["id"] === "string" &&
    typeof target["url"] === "string" &&
    typeof target["webSocketDebuggerUrl"] === "string"
  );
}

interface CdpResponse {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  error?: { message?: string };
}

// One attached tab. Short-lived on purpose: a session is opened for a single tool step and
// closed in a `finally`, so a crashed page or a closed tab can never leave a socket (or a
// pending promise) alive between instructions — the same lesson as the stranded IPC listeners
// in M8/M9, applied to a different kind of connection.
export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }
  >();

  private constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {
    this.socket.on("message", (data: Buffer | string) => this.onMessage(data));
    this.socket.on("close", () => this.failAll(new Error("Chrome closed the connection.")));
    this.socket.on("error", (error: Error) => this.failAll(error));
  }

  static async connect(
    target: PageTarget,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<CdpSession> {
    const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting to the Chrome tab "${target.title}".`));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new CdpSession(socket, timeoutMs);
  }

  // Run an expression in the page and get its value back. `returnByValue` means we only ever
  // deal in JSON — no remote object handles to leak, and everything gmailScript returns is
  // already a plain, serialisable result object.
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = response.result?.exceptionDetails?.text;
    if (exception !== undefined) {
      throw new Error(`The Gmail page rejected the request: ${exception}`);
    }
    return response.result?.result?.value as T;
  }

  // Types into whatever is focused, firing the input events a rich editor listens for. Setting
  // innerHTML directly would put text on screen that Gmail's own model never saw — it can then
  // send an empty message, or drop the draft on the next re-render.
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  close(): void {
    this.failAll(new Error("The connection to Chrome was closed."));
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  private send(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private onMessage(data: Buffer | string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString("utf8")) as CdpResponse;
    } catch {
      return; // an unparseable frame is not something we can act on
    }
    if (typeof message.id !== "number") return; // an event, not a reply to us
    const waiter = this.pending.get(message.id);
    if (waiter === undefined) return;
    this.pending.delete(message.id);
    if (message.error?.message !== undefined) {
      waiter.reject(new Error(message.error.message));
      return;
    }
    waiter.resolve(message);
  }

  // Nothing may be left hanging when the socket goes away: a pending promise that never settles
  // would leave the command bar showing "Thinking…" forever.
  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
