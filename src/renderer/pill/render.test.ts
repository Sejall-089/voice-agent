// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PillView } from "../../core/jobs/pillView.ts";
import { ChimePlayer } from "../audio/chime.ts";
import { ACTION_LABEL, DISMISS_ALL_LABEL, measureLabels, measurePill, renderPill, reportMeasurements } from "./render.ts";

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
    onDismissAll: () => calls.push("dismiss-all"),
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
    // With "Dismiss all" offered too (M27), so its label is checked with the rest.
    const { root } = draw({ ...VIEW, dismissAll: true });
    expect(root.querySelector(".dismiss-all")).not.toBeNull();
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
    const handlers = { onAction: () => undefined, onExpand: () => undefined, onMute: () => undefined, onDismissAll: () => undefined };
    renderPill(root, VIEW, handlers);
    renderPill(root, { ...VIEW, items: VIEW.items.slice(0, 1) }, handlers);
    expect(root.querySelectorAll(".row").length).toBe(1);
    expect(root.querySelectorAll(".summary").length).toBe(1);
  });

  it("'Dismiss all' (M27): beside the chime toggle in the list's header, only when main offers it, and its click carries nothing", () => {
    const plain = draw(VIEW);
    expect(plain.root.querySelector(".dismiss-all")).toBeNull();
    // Not offered: the header holds the chime toggle alone, as before M27.
    expect(plain.text(".list > .header .controls button")).toEqual(["Chime on"]);
    const offered = draw({ ...VIEW, dismissAll: true });
    expect(DISMISS_ALL_LABEL).toBe("Dismiss all");
    // In the same row as the chime toggle, just before it — the list's first child, above the rows.
    expect(offered.text(".list > .header .controls button")).toEqual([DISMISS_ALL_LABEL, "Chime on"]);
    expect(offered.root.querySelector(".list")?.firstElementChild?.className).toBe("header");
    expect(offered.root.querySelectorAll(".row .dismiss-all")).toHaveLength(0);
    // Clicking it asks for Dismiss all and nothing else — not the chime beside it.
    offered.click(".dismiss-all");
    expect(offered.calls).toEqual(["dismiss-all"]);
    // Never on a closed pill, whatever the view says.
    expect(draw({ ...VIEW, expanded: false, dismissAll: true }).root.querySelector(".dismiss-all")).toBeNull();
  });

  // jsdom does no layout, so it cannot say whether the button stays on screen when the list
  // scrolls — scripts/pill-dismiss-all-recon.cjs measures that in a real window. What jsdom CAN
  // do is apply pill.html's own stylesheet: this pins the two properties that recon showed are
  // load-bearing, so dropping either fails `npm test`, not only a script someone has to run.
  it("the header holding Dismiss all and the chime toggle is PINNED and OPAQUE (pill.html's own stylesheet)", () => {
    // From the repo root, where the suite runs (as tests/nativeTarget.test.ts reads package.json):
    // under jsdom, import.meta.url is not a file: URL.
    const html = readFileSync("src/renderer/pill.html", "utf8");
    const sheet = document.createElement("style");
    sheet.textContent = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    document.head.append(sheet);
    try {
      const { root } = draw({ ...VIEW, dismissAll: true });
      const header = root.querySelector(".list > .header") as HTMLElement;
      expect(header.querySelector(".dismiss-all")).not.toBeNull();
      const style = getComputedStyle(header);
      expect(style.position).toBe("sticky");
      expect(style.top).toBe("-8px");
      // Opaque: rows scrolling under it showed through at --surface's 0.96 (recon screenshot).
      expect(style.backgroundColor).toBe("rgb(24, 24, 27)");
    } finally {
      sheet.remove();
    }
  });

  it("shows a notice when there is one, and nothing when there is not", () => {
    expect(draw({ ...VIEW, notice: "Finish what's open in the bar first, then resume this." }).text(".notice")).toEqual([
      "Finish what's open in the bar first, then resume this.",
    ]);
    expect(draw({ ...VIEW, notice: null }).root.querySelector(".notice")).toBeNull();
    expect(draw(VIEW).root.querySelector(".notice")).toBeNull();
  });
});

