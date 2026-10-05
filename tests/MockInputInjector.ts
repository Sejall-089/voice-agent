import type { ForegroundWindow, InputInjector } from "../src/main/shell/InputInjector.ts";

// Deterministic stand-in for WindowsInputInjector. No PowerShell, no SendInput, nothing
// touches this machine's actual focused window — mirrors FakeTranscriber/FakeGmail/FakeNotion.
export class MockInputInjector implements InputInjector {
  public readonly typed: string[] = [];
  // Every (virtual key, press count) pair pressKey was asked for, in order (M18).
  public readonly pressed: { vk: number; count: number }[] = [];
  public disposed = false;

  // Queued replies for getForegroundWindow(); the last one repeats once the queue is empty,
  // so a test that sets one target doesn't have to requeue it for every call.
  private readonly foregroundQueue: (ForegroundWindow | null)[];
  // When set, typeText() throws this instead of recording the text — the short-write /
  // UIPI-blocked case.
  private readonly failTypeWith: string | null;
  // Same idea for pressKey (M18) - the short-write / UIPI-blocked case.
  private readonly failPressWith: string | null;
  // How long the fake pretends the OS took.
  //
  // NOT ZERO BY DEFAULT, and that is the point of it existing at all (CLAUDE.md): the real
  // pressKey is a round trip to a PowerShell host that sleeps 40ms between presses, and a fake
  // that resolves in the same tick cannot test ORDERING against it - only call-sequence, which
  // is a weaker and different property. M16.9 shipped a bug straight through a test that made
  // exactly that substitution. Any test asserting what is true DURING a press needs this.
  private readonly delayMs: number;

  constructor(
    options: {
      foreground?: (ForegroundWindow | null)[];
      failTypeWith?: string;
      failPressWith?: string;
      delayMs?: number;
    } = {},
  ) {
    this.foregroundQueue = options.foreground ?? [{ handle: 1, title: "Untitled - Notepad" }];
    this.failTypeWith = options.failTypeWith ?? null;
    this.failPressWith = options.failPressWith ?? null;
    this.delayMs = options.delayMs ?? 1;
  }

  private settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
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

  // Async with a real (tiny) delay, and it records the call only AFTER that delay - so a test
  // that reads `pressed` mid-flight sees what the OS would actually have seen by then, not what
  // was merely requested.
  //
  // Rejects with a BARE `Error`, which is what WindowsInputInjector.pressKey throws on a short
  // write. Checked against the real implementation rather than assumed: `typeText` throws a
  // bare Error too, so there is no typed-error family here for a fake to drift away from
  // (CLAUDE.md on M16.7). The corollary is that a test asserting only the error TYPE proves
  // nothing - assert the message reaching the caller instead.
  async pressKey(vk: number, count: number): Promise<void> {
    await this.settle();
    if (this.failPressWith !== null) throw new Error(this.failPressWith);
    this.pressed.push({ vk, count });
  }

  dispose(): void {
    this.disposed = true;
  }
}
