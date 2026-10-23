import { describe, expect, it } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry, toToolSchemas } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { CONNECTORS } from "../src/core/mcp/load.ts";
import { SEPARATOR } from "../src/core/mcp/adapter.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";

// M29: what a plan's preview calls each step, on screen and aloud, is the TOOL's `planPhrase` —
// written in its code, or in a connector's pinned definition — and never the model's `describe`.
// This file holds every phrase the app can show to the same rules, and pins them all as literals,
// so a changed phrase is a deliberate edit here rather than a side effect somewhere else.

// Every built-in tool, every group switched on.
const BUILT_IN = buildRegistry({
  gmail: true,
  notion: true,
  calendar: true,
  speech: true,
  pointing: true,
  jobs: true,
});

// Every connector tool, from the definitions themselves, under the name the model sees. Read from
// the definitions rather than a loaded connector so that no setting or key can leave one out.
const CONNECTOR_PHRASES: [string, string][] = CONNECTORS.flatMap((def) =>
  def.tools.map((tool): [string, string] => [`${def.id}${SEPARATOR}${tool.name}`, tool.planPhrase]),
);

const ALL: [string, string][] = [
  ...BUILT_IN.map((tool): [string, string] => [tool.name, tool.planPhrase]),
  ...CONNECTOR_PHRASES,
];

// The approved list (M29), word for word.
const APPROVED: Record<string, string> = {
  summarize: "summarize the text you copied",
  rewrite: "reword the text you copied",
  openTarget: "open a web page",
  remember: "save a fact to memory",
  sendMessage: "post a message to Slack",
  recall: "look up a saved fact",
  openApp: "open an app",
  systemVolume: "change the volume",
  mediaControl: "control what is playing",
  searchSpotify: "search Spotify",
  tellTime: "tell the time or date",
  draftReply: "draft a reply in Gmail",
  reviseDraft: "change the Gmail draft",
  sendReply: "send the Gmail reply",
  readEmail: "read the open email",
  addToPage: "add a note to the Notion page",
  readSchedule: "read your calendar",
  createEvent: "add an event to your calendar",
  moveEvent: "move a calendar event",
  elaborate: "read out the rest of the last answer",
  pointAt: "point at something on screen",
  jobStatus: "check your background jobs",
  linear__create_issue: "create a Linear issue",
  linear__search_issues: "search Linear issues",
  linear__get_issue: "read a Linear issue",
  github__create_issue: "open a GitHub issue",
  github__list_issues: "list GitHub issues",
  github__get_issue: "read a GitHub issue",
};

describe("every tool's plan phrase", () => {
  it("covers all 28 tools, and is the approved phrase for each", () => {
    expect(ALL).toHaveLength(28);
    expect(Object.fromEntries(ALL)).toEqual(APPROVED);
  });

  // One test per rule, each over every phrase, so a failure names the rule it broke.
  it.each(ALL)("%s: non-empty and at most 40 characters", (_name, phrase) => {
    expect(phrase.trim().length).toBeGreaterThan(0);
    expect(phrase.length).toBeLessThanOrEqual(40);
  });

  // Spoken as well as shown: M14 found the speech engine garbles anything outside plain text.
  it.each(ALL)("%s: printable ASCII only", (_name, phrase) => {
    expect(phrase).toMatch(/^[\x20-\x7E]+$/);
  });

  it.each(ALL)("%s: starts lowercase, with no surrounding space", (_name, phrase) => {
    expect(phrase).toMatch(/^[a-z]/);
    expect(phrase).toBe(phrase.trim());
  });

  // The screen and the spoken form add their own: "1. Read your calendar", "First, ... ."
  it.each(ALL)("%s: no trailing punctuation", (_name, phrase) => {
    expect(phrase).not.toMatch(/[.,;:!?'")\]-]$/);
  });

  // An IDENTIFIER is what this rules out: a word shaped like this app's tool names — an underscore
  // (`linear__create_issue`), or camelCase, lowercase first with a capital inside (`readSchedule`).
  // Not a brand written its own way ("GitHub"), and not a plain English word that happens to be a
  // one-word tool's name ("summarize"): both read the same to a person either way.
  const IDENTIFIER = /_|^[a-z][a-z0-9]*[A-Z]/;
  it.each(ALL)("%s: no identifier", (name, phrase) => {
    for (const word of phrase.split(" ")) {
      expect(word, word).not.toMatch(IDENTIFIER);
    }
    if (IDENTIFIER.test(name)) expect(phrase).not.toContain(name);
  });

  it("no two tools share a phrase", () => {
    const phrases = ALL.map(([, phrase]) => phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe("the model never sees a plan phrase", () => {
  it("is not in the tool schemas", () => {
    for (const schema of toToolSchemas(BUILT_IN)) {
      expect(Object.keys(schema).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });

  // Through the planner, at the one place the model is handed the menu: what FakeLLM was offered
  // is what a provider client would have been. The KEY is what is checked, not the words: a
  // phrase may share words with a description we also wrote ("change the volume").
  it("is not in what the planner offers the model", async () => {
    const llm = new FakeLLM({ kind: "none", text: null }, "");
    const planner = new Planner(
      llm,
      new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null } }),
      BUILT_IN,
      new NoopMemoryResolver(),
      new InMemoryActionLog(),
    );
    await planner.run("anything");

    expect(llm.lastToolsOffered).toHaveLength(BUILT_IN.length);
    for (const schema of llm.lastToolsOffered) {
      expect(Object.keys(schema).sort()).toEqual(["description", "inputSchema", "name"]);
    }
    expect(JSON.stringify(llm.lastToolsOffered)).not.toContain("planPhrase");
  });
});
