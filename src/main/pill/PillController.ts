import { Chime } from "../../core/jobs/chime.ts";
import type { JobManager } from "../../core/jobs/JobManager.ts";
import { FOREGROUND_BUSY } from "../../core/jobs/messages.ts";
import { dismissAllTargets, initialPillState, isPointInRect, pillView, reducePill } from "../../core/jobs/pill.ts";
import type { PillEvent, PillState, PillView, Rect } from "../../core/jobs/pill.ts";
import type { PointerPoint, PointerPressSource } from "../shell/PointerPressSource.ts";
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
//   dismiss all  take every listed done, failed or expired job out of the list (M27) — never a
//             live or interrupted one.
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
  // Is the pointer over the pill's window right now? Optional, and asked once a tick as a
  // CORRECTION to what the page reports: the window is resized under the pointer when the
  // list opens and closes, and a `mouseleave` that never arrives would otherwise leave the
  // list believing it is being looked at for ever. Null: cannot tell (no window yet).
  pointerOver?: () => boolean | null;
  // Where the one-line-per-event diagnostic record goes (see `say`). main.ts passes the
  // console. Optional: without it nothing is logged and nothing else changes.
  log?: (line: string) => void;
  now?: () => number;
  // M27, fix B: mouse presses anywhere on screen, so a press OUTSIDE the pill can close an open
  // list (the pill cannot take focus, so it never blurs). Optional, and allowed to fail: without
  // it, or if it cannot start, the list closes as it always did — ten seconds after the pointer
  // leaves, a second click, a row's Review…/Resume, the hotkey.
  outsidePresses?: PointerPressSource;
  // The pill window's bounds right now, in the same space as a press's point (DIP), or null when
  // there is no visible pill. A press inside them is the pill's own business.
  pillBounds?: () => Rect | null;
}

