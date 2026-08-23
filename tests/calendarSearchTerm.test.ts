import { describe, it, expect } from "vitest";
import { withoutFillerWords } from "../src/core/tools/calendarSupport.ts";

// The search term the app sends is not the sentence the user said, and the gap between them
// was M13's first behavioural live bug: "move the test one meeting to 8pm" searched Google for
// `the test one meeting` and found nothing, because the event is called "test one" and `q=`
// requires every term to appear.
//
// This function only ever runs AFTER an exact search found nothing, which is what makes it
// safe to strip a word like "meeting" at all — see the comment on FILLER in calendarSupport.

describe("withoutFillerWords", () => {
  it("strips the words that made it a sentence", () => {
    expect(withoutFillerWords("the test one meeting")).toBe("test one");
    expect(withoutFillerWords("my 3pm meeting")).toBe("3pm");
    expect(withoutFillerWords("the design review")).toBe("design review");
    expect(withoutFillerWords("that standup event")).toBe("standup");
  });

  it("keeps words that could plausibly be part of a real title", () => {
    // Only obviously-generic nouns go. A title is far more likely to contain "sync",
    // "standup" or "review" than "appointment".
    expect(withoutFillerWords("the design sync")).toBe("design sync");
    expect(withoutFillerWords("the weekly standup")).toBe("weekly standup");
    expect(withoutFillerWords("my 1:1 with alex")).toBe("1:1 alex");
  });

  it("returns null when there is nothing to strip", () => {
    // Signals "already as narrow as it gets" — the caller must not waste a second search
    // asking Google the identical question.
    expect(withoutFillerWords("test one")).toBeNull();
    expect(withoutFillerWords("design review")).toBeNull();
  });

  it("returns null rather than an empty search", () => {
    // "move the meeting to 4" strips to nothing. An empty `q=` matches the entire calendar,
    // which would turn a clean refusal into a list of everything the user owns.
    expect(withoutFillerWords("the meeting")).toBeNull();
    expect(withoutFillerWords("my appointment")).toBeNull();
    expect(withoutFillerWords("that thing")).toBeNull();
    expect(withoutFillerWords("   ")).toBeNull();
  });

  it("ignores case and surrounding punctuation when deciding", () => {
    expect(withoutFillerWords("The Test One Meeting")).toBe("Test One");
    expect(withoutFillerWords("the 'design review' meeting")).toBe("'design review'");
  });

  it("preserves the original casing of the words it keeps", () => {
    // The kept term is shown back to the user in a refusal, so it should read the way they
    // said it rather than being flattened.
    expect(withoutFillerWords("the Q3 Planning meeting")).toBe("Q3 Planning");
  });
});
