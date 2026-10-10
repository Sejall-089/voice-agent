// Which URLs in a result may be opened by clicking them — the ONE rule, and the one list.
//
// A result is text, and not all of it is ours: an issue title or an email body is written by
// whoever filed the issue or sent the email, and reaches the result bar unchanged (spec §5b,
// "tool results are data"). So "make URLs clickable" cannot mean "make every URL clickable" —
// that would let anyone who can get text in front of the user put a link to anything in this
// app's own window.
//
// It means: the links THIS APP hands back, to the two services it files issues in. A URL is a
// link only when ALL of these hold, and each one closes a specific door:
//
//   - the string is the URL and nothing else: it starts with a lowercase `https://` and has no
//     whitespace, control character or backslash anywhere (so a parser's leniency about
//     "https:\\host" or an embedded newline is never what decides)
//   - the scheme is https — not http, and nothing that is not a web page at all
//     (javascript:, file:, data:, an app protocol)
//   - the hostname is EXACTLY one in the list — `github.com.evil.com` and `gist.github.com` are
//     different hosts, and `evil.com/github.com` is a path
//   - there is no username or password — `https://github.com@evil.com` goes to evil.com
//   - there is no explicit port
//
// USED TWICE, ON PURPOSE. The renderer asks it what to DRAW as a link; main asks it again
// before OPENING anything (WindowsShell.openResultLink). The renderer is the process that
// displays other people's text, so main does not take its word for what is safe.
//
// No imports and no platform APIs beyond `URL`, which the browser and node both have: this
// file is loaded by the renderer, the main process and the tests alike.

export const RESULT_LINK_HOSTS: readonly string[] = ["github.com", "linear.app"];

// The whole string, shaped like an https URL, with nothing a URL parser might quietly forgive.
const STRICT_HTTPS = /^https:\/\/[^\s\\\u0000-\u001f\u007f]+$/;

export function isAllowedResultLink(value: unknown): value is string {
  if (typeof value !== "string" || !STRICT_HTTPS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    RESULT_LINK_HOSTS.includes(url.hostname)
  );
}

export type ResultPart = { kind: "text"; text: string } | { kind: "link"; url: string };

// One run of non-space characters starting at "https://". Judged WHOLE: an allowed URL that is
// only the tail of another one ("https://evil.com/?to=https://github.com/…") is part of a
// candidate whose host is evil.com, and is never looked at on its own.
const CANDIDATE = /https:\/\/[^\s<>"'`]+/g;

// Punctuation that ends a sentence rather than a URL. A closing bracket is dropped only when
// the candidate has no opening one for it — "(see https://…/x)" loses its ")", a wiki page
// called "Page_(draft)" keeps it.
function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.slice(-1);
    const unbalanced = (open: string, close: string): boolean =>
      last === close && url.split(close).length > url.split(open).length;
    if (/[.,;:!?]/.test(last) || unbalanced("(", ")") || unbalanced("[", "]") || unbalanced("{", "}")) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

// A result, cut into the text to show as text and the URLs to show as links. LOSSLESS: the
// pieces, joined, are the original string — nothing is dropped, reordered or rewritten, and a
// URL that is not allowed simply stays inside the text around it.
export function splitResultLinks(text: string): ResultPart[] {
  const parts: ResultPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimTrailing(match[0]);
    if (!isAllowedResultLink(url)) continue;

    if (match.index > cursor) parts.push({ kind: "text", text: text.slice(cursor, match.index) });
    parts.push({ kind: "link", url });
    cursor = match.index + url.length;
  }

  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