describe("measurePill", () => {
  it("is null when the list is not open — there is nothing to size the window to", () => {
    expect(measurePill(draw({ ...VIEW, expanded: false }).root)).toBeNull();
    expect(measurePill(draw({ ...VIEW, mode: "hidden", items: [], expanded: false }).root)).toBeNull();
  });

  it("is the list's full content height plus the pill and the gap", () => {
    const { root } = draw(VIEW);
    const list = root.querySelector(".list") as HTMLElement;
    // jsdom does no layout, so the three numbers a browser would supply are supplied here.
    Object.defineProperty(list, "scrollHeight", { value: 201.2 });
    Object.defineProperty(list, "offsetHeight", { value: 120 });
    Object.defineProperty(list, "clientHeight", { value: 118 });
    // content 201.2 + border 2 + gap 6 + pill 44, rounded UP so nothing is cut by a fraction.
    expect(measurePill(root)).toBe(254);
  });

  it("a detail is drawn as ONE element holding the whole message — nothing is truncated by the page", () => {
    const long = "Could not confirm the message to #fun. It may have been sent. Check Slack before trying again.";
    const { text } = draw({ ...VIEW, items: [{ id: "j", title: "t", state: "failed", detail: long, actions: ["dismiss"] }] });
    expect(text(".row .detail")).toEqual([long]);
  });
});

// M27: the pill is drawn as wide as main chose for its label, and the page measures every way
// of writing the label so main can choose. jsdom does no layout, so a width is supplied per
// label: 8 px a character plus 60 for the padding and the dot, like a browser would roughly.
function withFakeLayout<T>(run: (seen: { styles: string[] }) => T): T {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const seen = { styles: [] as string[] };
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    seen.styles.push(this.style.cssText);
    const width = 60 + 8 * (this.querySelector(".label")?.textContent ?? "").length;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 44, width, height: 44, toJSON: () => ({}) };
  };
  try {
    return run(seen);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
}

describe("the label's width (M27)", () => {
  const COLLAPSED: PillView = { ...VIEW, expanded: false, label: "1 needs you · 2 done", labelOptions: ["1 needs you · 2 done", "1 needs you · +2 more"] };

  it("the pill is drawn at the width main chose, and at the stylesheet's until it has chosen", () => {
    expect((draw({ ...COLLAPSED, width: 300 }).root.querySelector(".summary") as HTMLElement).style.width).toBe("300px");
    expect((draw(COLLAPSED).root.querySelector(".summary") as HTMLElement).style.width).toBe("");
  });

  it("measures each way of writing the label at its natural width, and leaves the pill as it was", () => {
    const { root, text } = draw({ ...COLLAPSED, width: 240 });
    const widths = withFakeLayout((seen) => {
      const result = measureLabels(root, ["1 needs you · 2 done", "1 needs you · +2 more"]);
      // Measured at max-content, not at the 240 px the pill is drawn at.
      expect(seen.styles.every((style) => style.includes("width: max-content"))).toBe(true);
      return result;
    });
    expect(widths).toEqual([60 + 8 * 20, 60 + 8 * 21]);
    expect(root.querySelectorAll(".summary")).toHaveLength(1); // the probe is gone
    expect(text(".summary .label")).toEqual(["1 needs you · 2 done"]);
  });

  it("reports the widths, with the labels they are for, only when main does not have them yet", () => {
    const reports: string[] = [];
    const send = {
      contentHeight: () => undefined,
      labelWidths: (labels: string[], widths: number[]) => void reports.push(JSON.stringify([labels, widths])),
    };
    withFakeLayout(() => {
      reportMeasurements(draw(COLLAPSED).root, COLLAPSED, send);
      const accepted = { ...COLLAPSED, labelWidths: [220, 228], width: 232 };
      reportMeasurements(draw(accepted).root, accepted, send);
    });
    expect(reports).toEqual([JSON.stringify([COLLAPSED.labelOptions, [220, 228]])]);
  });

  it("hidden: nothing to measure, nothing reported", () => {
    const reports: unknown[] = [];
    const hidden: PillView = { ...VIEW, mode: "hidden", items: [], expanded: false };
    withFakeLayout(() =>
      reportMeasurements(draw(hidden).root, hidden, { contentHeight: (h) => reports.push(h), labelWidths: (l) => reports.push(l) }),
    );
    expect(reports).toEqual([]);
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
