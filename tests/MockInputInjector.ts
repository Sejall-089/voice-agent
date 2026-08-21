import type { ForegroundWindow, InputInjector } from "../src/main/shell/InputInjector.ts";

// Deterministic stand-in for WindowsInputInjector. No PowerShell, no SendInput, nothing
// touches this machine's actual focused window — mirrors FakeTranscriber/FakeGmail/FakeNotion.
export class MockInputInjector implements InputInjector {
  public readonly typed: string[] = [];
  public disposed = false;

  // Queued replies for getForegroundWindow(); the last one repeats once the queue is empty,
  // so a test that sets one target doesn't have to requeue it for every call.
  private readonly foregroundQueue: (ForegroundWindow | null)[];
  // When set, typeText() throws this instead of recording the text — the short-write /
  // UIPI-blocked case.
  private readonly failTypeWith: string | null;

  constructor(
    options: {
      foreground?: (ForegroundWindow | null)[];
      failTypeWith?: string;
    } = {},
  ) {
    this.foregroundQueue = options.foreground ?? [{ handle: 1, title: "Untitled - Notepad" }];
    this.failTypeWith = options.failTypeWith ?? null;
  }

  getForegroundWindow(): Promise<ForegroundWindow | null> {
    const next = this.foregroundQueue.length > 1 ? this.foregroundQueue.shift() : this.foregroundQueue[0];
    return Promise.resolve(next ?? null);
  }

  typeText(text: string): Promise<void> {
    if (this.failTypeWith !== null) {
      return Promise.reject(new Error(this.failTypeWith));
    }
    this.typed.push(text);
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }
}
