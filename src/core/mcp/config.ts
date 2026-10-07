import type { ConnectorDef, ConnectorSettings, ConnectorToolDef } from "./types.ts";

// Which connectors are on, and which of their tools (M19). The pure half of loading
// connectors.json: main.ts reads the file and the environment; this decides what they mean.
//
// THE FILE CAN ONLY SWITCH ON AND NARROW. A connector exists because there is a definition for
// it in core/mcp/connectors/; a tool exists because that definition pins it. connectors.json
// chooses among those — it cannot name a URL, add a tool, or change a tier, so nothing a person
// (or a bad merge) puts in it can widen what the app is able to do. That is the registry's
// closed world (spec §6), kept through a config file.
//
// EVERYTHING DEFAULTS TO OFF. A connector is on only when `enabled` is literally `true`, and a
// tool is exposed only when it is listed by name — an enabled connector with no `tools` list
// exposes nothing. An allowlist that has to be written out is the point.
//
// Nothing here ever throws. A config file that cannot be read must cost the connectors, not the
// app: every problem becomes a line in `notes` for main.ts to log, and the affected piece is
// simply left off the menu.

export interface ConnectorConfig {
  enabled: boolean;
  tools: string[];
  settings: ConnectorSettings;
}

export interface ParsedConnectors {
  connectors: Record<string, ConnectorConfig>;
  notes: string[];
}

// `text` is the file's contents, or null when there is no file — which is a normal install,
// not a problem, and produces no note.
export function parseConnectorsConfig(text: string | null): ParsedConnectors {
  if (text === null) return { connectors: {}, notes: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { connectors: {}, notes: ["connectors.json is not valid JSON - no connectors loaded"] };
  }
  const root = isRecord(parsed) ? parsed["connectors"] : undefined;
  if (!isRecord(root)) {
    return {
      connectors: {},
      notes: ['connectors.json has no "connectors" object - no connectors loaded'],
    };
  }

  const connectors: Record<string, ConnectorConfig> = {};
  const notes: string[] = [];
  for (const [id, raw] of Object.entries(root)) {
    if (!isRecord(raw)) {
      notes.push(`connector "${id}" is not an object - ignored`);
      continue;
    }
    const tools = raw["tools"];
    if (tools !== undefined && !isStringArray(tools)) {
      // Ignored WHOLE rather than salvaged. A half-read allowlist is a different allowlist from
      // the one somebody wrote, and "nothing" is the only safe reading of one we cannot parse.
      notes.push(`connector "${id}": "tools" must be a list of names - ignored`);
      continue;
    }
    const settings = raw["settings"];
    if (settings !== undefined && !isStringRecord(settings)) {
      notes.push(`connector "${id}": "settings" must be an object of text values - ignored`);
      continue;
    }
    connectors[id] = {
      enabled: raw["enabled"] === true,
      tools: tools ?? [],
      settings: settings ?? {},
    };
  }
  return { connectors, notes };
}

// One connector that will actually be offered: its definition, the tools that survived the
// allowlist, and its settings.
export interface SelectedConnector {
  def: ConnectorDef;
  tools: ConnectorToolDef[];
  settings: ConnectorSettings;
}

export interface Selection {
  selected: SelectedConnector[];
  notes: string[];
}

// What goes on the menu. `hasKey` answers "is this .env variable set?" — a synchronous, offline
// question, so nothing on the network decides what the model is offered (main.ts has held that
// line since M13) and this function never sees the key itself.
export function selectConnectors(
  config: ParsedConnectors,
  definitions: readonly ConnectorDef[],
  hasKey: (keyName: string) => boolean,
): Selection {
  const notes = [...config.notes];
  const selected: SelectedConnector[] = [];

  for (const id of Object.keys(config.connectors)) {
    if (!definitions.some((def) => def.id === id)) {
      notes.push(`connector "${id}" is in connectors.json but this build has no definition for it - ignored`);
    }
  }

  for (const def of definitions) {
    const entry = config.connectors[def.id];
    if (entry === undefined || !entry.enabled) continue;
    if (!hasKey(def.keyName)) {
      notes.push(`${def.label} tools disabled - ${def.keyName} not set`);
      continue;
    }

    const tools: ConnectorToolDef[] = [];
    for (const name of entry.tools) {
      const tool = def.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        notes.push(`${def.label}: "${name}" is not a tool this build defines - ignored`);
        continue;
      }
      const missing = (tool.requires ?? []).filter(
        (key) => (entry.settings[key] ?? "").trim().length === 0,
      );
      if (missing.length > 0) {
        notes.push(
          `${def.label}: "${name}" needs settings.${missing.join(", settings.")} in connectors.json - not offered`,
        );
        continue;
      }
      if (!tools.includes(tool)) tools.push(tool);
    }

    if (tools.length === 0) {
      notes.push(`${def.label} is enabled but exposes no tools`);
      continue;
    }
    selected.push({ def, tools, settings: entry.settings });
  }

  return { selected, notes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
