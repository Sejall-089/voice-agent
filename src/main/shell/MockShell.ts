import type { AudioClip } from "../../core/types.ts";
import type { CapturedContext, LocalAction, OSShell } from "./OSShell.ts";
import type { VoiceShell, VoiceState } from "./VoiceShell.ts";

export interface MockShellOptions {
  context: CapturedContext;
  inputs?: string[]; // queued return values for showInput()
  confirms?: boolean[]; // queued answers for confirm()
  clips?: AudioClip[]; // queued return values for stopRecording()
  failRecording?: string; // when set, startRecording() rejects with this message
}

// Headless implementation of the OSShell contract (spec.md §4) and the VoiceShell contract
// (M7). Imports no electron, so the whole core + planner + tools + voice state machine run
// under vitest with no desktop and no microphone. Actions, results, and voice states land
// in public arrays for assertions.
export class MockShell implements OSShell, VoiceShell {
  public readonly results: string[] = [];
  public readonly actions: LocalAction[] = [];
  public readonly confirmMessages: string[] = [];
  public readonly voiceStates: { state: VoiceState; detail?: string }[] = [];
  public recordingsStarted = 0;
  public recordingsStopped = 0;
  public recordingsCancelled = 0;

  private readonly context: CapturedContext;
  private readonly inputs: string[];
  private readonly confirms: boolean[];
  private readonly clips: AudioClip[];
  private readonly failRecording: string | undefined;

  constructor(options: MockShellOptions) {
    this.context = options.context;
    this.inputs = [...(options.inputs ?? [])];
    this.confirms = [...(options.confirms ?? [])];
    this.clips = [...(options.clips ?? [])];
    this.failRecording = options.failRecording;
  }

  registerHotkey(): boolean {
    // No hotkeys in a headless shell — but nothing ever "fails" here either.
    return true;
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

  // --- VoiceShell ---

  startRecording(): Promise<void> {
    this.recordingsStarted += 1;
    if (this.failRecording !== undefined) {
      return Promise.reject(new Error(this.failRecording));
    }
    return Promise.resolve();
  }

  // Unqueued clips resolve as silence, which is what an empty capture really is.
  stopRecording(): Promise<AudioClip> {
    this.recordingsStopped += 1;
    return Promise.resolve(this.clips.shift() ?? { wav: new Uint8Array(0), durationMs: 0 });
  }

  cancelRecording(): Promise<void> {
    this.recordingsCancelled += 1;
    return Promise.resolve();
  }

  showVoiceState(state: VoiceState, detail?: string): void {
    this.voiceStates.push(detail === undefined ? { state } : { state, detail });
  }
}
