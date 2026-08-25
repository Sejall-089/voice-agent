import Anthropic from "@anthropic-ai/sdk";
import { visionError } from "../errors.ts";
import type {
  LocateParams,
  VisionApi,
  VisionResponse,
} from "./ModelVisionLocator.ts";

// The SDK adapter, and NOTHING ELSE.
//
// This file is deliberately the smallest thing in `core/vision/`, and it is the only part of the
// vision path with no test. That is the point of where the seam was drawn: everything that
// decides what the user is told — which failure is which, what happens when the answer is
// off-schema or truncated — lives on the other side of `VisionApi` and is tested against
// literals. What is left here is a translation between our params and the SDK's types, with no
// branching except the missing-key guard. If a bug lives in this file, it is the kind a single
// live run finds immediately; the kinds that hide are all next door.
//
// M13's `GoogleCalendar.ts` is why this is split at all: it shipped untested on the argument
// that only a live run could prove it, and both bugs the first live run found were in the half
// that was ordinary branching.
export class AnthropicVisionApi implements VisionApi {
  private readonly apiKey: string | undefined;
  private client: Anthropic | null = null;

  constructor(apiKey: string | undefined = process.env["ANTHROPIC_API_KEY"]) {
    // Read but never logged (spec §10). A missing key is surfaced as a friendly refusal on first
    // use rather than a crash at startup — the same shape as AnthropicLLMClient.
    this.apiKey = apiKey;
  }

  private getClient(): Anthropic {
    if (!this.apiKey) throw visionError("no-key");
    if (!this.client) this.client = new Anthropic({ apiKey: this.apiKey });
    return this.client;
  }

  async create(params: LocateParams): Promise<VisionResponse> {
    const response = await this.getClient().messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: [
        {
          name: params.toolName,
          description: params.toolDescription,
          // Adapt this repo's vendor-neutral JSONSchema to the SDK's InputSchema at the
          // boundary — the same cast anthropic.ts already makes for tool schemas.
          input_schema: params.toolSchema as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      // Forced, not "auto". There is exactly one thing to say and one shape to say it in, and a
      // model that answers in prose instead is a failure to handle rather than a style to allow.
      tool_choice: { type: "tool", name: params.toolName },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: params.imageMediaType,
                data: params.imageBase64,
              },
            },
            { type: "text", text: params.text },
          ],
        },
      ],
    });

    return {
      content: response.content.map((block) =>
        block.type === "tool_use"
          ? { type: block.type, name: block.name, input: block.input }
          : { type: block.type },
      ),
      stopReason: response.stop_reason,
    };
  }
}
