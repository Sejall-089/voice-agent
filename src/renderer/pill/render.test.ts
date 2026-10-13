// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PillView } from "../../core/jobs/pillView.ts";
import { ChimePlayer } from "../audio/chime.ts";
import { ACTION_LABEL, renderPill } from "./render.ts";

// What the pill actually DRAWS (M23). CLAUDE.md: a log line proves what the app decided, not
// what the user saw — so this inspects the DOM the page ends up with, and clicks its buttons.

const VIEW: PillView = {
  mode: "needs-you",
  label: "1 needs you",
  pulse: true,
  expanded: true,
  muted: false,
  items: [
    { id: "job1", title: "post the summary to #bugs", state: "needs-you", detail: "Needs your OK — sendMessage", actions: ["review", "cancel"] },
    { id: "job2", title: "file this bug", state: "failed", detail: "Linear said no.", actions: ["dismiss"] },
  ],
};

function draw(view: PillView) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const calls: string[] = [];
  renderPill(root, view, {
    onAction: (id, action) => calls.push(`action:${id}:${action}`),
    onExpand: (expanded) => calls.push(`expand:${expanded}`),
    onMute: (muted) => calls.push(`mute:${muted}`),
  });
  const text = (selector: string): string[] =>
    [...root.querySelectorAll(selector)].map((node) => node.textContent ?? "");
  const click = (selector: string, index = 0): void => {
    (root.querySelectorAll(selector)[index] as HTMLElement | undefined)?.click();
  };
  return { root, calls, text, click };
}

