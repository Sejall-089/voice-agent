// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandBar, flattenNewlines } from "./CommandBar.tsx";

// The bar's text box, in a real DOM (jsdom): a textarea that WRAPS, and every flow that reads
// or writes it — an instruction capture, a question's answer, the resets.
//
// It replaced a single-line <input> after a live run in which a long instruction scrolled
// sideways out of view and the user could not read back what had been run.
//
// WHAT THIS CANNOT SHOW: that the text actually wraps, or how tall the box gets. jsdom does no
// layout (every scrollHeight is 0). That is scripts/bar-wrap-recon.cjs, against a real window.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A stand-in for the preload bridge: every `on…` hands back an unsubscribe and remembers its
// callback so a test can fire it as main would; every outgoing call is recorded.
function fakeApi() {
  const sent: string[] = [];
  const handlers = new Map<string, (...args: never[]) => void>();
  const on =
    (name: string) =>
    (callback: (...args: never[]) => void): (() => void) => {
      handlers.set(name, callback);
      return () => handlers.delete(name);
    };
  const api = {
    onShow: on("show"),
    onEcho: on("echo"),
    onStatus: on("status"),
    onReset: on("reset"),
    onAsk: on("ask"),
    onFocusInput: on("focus"),
    onVoiceStart: on("voiceStart"),
    onVoiceStop: on("voiceStop"),
    onVoiceCancel: on("voiceCancel"),
    onVoiceState: on("voiceState"),
    onThinking: on("thinking"),
    onSpeak: on("speak"),
    onStopSpeaking: on("stopSpeaking"),
    onChime: on("chime"),
    onChimeStop: on("chimeStop"),
    submit: (text: string) => void sent.push(`submit:${JSON.stringify(text)}`),
    close: () => void sent.push("close"),
    notifyTyping: () => void sent.push("typing"),
    openResultLink: () => undefined,
    voiceStarted: () => undefined,
    sendAudio: () => undefined,
    speechEnded: () => undefined,
  };
  const fire = (name: string, ...args: unknown[]): void => {
    const handler = handlers.get(name) as ((...a: unknown[]) => void) | undefined;
    if (handler === undefined) throw new Error(`nothing is listening for ${name}`);
    act(() => handler(...args));
  };
  return { api, sent, fire };
}

let host: HTMLDivElement;
let root: Root;
let bridge: ReturnType<typeof fakeApi>;

beforeEach(() => {
  bridge = fakeApi();
  (window as unknown as { api: unknown }).api = bridge.api;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandBar />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const box = (): HTMLTextAreaElement => {
  const element = host.querySelector(".command-input");
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("the bar's box is not a textarea");
  return element;
};

// Put text in the box the way the browser does for typing or a paste: set the DOM value, then
// an `input` event. React's controlled value is only updated by the component's own onChange.
function enter(text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    box().dispatchEvent(event);
  });
  return event;
}

describe("the bar's text box", () => {
  it("is a TEXTAREA, one row to start with — not a single-line input", () => {
    expect(host.querySelector("input")).toBeNull();
    expect(box().tagName).toBe("TEXTAREA");
    expect(box().rows).toBe(1);
    // The class the stylesheet and the ask-recon scripts find it by is unchanged.
    expect(box().classList.contains("command-input")).toBe(true);
  });

  it("holds a long instruction whole", () => {
    const long = "create an issue on github for body format and send these notes to fun channel";
    enter(long);
    expect(box().value).toBe(long);
  });

  it("ENTER submits what is in the box, trimmed, and types no newline", () => {
    enter("  summarize this  ");
    const event = press("Enter");
    expect(bridge.sent).toContain('submit:"summarize this"');
    expect(event.defaultPrevented).toBe(true);
    expect(box().value).not.toContain("\n");
  });

  it("SHIFT+ENTER does nothing: no submit, and no newline", () => {
    enter("summarize this");
    const event = press("Enter", { shiftKey: true });
    expect(bridge.sent.filter((entry) => entry.startsWith("submit"))).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(box().value).toBe("summarize this");
  });

  it("Enter on an empty box submits nothing (there is nothing to run, and nothing is being dictated)", () => {
    press("Enter");
    expect(bridge.sent).toEqual([]);
  });

  it("a PASTED NEWLINE is flattened to a space, so what is submitted is one line", () => {
    enter("file this bug\nand tell the team\r\n\r\nplease");
    expect(box().value).toBe("file this bug and tell the team please");
    press("Enter");
    expect(bridge.sent).toContain('submit:"file this bug and tell the team please"');
  });

  it("flattenNewlines: every kind of line break, runs of them, and the spaces around them", () => {
    expect(flattenNewlines("a\nb")).toBe("a b");
    expect(flattenNewlines("a\r\nb")).toBe("a b");
    expect(flattenNewlines("a \n\n\n b")).toBe("a b");
    expect(flattenNewlines("no breaks here")).toBe("no breaks here");
    expect(flattenNewlines("a\nb")).not.toMatch(/[\r\n]/);
  });

  it("typing tells main once, on the first character, not on every key", () => {
    enter("s");
    enter("su");
    enter("sum");
    expect(bridge.sent.filter((entry) => entry === "typing")).toEqual(["typing"]);
  });

  it("Escape still closes", () => {
    press("Escape");
    expect(bridge.sent).toEqual(["close"]);
  });
});

