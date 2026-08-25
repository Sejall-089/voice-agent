import OpenAI from "openai";
import { visionError } from "../errors.ts";
import type { LocateParams, VisionApi, VisionResponse } from "./ModelVisionLocator.ts";

// The OpenAI adapter, and NOTHING ELSE — the counterpart of anthropicApi.ts beside it.
//
// Like its sibling, this is deliberately the smallest thing in `core/vision/` and the only part
// of the OpenAI path with no test: everything that decides what the user is TOLD lives on the
// other side of `VisionApi` in ModelVisionLocator.ts and is tested against literals. What is
// left here is a translation between our params and the SDK's types, with no branching except
// the missing-key guard.
//
// TWO THINGS HERE ARE MEASURED RATHER THAN CHOSEN, and both would fail silently if changed:
//
//   `detail: "high"` — without it the model looks at a coarse thumbnail and cannot reliably find
//   a control at all. It is also what triggers the shortest-side-768 rescale, which is why the
//   frame handed to us is pre-sized to match (core/vision/frame.ts's OPENAI_FRAME). Change one
//   of those two without the other and every coordinate comes back offset by the resize factor
//   — measured at 4/4 boxes landing outside the target button.
//
//   the forced `tool_choice` — there is exactly one thing to say and one shape to say it in, and
//   a model that answers in prose instead is a failure to handle rather than a style to allow.
export class OpenAIVisionApi implements VisionApi {
  private readonly apiKey: string | undefined;
  private client: OpenAI | null = null;

  constructor(apiKey: string | undefined = process.env["OPENAI_API_KEY"]) {
    // Read but never logged (spec §10). A missing key surfaces as a friendly refusal on first
    // use rather than a crash at startup — the same shape as OpenAILLMClient.
    this.apiKey = apiKey;
  }

  private getClient(): OpenAI {
    if (!this.apiKey) throw visionError("no-key");
    if (!this.client) this.client = new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }

  async create(params: LocateParams): Promise<VisionResponse> {
    const response = await this.getClient().chat.completions.create({
      model: params.model,
      // Reasoning tokens come out of the same allowance the tool call has to fit inside (§3a).
      max_completion_tokens: params.maxTokens,
      messages: [
        { role: "system", content: params.system },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${params.imageMediaType};base64,${params.imageBase64}`,
                detail: "high",
              },
            },
            { type: "text", text: params.text },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: params.toolName,
            description: params.toolDescription,
            // Adapt this repo's vendor-neutral JSONSchema to the SDK's shape at the boundary —
            // the same cast openai.ts already makes for tool schemas.
            parameters: params.toolSchema as unknown as OpenAI.FunctionParameters,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: params.toolName } },
    });

    const choice = response.choices[0];
    const raw = choice?.message?.tool_calls?.[0];
    // The SDK's tool-call type is a union (function calls and custom calls), so narrow once here
    // rather than at each field read. Anything that is not a function call is "it didn't use the
    // tool", which ModelVisionLocator already has an honest message for.
    const call = raw && raw.type === "function" ? raw : null;

    // Normalise into the same block shape the Anthropic adapter produces, so ModelVisionLocator
    // never learns which provider answered. `arguments` is a JSON STRING here where Anthropic
    // hands back an object, and that parse is the one place this file can throw on well-formed
    // HTTP — a truncated tool call is unparseable JSON, and it must read as "bad answer" rather
    // than as a crash.
    let input: unknown = null;
    if (call) {
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        throw visionError("bad-response", "its answer wasn't valid JSON");
      }
    }

    return {
      content: call ? [{ type: "tool_use", name: call.function.name, input }] : [],
      // Map OpenAI's vocabulary onto the one ModelVisionLocator already reads, so the
      // out-of-room case produces the same honest message on either provider.
      stopReason: choice?.finish_reason === "length" ? "max_tokens" : (choice?.finish_reason ?? null),
    };
  }
}
