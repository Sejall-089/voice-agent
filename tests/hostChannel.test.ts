import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HostChannel, HostTimeoutError, verbOf } from "../src/main/shell/hostChannel.ts";
import { budgetFor, unconfirmedOutcomeMessage } from "../src/main/shell/WindowsInputInjector.ts";

// The input host's line protocol (post-M18 fix). THESE ARE THE TESTS THAT COULD NOT EXIST
// BEFORE, and that is the point of the file they test.
//
// The bug: replies were matched to requests by QUEUE POSITION (`waiters.shift()`), and a
// timed-out request removed its waiter while its reply was still in flight — so the next
// request received the previous one's answer and everything after it was off by one. A stale
// `KEY OK` could resolve a later key press as a success that never happened. None of it was
// reachable by a test, because the correlation logic was welded to a spawned PowerShell
// process. Extracting it is what makes the rest of this file possible.
//
// THE FAKE HOST BELOW IS ASYNC AND FAILS THE WAY THE REAL ONE DOES: it answers on a timer
// rather than in the same tick, it echoes the request id back exactly as HOST_SCRIPT now does,
// and it can answer AFTER the budget has expired — which is the one behaviour the real host
// exhibited and which `MockInputInjector` cannot express at all.

interface Harness {
  channel: HostChannel;
  written: string[];
  kills: () => number;
  logs: string[];
  untagged: string[];
  /** Answer the Nth command written, the way the host does: same id, prefixed. */
  replyTo: (index: number, body: string) => void;
  /** Answer with a raw line, for ids that match nothing and untagged lines. */
  raw: (line: string) => void;
  /** The id the host saw for the Nth command written. */
  idOf: (index: number) => number;
}

function harness(): Harness {
  const written: string[] = [];
  const logs: string[] = [];
  const untagged: string[] = [];
  let kills = 0;

  const channel = new HostChannel(
    {
      write: (line: string) => {
        written.push(line);
      },
      kill: () => {
        kills += 1;
      },
    },
    {
      onUntagged: (line) => untagged.push(line),
      onLog: (message) => logs.push(message),
    },
  );

  const idOf = (index: number): number => {
    const line = written[index] ?? "";
    return Number(line.slice(1, line.indexOf(" ")));
  };

  return {
    channel,
    written,
    kills: () => kills,
    logs,
    untagged,
    idOf,
    replyTo: (index, body) => channel.receive(`#${idOf(index)} ${body}\n`),
    raw: (line) => channel.receive(`${line}\n`),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the budget table", () => {
  // Written as LITERALS, not computed from the constants — the point is that these specific
  // durations are what ships. The flat 20s TYPE budget this replaced died at exactly 500
  // characters (20000 / 40ms per char) while dictation's cap is 90 SECONDS of speech.
  it("scales with the work the host will actually do", () => {
    expect(budgetFor(0)).toBe(5_000); // FG — identical to the old flat foreground timeout
    expect(budgetFor(15)).toBe(6_200); // KEY at the press ceiling; host needs 600ms
    expect(budgetFor(100)).toBe(13_000); // TYPE; host needs ~4.0s
    expect(budgetFor(500)).toBe(45_000); // TYPE; host needs ~20.0s — the OLD hard ceiling
    expect(budgetFor(1200)).toBe(101_000); // TYPE; host needs ~48.0s — a full 90s dictation
    expect(budgetFor(1800)).toBe(149_000); // TYPE; host needs ~72.0s
  });

  it("always leaves at least double the host's own chunk time", () => {
    for (const units of [0, 1, 15, 100, 500, 1200, 1800, 5000]) {
      // The host sleeps 40ms per unit; the budget must exceed that with room to spare.
      expect(budgetFor(units)).toBeGreaterThan(units * 40);
    }
  });

  it("never returns a negative budget for nonsense input", () => {
    expect(budgetFor(-5)).toBe(5_000);
  });
});

