// Investigating the intermittent "The input host did not respond in time." on mediaKey
// commands (live finding, post-M18).
//
//   INPUT_HOST_DEBUG=1 npx vite-node scripts/input-host-bench.ts
//
// Follows scripts/uia-host-bench.ts exactly: it IMPORTS THE REAL CLASS rather than
// re-implementing the spawn or copying HOST_SCRIPT. A benchmark with its own copy of the host
// script would be the most expensive possible version of CLAUDE.md's lenient-fake mistake —
// it would measure something that is not what ships.
//
// THE QUESTIONS, in the order they can change the fix:
//   Q1  Cold start: spawn -> first reply, including the Add-Type compile, against the budget.
//       If that exceeds a request's timeout, the first command is doomed and a warm-up is the
//       fix. If it does not, the timeout has another cause.
//   Q2  Back-to-back: 50 commands with no gap. Does the pipeline hold, and does the FIRST one
//       behave differently from the other 49?
//   Q3  After idle: does a host that has sat quiet go stale? 10s, 60s, and (with --long) 5min.
//   Q4  After a timeout, is the next command fine (transient) or does it keep failing (wedged)?
//   Q5  Does a LATE reply to a timed-out request get handed to the NEXT request? With
//       INPUT_HOST_DEBUG=1 the injector prints "STRAY LINE (no waiter)" when a late reply is
//       discarded, and a reply whose verb does not match its request when it is not.
//
// SAFETY: the default probe key is 0x07, an UNDEFINED virtual key. It exercises the identical
// path — a real `wVk`, a real keydown/keyup pair, a real SendInput — and changes nothing on the
// machine, so 50 of them do not leave the volume somewhere new or toggle anyone's music. Pass
// `--real` to use volume up/down in alternating PAIRS instead (net zero, but audible).

import { WindowsInputInjector } from "../src/main/shell/WindowsInputInjector.ts";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]!;
};

const INERT_VK = 0x07; // undefined in WinUser.h — delivered, ignored by everything
const VOLUME_UP = 0xaf;
const VOLUME_DOWN = 0xae;
const REAL = has("--real");
const BURST = Number(flag("--burst", "50"));
const LONG = has("--long");

interface Sample {
  phase: string;
  n: number;
  ms: number;
  ok: boolean;
  error?: string;
}

const samples: Sample[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One press, timed, never throwing — a timeout is a RESULT here, not an abort.
async function press(injector: WindowsInputInjector, phase: string, n: number): Promise<Sample> {
  // Alternate up/down in --real mode so the volume ends where it started.
  const vk = REAL ? (n % 2 === 0 ? VOLUME_UP : VOLUME_DOWN) : INERT_VK;
  const started = Date.now();
  try {
    await injector.pressKey(vk, 1);
    const sample = { phase, n, ms: Date.now() - started, ok: true };
    samples.push(sample);
    return sample;
  } catch (error) {
    const sample = {
      phase,
      n,
      ms: Date.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    samples.push(sample);
    return sample;
  }
}

function stats(phase: string): string {
  const rows = samples.filter((s) => s.phase === phase);
  if (rows.length === 0) return `${phase}: no samples`;
  const times = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const fails = rows.filter((r) => !r.ok);
  const pct = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? -1;
  return (
    `${phase.padEnd(16)} n=${String(rows.length).padStart(3)}  ` +
    `ok=${String(times.length).padStart(3)}  fail=${String(fails.length).padStart(2)}  ` +
    (times.length > 0
      ? `min=${times[0]}ms  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  max=${times[times.length - 1]}ms`
      : "no successful samples")
  );
}

async function main(): Promise<void> {
  console.log(
    `\ninput-host bench — probe key ${REAL ? "VOLUME UP/DOWN (audible, net zero)" : "0x07 (inert)"}` +
      `, burst=${BURST}${LONG ? ", including the 5-minute phase" : ""}\n`,
  );
  if (process.env["INPUT_HOST_DEBUG"] !== "1") {
    console.log("NOTE: set INPUT_HOST_DEBUG=1 to see per-request timings and stray-line logs.\n");
  }

  const injector = new WindowsInputInjector();

  // --- Q1: cold start. The FIRST press pays for spawn + Add-Type + READY. -------------------
  console.log("Q1  cold start (first press pays for spawn + Add-Type + READY)");
  const cold = await press(injector, "cold", 0);
  console.log(
    `    first press: ${cold.ms}ms  ${cold.ok ? "OK" : `FAILED — ${cold.error ?? ""}`}\n`,
  );

  // --- Q2: back-to-back. ---------------------------------------------------------------------
  console.log(`Q2  ${BURST} presses back to back (no gap)`);
  for (let n = 1; n <= BURST; n += 1) {
    const s = await press(injector, "burst", n);
    if (!s.ok) console.log(`    #${n} FAILED after ${s.ms}ms — ${s.error ?? ""}`);
    // Q4, in-line: after a failure, immediately try again and say which it was.
    if (!s.ok) {
      const next = await press(injector, "after-fail", n);
      console.log(
        `    -> next press ${next.ok ? `SUCCEEDED in ${next.ms}ms (TRANSIENT)` : `ALSO FAILED (WEDGED)`}`,
      );
    }
  }
  console.log(`    ${stats("burst")}\n`);

  // --- Q3: does an idle host go stale? -------------------------------------------------------
  const idlePhases: { label: string; gapMs: number; count: number }[] = [
    { label: "idle-10s", gapMs: 10_000, count: 5 },
    { label: "idle-60s", gapMs: 60_000, count: 3 },
  ];
  if (LONG) idlePhases.push({ label: "idle-5min", gapMs: 300_000, count: 2 });

  // DELIBERATE DEVIATION from "50 commands at each gap": 50 presses at a 5-minute gap is four
  // hours. The question these phases answer is "does an idle host go stale", which needs a few
  // samples AFTER a long quiet period, not fifty. The 50 live in the back-to-back phase above,
  // where they actually buy something. Counts are tunable with --burst / --long.
  for (const { label, gapMs, count } of idlePhases) {
    console.log(`Q3  ${label}: ${count} presses, ${gapMs / 1000}s idle before each`);
    for (let n = 1; n <= count; n += 1) {
      await sleep(gapMs);
      const s = await press(injector, label, n);
      console.log(`    #${n} after ${gapMs / 1000}s idle: ${s.ms}ms ${s.ok ? "OK" : `FAILED — ${s.error ?? ""}`}`);
      if (!s.ok) {
        const next = await press(injector, "after-fail", n);
        console.log(
          `    -> next press ${next.ok ? `SUCCEEDED in ${next.ms}ms (TRANSIENT)` : "ALSO FAILED (WEDGED)"}`,
        );
      }
    }
    console.log("");
  }

  // --- Summary -------------------------------------------------------------------------------
  console.log("SUMMARY");
  for (const phase of ["cold", "burst", "idle-10s", "idle-60s", "idle-5min", "after-fail"]) {
    if (samples.some((s) => s.phase === phase)) console.log(`  ${stats(phase)}`);
  }
  const failures = samples.filter((s) => !s.ok);
  console.log(`\n  total failures: ${failures.length} / ${samples.length}`);
  for (const f of failures) console.log(`    ${f.phase} #${f.n} after ${f.ms}ms: ${f.error ?? ""}`);

  injector.dispose();
  // The host is detached-ish; give dispose a beat to land before the process exits under it.
  await sleep(300);
  process.exit(0);
}

void main();
