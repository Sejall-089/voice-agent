import { visionError } from "../errors.ts";
import {
  LOCATE_SYSTEM,
  LOCATE_TOOL_DESCRIPTION,
  LOCATE_TOOL_NAME,
  LOCATE_TOOL_SCHEMA,
  parseLocateResponse,
  renderLocateRequest,
} from "./prompt.ts";
import type { JSONSchema, LocateResult, Screenshot, VisionLocator } from "../types.ts";

// The vision call (M15). Anthropic-only, behind the `VisionLocator` interface, so a second
// provider is a drop-in rather than a rewrite — the same arrangement `Transcriber` and
// `SpeechSynthesizer` already have, and the same one-connector precedent Slack set.
//
// M13'S SPLIT, APPLIED ON PURPOSE THIS TIME. `GoogleCalendar.ts` shipped untested on the
// argument that only a live run could prove it, and both bugs the first live run found were in
// the half that was ordinary branching. So the seam below is drawn to put as much as possible on
// the testable side of it:
//
//   testable, and tested (tests/anthropicVision.test.ts):
//     which model is asked, that the image and the target actually reach the request, what
//     happens when the answer has no tool call, when it was truncated, when it is off-schema,
//     and what the user is told for every failure status.
//   live-only, and deliberately thin:
//     `AnthropicMessages` at the bottom of this file — the twenty lines that turn our params
//     into the SDK's shape. Nothing branches there.

// How much room the answer gets. 4096 rather than something tight, for spec §3a's exact reason,
// which applies with more force here: thinking is ON BY DEFAULT on the current Opus models, and
// those tokens come out of the same allowance the tool call has to fit inside. A cap the model
// does not reach costs nothing; one it does reach looks exactly like a refusal.
const LOCATE_MAX_TOKENS = 4096;

export const DEFAULT_VISION_MODEL = "claude-opus-5";

// Everything the call needs, already shaped by us. The seam is drawn HERE rather than at "call
// the API" so that request shaping — which model, which schema, which image — is on the testable
// side. What is left below it is a pure translation into SDK types.
export interface LocateParams {
  model: string;
  maxTokens: number;
  system: string;
  toolName: string;
  toolDescription: string;
  toolSchema: JSONSchema;
  imageBase64: string;
  imageMediaType: "image/png";
  text: string;
}

// The only shape of the response this code cares about. Structural rather than the SDK's own
// types, so a test can hand back a literal without constructing an SDK object.
export interface VisionResponseBlock {
  type: string;
  name?: string;
  input?: unknown;
}

export interface VisionResponse {
  content: VisionResponseBlock[];
  stopReason?: string | null;
}

export interface VisionApi {
  create(params: LocateParams): Promise<VisionResponse>;
}

export interface AnthropicVisionOptions {
  api: VisionApi;
  model?: string;
}

export class AnthropicVisionLocator implements VisionLocator {
  private readonly api: VisionApi;
  private readonly model: string;

  constructor(options: AnthropicVisionOptions) {
    this.api = options.api;
    this.model = options.model ?? DEFAULT_VISION_MODEL;
  }

  async locate(shot: Screenshot, target: string): Promise<LocateResult> {
    const params: LocateParams = {
      model: this.model,
      maxTokens: LOCATE_MAX_TOKENS,
      system: LOCATE_SYSTEM,
      toolName: LOCATE_TOOL_NAME,
      toolDescription: LOCATE_TOOL_DESCRIPTION,
      toolSchema: LOCATE_TOOL_SCHEMA,
      imageBase64: toBase64(shot.png),
      imageMediaType: "image/png",
      text: renderLocateRequest(target),
    };

    let response: VisionResponse;
    try {
      response = await this.api.create(params);
    } catch (error) {
      throw classifyVisionFailure(error);
    }

    const call = response.content.find(
      (block) => block.type === "tool_use" && block.name === LOCATE_TOOL_NAME,
    );

    if (call === undefined) {
      // Truncation gets its own message, for M9's reason: "it ran out of room" and "it answered
      // in words" are different facts, and telling someone the model could not understand their
      // screen when it simply hit a ceiling sends them looking at the wrong thing.
      if (response.stopReason === "max_tokens") {
        throw visionError(
          "bad-response",
          `it ran out of room before answering (${LOCATE_MAX_TOKENS} tokens)`,
        );
      }
      throw visionError("bad-response", "it replied without using the tool it was given");
    }

    // Off-schema answers throw a `bad-response` VisionError of their own — see prompt.ts, where
    // the parser lives beside the schema it is the other half of.
    return parseLocateResponse(call.input);
  }
}

// What the user is told when the call itself fails.
//
// Classified on the HTTP STATUS, never on the text of the message. That distinction is the whole
// lesson of M13's 403: a status code is a documented contract, and a message string is prose
// that changes without warning. Where there is no status — a socket that never connected, a
// DNS failure — the error's own words are surfaced verbatim rather than interpreted, exactly as
// PiperSynthesizer surfaces the engine's last line instead of inventing a diagnosis.
export function classifyVisionFailure(error: unknown): Error {
  const status = statusOf(error);
  const detail = messageOf(error);

  if (status === 401 || status === 403) return visionError("denied", detail);
  if (status === 429) return visionError("rate-limited");
  if (status === 400) return visionError("rejected", detail);
  // Anything else with a status is the service having a bad day: 5xx, 404 on a model name, 408.
  // All of them are "I couldn't get an answer", and none is fixed by the user changing a setting.
  if (status !== null) return visionError("unreachable", `${status} — ${detail}`);
  return visionError("unreachable", detail);
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