describe("replies are matched by id, not by arrival order", () => {
  // TEST 1. Under the old `waiters.shift()` these two answers would have been SWAPPED: A was
  // queued first, so it would have taken whichever reply arrived first. Delivered deliberately
  // out of order.
  it("gives each concurrent request its own reply when they arrive out of order", async () => {
    const h = harness();

    const a = h.channel.request("KEY 175 10", budgetFor(10));
    const b = h.channel.request("KEY 175 2", budgetFor(2));
    expect(h.channel.pendingCount()).toBe(2);

    // B answers FIRST.
    h.replyTo(1, "KEY OK 4");
    h.replyTo(0, "KEY OK 20");

    await expect(b).resolves.toBe("KEY OK 4");
    await expect(a).resolves.toBe("KEY OK 20");
  });

  it("tags every command it writes with a distinct id", () => {
    const h = harness();
    void h.channel.request("FG", budgetFor(0));
    void h.channel.request("KEY 175 1", budgetFor(1));

    expect(h.written[0]).toBe("#1 FG");
    expect(h.written[1]).toBe("#2 KEY 175 1");
    expect(h.idOf(0)).not.toBe(h.idOf(1));
  });
});

describe("a timed-out request", () => {
  // TEST 2.
  it("stays rejected even though its reply arrives later", async () => {
    const h = harness();
    const budget = budgetFor(10);

    const a = h.channel.request("KEY 175 10", budget);
    const settled = expect(a).rejects.toBeInstanceOf(HostTimeoutError);

    await vi.advanceTimersByTimeAsync(budget + 1);
    await settled;

    // The reply turns up 50ms after the budget blew. It must resolve nothing.
    h.replyTo(0, "KEY OK 20");
    await vi.advanceTimersByTimeAsync(50);

    await expect(a).rejects.toThrow(/did not respond in time/);
    expect(h.logs.some((l) => l.includes("discarded a reply"))).toBe(true);
  });

  // TEST 3. With ids this cannot happen by construction; asserted anyway, because the old code
  // made exactly this reachable — an `FG` reply resolving a `KEY` request.
  it("never lets another verb's reply resolve it", async () => {
    const h = harness();
    const budget = budgetFor(1);

    const key = h.channel.request("KEY 175 1", budget);

    // A reply carrying a DIFFERENT id, as a stale FG answer would.
    h.channel.receive("#999 FG 12345 \n");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.channel.pendingCount()).toBe(1); // still waiting — it took nothing

    h.replyTo(0, "KEY OK 2");
    await expect(key).resolves.toBe("KEY OK 2");
  });

  // TEST 4.
  it("kills the host exactly once and refuses further use", async () => {
    const h = harness();
    const budget = budgetFor(1);

    const a = h.channel.request("KEY 175 1", budget);
    const settled = expect(a).rejects.toBeInstanceOf(HostTimeoutError);
    await vi.advanceTimersByTimeAsync(budget + 1);
    await settled;

    expect(h.kills()).toBe(1);
    expect(h.channel.isPoisoned()).toBe(true);

    // The next request is refused rather than sent down a pipe nobody is reading. The OWNER
    // (WindowsInputInjector.ensureStarted) sees `isPoisoned()` and spawns a clean host.
    await expect(h.channel.request("KEY 175 1", budget)).rejects.toThrow(/did not respond in time/);
    expect(h.written).toHaveLength(1); // nothing new was written
    expect(h.kills()).toBe(1); // and it was not killed twice
  });

  it("fails every other request in flight rather than leaving them hanging", async () => {
    const h = harness();
    const shortBudget = budgetFor(1);
    const longBudget = budgetFor(1000);

    const slow = h.channel.request("TYPE AAAA", longBudget);
    const quick = h.channel.request("KEY 175 1", shortBudget);

    const quickSettled = expect(quick).rejects.toBeInstanceOf(HostTimeoutError);
    const slowSettled = expect(slow).rejects.toThrow(/stopped after another request timed out/);

    await vi.advanceTimersByTimeAsync(shortBudget + 1);
    await quickSettled;
    await slowSettled;

    expect(h.channel.pendingCount()).toBe(0);
  });

  // TEST 5. The constraint that matters most: an unconfirmed key press is NEVER repeated,
  // because pressing mute or play/pause again would undo what the user asked for.
  it("never retries — exactly one command reaches the host", async () => {
    const h = harness();
    const budget = budgetFor(5);

    const a = h.channel.request("KEY 175 5", budget);
    const settled = expect(a).rejects.toBeInstanceOf(HostTimeoutError);
    await vi.advanceTimersByTimeAsync(budget + 1);
    await settled;

    expect(h.written).toEqual(["#1 KEY 175 5"]);
    expect(h.written.filter((w) => w.includes("KEY 175 5"))).toHaveLength(1);
  });
});

