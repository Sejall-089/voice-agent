// The closed list of apps this assistant can open, by NAME only (M18).
//
// WHAT THIS FILE DELIBERATELY DOES NOT KNOW: where any of these programs live, what a Windows
// path looks like, or how to start a process. It holds names and nothing else. The paths and
// protocol URIs are in `src/main/shell/appLaunch.ts`, on the shell side of the portability
// contract (spec.md §4) — so `/core` stays OS-agnostic, and a Mac shell would ship a different
// launch table against this same catalog.
//
// The split is also the safety property. "Open Spotify" has to become a command line
// eventually, and the question is who writes it. Here the model's entire contribution is a
// STRING THE USER SAID; the catalog turns that into a launch spec by exact match or refuses.
// There is no path in the model's output to put a path in, which is the same
// proposes/disposes rule §5 states, applied to a command line instead of a tool call.

// One openable app. `id` is the stable key the launch table is keyed by, `label` is what the
// user is shown, and `aliases` are the other things people actually say.
export interface AppEntry {
  id: string;
  label: string;
  aliases: readonly string[];
}

// The four that ship. Three of them are part of Windows, so they are present on every machine
// this runs on; Spotify is the one that may not be installed, which is why `openApp` reports
// what the OS said rather than claiming success (see appLaunch.ts).
//
// ALIASES ARE WHAT PEOPLE SAY, NOT SYNONYMS WE INVENTED. "calc" and "files" are real; a
// thesaurus entry that nobody would utter only widens the match surface for no gain. Two
// built-ins must never share one (tests/apps.test.ts asserts it) — an ambiguous alias would
// have to be resolved by ORDER, and quietly picking the first is exactly the kind of confident
// wrong answer this codebase refuses everywhere else.
export const BUILT_IN_APPS: readonly AppEntry[] = [
  { id: "spotify", label: "Spotify", aliases: ["music"] },
  { id: "notepad", label: "Notepad", aliases: ["text editor"] },
  { id: "calculator", label: "Calculator", aliases: ["calc"] },
  {
    id: "explorer",
    label: "File Explorer",
    aliases: ["files", "file manager", "windows explorer"],
  },
];

// Trailing nouns people add that carry no information: "open the Spotify app" names the same
// thing as "open Spotify". Stripped one at a time rather than repeatedly — "the x app program"
// is not something anyone says, and a loop here would start eating words out of real names.
const TRAILING_NOUNS = ["app", "application", "program"];

// Reduce what the user said to a comparable key.
//
// Punctuation is trimmed only at the ENDS. A blanket strip would mangle the real names this
// catalog will grow into — "VS Code" survives either way, but `Notepad++` and `C:\...`-style
// labels do not, and a normalizer that corrupts the thing it is normalizing fails silently by
// simply never matching.
export function normalizeAppName(raw: string): string {
  let value = raw.toLowerCase().replace(/\s+/g, " ").trim();
  value = value.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");

  if (value.startsWith("the ")) value = value.slice(4).trim();

  for (const noun of TRAILING_NOUNS) {
    if (value.endsWith(` ${noun}`)) {
      value = value.slice(0, value.length - noun.length - 1).trim();
      break;
    }
  }

  return value;
}

// Find the app the user named, or `null`.
//
// EXACT MATCH ON A NORMALIZED NAME, AND NOTHING ELSE. No prefixes, no edit distance, no
// substrings. The reason is the failure mode, not purity: a fuzzy match that is wrong starts
// the wrong program, and the user finds out by watching it open. "spotifyy" being refused with
// the real list is recoverable in one breath; launching something else is not. It is also the
// mistake M13's calendar search made in the other direction (see CLAUDE.md on fakes that match
// substrings where the real thing ANDs its terms) — leniency in matching is where confident
// wrong answers come from.
//
// Generic over the entry type so the shell's richer `CatalogEntry` comes back carrying its
// launch spec, instead of being narrowed to `AppEntry` and looked up a second time.
export function matchApp<T extends AppEntry>(raw: string, catalog: readonly T[]): T | null {
  const name = normalizeAppName(raw);
  if (name.length === 0) return null;

  for (const entry of catalog) {
    if (normalizeAppName(entry.id) === name) return entry;
    if (normalizeAppName(entry.label) === name) return entry;
    for (const alias of entry.aliases) {
      if (normalizeAppName(alias) === name) return entry;
    }
  }

  return null;
}

// "Spotify, Notepad and Calculator" — for the refusal message, which is the only place the
// closed list is ever spoken. A refusal that does not say what IS possible just reads as the
// app being broken (spec.md §8's rule, in miniature).
export function describeCatalog(catalog: readonly AppEntry[]): string {
  const labels = catalog.map((entry) => entry.label);
  if (labels.length === 0) return "nothing";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
