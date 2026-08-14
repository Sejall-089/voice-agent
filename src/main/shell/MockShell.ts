import type { CapturedContext, LocalAction, OSShell } from "./OSShell.ts";

export interface MockShellOptions {
  context: CapturedContext;
  inputs?: string[]; // queued return values for showInput()
  confirms?: boolean[]; // queued answers for confirm()
}

// Headless implementation of the OSShell contract (spec.md §4). Imports no electron, so
// the whole core + planner + tools run under vitest with no desktop. Actions and results
// land in public arrays for assertions.
export class MockShell implements OSShell {
  public readonly results: string[] = [];
  public readonly actions: LocalAction[] = [];
  public readonly confirmMessages: string[] = [];

  private readonly context: CapturedContext;
  private readonly inputs: string[];
  private readonly confirms: boolean[];

  constructor(options: MockShellOptions) {
    this.context = options.context;
    this.inputs = [...(options.inputs ?? [])];
    this.confirms = [...(options.confirms ?? [])];
  }

  registerHotkey(): void {
    // No hotkeys in a headless shell.
  }

  getContext(): Promise<CapturedContext> {
    return Promise.resolve(this.context);
  }

  showInput(): Promise<string> {
    return Promise.resolve(this.inputs.shift() ?? "");
  }

  showResult(text: string): void {
    this.results.push(text);
  }

  confirm(message: string): Promise<boolean> {
    this.confirmMessages.push(message);
    return Promise.resolve(this.confirms.shift() ?? false);
  }

  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }> {
    this.actions.push(action);
    return Promise.resolve({ ok: true });
  }
}