describe("a slow but progressing TYPE", () => {
  // TEST 7 (item 2). THE REGRESSION THAT MATTERS FOR DICTATION. A long transcript legitimately
  // takes tens of seconds — the host sleeps 40ms per character — and killing the host partway
  // through would abandon a half-typed sentence in the user's document. So a TYPE that is
  // merely slow must be left alone until ITS OWN budget, which is far larger than a key
  // press's.
  it("is not killed while it is still inside its own budget", async () => {
    const h = harness();
    const chars = 500;
    const budget = budgetFor(chars); // 45s
    const hostWork = chars * 40; // 20s — what the host genuinely needs

    const typing = h.channel.request("TYPE <base64>", budget);

    // Well past a key press's budget (6.2s) and past the old flat 20s ceiling...
    await vi.advanceTimersByTimeAsync(hostWork - 1);
    expect(h.channel.pendingCount()).toBe(1); // ...still waiting
    expect(h.kills()).toBe(0); // ...and the host is untouched
    expect(h.channel.isPoisoned()).toBe(false);

    h.replyTo(0, "TYPE OK 1000");
    await expect(typing).resolves.toBe("TYPE OK 1000");
    expect(h.kills()).toBe(0);
  });

  it("is still killed if it blows its own, larger budget", async () => {
    const h = harness();
    const budget = budgetFor(500);

    const typing = h.channel.request("TYPE <base64>", budget);
    const settled = expect(typing).rejects.toBeInstanceOf(HostTimeoutError);
    await vi.advanceTimersByTimeAsync(budget + 1);
    await settled;

    expect(h.kills()).toBe(1);
  });

  // The old flat budget, stated as the thing that is now impossible: a 500-character transcript
  // used to sit exactly on a 20_000ms ceiling, so anything longer was killed for being long.
  it("would have timed out under the old flat 20s budget", () => {
    const hostWorkFor500 = 500 * 40;
    expect(hostWorkFor500).toBe(20_000); // exactly the old budget — no headroom at all
    expect(budgetFor(500)).toBeGreaterThan(hostWorkFor500);
    expect(budgetFor(1200)).toBeGreaterThan(1200 * 40);
  });
});

describe("the first command after a spawn", () => {
  // TEST 6. The channel-level half of the regression. THE REAL PROOF IS THE BENCH
  // (`scripts/input-host-bench.ts`), because the bug was in the PowerShell invocation and no
  // unit test can see that — this asserts only that nothing in the correlation layer eats a
  // first reply, which is the part that lives here.
  it("gets its own reply", async () => {
    const h = harness();

    const first = h.channel.request("KEY 175 1", budgetFor(1));
    expect(h.written).toEqual(["#1 KEY 175 1"]);

    h.replyTo(0, "KEY OK 2");
    await expect(first).resolves.toBe("KEY OK 2");
    expect(h.kills()).toBe(0);
  });

  it("routes the untagged READY handshake to the owner, not to a request", async () => {
    const h = harness();
    h.raw("READY");
    expect(h.untagged).toEqual(["READY"]);

    // And a request afterwards is unaffected by it.
    const first = h.channel.request("FG", budgetFor(0));
    h.replyTo(0, "FG NONE");
    await expect(first).resolves.toBe("FG NONE");
  });
});

