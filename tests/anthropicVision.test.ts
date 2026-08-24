import { describe, it, expect } from "vitest";
import {
  AnthropicVisionLocator,
  classifyVisionFailure,
  DEFAULT_VISION_MODEL,
} from "../src/core/vision/AnthropicVisionLocator.ts";
import { LOCATE_TOOL_NAME } from "../src/core/vision/prompt.ts";
import { VisionError } from "../src/core/errors.ts";
import { RECON_SHOT } from "./FakeScreen.ts";
import type {
  LocateParams,
  VisionApi,
  VisionResponse,
} from "../src/core/vision/AnthropicVisionLocator.ts";

// The vision transport (M15), tested on the half that is ordinary branching.
//
// M13 shipped `GoogleCalendar.ts` untested on the argument that "only a live run can prove it",
// and both bugs the first live run found were in the half that decided what a person gets TOLD
// when something breaks. Everything asserted below is that half: which model is asked, whether
// the image and the target actually reach the request, and what comes out when the answer is
// missing, truncated, off-schema, or the call fails outright. No network, no API key, no SDK.

class StubApi implements VisionApi {
  public readonly calls: LocateParams[] = [];
  constructor(
    private readonly response: VisionResponse | null,
    private readonly failure?: unknown,
  ) {}

  create(params: LocateParams): Promise<VisionResponse> {
    this.calls.push(params);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.response ?? { content: [] });
  }
}

function toolUse(input: unknown, stopReason: string | null = "tool_use"): VisionResponse {
  return { content: [{ type: "tool_use", name: LOCATE_TOOL_NAME, input }], stopReason };
}

function visionFailure(run: () => Promise<unknown>): Promise<VisionError> {
  return run().then(
    () => {
      throw new Error("expected a VisionError, but the call succeeded");
    },
    (error: unknown) => {
      if (error instanceof VisionError) return error;
      throw error;
    },
  );
}

// An error shaped like the SDK's: a real Error carrying a numeric `status`.
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("what gets sent", () => {
  it("asks the configured model, with the image and the target", async () => {
    const api = new StubApi(toolUse({ outcome: "found", box: { x: 1, y: 2, width: 8, height: 8 } }));
    const locator = new AnthropicVisionLocator({ api });

    await locator.locate(RECON_SHOT, "  the send button  ");

    const call = api.calls[0]!;
    expect(call.model).toBe(DEFAULT_VISION_MODEL);
    expect(call.imageMediaType).toBe("image/png");
    // RECON_SHOT's png is the four-byte PNG signature; base64 of 89 50 4e 47 is "iVBORw==".
    expect(call.imageBase64).toBe("iVBORw==");
    expect(call.text).toBe("Find: the send button");
    expect(call.toolName).toBe(LOCATE_TOOL_NAME);
  });

  it("honours a model override", async () => {
    const api = new StubApi(toolUse({ outcome: "notFound" }));
    await new AnthropicVisionLocator({ api, model: "claude-sonnet-5" }).locate(RECON_SHOT, "x");
    expect(api.calls[0]?.model).toBe("claude-sonnet-5");
  });

  it("leaves room for thinking tokens", async () => {
    // Thinking is on by default on the current Opus models and is spent from the SAME allowance
    // the tool call has to fit inside (spec §3a). A tight cap here looks exactly like a refusal.
    const api = new StubApi(toolUse({ outcome: "notFound" }));
    await new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x");
    expect(api.calls[0]?.maxTokens).toBe(4096);
  });
});