describe("the flows that read and write the box still work", () => {
  it("INSTRUCTION CAPTURE: opening the bar clears the box and what is typed next is what is submitted", () => {
    enter("something left over");
    bridge.fire("show");
    expect(box().value).toBe("");
    enter("open my dashboard");
    press("Enter");
    expect(bridge.sent.filter((entry) => entry.startsWith("submit"))).toEqual(['submit:"open my dashboard"']);
  });

  it("QUESTION REPLY: the question appears, the box starts empty, and Enter sends the ANSWER", () => {
    enter("a half-typed instruction");
    bridge.fire("ask", "Which channel is the bugs channel?");
    expect(host.querySelector(".command-question")?.textContent).toBe("Which channel is the bugs channel?");
    // A half-typed instruction must not become the answer.
    expect(box().value).toBe("");
    expect(box().placeholder).toContain("Type your answer");

    const before = bridge.sent.length;
    enter("#bugs");
    press("Enter");
    // Only the answer went out. Answering a question is not "I started typing instead of
    // speaking", so no typing signal accompanies it.
    expect(bridge.sent.slice(before)).toEqual(['submit:"#bugs"']);
  });

  it("QUESTION REPLY: an EMPTY answer is still an answer, and is sent", () => {
    bridge.fire("ask", "Anything to add?");
    press("Enter");
    expect(bridge.sent).toEqual(['submit:""']);
  });

  it("QUESTION REPLY: Shift+Enter does not answer", () => {
    bridge.fire("ask", "Which channel?");
    enter("#bugs");
    press("Enter", { shiftKey: true });
    expect(bridge.sent.filter((entry) => entry.startsWith("submit"))).toEqual([]);
  });

  it("when the question is taken down the box is emptied, so a sent answer is not the next instruction", () => {
    bridge.fire("ask", "Which channel?");
    enter("#bugs");
    bridge.fire("ask", null);
    expect(host.querySelector(".command-question")).toBeNull();
    expect(box().value).toBe("");
    expect(box().placeholder).toContain("Speak, or type");
  });

  it("RESET (the bar was hidden) clears the box", () => {
    enter("never mind");
    bridge.fire("reset");
    expect(box().value).toBe("");
  });

  it("DICTATION: with the microphone live, Enter on an EMPTY box submits (it means 'stop talking, run it')", () => {
    bridge.fire("voiceState", "recording");
    press("Enter");
    expect(bridge.sent).toEqual(['submit:""']);
  });

  it("DICTATION DISPLAY: what was heard is shown in its own line, in full, and the box stays empty", () => {
    const heard = "create an issue on github for body format and send these notes to fun channel";
    bridge.fire("voiceState", "idle", heard);
    expect(host.querySelector(".voice-heard")?.textContent).toBe(`Heard: “${heard}”`);
    expect(box().value).toBe("");
  });

  it("FOCUS: the focus request from main does not clear a half-typed answer", () => {
    bridge.fire("ask", "Which channel?");
    enter("#bu");
    bridge.fire("focus");
    expect(box().value).toBe("#bu");
  });

  it("the refusal's second paragraph is drawn in the result area as its own line of text", () => {
    const refusal = "I tried to decide more than one thing in a single step.\n\nWhat I heard: “do two things”";
    bridge.fire("echo", refusal);
    expect(host.querySelector(".command-echo")?.textContent).toContain("What I heard: “do two things”");
  });
});
