import type { Fact, Memory, ResolvedFact, ToolInput } from "../types.ts";

// A memory that remembers nothing. Used by tests that exercise the planner and tools without
// caring about memory (M1/M2 specs), and as the trivial stand-in before SqliteMemory existed.
// It satisfies the full Memory interface so it can be handed to the Planner anywhere the real
// engine would go.
export class NoopMemoryResolver implements Memory {
  // Arguments pass through untouched — nothing is ever resolved.
  resolveArgs(input: ToolInput): Promise<ToolInput> {
    return Promise.resolve(input);
  }

  resolve(_reference: string): ResolvedFact | null {
    return null;
  }

  write(_subject: string, _value: string): void {
    // Intentionally forgets.
  }

  query(_subjectLike: string): Fact[] {
    return [];
  }
}
