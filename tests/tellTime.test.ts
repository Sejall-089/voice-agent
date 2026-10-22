import { describe, it, expect } from "vitest";
import { formatTimeAnswer, tellTimeTool } from "../src/core/tools/tellTime.ts";
import { toSpokenResult } from "../src/core/speech.ts";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { NoopMemoryResolver } from "../src/core/memory/NoopMemoryResolver.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeLLM } from "./FakeLLM.ts";

// M25 Fix 3: "what's the time" gets one short, exact sentence, built in code from the clock.
//
// Every expected string below is a LITERAL, written by hand from the UTC instant and the zone —
// never produced by asking Intl, because node (these tests) and electron (the app) ship different
// ICU, and a test that formats its own expectation only proves the runtime agrees with itself
// (CLAUDE.md, M14).

const KOLKATA = "Asia/Kolkata"; // UTC+05:30, no daylight saving
const NEW_YORK = "America/New_York"; // UTC-04:00 on these dates (EDT)

// 2026-10-22 is a Thursday.
const at = (h: number, m: number, day = 22): number => Date.UTC(2026, 9, day, h, m);

describe("formatTimeAnswer — the time", () => {
  it.each([
    [at(9, 21), KOLKATA, "It's 2:51 PM."],
    [at(6, 30), KOLKATA, "It's 12:00 PM."], // noon
    [at(18, 35, 21), KOLKATA, "It's 12:05 AM."], // just after midnight
    [at(18, 29), KOLKATA, "It's 11:59 PM."],
    [at(9, 21), NEW_YORK, "It's 5:21 AM."],
  ])("%i in %s -> %s", (now, zone, expected) => {
    expect(formatTimeAnswer("time", now, zone)).toBe(expected);
  });

  it("is the time only: no date, no zone, no seconds", () => {
    const answer = formatTimeAnswer("time", at(9, 21), KOLKATA);
    expect(answer).not.toMatch(/2026|October|Thursday|IST|Kolkata|:\d{2}:\d{2}/);
  });

  it("is plain ASCII on this machine's ICU", () => {
    for (const zone of [KOLKATA, NEW_YORK]) {
      expect(formatTimeAnswer("time", at(9, 21), zone)).toMatch(/^[\x20-\x7E]+$/);
      expect(formatTimeAnswer("date", at(9, 21), zone)).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  // The test above cannot fail here: this node's ICU (78) puts a plain space before "PM". An ICU
  // that puts U+202F there — and lowercases the day period — is handed in as literal parts, and
  // the answer must be assembled from the pieces with every separator its own.
  it("is assembled from the pieces, whatever separators an ICU puts between them", () => {
    const narrowNbsp = " ";
    const timeParts = () => [
      { type: "hour" as const, value: "7" },
      { type: "literal" as const, value: "." },
      { type: "minute" as const, value: "05" },
      { type: "literal" as const, value: narrowNbsp },
      { type: "dayPeriod" as const, value: "pm" },
    ];
    const dateParts = () => [
      { type: "weekday" as const, value: "Thursday" },
      { type: "literal" as const, value: " " },
      { type: "day" as const, value: "22" },
      { type: "literal" as const, value: narrowNbsp },
      { type: "month" as const, value: "October" },
    ];
    expect(formatTimeAnswer("time", 0, KOLKATA, timeParts)).toBe("It's 7:05 PM.");
    expect(formatTimeAnswer("date", 0, KOLKATA, dateParts)).toBe("It's Thursday, 22 October.");
  });
});

describe("formatTimeAnswer — the date", () => {
  it("is the date only", () => {
    expect(formatTimeAnswer("date", at(9, 21), KOLKATA)).toBe("It's Thursday, 22 October.");
  });

  it("is the date in the user's zone, not UTC's", () => {
    // 18:35 UTC on the 21st is already 00:05 on Thursday the 22nd in Kolkata, still Wednesday
    // afternoon in New York.
    expect(formatTimeAnswer("date", at(18, 35, 21), KOLKATA)).toBe("It's Thursday, 22 October.");
    expect(formatTimeAnswer("date", at(18, 35, 21), NEW_YORK)).toBe("It's Wednesday, 21 October.");
  });
});

describe("how it is spoken", () => {
  it.each([
    ["It's 2:51 PM.", "It's 2 51 PM."],
    ["It's 12:00 PM.", "It's 12 PM."],
    ["It's 12:05 AM.", "It's 12 oh 5 AM."],
    ["It's Thursday, 22 October.", "It's Thursday, 22 October."],
  ])("%s is said as %s", (shown, said) => {
    expect(toSpokenResult(shown)).toEqual({ text: said, remainder: null });
  });
});

describe("tellTime through the planner", () => {
  function run(what: string) {
    const shell = new MockShell({ context: { selectedText: null, activeApp: null, activeWindowTitle: null } });
    const log = new InMemoryActionLog();
    const planner = new Planner(
      new FakeLLM({ kind: "tool", name: "tellTime", input: { what } }),
      shell,
      buildRegistry({ gmail: false }),
      new NoopMemoryResolver(),
      log,
    );
    return { planner, shell, log };
  }

  it("answers the time in one sentence, logged as a run — not as a miss", async () => {
    const { planner, shell, log } = run("time");
    const outcome = await planner.run("what's the time");

    expect(outcome.status).toBe("ok");
    expect(outcome.result).toMatch(/^It's (1[0-2]|[1-9]):[0-5]\d (AM|PM)\.$/);
    expect(shell.results).toEqual([outcome.result]);
    expect(log.misses).toEqual([]);
    expect(log.getLast()?.tool).toBe("tellTime");
  });

  it("answers the date only when the date is asked", async () => {
    const { planner } = run("date");
    const outcome = await planner.run("what's the date");

    expect(outcome.result).toMatch(/^It's [A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+\.$/);
  });

  it("is on the menu with no configuration at all", () => {
    expect(buildRegistry({ gmail: false }).map((tool) => tool.name)).toContain("tellTime");
    expect(tellTimeTool.risk).toBe("safe");
  });
});
