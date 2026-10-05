import { UserFixableError } from "../errors.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";

// Task 20 (spec.md §6): open a Spotify search for something. THE USER PRESSES PLAY.
//
// This is what M18's "play <song> on Spotify" became once the account turned out to be free.
// The Web API's `PUT /v1/me/player/play` needs Premium — and a development-mode app needs the
// owner's account to be Premium at all — so there is no honest way to start playback from
// here. The alternative is not to fake it: this opens the search and stops, and every string
// in the file is written so nobody reads it as more than that. The words "playing" and "now
// playing" appear nowhere, and a test asserts their absence.
//
// WHY THE URL IS BUILT FROM A FIXED TEMPLATE AND NOT SUPPLIED BY THE MODEL. `openTarget`
// already exists and would happily open a Spotify URL if the model wrote one — which is
// exactly the hole this avoids. Here the scheme, host and path are constants in this file and
// the model contributes only the search terms, percent-encoded. There is no input that can
// retarget the request at another host, and tests assert the host and path prefix literally.
const SEARCH_BASE = "https://open.spotify.com/search/";

// Spotify's search box is not going to do anything useful with an essay, and an unbounded
// query would build an unbounded URL. Cut rather than refused: a query this long is a model
// being verbose, not a request that cannot be served.
const MAX_QUERY_CHARS = 200;

export const searchSpotifyTool: Tool = {
  name: "searchSpotify",
  description:
    "Open a Spotify search in the browser for a song, artist, album or playlist. Use this when " +
    "the user wants to find or play something on Spotify — 'play Bohemian Rhapsody on " +
    "Spotify', 'find that Radiohead album'. IMPORTANT: this OPENS THE SEARCH RESULTS and " +
    "nothing more. I cannot start playback (that needs Spotify Premium), so the user clicks " +
    "the track themselves — never tell them something is playing. Pass `query` as just the " +
    "search terms, the way they would be typed into a search box: no URL, no 'spotify', no " +
    "'play'. To open the Spotify APP itself rather than a search, use `openApp`.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search terms alone, e.g. 'bohemian rhapsody' or 'radiohead in rainbows'. " +
          "Not a URL and not a sentence.",
      },
    },
    required: ["query"],
  },
  // Opening a browser tab, which is what `openTarget` has been since M2 and for the same
  // reason: the user closes it.
  risk: "reversible",
  // A literal to put in a search box, not a reference to resolve. Letting memory near it would
  // rewrite "my favourite album" into whatever URL happened to be stored under that name and
  // then search Spotify for a URL — the same failure `pointAt` avoids with its `target`.
  resolvesReferences: false,
  handler: async (input: ToolInput, deps: ToolDeps): Promise<string> => {
    const raw = typeof input["query"] === "string" ? input["query"].trim() : "";

    if (raw.length === 0) {
      throw new UserFixableError("What should I search Spotify for?");
    }

    const query = raw.slice(0, MAX_QUERY_CHARS);
    // `encodeURIComponent` is what keeps the template a template: a query containing `/`, `?`,
    // `#` or `&` becomes path characters rather than a new path, query string or fragment, so
    // there is no query that can reach a different page — let alone a different host.
    const url = `${SEARCH_BASE}${encodeURIComponent(query)}`;

    const result = await deps.shell.executeAction({ kind: "openUrl", payload: url });

    if (!result.ok) {
      throw new UserFixableError(result.error ?? `I couldn't open a Spotify search for ${query}.`);
    }

    // Says what happened and no more. "Opened" rather than "playing", and the search terms
    // echoed back so the user can see whether the model heard them correctly.
    return `Opened a Spotify search for "${query}" — press play on the one you want.`;
  },
};