export class PillController {
  private state: PillState;
  private readonly chime: Chime;
  private readonly now: () => number;
  // A sentence shown in the pill for a moment (a resume that was refused).
  private notice: { text: string; until: number } | null = null;
  // The last view handed to the surface, serialised: a tick that changes nothing draws nothing.
  private drawn: string | null = null;
  // The outside-press watcher (fix B): not asked yet, starting, able to watch, or not available.
  private presses: "idle" | "starting" | "ready" | "unavailable" = "idle";
  private watching = false;

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
      this.dispatch({ type: "jobs", jobs: deps.manager.views(), now: this.now() }, "nothing left to show");
    });
    // Whatever was restored from the last run (interrupted jobs) is shown from the start.
    this.dispatch({ type: "jobs", jobs: deps.manager.views(), now: this.now() }, "startup");
  }

  // Called on a timer (about once a second): the fade and the pulse are both time passing,
  // waits expire, and a chime held back for the microphone may now be due.
  tick(): void {
    this.deps.manager.expireDue();
    this.chime.flush();
    if (this.notice !== null && this.now() >= this.notice.until) this.notice = null;
    const over = this.deps.pointerOver?.() ?? null;
    if (over !== null && over !== this.state.hovering) {
      this.say(`hover ${over ? "enter" : "leave"} (pointer check, the page did not report it)`);
      this.dispatch({ type: "hover", inside: over, now: this.now() }, "pointer check");
    }
    const idleDue =
      this.state.expanded && this.state.collapseAt !== null && this.now() >= this.state.collapseAt;
    this.dispatch(
      { type: "tick", now: this.now() },
      idleDue ? "10 s with the pointer off the pill" : "nothing left to show",
    );
  }

  // THE USER HAS MOVED ON — the hotkey was pressed, or a new instruction was given. The list
  // closes. Called by main from the same place a job is detached; a no-op when it is closed.
  collapse(reason = "hotkey or new instruction"): void {
    this.dispatch({ type: "collapse" }, reason);
  }

  view(): PillView {
    return { ...pillView(this.state), notice: this.notice?.text ?? null };
  }

  // --- From the pill's page. Untrusted. ---

  onAction(rawId: unknown, rawAction: unknown): void {
    if (typeof rawId !== "string" || typeof rawAction !== "string") {
      this.say("action dropped: not a job id and an action name");
      return;
    }
    const item = this.view().items.find((candidate) => candidate.id === rawId);
    // Only an action that row is showing right now. A stale click — the job moved on while
    // the pointer was travelling — does nothing.
    if (item === undefined || !item.actions.some((action) => action === rawAction)) {
      // The action name is logged only when it is one of ours: anything else came from the
      // page as free text.
      const known = ["review", "resume", "cancel", "dismiss"].includes(rawAction);
      this.say(
        `action dropped: ${known ? `"${rawAction}"` : "an unknown action"} is not offered ` +
          `${item === undefined ? "(no such row)" : `by this row (${item.state})`}`,
      );
      return;
    }

    // Logged when it is CLICKED, before anything it causes — so the lines that follow (a job
    // changing, the list closing) read in the order they happened.
    this.say(`action "${rawAction}" on ${rawId}`);
    let outcome: string;
    switch (rawAction) {
      case "review":
      case "resume": {
        const result = this.deps.manager.resume(rawId);
        if (result === "busy") {
          // The one action that did NOT happen: the list stays open, because the sentence
          // saying why is in it.
          this.say(`action "${rawAction}" on ${rawId} -> refused, the user is busy; list left open`);
          this.notice = { text: FOREGROUND_BUSY, until: this.now() + 6_000 };
          this.dispatch({ type: "tick", now: this.now() }, "notice");
          return;
        }
        outcome = result;
        break;
      }
      case "cancel":
        outcome = this.deps.manager.cancel(rawId) ? "cancelled" : "already ended";
        break;
      case "dismiss":
        outcome = this.deps.manager.acknowledge(rawId) ? "dismissed" : "not ended yet";
        this.dispatch({ type: "jobs", jobs: this.deps.manager.views(), now: this.now() }, "nothing left to show");
        break;
      default:
        return;
    }
    // Only an outcome worth a second line: the click did not do the ordinary thing.
    if (!["ok", "cancelled", "dismissed"].includes(outcome)) {
      this.say(`action "${rawAction}" on ${rawId} -> ${outcome}`);
    }
    // Review… and Resume: the list has done its job and gets out of the way — in particular
    // out of the way of the dialog "Review…" is about to open, or of the screen a resumed job
    // needs. Dismiss and Cancel DO NOT CLOSE IT (M27): someone clearing several rows had to
    // reopen the pill for each (M26's first live finding). The list stays open while anything
    // is still listed, and closes when the last row goes — the reducer's "nothing left to show",
    // reached through the job change above.
    if (rawAction === "review" || rawAction === "resume") {
      this.dispatch({ type: "collapse" }, `the "${rawAction}" button`);
    }
  }

  // "Dismiss all", beside the chime toggle in the open list (M27). Acts on exactly the rows the open list is
  // showing that are done, failed or expired (`dismissAllTargets`) — never a live job, never an
  // interrupted one, never one past the cap — and only while the view is offering the button: a
  // press that arrives after the list closed, or with nothing to dismiss, is dropped. It
  // cancels nothing. The page sends no arguments; nothing it could send would be read.
  onDismissAll(): void {
    const view = this.view();
    if (view.dismissAll !== true) {
      this.say(`action "dismiss all" dropped: not offered ${view.expanded ? "(nothing ended is listed)" : "(the list is closed)"}`);
      return;
    }
    const ids = dismissAllTargets(view.items);
    this.say(`action "dismiss all" on ${ids.length} rows: ${ids.join(", ")}`);
    const refused = ids.filter((id) => !this.deps.manager.acknowledge(id));
    if (refused.length > 0) this.say(`action "dismiss all" -> not ended yet: ${refused.join(", ")}`);
    this.dispatch({ type: "jobs", jobs: this.deps.manager.views(), now: this.now() }, "nothing left to show");
  }

  // A click on the pill itself. The ONLY thing that opens the list.
  onExpand(raw: unknown): void {
    if (typeof raw !== "boolean") return;
    this.say(`click on the pill: asks to ${raw ? "open" : "close"} the list`);
    this.dispatch({ type: "expand", expanded: raw, now: this.now() }, "a click on the pill");
  }

  // The pointer entered or left the pill's window.
  onHover(raw: unknown): void {
    if (typeof raw !== "boolean") return;
    // Logged only when it is news: the page repeats "enter" as the window is resized under the
    // pointer (seen in a real window: four in a row), and a line that changes nothing is noise.
    if (raw !== this.state.hovering) this.say(`hover ${raw ? "enter" : "leave"}`);
    this.dispatch({ type: "hover", inside: raw, now: this.now() }, "hover");
  }

  // The page measured the open list. A number from the renderer: checked here and bounded in
  // `pillSize`, so the most a wrong one can do is make the panel its maximum height.
  onContentHeight(raw: unknown): void {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 10_000) return;
    this.dispatch({ type: "measured", height: raw }, "measured");
  }

  // The page measured how wide each way of writing the label is (M27). Checked here as the
  // height is; the labels must be exactly the ones the pill is showing (`reducePill`), and the
  // width it picks is bounded in `pillSize`, so the most a wrong report can do is make the pill
  // its widest or say "+N more" too soon.
  onLabelWidths(rawLabels: unknown, rawWidths: unknown): void {
    if (!Array.isArray(rawLabels) || !Array.isArray(rawWidths)) return;
    if (rawLabels.length === 0 || rawLabels.length > 4 || rawWidths.length !== rawLabels.length) return;
    const labels = rawLabels.filter((label): label is string => typeof label === "string");
    const widths = rawWidths.filter(
      (width): width is number => typeof width === "number" && Number.isFinite(width) && width > 0 && width <= 10_000,
    );
    if (labels.length !== rawLabels.length || widths.length !== rawWidths.length) return;
    this.dispatch({ type: "labelMeasured", labels, widths }, "label measured");
  }

  onMute(raw: unknown): void {
    if (typeof raw !== "boolean") return;
    // Written first: a mute that is shown and not saved would come back unmuted.
    writeFlag(this.deps.settings, CHIME_MUTED, raw);
    this.dispatch({ type: "mute", muted: raw }, "mute");
  }

  // `reason` is why this event happened, in a few fixed words. It is used for exactly one
  // thing: if the event OPENS or CLOSES the list, the log line saying so names it.
  private dispatch(event: PillEvent, reason: string): void {
    const wasOpen = this.state.expanded;
    this.state = reducePill(this.state, event);
    if (this.state.expanded !== wasOpen) {
      this.say(`list ${this.state.expanded ? "OPENED" : "CLOSED"}: ${reason}`);
    }
    // Watch for outside presses exactly while the list is open — whatever opened or closed it.
    this.syncWatching();
    const view = this.view();
    const serialised = JSON.stringify(view);
    if (serialised !== this.drawn) {
      this.drawn = serialised;
      this.deps.surface.render(view);
    }
    // The pill is on screen, so the list could be opened by the next click: have the watcher
    // ready BEFORE that click, not starting at it (it takes about 1.5 s).
    if (view.mode !== "hidden") this.preparePresses();
    // THE LIST IS OPEN WITH THESE JOBS IN IT: the user has seen them. Recorded once per job
    // (the manager ignores a second look), and it is what starts the hour after which a
    // failed or expired one leaves the pill. Only what is actually LISTED — a job past the
    // cap was not on screen. Marking re-enters here through the manager's change event; the
    // second pass finds nothing left to mark.
    if (view.expanded) {
      const ended = view.items
        .filter((item) => item.actions.includes("dismiss"))
        .map((item) => item.id);
      if (ended.length > 0) this.deps.manager.markSeen(ended);
    }
  }

  // --- Outside presses (M27, fix B) ---
  //
  // Until M27 nothing closed an open list when the user clicked elsewhere: the pill never takes
  // focus, so it never blurs (M26's second live finding). Now, while the list is open, every
  // mouse press is reported with where the pointer was, and one OUTSIDE the pill closes it — on
  // the desktop, another app, or the instruction bar alike. Mouse buttons only: a key, a hotkey,
  // a window hiding, a dialog opening are not presses (measured, PointerPressSource.ts).

  private preparePresses(): void {
    const source = this.deps.outsidePresses;
    if (source === undefined || this.presses !== "idle") return;
    this.presses = "starting";
    source.onFailure((reason) => this.pressesUnavailable(reason));
    source.prepare().then(
      () => {
        if (this.presses !== "starting") return;
        this.presses = "ready";
        // The list may have been opened while it was starting.
        this.syncWatching();
      },
      (error: unknown) => this.pressesUnavailable(error instanceof Error ? error.message : String(error)),
    );
  }

  // SAID, never swallowed: the list still works without it — it closes ten seconds after the
  // pointer leaves, as before M27 — but a click elsewhere will not close it, and the log is the
  // only place that difference can be traced to.
  private pressesUnavailable(reason: string): void {
    if (this.presses === "unavailable") return;
    this.presses = "unavailable";
    this.watching = false;
    this.say(`outside presses cannot be watched (${reason}); an open list closes after 10 s with the pointer off it, as before`);
  }

  private syncWatching(): void {
    const source = this.deps.outsidePresses;
    if (source === undefined) return;
    const want = this.state.expanded && this.presses === "ready";
    if (want && !this.watching) {
      this.watching = true;
      source.watch((point) => this.onPress(point));
      this.say("watching for presses outside the pill");
    } else if (!want && this.watching) {
      this.watching = false;
      source.stop();
      this.say("stopped watching for presses outside the pill");
    }
  }

  private onPress(point: PointerPoint): void {
    // A press polled just before the list closed can arrive just after: it is about a list that
    // is no longer open.
    if (!this.watching || !this.state.expanded) return;
    const bounds = this.deps.pillBounds?.() ?? null;
    // Inside the pill — a row's button, the pill itself, the list's own controls — is the page's
    // business. With no pill on screen there is nothing to be outside of.
    if (bounds === null || isPointInRect(point, bounds)) return;
    this.dispatch({ type: "collapse" }, "a press outside the pill");
  }

  // One line per pill event, for the console (M23 follow-up). A live report — "the list
  // stayed open after Review…" — could not be reproduced, and nothing had recorded what the
  // pill was told or why it opened and closed. This is that record. It carries a timestamp, a
  // job id and fixed words only: never an instruction, an argument or a result.
  private say(what: string): void {
    this.deps.log?.(`${new Date(this.now()).toISOString()} pill ${what}`);
  }
}
