// Round-trips one literal sentence through the TYPE path's encoding and framing and prints the
// bytes at every stage. Companion to scripts/typing-fidelity-probe.ts.
//
//   npx vite-node scripts/type-roundtrip-probe.ts
//
// TYPES NOTHING. The one line of the host that calls SendInput for TYPE is replaced with a
// recorder; everything else is the real thing, obtained rather than copied:
//
//   * the `TYPE <base64>` command is captured from the real `typeText()` (so the real
//     `encodeBase64Utf16` built it),
//   * the `#<id> ` tag is added, and the reply routed, by the real `HostChannel`,
//   * the host script is the file the real class wrote for `-File`, read back off disk, and it
//     is spawned with the same argv — so stdin decoding, the tag strip, `Substring(5)`,
//     `FromBase64String`, `Unicode.GetString`, `ToCharArray` and `KeyEvent()` are the shipped
//     ones. What is NOT exercised: the marshalling of INPUT[] into user32, and anything the OS
//     or the target window does afterwards.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostChannel } from "../src/main/shell/hostChannel.ts";
import { WindowsInputInjector } from "../src/main/shell/WindowsInputInjector.ts";

const SENTENCE = "My name is Sejal, not Angel.";

const hex = (bytes: Iterable<number>, width = 2): string =>
  [...bytes].map((b) => b.toString(16).toUpperCase().padStart(width, "0")).join(" ");

function patch(script: string, anchor: string, replacement: string): string {
  const at = script.indexOf(anchor);
  if (at === -1) throw new Error(`The host script no longer contains: ${anchor}`);
  return script.slice(0, at) + replacement + script.slice(at + anchor.length);
}

const HEXLINE = `(($X | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ')`;

