import type { Tool } from "../types.ts";
import { buildConnectorTools } from "./adapter.ts";
import { parseConnectorsConfig, selectConnectors } from "./config.ts";
import { githubConnector } from "./connectors/github.ts";
import { linearConnector } from "./connectors/linear.ts";
import type { ConnectorDef, McpConnection } from "./types.ts";

// Every connector this build knows how to talk to. THE LIST IS THE CLOSED WORLD: a connector
// that is not here cannot be switched on from connectors.json, whatever that file says. Adding
// an app is a definition file in ./connectors/ and one entry here — not a new surface.
export const CONNECTORS: readonly ConnectorDef[] = [linearConnector, githubConnector];

export interface LoadOptions {
  // The contents of connectors.json, or null when the file does not exist.
  configText: string | null;
  // Reads one .env variable by NAME. /core never touches process.env; main.ts hands this in.
  readKey: (keyName: string) => string | undefined;
  // Builds the live link for one connector. Called at most once per connector, and only for one
  // that is enabled and has a key — so a connector that is switched off never has a connection
  // object at all. The connection itself opens lazily (SdkMcpConnection): calling this touches
  // no network.
  connect: (def: ConnectorDef, key: string) => McpConnection;
  // A line for the console, written while a tool RUNS (M20): the server's own text for a
  // failure the connector did not recognise, which is deliberately shown to nobody. Separate
  // from `notes` below, which are startup lines. Omitted → those lines are dropped.
  log?: (line: string) => void;
  definitions?: readonly ConnectorDef[];
}

export interface LoadedConnectors {
  tools: Tool[];
  // Lines for main.ts to log: what was switched off and why, and what was ignored. Never
  // contains a key — only the NAME of the variable one was expected in.
  notes: string[];
}

// connectors.json + .env → the connector tools on this run's menu. Everything that decides
// anything is in config.ts and adapter.ts; this is the join, kept out of main.ts so it has a
// test that can fail (CLAUDE.md: anything living in main.ts has none).
export function loadConnectorTools(options: LoadOptions): LoadedConnectors {
  const definitions = options.definitions ?? CONNECTORS;
  const hasKey = (keyName: string): boolean =>
    (options.readKey(keyName) ?? "").trim().length > 0;

  const { selected, notes } = selectConnectors(
    parseConnectorsConfig(options.configText),
    definitions,
    hasKey,
  );

  const tools: Tool[] = [];
  for (const entry of selected) {
    const key = (options.readKey(entry.def.keyName) ?? "").trim();
    for (const tool of buildConnectorTools(entry, options.connect(entry.def, key), options.log)) {
      // Two definitions sharing an id would produce the same namespaced name. First one wins,
      // and it is said out loud rather than left to whichever `find` happens to hit.
      if (tools.some((existing) => existing.name === tool.name)) {
        notes.push(`${tool.name} is defined twice - the second was ignored`);
        continue;
      }
      tools.push(tool);
    }
  }
  return { tools, notes };
}