describe("renderPill", () => {
  it("hidden: draws nothing", () => {
    const { root } = draw({ ...VIEW, mode: "hidden", items: [], expanded: false });
    expect(root.children.length).toBe(0);
  });

  it("collapsed: one button with the label, the mode and the pulse on the root — and no list", () => {
    const { root, text } = draw({ ...VIEW, expanded: false });
    expect(text(".summary .label")).toEqual(["1 needs you"]);
    expect(root.classList.contains("mode-needs-you")).toBe(true);
    expect(root.classList.contains("pulse")).toBe(true);
    expect(root.querySelector(".list")).toBeNull();
    expect(root.querySelectorAll("button").length).toBe(1);
  });

  it("steady amber: the pulse class is gone when the view says so", () => {
    const { root } = draw({ ...VIEW, pulse: false, expanded: false });
    expect(root.classList.contains("mode-needs-you")).toBe(true);
    expect(root.classList.contains("pulse")).toBe(false);
  });

  it("expanded: a row per job with its title, detail and exactly its own buttons", () => {
    const { root, text } = draw(VIEW);
    expect(text(".row .title")).toEqual(["post the summary to #bugs", "file this bug"]);
    expect(text(".row .detail")).toEqual(["Needs your OK — sendMessage", "Linear said no."]);
    const buttons = (row: number): string[] =>
      [...(root.querySelectorAll(".row")[row]?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? "");
    expect(buttons(0)).toEqual(["Review…", "Cancel"]);
    expect(buttons(1)).toEqual(["Dismiss"]);
  });

  it("NO BUTTON SAYS APPROVE, SEND OR YES: the labels are fixed, and none of them is a decision", () => {
    expect(ACTION_LABEL).toEqual({ review: "Review…", resume: "Resume", cancel: "Cancel", dismiss: "Dismiss" });
    const { root } = draw(VIEW);
    const words = [...root.querySelectorAll("button")].map((button) => (button.textContent ?? "").toLowerCase());
    for (const word of words) {
      expect(word).not.toMatch(/approve|send|yes|confirm|ok\b/);
    }
  });

  it("a click sends the job's id and that row's action, and nothing else", () => {
    const { calls, click } = draw(VIEW);
    click(".action-review");
    click(".action-cancel");
    click(".action-dismiss");
    expect(calls).toEqual(["action:job1:review", "action:job1:cancel", "action:job2:dismiss"]);
  });

  it("the pill itself toggles the list; the mute button toggles the chime", () => {
    const open = draw(VIEW);
    open.click(".summary");
    open.click(".mute");
    expect(open.calls).toEqual(["expand:false", "mute:true"]);

    const closedAndMuted = draw({ ...VIEW, expanded: false, muted: true });
    closedAndMuted.click(".summary");
    expect(closedAndMuted.calls).toEqual(["expand:true"]);

    const muted = draw({ ...VIEW, muted: true });
    expect(muted.text(".mute")).toEqual(["Chime off"]);
    expect(muted.root.querySelector(".mute")?.getAttribute("aria-pressed")).toBe("true");
    muted.click(".mute");
    expect(muted.calls).toEqual(["mute:false"]);
  });

  it("TEXT IS TEXT: markup in an instruction or a result is shown, never parsed", () => {
    const hostile = '<img src=x onerror="window.pwned = 1"><a href="https://evil.example">click</a>';
    const { root, text } = draw({
      ...VIEW,
      items: [{ id: "job1", title: hostile, state: "failed", detail: hostile, actions: ["dismiss"] }],
      notice: hostile,
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(text(".row .title")).toEqual([hostile]);
    expect(text(".row .detail")).toEqual([hostile]);
    expect(text(".notice")).toEqual([hostile]);
  });

  it("a button's words never come from the view: an item cannot rename its own action", () => {
    const { root } = draw({
      ...VIEW,
      items: [{ id: "job1", title: "Approve and send now", state: "needs-you", detail: "Click to approve", actions: ["review"] }],
    });
    expect([...root.querySelectorAll(".row button")].map((b) => b.textContent)).toEqual(["Review…"]);
  });

  it("redrawing replaces what was there instead of adding to it", () => {
    const root = document.createElement("div");
    const handlers = { onAction: () => undefined, onExpand: () => undefined, onMute: () => undefined };
    renderPill(root, VIEW, handlers);
    renderPill(root, { ...VIEW, items: VIEW.items.slice(0, 1) }, handlers);
    expect(root.querySelectorAll(".row").length).toBe(1);
    expect(root.querySelectorAll(".summary").length).toBe(1);
  });

  it("shows a notice when there is one, and nothing when there is not", () => {
    expect(draw({ ...VIEW, notice: "Finish what's open in the bar first, then resume this." }).text(".notice")).toEqual([
      "Finish what's open in the bar first, then resume this.",
    ]);
    expect(draw({ ...VIEW, notice: null }).root.querySelector(".notice")).toBeNull();
    expect(draw(VIEW).root.querySelector(".notice")).toBeNull();
  });
});

// A stand-in for an <audio> element: never a real one, so no test in this repo makes a sound.
function fakeAudio() {
  const made: { url: string; played: number; paused: number; element: HTMLAudioElement }[] = [];
  const create = (url: string): HTMLAudioElement => {
    const record = { url, played: 0, paused: 0, element: null as unknown as HTMLAudioElement };
    const element = {
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      play: (): Promise<void> => {
        record.played += 1;
        return Promise.resolve();
      },
      pause: (): void => {
        record.paused += 1;
      },
    };
    record.element = element as unknown as HTMLAudioElement;
    made.push(record);
    return record.element;
  };
  return { made, create };
}

describe("ChimePlayer", () => {
  it("plays the bundled file on an element of its own", () => {
    const audio = fakeAudio();
    new ChimePlayer("needs-you.wav", audio.create).play();
    expect(audio.made.map((entry) => [entry.url, entry.played])).toEqual([["needs-you.wav", 1]]);
  });

  it("does not stack: a second request while one is playing starts nothing", () => {
    const audio = fakeAudio();
    const player = new ChimePlayer("needs-you.wav", audio.create);
    player.play();
    player.play();
    expect(audio.made.length).toBe(1);
  });

  it("plays again once the last one ended", () => {
    const audio = fakeAudio();
    const player = new ChimePlayer("needs-you.wav", audio.create);
    player.play();
    (audio.made[0]?.element as unknown as { onended: () => void }).onended();
    player.play();
    expect(audio.made.length).toBe(2);
  });

  it("stop() cuts it off, and is safe with nothing playing", () => {
    const audio = fakeAudio();
    const player = new ChimePlayer("needs-you.wav", audio.create);
    player.stop();
    player.play();
    player.stop();
    expect(audio.made[0]?.paused).toBe(1);
    player.play(); // and it can play again afterwards
    expect(audio.made.length).toBe(2);
  });

  it("a play() the browser refuses is forgotten, not left blocking the next one", async () => {
    const made: number[] = [];
    const player = new ChimePlayer("needs-you.wav", () => {
      made.push(1);
      return {
        onended: null,
        onerror: null,
        play: () => Promise.reject(new Error("NotAllowedError")),
        pause: () => undefined,
      } as unknown as HTMLAudioElement;
    });
    player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.play();
    expect(made.length).toBe(2);
  });
});
