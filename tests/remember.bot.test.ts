import { describe, expect, it } from "vitest";
import type { DirectoryFailure, ToolChoice } from "../src/core/types.ts";
import { UNAVAILABLE, harness, notFound } from "./botChainHarness.ts";

// M22 prompt 5. `remember` in bot mode: a CHANNEL fact — its value starts with "#", or its subject
// ends in "channel" — is checked against Slack before it is saved, and saved as Slack's own
// "#name". A channel Slack does not have, or a Slack that cannot be asked, is refused and NOTHING
// is written. Every other fact, and every fact in webhook mode, is saved exactly as before.

const remember = (subject: string, value: string): ToolChoice => ({
  kind: "tool",
  name: "remember",
  input: { subject, value },
});

describe("bot-mode remember: channel facts are checked and canonical", () => {
  it.each([
    { subject: "team", value: "#help", stored: "#help" },
    { subject: "team", value: "#HELP", stored: "#help" },
    { subject: "bugs channel", value: "#bug-reports", stored: "#bug-reports" },
    { subject: "bugs channel", value: "help", stored: "#help" },
    { subject: "the support channel", value: " Help ", stored: "#help" },
  ])("$subject = $value is stored as $stored", async ({ subject, value, stored }) => {
    const h = harness(remember(subject, value));
    const outcome = await h.planner.run(`remember ${subject} is ${value}`);

    expect(outcome.status).toBe("ok");
    const [fact] = h.facts();
    expect(fact?.value).toBe(stored);
    expect(h.shell.results[0]).toMatch(new RegExp(`= ${stored}$`));
  });

  it("an update reports the canonical value it stored", async () => {
    const h = harness(remember("bugs channel", "bug-reports"), { facts: { "bugs channel": "#help" } });
    await h.planner.run("actually the bugs channel is bug-reports");
    expect(h.shell.results).toEqual(['Updated "bugs channel": #help → #bug-reports (v2).']);
  });

  it("refuses a channel Slack does not have, with suggestions, and writes nothing", async () => {
    const h = harness(remember("bugs channel", "#bug"));
    const outcome = await h.planner.run("remember the bugs channel is #bug");

    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([notFound("#bug", " Similar channels: #bug-reports.")]);
    expect(h.facts()).toEqual([]);
    expect(h.events.filter((e) => e.startsWith("write:"))).toEqual([]);
  });

  it.each(["network", "auth", "rate_limited", "ambiguous"] as DirectoryFailure[])(
    "refuses when Slack cannot answer (%s), and writes nothing",
    async (failure) => {
      const h = harness(remember("team", "#help"), { failOn: { 0: failure } });
      const outcome = await h.planner.run("remember the team is #help");
      expect(outcome.status).toBe("refused");
      // remember's refusals say what did not happen to a FACT (prompt 6): "saved", not "sent".
      expect(h.shell.results).toEqual([UNAVAILABLE[failure].replace(/so nothing was sent\.$/, "so nothing was saved.")]);
      expect(h.facts()).toEqual([]);
    },
  );

  // M33 commit 1 moved this check from the handler into `prepare`. The real action log's row 475,
  // replayed: the same words, `refused`, nothing written, no dialog, and each of §6f's spellings
  // looked up once (as typed, without "channel", with hyphens) — none of them a second time.
  it("row 475: 'the second channel' = 'fun channel' is refused the same way from prepare", async () => {
    const h = harness(remember("the second channel", "fun channel"));
    const outcome = await h.planner.run("remember the second channel is fun channel");

    expect(outcome.status).toBe("refused");
    expect(h.shell.results).toEqual([notFound("#fun channel")]);
    expect(h.facts()).toEqual([]);
    expect(h.shell.confirmMessages).toEqual([]);
    expect(h.log.entries).toEqual([
      expect.objectContaining({ tool: "remember", status: "refused", result: notFound("#fun channel") }),
    ]);
    expect(h.directory.calls).toEqual(["fun channel", "fun", "fun-channel"]);
  });

  it("does not leave an existing fact changed when the new value is refused", async () => {
    const h = harness(remember("bugs channel", "#nope"), { facts: { "bugs channel": "#help" } });
    await h.planner.run("the bugs channel is #nope");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#help", active: 1 }]);
  });
});

describe("bot-mode remember: other facts are untouched", () => {
  it.each([
    { subject: "tone", value: "concise and warm" },
    { subject: "target:dashboard", value: "https://app.example.com" },
    { subject: "team lead", value: "Dana" },
  ])("$subject = $value is saved as given, with no Slack lookup", async ({ subject, value }) => {
    const h = harness(remember(subject, value));
    const outcome = await h.planner.run(`remember ${subject} is ${value}`);
    expect(outcome.status).toBe("ok");
    expect(h.facts()).toEqual([{ subject, value, active: 1 }]);
    expect(h.directory.calls).toEqual([]);
  });
});

describe("remember outside bot mode is exactly M21", () => {
  it.each(["none", "webhook"] as const)("mode %s: '#nope' is saved as typed, Slack never asked", async (mode) => {
    const h = harness(remember("bugs channel", "#nope"), { mode });
    const outcome = await h.planner.run("remember the bugs channel is #nope");
    expect(outcome.status).toBe("ok");
    expect(h.shell.results).toEqual(["Remembered: bugs channel = #nope"]);
    expect(h.directory.calls).toEqual([]);
  });

  it("a bot sender with no directory saves as typed (no directory: not bot mode for remember)", async () => {
    const h = harness(remember("bugs channel", "#nope"), { directory: false });
    await h.planner.run("remember the bugs channel is #nope");
    expect(h.facts()).toEqual([{ subject: "bugs channel", value: "#nope", active: 1 }]);
  });
});