describe("what comes back", () => {
  it("reads the tool call", async () => {
    const api = new StubApi(
      toolUse({ outcome: "found", box: { x: 10, y: 20, width: 30, height: 40 }, label: "Send" }),
    );
    const result = await new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "the send button");
    expect(result).toEqual({
      kind: "found",
      box: { x: 10, y: 20, width: 30, height: 40 },
      label: "Send",
    });
  });

  it("refuses when the model answered in words instead of using the tool", async () => {
    const api = new StubApi({ content: [{ type: "text" }], stopReason: "end_turn" });
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "the send button"),
    );
    expect(error.reason).toBe("bad-response");
    expect(error.message).toContain("without using the tool");
  });

  it("distinguishes running out of room from answering badly", async () => {
    // M9's distinction, in a new place: "I ran out of room" and "I don't understand your screen"
    // are different facts, and collapsing them sends the user to look at the wrong thing.
    const api = new StubApi({ content: [], stopReason: "max_tokens" });
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "the send button"),
    );
    expect(error.reason).toBe("bad-response");
    expect(error.message).toContain("ran out of room");
    expect(error.message).toContain("4096");
  });

  it("ignores a tool call by some other name", async () => {
    const api = new StubApi({
      content: [{ type: "tool_use", name: "something_else", input: { outcome: "found" } }],
      stopReason: "tool_use",
    });
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "the send button"),
    );
    expect(error.reason).toBe("bad-response");
  });

  it("passes an off-schema answer to the parser rather than trusting it", async () => {
    const api = new StubApi(toolUse({ outcome: "found", label: "Send" })); // found, but no box
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "the send button"),
    );
    expect(error.reason).toBe("bad-response");
    expect(error.message).toContain("gave no position");
  });
});

// Classified on the STATUS CODE, never on the message text. A status is a documented contract;
// a message is prose that changes without warning. M13 learned this the expensive way by reading
// a 403 as a revocation and sending the user round a reconnect loop that could never have helped.
describe("what the user is told when the call fails", () => {
  it("names the key on 401 and 403, and says which key", async () => {
    for (const status of [401, 403]) {
      const api = new StubApi(null, httpError(status, "invalid x-api-key"));
      const error = await visionFailure(() =>
        new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
      );
      expect(error.reason).toBe("denied");
      expect(error.message).toContain("invalid x-api-key");
    }
  });

  it("says to wait on 429, and does not blame a setting", async () => {
    const api = new StubApi(null, httpError(429, "rate_limit_error"));
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
    );
    expect(error.reason).toBe("rate-limited");
    expect(error.message).toMatch(/give it a moment/);
    expect(error.message).not.toMatch(/\.env/);
  });

  it("surfaces Anthropic's own words on 400 without diagnosing them", async () => {
    const api = new StubApi(null, httpError(400, "image exceeds 8000 pixels"));
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
    );
    expect(error.reason).toBe("rejected");
    expect(error.message).toContain("image exceeds 8000 pixels");
  });

  it("treats every other status as the service having a bad day", async () => {
    for (const status of [404, 408, 500, 503, 529]) {
      const api = new StubApi(null, httpError(status, "upstream"));
      const error = await visionFailure(() =>
        new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
      );
      expect(error.reason).toBe("unreachable");
      expect(error.message).toContain(String(status));
    }
  });

  it("surfaces a bare network failure verbatim", async () => {
    const api = new StubApi(null, new Error("connect ETIMEDOUT 160.79.104.10:443"));
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
    );
    expect(error.reason).toBe("unreachable");
    expect(error.message).toContain("connect ETIMEDOUT");
  });

  it("survives being thrown something that is not an Error at all", async () => {
    const api = new StubApi(null, "everything is fine");
    const error = await visionFailure(() =>
      new AnthropicVisionLocator({ api }).locate(RECON_SHOT, "x"),
    );
    expect(error.reason).toBe("unreachable");
    expect(error.message).toContain("everything is fine");
  });
});

describe("classifyVisionFailure on its own", () => {
  it("ignores a non-numeric status rather than trusting it", () => {
    const error = classifyVisionFailure(Object.assign(new Error("odd"), { status: "401" }));
    expect((error as VisionError).reason).toBe("unreachable");
  });

  it("handles null and undefined", () => {
    expect((classifyVisionFailure(null) as VisionError).reason).toBe("unreachable");
    expect((classifyVisionFailure(undefined) as VisionError).reason).toBe("unreachable");
  });
});