describe("failAll", () => {
  it("rejects everything outstanding when the host exits", async () => {
    const h = harness();
    const a = h.channel.request("FG", budgetFor(0));
    const b = h.channel.request("KEY 175 1", budgetFor(1));

    const aSettled = expect(a).rejects.toThrow(/exited unexpectedly/);
    const bSettled = expect(b).rejects.toThrow(/exited unexpectedly/);
    h.channel.failAll(new Error("The input host exited unexpectedly."));
    await aSettled;
    await bSettled;

    expect(h.channel.pendingCount()).toBe(0);
    expect(h.channel.isPoisoned()).toBe(true);
  });
});

describe("verbOf", () => {
  // The one function standing between a diagnostic log and the user's dictated text.
  it("keeps the verb and drops every argument", () => {
    expect(verbOf("FG")).toBe("FG");
    expect(verbOf("KEY 175 5")).toBe("KEY");
    expect(verbOf("TYPE AGUAbwBtAGUAIABzAGUAYwByAGUAdAA=")).toBe("TYPE");
    expect(verbOf("KEY OK 10")).toBe("KEY");
    expect(verbOf("")).toBe("");
  });

  it("never leaks an argument into a log line", () => {
    const h = harness();
    const secret = "AGUAbwBtAGUAIABzAGUAYwByAGUAdAA=";
    void h.channel.request(`TYPE ${secret}`, budgetFor(10));
    h.replyTo(0, "TYPE OK 20");

    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line, line).not.toContain(secret);
      expect(line, line).not.toContain("175");
    }
  });
});

describe("what the user is told when a request did not confirm", () => {
  // Item 4. Both verbs, as literals, because this is the sentence a person reads after a
  // timeout — and because until it was extracted it lived inside a class no test could import
  // without spawning PowerShell.
  it("tells the truth about a key press that may already have landed", () => {
    expect(unconfirmedOutcomeMessage("KEY")).toBe(
      "I couldn't confirm that key press - it may or may not have gone through. Nothing was " +
        "retried, because repeating a mute or play/pause would undo it. Try again if nothing " +
        "changed.",
    );
  });

  it("warns that a timed-out dictation may have left part of the text behind", () => {
    expect(unconfirmedOutcomeMessage("TYPE")).toBe(
      "I couldn't confirm the typing finished - part of the text may have been typed into the " +
        "window already. Nothing was retried, because that would risk typing it twice. Check " +
        "the window before dictating again.",
    );
  });

  // The two properties that matter more than the exact wording, asserted as rules so a future
  // rewrite cannot quietly drop them.
  it("never claims the action failed, and always says nothing was retried", () => {
    for (const verb of ["KEY", "TYPE"] as const) {
      const message = unconfirmedOutcomeMessage(verb);
      // Not an assertion that it failed — we genuinely do not know.
      expect(message, verb).not.toMatch(/\bfailed\b|\bdidn't happen\b|\bnothing happened\b/i);
      // The uncertainty is stated...
      expect(message, verb).toMatch(/couldn't confirm/);
      // ...and so is the no-retry decision, which is the safety property.
      expect(message, verb).toMatch(/[Nn]othing was retried/);
      // Plain ASCII, so core/speech.ts and the strict FakeSynthesizer can carry it (M14).
      expect(message, verb).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("says the thing that is specific to each verb", () => {
    // A key press is a toggle risk; typed text is a partial-text risk. The two must not blur.
    expect(unconfirmedOutcomeMessage("KEY")).toContain("mute or play/pause");
    expect(unconfirmedOutcomeMessage("TYPE")).toContain("part of the text may have been typed");
    expect(unconfirmedOutcomeMessage("KEY")).not.toContain("text");
    expect(unconfirmedOutcomeMessage("TYPE")).not.toContain("key press");
  });
});
