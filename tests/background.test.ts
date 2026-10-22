import { describe, expect, it } from "vitest";
import { CONNECTORS, loadConnectorTools } from "../src/core/mcp/load.ts";
import { UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { declaredTiers } from "../src/core/risk.ts";

// `Tool.background` (M23), over the whole menu.
//
// The table below is the one that was APPROVED, written out — not derived from the tools. A
// tool whose tag changes, and a new tool with any tag at all, fails here until someone edits
// this file on purpose: "may run with nobody at the screen" is not something a tool should
// become by a one-word diff in its own file.

const connectors = loadConnectorTools({
  configText: JSON.stringify({
    connectors: Object.fromEntries(
      CONNECTORS.map((def) => [
        def.id,
        {
          enabled: true,
          tools: def.tools.map((tool) => tool.name),
          settings: { defaultTeam: "Engineering", owner: "acme", repo: "tracker" },
        },
      ]),
    ),
  }),
  readKey: () => "unused",
  connect: (def) => new UnavailableConnection(def.label),
}).tools;

const MENU = buildRegistry({
  gmail: true,
  notion: true,
  calendar: true,
  speech: true,
  pointing: true,
  connectors,
  jobs: true,
});

const APPROVED: Readonly<Record<string, "ok" | "foreground-only">> = {
  // Pure, or an API call working from the snapshot.
  summarize: "ok",
  recall: "ok",
  remember: "ok",
  readSchedule: "ok",
  createEvent: "ok",
  moveEvent: "ok",
  sendMessage: "ok",
  jobStatus: "ok",
  tellTime: "ok", // M25: reads the clock; nothing on screen is touched
  linear__create_issue: "ok",
  linear__search_issues: "ok",
  linear__get_issue: "ok",
  github__create_issue: "ok",
  github__list_issues: "ok",
  github__get_issue: "ok",
  // Act on whatever is open at that moment.
  draftReply: "foreground-only",
  reviseDraft: "foreground-only",
  sendReply: "foreground-only",
  readEmail: "foreground-only",
  addToPage: "foreground-only",
  // Take focus, or point at the current window.
  pointAt: "foreground-only",
  openTarget: "foreground-only",
  openApp: "foreground-only",
  searchSpotify: "foreground-only",
  // Hit the current media session, overwrite the clipboard, or speak.
  systemVolume: "foreground-only",
  mediaControl: "foreground-only",
  rewrite: "foreground-only",
  elaborate: "foreground-only",
};

describe("every tool says whether it may run in the background", () => {
  it("the menu and the approved table name exactly the same tools", () => {
    expect(MENU.map((tool) => tool.name).sort()).toEqual(Object.keys(APPROVED).sort());
  });

  it.each(MENU.map((tool) => [tool.name, tool] as const))("%s carries its approved tag", (name, tool) => {
    expect(tool.background).toBe(APPROVED[name]);
  });

  it("no tool is left without one — the field has no default to fall back on", () => {
    for (const tool of MENU) {
      expect(["ok", "foreground-only"], tool.name).toContain(tool.background);
    }
  });

  it("the tag is independent of the tier: a safe tool can need the screen, a dangerous one need not", () => {
    const byName = new Map(MENU.map((tool) => [tool.name, tool]));
    // A read, and still about a moment.
    expect(declaredTiers(byName.get("readEmail")!.risk)).toEqual(["safe"]);
    expect(byName.get("readEmail")!.background).toBe("foreground-only");
    // Irreversible, and fine to prepare unattended — the confirm gate is what holds it.
    expect(declaredTiers(byName.get("sendMessage")!.risk)).toEqual(["dangerous"]);
    expect(byName.get("sendMessage")!.background).toBe("ok");
  });

  // RE-JUSTIFIED AT M25. Was "jobStatus is the only status-only tool". What it protects is that a
  // tool skips the job queue only when it is on an approved list and is `safe` — a status-only
  // tool is admitted with no slot and never listed, so it must not be able to act. `tellTime`
  // (reads the clock) joins on purpose; the safe check now covers every one of them.
  it("only the approved tools are status-only, and every one of them is safe", () => {
    const statusOnly = MENU.filter((tool) => tool.statusOnly === true);
    expect(statusOnly.map((tool) => tool.name).sort()).toEqual(["jobStatus", "tellTime"]);
    for (const tool of statusOnly) expect(declaredTiers(tool.risk), tool.name).toEqual(["safe"]);
  });

  it("jobStatus is on the menu only when there are job records to read", () => {
    const without = buildRegistry({ gmail: true, notion: true, calendar: true, speech: true, pointing: true, connectors });
    expect(without.map((tool) => tool.name)).not.toContain("jobStatus");
    expect(MENU.map((tool) => tool.name)).toContain("jobStatus");
  });
});
