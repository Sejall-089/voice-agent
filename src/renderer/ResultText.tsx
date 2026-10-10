import type { KeyboardEvent, MouseEvent } from "react";
import { splitResultLinks } from "../core/resultLinks.ts";

// A result, with the links this app is willing to open drawn as links.
//
// Everything is a React text node or an <a> built here — the result is never parsed as markup,
// so a title containing "<img onerror=…>" is shown as those characters. Which URLs become links
// is decided by `splitResultLinks` (core/resultLinks.ts): https, an exact host from one short
// list, nothing else. Anything that fails stays text, exactly as it was written.
//
// A click does not follow the href. This window is the command bar; navigating it would replace
// the app's own UI with a web page that has the preload bridge in reach. The click asks main to
// open the URL in the default browser, and main checks the URL again before it does. The href
// is there so the element is a real link — focusable, announced as one — and main also refuses
// every navigation and every new window, in case this handler is ever not what runs.
export function ResultText({ text }: { text: string }): JSX.Element {
  const open = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.api.openResultLink(url);
  };
  // Enter on a focused link opens it. Handled here and PREVENTED, rather than left to the
  // browser to turn into a click: the link is then opened exactly once, by one code path.
  const openOnEnter = (url: string) => (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.api.openResultLink(url);
  };

  return (
    <>
      {splitResultLinks(text).map((part, index) =>
        part.kind === "text" ? (
          part.text
        ) : (
          <a
            key={index}
            className="result-link"
            href={part.url}
            onClick={open(part.url)}
            onKeyDown={openOnEnter(part.url)}
          >
            {part.url}
          </a>
        ),
      )}
    </>
  );
}
