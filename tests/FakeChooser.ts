import type { Candidate, ChoiceResult, ElementChooser } from "../src/core/types.ts";

// Deterministic stand-in for the choose call (M16) — no network, no API key, no model.
//
// WRITTEN INDEPENDENTLY OF THE CODE UNDER TEST, per CLAUDE.md: it shares no line with
// `ModelElementChooser` and never goes through `parseChoice`. The wire-shape parsing is tested
// separately against literal replies (tests/choosePrompt.test.ts) and this exercises the layer
// above it. A fake built out of the parser would only prove the parser agrees with itself.
//
// It answers by NAME rather than by number, and that is deliberate: a test that hard-codes
// "PICK 15" silently stops meaning anything the moment the filter changes what lands at
// position 15. Naming the control keeps the test about the control.
export class FakeChooser implements ElementChooser {
  public readonly asked: {
    candidates: readonly Candidate[];
    target: string;
    windowTitle: string;
  }[] = [];

  private readonly answer: (candidates: readonly Candidate[]) => ChoiceResult;
  private readonly failure: Error | undefined;

  private constructor(
    answer: (candidates: readonly Candidate[]) => ChoiceResult,
    failure?: Error,
  ) {
    this.answer = answer;
    this.failure = failure;
  }

  // "Whatever is called this" — the normal case.
  static picking(name: string): FakeChooser {
    return new FakeChooser((candidates) => {
      const match = candidates.find((c) => c.name === name || c.name.startsWith(name));
      if (!match) {
        // Loud, not silent. A test that asked for a control the filter dropped should fail
        // saying so, not quietly exercise the not-found branch and look like it passed.
        throw new Error(
          `FakeChooser: no candidate named ${JSON.stringify(name)} — the list has ` +
            `${candidates.length}: ${candidates.map((c) => c.name).join(", ")}`,
        );
      }
      return { kind: "picked", number: match.number };
    });
  }

  static picking_number(number: number): FakeChooser {
    return new FakeChooser(() => ({ kind: "picked", number }));
  }

  static saying_none(): FakeChooser {
    return new FakeChooser(() => ({ kind: "none" }));
  }

  static saying_ambiguous(...names: string[]): FakeChooser {
    return new FakeChooser((candidates) => ({
      kind: "ambiguous",
      numbers: names.map(
        (name) => candidates.find((c) => c.name.startsWith(name))?.number ?? -1,
      ),
    }));
  }

  static failing(error: Error): FakeChooser {
    return new FakeChooser(() => ({ kind: "none" }), error);
  }

  choose(
    candidates: readonly Candidate[],
    target: string,
    windowTitle: string,
  ): Promise<ChoiceResult> {
    this.asked.push({ candidates, target, windowTitle });
    if (this.failure) return Promise.reject(this.failure);
    try {
      return Promise.resolve(this.answer(candidates));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
