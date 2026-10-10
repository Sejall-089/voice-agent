import { describe, it, expect } from "vitest";
import {
  RESULT_LINK_HOSTS,
  isAllowedResultLink,
  splitResultLinks,
} from "../src/core/resultLinks.ts";

// Which text in a result may be a clickable link. ONE rule, used twice: the renderer asks it
// what to draw as a link, and main asks it again before opening anything — because the renderer
// is the side that displays text other people wrote (an issue title, an email body), and main
// must not take its word for what is safe to open.
//
// Every URL here is a literal. Nothing asks the code under test to produce its own input.

const GITHUB = "https://github.com/Sejall-089/throwaway_repo/issues/3";
const LINEAR = "https://linear.app/sejal/issue/SEJ-7/login-button-does-nothing";

// Things that look like, contain, or sit near an allowed host — and are not one.
const NOT_LINKS: [label: string, url: string][] = [
  ["an allowed host as a SUBDOMAIN LABEL of another", "https://github.com.evil.com/Sejall-089/x/issues/3"],
  ["an allowed host in the PATH of another", "https://evil.com/github.com/Sejall-089/x/issues/3"],
  ["a bare host and path with no scheme", "evil.com/github.com"],
  ["http, not https", "http://github.com/Sejall-089/x/issues/3"],
  ["a javascript: URL", "javascript:alert(document.cookie)"],
  ["a file: URL", "file:///C:/Windows/System32/calc.exe"],
  ["a data: URL", "data:text/html,<script>alert(1)</script>"],
  ["a username in front of the host", "https://user@github.com/Sejall-089/x/issues/3"],
  ["a username and password", "https://user:secret@github.com/Sejall-089/x"],
  ["the real host as a USERNAME for another", "https://github.com@evil.com/x"],
  ["a subdomain of an allowed host", "https://gist.github.com/someone/abc"],
  ["a non-default port", "https://github.com:8443/x"],
  ["a trailing dot on the host", "https://github.com./x"],
  ["a backslash trick", "https://github.com\\@evil.com/x"],
  ["a lookalike host", "https://github.com-login.example/x"],
  ["a protocol-relative URL", "//github.com/x"],
  ["an app protocol", "spotify:track:123"],
];

describe("the allowlist", () => {
  it("is exactly these two hosts", () => {
    expect([...RESULT_LINK_HOSTS]).toEqual(["github.com", "linear.app"]);
  });
});

describe("isAllowedResultLink", () => {
  it.each([GITHUB, LINEAR, "https://github.com/", "https://linear.app/x?y=1#z"])("allows %s", (url) => {
    expect(isAllowedResultLink(url)).toBe(true);
  });

  it.each(NOT_LINKS)("rejects %s", (_label, url) => {
    expect(isAllowedResultLink(url)).toBe(false);
  });

  it.each([
    ["leading whitespace", ` ${GITHUB}`],
    ["trailing whitespace", `${GITHUB} `],
    ["a space inside", "https://github.com/a b"],
    ["a newline inside", "https://github.com/a\nhttps://evil.com"],
    ["a tab inside", "https://github.com/\ta"],
    ["an empty string", ""],
  ])("rejects %s — the string must be the URL, the whole URL and nothing else", (_label, url) => {
    expect(isAllowedResultLink(url)).toBe(false);
  });

  it.each([[undefined], [null], [42], [{ href: GITHUB }], [[GITHUB]]])(
    "rejects a non-string (%j) without throwing",
    (value) => {
      expect(isAllowedResultLink(value)).toBe(false);
    },
  );
});

