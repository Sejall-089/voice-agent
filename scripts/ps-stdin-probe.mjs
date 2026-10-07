// Why does the FIRST command written to the input host get no reply?
//
// The bench (scripts/input-host-bench.ts) found: spawn -> READY in 739ms, then command #1 gets
// NO reply for its whole 10s budget while the child is still alive and nothing is buffered,
// then #2 onwards reply in 1-3ms, forever, through 50 back-to-back and 60s idles. The lost
// reply never arrives at all — not even as a late stray line. It is SWALLOWED, not slow.
//
// That matches the KNOWN ISSUE already written in WindowsInputInjector.ts at M16.8: with
// `-Command -`, PowerShell treats stdin as the SCRIPT SOURCE and keeps consuming it, so a line
// written afterwards can be eaten by the parser instead of reaching [Console]::In.ReadLine().
//
// THIS PROBE ISOLATES THE MECHANISM, and deliberately does NOT use our host script. The
// question is about how PowerShell is invoked, so the script under test is three lines — if it
// used the real 200-line HOST_SCRIPT, a failure could be blamed on our Add-Type or our loop.
// It answers:
//
//   A) `-Command -` : is the first line after READY swallowed?
//   B) does WAITING before the first line help? (0 / 50 / 250 / 1000 ms)
//        -> if yes, a warm-up or a longer first-request timeout can work
//        -> if no, the invocation itself is the bug and only `-File` fixes it
//   C) `-File <temp.ps1>` : the invocation src/main/uia/WindowsElements.ts already uses, and
//      which the M16.8 note says works. Same three-line script, same delays.
//
//   node scripts/ps-stdin-probe.mjs

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

// Three lines, so nothing but the invocation is on trial. Same shape as the real host: print a
// ready marker, then loop reading commands and echoing a reply.
const SCRIPT = `
Write-Output "READY"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "QUIT") { break }
  Write-Output "ECHO $line"
}
`;

const REPLY_TIMEOUT_MS = 3000;

function run(mode, delayMs) {
  return new Promise((resolve) => {
    let args;
    if (mode === "-File") {
      const dir = mkdtempSync(join(tmpdir(), "ps-probe-"));
      const file = join(dir, "host.ps1");
      writeFileSync(file, SCRIPT, "utf8");
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];
    } else {
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"];
    }

    const child = spawn("powershell.exe", args, { stdio: "pipe", windowsHide: true });
    child.stdout.setEncoding("utf8");

    let buffer = "";
    let ready = false;
    let sentAt = 0;
    const result = { mode, delayMs, readyMs: -1, replies: [], firstReplyMs: -1, swallowed: null };
    const spawnedAt = Date.now();
    let settled = false;

    const finish = (note) => {
      if (settled) return;
      settled = true;
      result.note = note;
      try {
        child.stdin.write("QUIT\n");
      } catch {
        /* already gone */
      }
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      result.swallowed = result.firstReplyMs === -1;
      finish(result.firstReplyMs === -1 ? "NO REPLY to the first command" : "ok");
    }, REPLY_TIMEOUT_MS + delayMs + 15_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (line.length === 0) continue;

        if (!ready && line === "READY") {
          ready = true;
          result.readyMs = Date.now() - spawnedAt;
          // The experiment: wait `delayMs` after READY, then write the first command.
          setTimeout(() => {
            sentAt = Date.now();
            child.stdin.write("ONE\n");
            // And a second command a beat later, to see whether #2 survives when #1 did not.
            setTimeout(() => child.stdin.write("TWO\n"), REPLY_TIMEOUT_MS);
          }, delayMs);
          continue;
        }

        if (ready) {
          const ms = Date.now() - sentAt;
          result.replies.push({ line, ms });
          if (result.firstReplyMs === -1) result.firstReplyMs = ms;
          if (result.replies.length >= 2) {
            clearTimeout(timer);
            result.swallowed = false;
            finish("both replied");
          }
        }
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      result.note = `spawn error: ${error.message}`;
      resolve(result);
    });
  });
}

const DELAYS = [0, 50, 250, 1000];

console.log("\nPowerShell stdin-invocation probe — is the first command after READY swallowed?\n");

for (const mode of ["-Command -", "-File"]) {
  console.log(`=== ${mode} ===`);
  for (const delayMs of DELAYS) {
    const r = await run(mode, delayMs);
    const got = r.replies.map((x) => `${x.line}@${x.ms}ms`).join(", ") || "(nothing)";
    const verdict =
      r.replies.length >= 2
        ? "BOTH replied"
        : r.replies.length === 1
          ? `ONLY ONE replied -> the other was SWALLOWED`
          : "NOTHING replied";
    console.log(
      `  delay=${String(delayMs).padStart(4)}ms  ready@${String(r.readyMs).padStart(4)}ms  ` +
        `replies=[${got}]  ${verdict}`,
    );
  }
  console.log("");
}

process.exit(0);
