// The contracts for reaching an app over MCP (M19) — the generic counterpart to GmailSurface,
// NotionSurface and CalendarSurface.
//
// Those three are hand-built: each knows one app, and each was a milestone. A connector is the
// other way round — one adapter (core/mcp/adapter.ts) that knows NO app, plus a small definition
// per app that says which remote tools this build is willing to call and how. Adding an app
// means adding a definition, not writing a surface.
//
// What it deliberately does NOT do is let the far side define the menu. An MCP server announces
// its own tools, descriptions, schemas and safety hints, and every one of those is text from
// somewhere else. None of it reaches the model and none of it is trusted: the names, the
// descriptions the model reads, the schemas arguments are checked against and the tiers are all
// pinned in this repo (core/mcp/connectors/). The server's own list is used for exactly two
// things — noticing it has DRIFTED from what was pinned, and making a tier stricter.
import type { JSONSchema, Risk, ToolInput } from "../types.ts";

// One tool as the SERVER describes it. Untrusted, and kept to the three facts the adapter is
// allowed to use: does it exist, what does it accept, and what does it claim about itself.
export interface RemoteTool {
  name: string;
  // The server's own JSON Schema. Used ONLY to check the arguments this build is about to send
  // are still acceptable — never shown to the model.
  inputSchema: Record<string, unknown>;
  // The server's hints, `undefined` when it gave none. May RAISE a tier, never lower one
  // (core/mcp/tiers.ts) — a server that calls its delete tool read-only is exactly the server
  // not to believe.
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

// One block of a tool result, reduced to the fields the flattener reads.
export interface ResultBlock {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
}

export interface RemoteResult {
  // TRUE IS A NORMAL RETURN, NOT A THROW. Recon found Linear reporting every failure this way.
  isError: boolean;
  content: readonly ResultBlock[];
  structuredContent?: unknown;
}

// A live link to one MCP server. Every method either does the named thing or throws a
// `ConnectorError` — the same "fail loudly, with a reason a person can act on" contract every
// surface in core/types.ts has.
//
// ASYNC, AND LAZILY CONNECTED. Nothing is opened until the first call, so no network request
// decides what is on the menu (the rule main.ts has kept since M13) and an app that is never
// asked about Linear never talks to it.
export interface McpConnection {
  // SAFE. What the server offers right now. Cached after the first successful read.
  listTools(): Promise<readonly RemoteTool[]>;
  // Whatever the tool is. The adapter decides whether a given call may happen; this just makes it.
  callTool(name: string, args: ToolInput): Promise<RemoteResult>;
}

// What a connector definition may read from connectors.json — plain strings, validated against
// the keys the definition says it understands. Never a secret: the key lives in .env.
export type ConnectorSettings = Readonly<Record<string, string>>;

// One tool this build is willing to call, pinned in code.
export interface ConnectorToolDef {
  // OUR name for it, without the connector prefix ("create_issue"). The model sees
  // `<connector>__<name>`; it never sees `remote`.
  name: string;
  // The server's name. NOT necessarily the same thing, and for Linear's create it must not be:
  // the remote tool is `save_issue`, which also UPDATES. The capability exposed is defined by
  // `inputSchema` below, not by the remote tool's reach.
  remote: string;
  // Written here, for the planner model. Never the server's text.
  description: string;
  // The word on the confirm dialog's approve button for this tool ("Create issue"). PINNED
  // HERE, beside the description and for the same reason: it is ours, written in this build,
  // and never anything the server says about its tool — not its description, its title or its
  // annotations. Omitted → the shell's default ("Send"). See `Tool.confirmLabel`.
  confirmLabel?: string;
  // What the model may propose, and what its proposal is validated against BEFORE anything is
  // sent. Must set `additionalProperties: false`: an argument that is not listed here cannot
  // reach the server, which is the whole of how `save_issue` is narrowed to "create".
  inputSchema: JSONSchema;
  // The tier, decided in code. OMITTED means unclassified, which is `caution` — or `dangerous`
  // if the name looks like a delete or a send. A tool is `safe` only by being declared so here.
  risk?: Risk;
  // Settings this tool cannot run without. A tool whose required setting is missing from
  // connectors.json is left off the menu rather than offered and then refused.
  requires?: readonly string[];
  // Arguments the MODEL DOES NOT CHOOSE, merged in after validation — which team an issue is
  // filed under, how many search results come back. Keeps the model's surface to what a spoken
  // instruction can actually determine.
  //
  // A KEY IS THE MODEL'S OR CODE'S, NEVER BOTH (M20): a key returned here must not also appear
  // in `inputSchema.properties`, and a definition where one does is refused at startup. For
  // GitHub a fixed key is the whole difference between create and update (`method`) and between
  // this install's repository and anyone's (`owner`, `repo`), so "which side wins the merge"
  // is not left as a question that has an answer.
  fixed?: (settings: ConnectorSettings) => ToolInput;
  // The question for the confirm dialog and the line for narration, built from the validated
  // arguments. FULL TEXT, never a preview: this is the last thing between an instruction and
  // something landing in someone else's tracker. Omitted → a generic listing of every argument.
  describe?: (args: ToolInput, settings: ConnectorSettings) => string;
  // Turn the server's raw text into what the user is shown and what a later chain step receives
  // as `{stepN}`. Throws (anything) when the text is not what a success looks like; the adapter
  // reports that as `bad-result`. Omitted → the raw text, unchanged.
  //
  // `settings` since M20: GitHub's list items carry no URL, so the link has to be built from the
  // owner and repository this install is pinned to — and a formatter that knows where a result
  // SHOULD have come from can refuse one that came from somewhere else.
  format?: (text: string, args: ToolInput, settings: ConnectorSettings) => string;
  // What to say when the server ran the tool and answered `isError` (M20). Returns OUR words for
  // a failure it recognises, or null for one it does not.
  //
  // DEFINING THIS MEANS THE SERVER'S OWN TEXT IS NEVER SHOWN. Without it the adapter repeats what
  // the server said, clipped — right for Linear, whose errors are short sentences about the
  // request. GitHub's carry the API URL that failed, a numeric user ID and a request ID, and one
  // of them is a paragraph addressed to a model ("STOP — do not call any other tools"). So a
  // connector that defines this gets its own sentence or, for anything unrecognised, the bare
  // "<app> said no." — which says less than it could, on purpose. In that case, and only that
  // case, the adapter writes the server's text to the CONSOLE so the reason exists somewhere.
  //
  // Anything specific in the sentence (an issue number, a repository) must come from `args` and
  // `settings`, which are ours, and never be lifted out of `text`.
  failure?: (text: string, args: ToolInput, settings: ConnectorSettings) => string | null;
}

// One app reachable over MCP.
export interface ConnectorDef {
  // The namespace: tools are exposed as `<id>__<name>`. Lowercase, no underscores.
  id: string;
  // What the user is told ("Linear said no: ...").
  label: string;
  url: string;
  // The NAME of the .env variable holding the key. The definition never holds the key itself.
  keyName: string;
  tools: readonly ConnectorToolDef[];
}
