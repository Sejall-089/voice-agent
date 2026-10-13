import { Chime } from "../../core/jobs/chime.ts";
import type { JobManager } from "../../core/jobs/JobManager.ts";
import { FOREGROUND_BUSY } from "../../core/jobs/messages.ts";
import { initialPillState, pillView, reducePill } from "../../core/jobs/pill.ts";
import type { PillEvent, PillState, PillView } from "../../core/jobs/pill.ts";
import { CHIME_MUTED, readFlag, writeFlag } from "../../core/settings.ts";
import type { SettingsStore } from "../../core/settings.ts";

// Everything between the job records and what the user sees and hears of them (M23): the
// pill's view, the pill's buttons, and the chime. No electron — the window, the IPC and the
// timer are handed in.
//
// WHAT THE PILL'S BUTTONS CAN DO IS THE WHOLE OF THIS LIST, and the renderer cannot extend it:
//
//   review    let a job that is waiting on a confirm go on to OPEN THE NATIVE DIALOG. It
//             approves nothing; the yes or no is given in that dialog, by a person.
//   resume    bring a job that needs the screen back in front of the user.
//   cancel    stop a job.
//   dismiss   take a finished or failed job out of the list.
//   mute      the chime, on or off.
//   expand    open or close the list.
//
// Everything arriving from the pill's page is `unknown` and is checked here: an action it does
// not know, an id that is not a job, an action that job's row does not currently offer — all
// are dropped without a word.

export interface PillSurface {
  render(view: PillView): void;
}

export interface PillControllerDeps {
  manager: JobManager;
  settings: SettingsStore;
  surface: PillSurface;
  // Play the bundled chime. A fake in every test.
  playChime: () => void;
  // Dictation, an instruction recording, or the app speaking is in progress.
  isBusy: () => boolean;
  now?: () => number;
}

export class PillController {
  private state: PillState;
  private readonly chime: Chime;
  private readonly now: () => number;
  // A sentence shown in the pill for a moment (a resume that was refused).
  private notice: { text: string; until: number } | null = null;
  // The last view handed to the surface, serialised: a tick that changes nothing draws nothing.
  private drawn: string | null = null;

  constructor(private readonly deps: PillControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.state = initialPillState(readFlag(deps.settings, CHIME_MUTED), this.now());
    this.chime = new Chime({
      play: deps.playChime,
      isMuted: () => this.state.muted,
      isBusy: deps.isBusy,
      isWaiting: (id) => deps.manager.get(id)?.state === "needs-you",
      now: this.now,
    });

    deps.manager.onChange((change) => {
      // A detached job that starts waiting is the one thing that makes a sound. An attached
      // job never waits: its dialog is already in front of the user.
      if (change.type === "state") {
        this.chime.onJobState(change.job.id, change.job.state, change.previous);
      }
      this.dispatch({ type: "jobs", jobs: deps.manager.views(), now: this.now() });
    });
    // Whatever was restored from the last run (interrupted jobs) is shown from the start.
    this.dispatch({ type: "jobs", jobs: deps.manager.views(), now: this.now() });
  }

  // Called on a timer (about once a second): the fade and the pulse are both time passing,
  // waits expire, and a chime held back for the microphone may now be due.
  tick(): void {
    this.deps.manager.expireDue();
    this.chime.flush();
    if (this.notice !== null && this.now() >= this.notice.until) this.notice = null;
    this.dispatch({ type: "tick", now: this.now() });
  }

  view(): PillView {
    return { ...pillView(this.state), notice: this.notice?.text ?? null };
  }

  // --- From the pill's page. Untrusted. ---

  onAction(rawId: unknown, rawAction: unknown): void {
    if (typeof rawId !== "string" || typeof rawAction !== "string") return;
    const item = this.view().items.find((candidate) => candidate.id === rawId);
    // Only an action that row is showing right now. A stale click — the job moved on while
    // the pointer was travelling — does nothing.
    if (item === undefined || !item.actions.some((action) => action === rawAction)) return;

    switch (rawAction) {
      case "review":
      case "resume": {
        const result = this.deps.manager.resume(rawId);
        if (result === "busy") {
          this.notice = { text: FOREGROUND_BUSY, until: this.now() + 6_000 };
          this.dispatch({ type: "tick", now: this.now() });
        }
        return;
      }
      case "cancel":
        this.deps.manager.cancel(rawId);
        return;
      case "dismiss":
        this.deps.manager.acknowledge(rawId);
        this.dispatch({ type: "jobs", jobs: this.deps.manager.views(), now: this.now() });
        return;
    }
  }

  onExpand(raw: unknown): void {
    if (typeof raw !== "boolean") return;
    this.dispatch({ type: "expand", expanded: raw });
  }

  onMute(raw: unknown): void {
    if (typeof raw !== "boolean") return;
    // Written first: a mute that is shown and not saved would come back unmuted.
    writeFlag(this.deps.settings, CHIME_MUTED, raw);
    this.dispatch({ type: "mute", muted: raw });
  }

  private dispatch(event: PillEvent): void {
    this.state = reducePill(this.state, event);
    const view = this.view();
    const serialised = JSON.stringify(view);
    if (serialised === this.drawn) return;
    this.drawn = serialised;
    this.deps.surface.render(view);
  }
}