describe("splitResultLinks", () => {
  const text = (value: string) => ({ kind: "text" as const, text: value });
  const link = (url: string) => ({ kind: "link" as const, url });
  // Whatever it does, it must never lose or alter a character of the result.
  const rejoined = (input: string): string =>
    splitResultLinks(input)
      .map((part) => (part.kind === "text" ? part.text : part.url))
      .join("");

  it("turns the GitHub create result's second line into a link", () => {
    expect(splitResultLinks(`Created #3: M20 live test\n${GITHUB}`)).toEqual([
      text("Created #3: M20 live test\n"),
      link(GITHUB),
    ]);
  });

  it("turns the Linear create result's second line into a link", () => {
    expect(splitResultLinks(`Created SEJ-7: Login button does nothing\n${LINEAR}`)).toEqual([
      text("Created SEJ-7: Login button does nothing\n"),
      link(LINEAR),
    ]);
  });

  it("leaves text with no URL as one unchanged piece", () => {
    const plain = "Sent via your Slack webhook.\n(You asked for #help.)\n\n• shipped on Friday";
    expect(splitResultLinks(plain)).toEqual([text(plain)]);
  });

  it("returns nothing for an empty result", () => {
    expect(splitResultLinks("")).toEqual([]);
  });

  it("links every URL in a multi-line list", () => {
    const list = [
      "#7: An older issue (open)",
      "https://github.com/Sejall-089/throwaway_repo/issues/7",
      "#8: Bug from email (open)",
      "https://github.com/Sejall-089/throwaway_repo/issues/8",
      "SEJ-9: A Linear one (Todo)",
      "https://linear.app/sejal/issue/SEJ-9/a-linear-one",
    ].join("\n");

    const parts = splitResultLinks(list);

    expect(parts.filter((part) => part.kind === "link")).toEqual([
      link("https://github.com/Sejall-089/throwaway_repo/issues/7"),
      link("https://github.com/Sejall-089/throwaway_repo/issues/8"),
      link("https://linear.app/sejal/issue/SEJ-9/a-linear-one"),
    ]);
    expect(rejoined(list)).toBe(list);
  });

  it.each(NOT_LINKS)("leaves %s as plain text", (_label, url) => {
    const input = `Look at this: ${url} — and nothing else.`;
    expect(splitResultLinks(input)).toEqual([text(input)]);
  });

  it("links the good URL and leaves the bad one beside it as text", () => {
    const input = `real: ${GITHUB}\nfake: https://github.com.evil.com/x`;
    expect(splitResultLinks(input)).toEqual([
      text("real: "),
      link(GITHUB),
      text("\nfake: https://github.com.evil.com/x"),
    ]);
  });

  it("does not link an allowed URL that is only the tail of another URL", () => {
    // One run of non-space characters is one candidate, judged whole. Its host is evil.com.
    const input = `https://evil.com/redirect?to=${GITHUB}`;
    expect(splitResultLinks(input)).toEqual([text(input)]);
  });

  it.each([
    ["a full stop", `See ${GITHUB}.`, "."],
    ["a comma", `See ${GITHUB}, then reply`, ", then reply"],
    ["a closing bracket", `(see ${GITHUB})`, ")"],
    ["a question mark", `Is it ${GITHUB}?`, "?"],
  ])("keeps %s that follows a URL out of the link", (_label, input, after) => {
    const parts = splitResultLinks(input);
    expect(parts).toContainEqual(link(GITHUB));
    expect(parts.at(-1)).toEqual(text(after));
    expect(rejoined(input)).toBe(input);
  });

  it("keeps brackets that belong to the URL", () => {
    const url = "https://github.com/a/b/wiki/Page_(draft)";
    expect(splitResultLinks(`open ${url} now`)).toEqual([text("open "), link(url), text(" now")]);
  });

  it("never loses a character, whatever is in the text", () => {
    for (const input of [
      "",
      "plain",
      GITHUB,
      `${GITHUB}${LINEAR}`,
      `a ${GITHUB} b ${LINEAR} c`,
      "https://",
      "https://github.com",
      "<a href='https://github.com/x'>x</a> <script>alert(1)</script>",
      `\n\n${GITHUB}\n\n`,
    ]) {
      expect(rejoined(input), JSON.stringify(input)).toBe(input);
    }
  });

  it("only ever calls something a link that the validator allows", () => {
    const soup = `${NOT_LINKS.map(([, url]) => url).join(" ")} ${GITHUB} ${LINEAR}`;
    for (const part of splitResultLinks(soup)) {
      if (part.kind === "link") expect(isAllowedResultLink(part.url), part.url).toBe(true);
    }
  });
});
