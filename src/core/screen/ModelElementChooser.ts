import { chooserError } from "../errors.ts";
import { CHOOSE_CONTROL_SYSTEM, parseChoice, renderChooseRequest } from "./prompt.ts";
import type { Candidate, ChoiceResult, ElementChooser, LLMClient } from "../types.ts";

// The choose call (M16), behind the `ElementChooser` interface.
//
// IT RIDES THE PLANNER'S EXISTING `LLMClient.complete()` RATHER THAN A NEW TRANSPORT, and that
// is the whole reason this file is short. M15 needed `VisionApi` plus an Anthropic adapter plus
// an OpenAI adapter, because a picture had to be attached and neither provider's chat helper
// took one. Here the request is text and the reply is a few tokens, so both providers' existing
// `complete()` — already written, already tested — is exactly the right transport. A second
// provider costs nothing.
//
// WHERE THE SEAM IS DRAWN, and M13's lesson applied on purpose again. Everything below is
// request shaping and answer handling, which is the half that decides what a person gets TOLD
// when something breaks; the transport is `LLMClient`, which is faked in tests. So:
//
//   testable, and tested (tests/modelChooser.test.ts):
//     that the candidate list and the target both reach the model, that the system prompt is the
//     one in prompt.ts, that every reply shape maps to the right ChoiceResult, and what happens
//     when the call itself throws.
//   live-only:
//     whether the MODEL PICKS WELL. Nothing in this file or its tests speaks to that. See the
//     note on the premise in prompt.ts, and scripts/choose-recon.mjs for the probe that does.

export interface ModelElementChooserOptions {
  llm: LLMClient;
}

export class ModelElementChooser implements ElementChooser {
  private readonly llm: LLMClient;

  constructor(options: ModelElementChooserOptions) {
    this.llm = options.llm;
  }

  async choose(
    candidates: readonly Candidate[],
    target: string,
    windowTitle: string,
  ): Promise<ChoiceResult> {
    // An empty list is a caller bug, not a model question. The settle gate
    // (core/screen/settle.ts) refuses before this point on a window with nothing in it, so
    // reaching here with no candidates means something upstream is wrong — and asking a model to
    // choose from nothing would burn a call to receive a meaningless answer.
    if (candidates.length === 0) {
      throw chooserError("empty", "there were no controls to choose from");
    }

    let reply: string;
    try {
      reply = await this.llm.complete(
        CHOOSE_CONTROL_SYSTEM,
        renderChooseRequest(candidates, target, windowTitle),
      );
    } catch (error) {
      throw classifyChooserFailure(error);
    }

    // Off-contract replies throw a ChooserError of their own — see prompt.ts, where the parser
    // lives beside the grammar it is the other half of.
    return parseChoice(reply);
  }
}

// What the user is told when the call itself fails.
//
// Classified on the HTTP STATUS, never on the text of the message — M13's 403 lesson, which cost
// a live debugging session: a status code is a documented contract and a message string is prose
// that changes without warning. Where there is no status (a socket that never connected, a DNS
// failure) the error's own words are surfaced verbatim rather than interpreted.
export function classifyChooserFailure(error: unknown): Error {
  const status = statusOf(error);
  const detail = messageOf(error);

  if (status === 401 || status === 403) return chooserError("denied", detail);
  if (status === 429) return chooserError("rate-limited");
  if (status !== null) return chooserError("unreachable", `${status} — ${detail}`);
  return chooserError("unreachable", detail);
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
