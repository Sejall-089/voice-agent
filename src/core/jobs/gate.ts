// Where a running instruction may have to WAIT (M23).
//
// Before M23 a planner run went from the model's answer to the last step without stopping for
// anything but a confirm dialog. A job can be told to stop in four more places: before it
// starts (three jobs are already executing), before a step that needs the user present, before
// a confirm nobody is there to answer, and when the user cancels it. The planner does not know
// about jobs, the pill or the cap — it asks this interface, generically, at those points, and
// does what it is told.
//
// THE DEFAULT IS AN OPEN GATE: every question answered "go", at once, without waiting. A
// planner built without one behaves exactly as every milestone before M23 did.

export type GateAnswer =
  | "go"
  // The user cancelled the job. The step is not run.
  | "cancelled"
  // The job waited for the user past its limit. The step is not run.
  | "expired";

export interface StepEntry {
  tool: string;
  // 1-based position in the plan, and the plan's length (1 and 1 for a lone call).
  index: number;
  total: number;
  // `Tool.background === "foreground-only"`: this step needs the user present.
  foregroundOnly: boolean;
}

export interface JobGate {
  // Planning is over and steps are about to run. Resolves when this job may execute — at once,
  // or when one of the executing jobs finishes or pauses. `statusOnly`: the plan is a single
  // status question, which never waits and is never listed.
  admit(plan: { tools: readonly string[]; statusOnly: boolean }): Promise<GateAnswer>;
  // Execution has reached this step. For a foreground-only step in a job the user has walked
  // away from, this is where it waits to be resumed. Every `enterStep` that answers "go" is
  // followed by exactly one `leaveStep`.
  enterStep(step: StepEntry): Promise<GateAnswer>;
  leaveStep(): void;
  // This step resolved to a tier that needs a confirm. With the user present: "go", not
  // waited. Otherwise the job waits here — BEFORE the confirm summary is built — and `waited`
  // tells the planner to work out the tier again before it describes anything.
  beforeConfirm(): Promise<{ answer: GateAnswer; waited: boolean }>;
  // Written around the handler call, so a job cut off by the app closing can say whether its
  // step may have gone through or never ran.
  handlerStarting(): void;
  handlerFinished(): void;
}

export const OPEN_GATE: JobGate = {
  admit: () => Promise.resolve("go"),
  enterStep: () => Promise.resolve("go"),
  leaveStep: () => undefined,
  beforeConfirm: () => Promise.resolve({ answer: "go", waited: false }),
  handlerStarting: () => undefined,
  handlerFinished: () => undefined,
};
