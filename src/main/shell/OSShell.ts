// The portability contract (spec.md §4). The core NEVER calls OS APIs directly —
// it only calls these methods. Porting to another OS = reimplementing this interface.

export interface CapturedContext {
  selectedText: string | null; // v0: current clipboard contents
  activeApp: string | null; // optional (active-win); may be null
  activeWindowTitle: string | null;
}

export type LocalAction =
  | { kind: "openUrl"; payload: string }
  | { kind: "copyToClipboard"; payload: string }
  | { kind: "notify"; payload: string };

export interface OSShell {
  registerHotkey(combo: string, onTrigger: () => void): void;
  getContext(): Promise<CapturedContext>;
  executeAction(action: LocalAction): Promise<{ ok: boolean; error?: string }>;
  showInput(): Promise<string>; // opens command bar, resolves with typed text
  showResult(text: string): void; // result popup
  confirm(message: string): Promise<boolean>; // yes/no dialog for irreversible actions
}
