// A stand-in for whisper-cli (M34), so WhisperCppTranscriber's process handling and transcript
// cleaning can be tested without whisper installed — run through node via `argsPrefix`, as
// fakePiper.mjs is.
//
// What this IS: a CLI taking whisper's own flags (`-m <model> -f <wav> -l <lang> -nt -np`) that
// checks the WAV it was pointed at exists, then prints FAKE_WHISPER_STDOUT on stdout, exactly as
// given, and exits 0. `-nt -np` make the real CLI's stdout the plain transcript; a leading space
// on the line is what the real one prints.
//
// What this IS NOT: evidence about what whisper itself writes for a spoken "#". Whether the real
// model ever emits one is a live question (docs/M34-live-checklist.md, H3). This only proves what
// the app does with a "#" once whisper has written one.

import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
const at = argv.indexOf("-f");
const wav = at === -1 ? undefined : argv[at + 1];
if (wav === undefined || !existsSync(wav)) {
  process.stderr.write(`fakeWhisper: no input file (${String(wav)})\n`);
  process.exit(2);
}
process.stdout.write(process.env.FAKE_WHISPER_STDOUT ?? " Remember the team is #social.\n");