async function main(): Promise<void> {
  // 1. The real class builds the command; its `request` is intercepted for TYPE only, so the
  //    real host is spawned (by a harmless FG) but is never asked to type.
  const injector = new WindowsInputInjector();
  const internals = injector as unknown as {
    request: (command: string, budgetMs: number) => Promise<string>;
    scriptDir: string | null;
  };
  const realRequest = internals.request.bind(injector);
  let captured: string | null = null;
  internals.request = async (command, budgetMs) => {
    if (!command.startsWith("TYPE ")) return realRequest(command, budgetMs);
    captured = command;
    return `TYPE OK ${SENTENCE.length * 2}`;
  };
  await injector.getForegroundWindow();
  if (internals.scriptDir === null) throw new Error("The injector did not write a host script.");
  const realScript = readFileSync(join(internals.scriptDir, "host.ps1"), "utf8");
  await injector.typeText(SENTENCE);
  injector.dispose();
  if (captured === null) throw new Error("typeText() never issued a TYPE command.");
  const command: string = captured;

  // 2. The shipped host, with SendInput for TYPE swapped for a recorder and dumps added.
  let script = realScript;
  script = patch(
    script,
    `    if ($line -eq "QUIT") { break }`,
    `    $X = $raw.ToCharArray(); Write-Output ("DUMP RAW " + ${HEXLINE})\n` +
      `    Write-Output ("DUMP TAG [" + $tag + "]")\n` +
      `    if ($line -eq "QUIT") { break }`,
  );
  script = patch(
    script,
    `$chars = $text.ToCharArray()`,
    `$chars = $text.ToCharArray()\n` +
      `            $X = $b64.ToCharArray(); Write-Output ("DUMP B64 " + $b64)\n` +
      `            $X = $bytes; Write-Output ("DUMP BYTES " + (($X | ForEach-Object { '{0:X2}' -f [int]$_ }) -join ' '))\n` +
      `            $X = $chars; Write-Output ("DUMP CHARS " + ${HEXLINE})\n` +
      `            $scans = @()`,
  );
  script = patch(
    script,
    `$result = [VoiceAgentInput]::SendInput([uint32]$events.Length, $events, $InputSize)`,
    `foreach ($e in $events) { $scans += ('{0:X4}:vk{1}:f{2}' -f [int]$e.ki.wScan, [int]$e.ki.wVk, [int]$e.ki.dwFlags) }\n` +
      `                $result = [uint32]$events.Length`,
  );
  script = patch(
    script,
    `            if ($sent -eq $expected) {`,
    `            Write-Output ("DUMP EVENTS " + ($scans -join ' '))\n            if ($sent -eq $expected) {`,
  );

  const dir = mkdtempSync(join(tmpdir(), "va-roundtrip-"));
  const scriptPath = join(dir, "host.ps1");
  writeFileSync(scriptPath, script, "utf8");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: "pipe", windowsHide: true },
  );

  const dumps = new Map<string, string>();
  const written: Buffer[] = [];
  const rawReplies: string[] = [];
  let ready: () => void = () => {};
  const isReady = new Promise<void>((r) => (ready = r));
  const channel = new HostChannel(
    {
      write: (line: string) => {
        const bytes = Buffer.from(`${line}\n`, "utf8");
        written.push(bytes);
        child.stdin.write(bytes);
      },
      kill: () => child.kill(),
    },
    {
      onUntagged: (line: string) => {
        if (line === "READY") return ready();
        const m = /^DUMP (\S+) (.*)$/.exec(line);
        if (m) dumps.set(m[1]!, m[2]!);
        else console.log(`[untagged] ${line}`);
      },
    },
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const l of chunk.split(/\r?\n/)) if (l.startsWith("#")) rawReplies.push(l);
    channel.receive(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(`[host stderr] ${chunk}`));

  await isReady;
  const reply = await channel.request(command, 15_000);
  child.stdin.write("QUIT\n");
  child.kill();
  rmSync(dir, { recursive: true, force: true });

  // 3. Show every stage.
  const utf16 = Buffer.from(SENTENCE, "utf16le");
  const wire = written[0]!;
  const units = [...SENTENCE].map((c) => c.charCodeAt(0));
  const downs = (dumps.get("EVENTS") ?? "").split(" ").filter((e) => e.endsWith(":f4"));
  const ups = (dumps.get("EVENTS") ?? "").split(" ").filter((e) => e.endsWith(":f6"));
  const typed = downs.map((e) => String.fromCharCode(parseInt(e.slice(0, 4), 16))).join("");

  console.log(`sentence            ${JSON.stringify(SENTENCE)}  (${SENTENCE.length} code units)`);
  console.log(`  chars             ${[...SENTENCE].map((c) => (c === " " ? "␠" : c).padStart(4)).join(" ")}`);
  console.log(`  UTF-16 units      ${hex(units, 4)}`);
  console.log("");
  console.log("NODE SIDE");
  console.log(`  UTF-16LE bytes    (${utf16.length}) ${hex(utf16)}`);
  console.log(`  typeText command  ${command}`);
  console.log(`  wire line         ${JSON.stringify(wire.toString("utf8"))}`);
  console.log(`  wire bytes        (${wire.length}) ${hex(wire)}`);
  console.log("");
  console.log("HOST SIDE (the shipped script, SendInput replaced by a recorder)");
  console.log(`  ReadLine chars    ${dumps.get("RAW")}`);
  console.log(`  tag               ${dumps.get("TAG")}`);
  console.log(`  base64 after tag  ${dumps.get("B64")}`);
  console.log(`  decoded bytes     ${dumps.get("BYTES")}`);
  console.log(`  ToCharArray       ${dumps.get("CHARS")}`);
  console.log(`  INPUT events      (${downs.length} down, ${ups.length} up) ${dumps.get("EVENTS")}`);
  console.log(`  raw reply line    ${JSON.stringify(rawReplies[0])}`);
  console.log(`  routed reply      ${JSON.stringify(reply)}`);
  console.log("");
  console.log("CHECKS");
  const check = (name: string, ok: boolean): void => console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  const rawChars = (dumps.get("RAW") ?? "").split(" ").map((h) => String.fromCharCode(parseInt(h, 16))).join("");
  check("host ReadLine == wire line (no BOM, no lost or altered byte)", `${rawChars}\n` === wire.toString("utf8"));
  check("base64 seen by host == base64 sent", `TYPE ${dumps.get("B64")}` === command);
  check("host decoded bytes == node UTF-16LE bytes", dumps.get("BYTES") === hex(utf16));
  check("host chars == sentence code units", dumps.get("CHARS") === hex(units, 4));
  check("key-down wScan sequence spells the sentence", typed === SENTENCE);
  check("every down is followed by its own up", downs.length === ups.length && downs.every((d, i) => d.slice(0, 4) === ups[i]!.slice(0, 4)));
  check(`reply is "TYPE OK ${SENTENCE.length * 2}"`, reply === `TYPE OK ${SENTENCE.length * 2}`);
}

void main().then(() => process.exit(0));
