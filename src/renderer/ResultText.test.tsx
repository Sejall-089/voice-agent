// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResultText } from "./ResultText.tsx";

// The result bar, drawn into a real DOM: which pieces of a result become links, and what a
// click or a key press on one does. This is the half a person sees and touches, so it is
// checked on the rendered elements, not on what the component was handed.
//
// It lives beside the component rather than in /tests because it needs the renderer's TypeScript
// settings (JSX, DOM); /tests is compiled as node code.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GITHUB = "https://github.com/Sejall-089/throwaway_repo/issues/3";
const LINEAR = "https://linear.app/sejal/issue/SEJ-7/login-button-does-nothing";

let host: HTMLDivElement;
let root: Root;
const openResultLink = vi.fn<(url: string) => void>();

beforeEach(() => {
  openResultLink.mockReset();
  // Only the one function this component may call. Anything else it reached for would be
  // undefined and throw.
  (window as unknown as { api: { openResultLink: (url: string) => void } }).api = { openResultLink };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(text: string): HTMLAnchorElement[] {
  act(() => root.render(<ResultText text={text} />));
  return [...host.querySelectorAll("a")];
}

describe("which results get a link", () => {
  it("links the GitHub issue URL, shown as the URL itself", () => {
    const links = show(`Created #3: M20 live test\n${GITHUB}`);

    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(GITHUB);
    expect(links[0]?.getAttribute("href")).toBe(GITHUB);
    // The whole result is still there, in order, character for character.
    expect(host.textContent).toBe(`Created #3: M20 live test\n${GITHUB}`);
  });

  it("links the Linear issue URL", () => {
    const links = show(`Created SEJ-7: Login button does nothing\n${LINEAR}`);
    expect(links.map((a) => a.textContent)).toEqual([LINEAR]);
  });

  it("links each URL in a multi-line list", () => {
    const urls = [7, 8, 9].map((n) => `https://github.com/Sejall-089/throwaway_repo/issues/${n}`);
    const links = show(urls.map((url, i) => `#${7 + i}: an issue (open)\n${url}`).join("\n"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(urls);
  });

  it("draws text with no URL exactly as it was, with no link", () => {
    const text = "Sent via your Slack webhook.\n\n• shipped on Friday";
    expect(show(text)).toEqual([]);
    expect(host.textContent).toBe(text);
  });

  it.each([
    ["github.com.evil.com", "https://github.com.evil.com/Sejall-089/x/issues/3"],
    ["evil.com/github.com", "evil.com/github.com"],
    ["https://evil.com/github.com", "https://evil.com/github.com/x"],
    ["http://github.com", "http://github.com/Sejall-089/x/issues/3"],
    ["javascript:", "javascript:alert(document.cookie)"],
    ["file:", "file:///C:/Windows/System32/calc.exe"],
    ["data:", "data:text/html,<b>hi</b>"],
    ["https://user@github.com", "https://user@github.com/Sejall-089/x"],
  ])("does NOT link %s — it stays plain text", (_label, url) => {
    const text = `Created #3: a title\n${url}`;
    expect(show(text)).toEqual([]);
    expect(host.textContent).toBe(text);
  });

  it("draws markup in a result as text, never as elements", () => {
    // An issue title is written by whoever filed the issue.
    const text = `Created #3: <img src=x onerror=alert(1)> <a href="https://evil.com">click</a>\n${GITHUB}`;
    const links = show(text);

    expect(links.map((a) => a.getAttribute("href"))).toEqual([GITHUB]); // only ours
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe(text);
  });
});

describe("using a link", () => {
  it("asks main to open exactly that URL on a click, and navigates nowhere itself", () => {
    const [link] = show(`Created #3: M20 live test\n${GITHUB}`);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    act(() => {
      link?.dispatchEvent(click);
    });

    expect(openResultLink).toHaveBeenCalledTimes(1);
    expect(openResultLink).toHaveBeenCalledWith(GITHUB);
    expect(click.defaultPrevented).toBe(true); // the bar's own window does not follow the href
  });

  it("opens the one that was clicked, in a list of several", () => {
    const links = show(`a\n${GITHUB}\nb\n${LINEAR}`);

    act(() => {
      links[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openResultLink.mock.calls).toEqual([[LINEAR]]);
  });

  it("can take keyboard focus, and Enter opens it — once", () => {
    const [link] = show(`Created #3: M20 live test\n${GITHUB}`);

    link?.focus();
    expect(document.activeElement).toBe(link);

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(enter);
    });

    expect(openResultLink.mock.calls).toEqual([[GITHUB]]);
    // Prevented, so the browser does not ALSO turn Enter into a click and open it twice.
    expect(enter.defaultPrevented).toBe(true);
  });

  it("does nothing for any other key", () => {
    const [link] = show(`x\n${GITHUB}`);
    act(() => {
      link?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      link?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    });
    expect(openResultLink).not.toHaveBeenCalled();
  });
});
