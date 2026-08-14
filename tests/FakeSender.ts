import type { MessageSender, SendResult } from "../src/core/types.ts";

// Records every send so tests can assert the side effect DID or DID NOT happen.
// Never touches the network — no real Slack message is ever posted by the test suite.
export class FakeSender implements MessageSender {
  public readonly calls: { channel: string; text: string }[] = [];

  constructor(
    private readonly result: SendResult = { ok: true },
    private readonly throws = false,
  ) {}

  send(channel: string, text: string): Promise<SendResult> {
    this.calls.push({ channel, text });
    if (this.throws) {
      return Promise.reject(new Error("network exploded"));
    }
    return Promise.resolve(this.result);
  }
}
