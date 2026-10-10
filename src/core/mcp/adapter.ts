import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { markFromClipboard, usesClipboardBesideOpenEmail } from "../contextHints.ts";
import { connectorError } from "../errors.ts";
import type { RiskPolicy, ToolRisk } from "../risk.ts";
import type { Tool, ToolDeps, ToolInput } from "../types.ts";
import type { SelectedConnector } from "./config.ts";
import { clip } from "./failure.ts";
import { failureText, flattenResult } from "./flatten.ts";
import { baseTier, effectiveTier, possibleTiers } from "./tiers.ts";
import type { ConnectorToolDef, McpConnection, RemoteTool } from "./types.ts";

// A connector's pinned tools, as ordinary registry `Tool`s (M19).
//
// THE WHOLE POINT IS THAT NOTHING DOWNSTREAM CAN TELL. What comes out of here is the same shape
// `sendMessage` and `createEvent` are: a schema the model reads, a tier, a `confirmSummary`, a
// handler returning a string. The planner gates it with the one `runStep` it has always had, a
// chain can name it as a step, and the registry stays a closed list — "the LLM proposes, the
// planner disposes" needed no new clause for MCP.
//
// What the adapter adds in front of the call, in order, every time:
//
//   1. VALIDATE the model's arguments against OUR pinned schema. `additionalProperties: false`
//      means an argument that is not listed cannot be sent — which, for Linear, is the entire
//      difference between "create an issue" and "edit any issue" (connectors/linear.ts).
//   2. MERGE the arguments code fixes (which team, how many results). Fixed wins.
//   3. CHECK DRIFT against the server's own schema: the remote tool must still exist, must
//      still accept exactly what is about to be sent, and (M20) must NAME every key of it. This
//      is the only use the server's schema is ever put to. A mismatch is refused here, by name,
//      instead of arriving back as a puzzling argument error from the far side — or, from a
//      server that ignores what it does not know, not arriving back at all.
//
// The gates run steps 1-3 too (`prepare`), so a confirm dialog is never shown for a call that
// could not have been made, and what it shows is what will be sent.
//
// And behind the call: an `isError` result is a FAILURE even though nothing threw (recon: that
// is how Linear reports every one), and a "success" the connector's formatter cannot read is a
// failure too — M11's rule that reporting success is not proof of anything.

// Between the connector id and the tool name. Two underscores, so it cannot collide with a
// hand-built tool (camelCase, no underscores) or be produced by a tool name on its own.
export const SEPARATOR = "__";

// Provider tool names are capped at 64 characters of [a-zA-Z0-9_-].
const MAX_TOOL_NAME = 64;
const ID_SHAPE = /^[a-z][a-z0-9]*$/;
const NAME_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

// `strict: false` and `validateFormats: false` because the SERVER's schema is compiled with this
// too, and it uses keywords (`format: "uri"`, `$schema`) that strict mode rejects outright. A
// schema we cannot compile is reported as drift, not thrown.
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });

// How much of a server's unrecognised failure text goes to the console. Longer than what a
// person is shown (failure.ts) because its whole purpose is diagnosis; still bounded, because
// it is text from somewhere else.
export const MAX_LOGGED_FAILURE = 1000;

export function buildConnectorTools(
  selected: SelectedConnector,
  connection: McpConnection,
  // Where a line for the CONSOLE goes — never the screen, never speech. /core does not touch
  // `console`; main.ts hands this in (via core/mcp/load.ts). Omitted → nothing is logged.
  log: (line: string) => void = () => undefined,
): Tool[] {
  const { def, settings } = selected;
  if (!ID_SHAPE.test(def.id)) {
    throw new Error(`Connector id "${def.id}" must be lowercase letters and digits.`);
  }

  // The server's schemas, compiled once each. Keyed on the schema OBJECT, so a reconnect that
  // returns a fresh tool list is compiled afresh rather than trusted from before.
  const remoteValidators = new WeakMap<object, ValidateFunction>();

  return selected.tools.map((tool): Tool => {
    const name = `${def.id}${SEPARATOR}${tool.name}`;
    if (!NAME_SHAPE.test(tool.name) || name.length > MAX_TOOL_NAME) {
      throw new Error(`Connector tool name "${name}" is not a valid tool name.`);
    }
    if (tool.inputSchema.additionalProperties !== false) {
      // A definition bug, caught at startup rather than discovered as an argument that leaked.
      throw new Error(`${name}: inputSchema must set additionalProperties to false.`);
    }
    // A key is the model's or code's, never both (M20). With no overlap the merge in `prepare`
    // has nothing to decide, so no ordering of it can hand the model a key code meant to fix.
    const shared = Object.keys(tool.fixed?.(settings) ?? {}).find((key) =>
      Object.hasOwn(tool.inputSchema.properties, key),
    );
    if (shared !== undefined) {
      throw new Error(`${name}: "${shared}" is fixed in code, so it must not be in inputSchema.`);
    }
    const validateOwn = ajv.compile(tool.inputSchema);

    const remoteTool = async (): Promise<RemoteTool> => {
      const tools = await connection.listTools();
      const found = tools.find((candidate) => candidate.name === tool.remote);
      if (found === undefined) {
        throw connectorError("drift", def.label, `it no longer has "${tool.remote}"`);
      }
      return found;
    };

    // Steps 1-3. Returns exactly what would be sent.
    const prepare = async (args: ToolInput): Promise<ToolInput> => {
      if (!validateOwn(args)) {
        throw connectorError("invalid-arguments", def.label, explain(validateOwn.errors));
      }
      const final: ToolInput = { ...args, ...(tool.fixed?.(settings) ?? {}) };

      const remote = await remoteTool();
      let validateRemote = remoteValidators.get(remote.inputSchema);
      if (validateRemote === undefined) {
        try {
          validateRemote = ajv.compile(remote.inputSchema);
        } catch {
          throw connectorError("drift", def.label, `I can't read the rules for "${tool.remote}"`);
        }
        remoteValidators.set(remote.inputSchema, validateRemote);
      }
      if (!validateRemote(final)) {
        throw connectorError(
          "drift",
          def.label,
          `"${tool.remote}" no longer accepts what I send: ${explain(validateRemote.errors)}`,
        );
      }
      // And every key about to be sent must be one the server NAMES (M20). The check above is
      // only as strict as the server's schema, and recon found GitHub's sets no
      // `additionalProperties` and its server silently ignores a key it does not know — so a
      // renamed `body` would validate, be dropped, and create an issue with nothing in it. A
      // schema with no `properties` at all names nothing, and is refused the same way.
      const named = remote.inputSchema["properties"];
      const unnamed =
        typeof named === "object" && named !== null
          ? Object.keys(final).find((key) => !Object.hasOwn(named, key))
          : Object.keys(final)[0];
      if (unnamed !== undefined) {
        throw connectorError("drift", def.label, `"${tool.remote}" no longer takes "${unnamed}"`);
      }
      return final;
    };

    const base = baseTier(tool);
    // A tool that is already `dangerous` has nowhere further to go, so its tier is a constant
    // and nothing is asked of the network to learn it. Anything lower may be RAISED by the
    // server's hints — which means reading them, which means a `RiskPolicy`. If that read fails,
    // `resolveRisk` escalates to the worst declared tier (core/risk.ts), and the confirm summary
    // then fails on the same broken connection and the call is refused: fail-closed twice.
    const policy: RiskPolicy<ToolInput, ToolDeps> = {
      tiers: possibleTiers(base),
      resolve: async () => effectiveTier(base, await remoteTool()),
    };
    const risk: ToolRisk<ToolInput, ToolDeps> = base === "dangerous" ? base : policy;

    return {
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk,
      // From the PINNED definition and nowhere else. The server's own account of the tool —
      // `remoteTool()`'s description, title, annotations — is never consulted for it; a
      // conditional spread, so a tool that pins none has no property at all and gets the
      // shell's default.
      ...(tool.confirmLabel === undefined ? {} : { confirmLabel: tool.confirmLabel }),
      // Arguments are literals to SEND. Memory resolution rewrites any string that starts with
      // "the" or "my" — and this install's fact for "the team" is a Slack channel, which would
      // otherwise arrive at Linear as a team name. Same reasoning as `remember` and `openApp`.
      resolvesReferences: false,
      // EVERYTHING that will be sent, in full. Not a preview and not the model's own account of
      // it: the validated arguments, plus the ones code fixed.
      //
      // And where it came from, when that is in doubt (M19, core/contextHints.ts): if an email
      // is open and an argument IS the clipboard's text, the question says "from your clipboard
      // text". A label, never a refusal — the model may have been right to use the clipboard.
      confirmSummary: async (args: ToolInput, deps: ToolDeps): Promise<string> => {
        const final = await prepare(args);
        const summary = tool.describe
          ? tool.describe(args, settings)
          : listing(def.label, tool, final);
        return usesClipboardBesideOpenEmail(args, deps.context)
          ? markFromClipboard(summary)
          : summary;
      },
      narrate: async (args: ToolInput): Promise<string> => {
        const final = await prepare(args);
        return `Using ${def.label}: ${clip(inline(tool, final))}…`;
      },
      handler: async (input: ToolInput): Promise<string> => {
        const final = await prepare(input);
        const result = await connection.callTool(tool.remote, final);
        const text = flattenResult(result);

        if (result.isError) {
          // A connector with its own wording never shows the server's (types.ts, `failure`).
          if (tool.failure === undefined) {
            throw connectorError("tool-failed", def.label, clip(failureText(text)));
          }
          const said = ownWords(() => tool.failure?.(text, input, settings) ?? null);
          if (said.length === 0) {
            // Not one the connector recognises, so the person is told only "<app> said no." —
            // and without this line the server's reason would exist nowhere at all. CONSOLE
            // ONLY: it is not in the error, so it cannot reach the screen, speech, the action
            // log or a later chain step. Flattened to one line so it cannot forge another.
            log(`${name} failed and I did not recognise why. ${def.label} said: ${forLog(text)}`);
          }
          throw connectorError("tool-failed", def.label, said);
        }
        if (text.trim().length === 0) {
          throw connectorError("bad-result", def.label, "it sent nothing back");
        }
        if (tool.format === undefined) return text;
        try {
          return tool.format(text, input, settings);
        } catch (error) {
          // The formatter's own words ("no `url`") — OURS, not the server's, so safe to show.
          const why = error instanceof Error ? error.message : String(error);
          throw connectorError("bad-result", def.label, clip(why));
        }
      },
    };
  });
}

// A connector's own sentence for a failure, or nothing. A `failure` hook that throws must not
// turn "the server said no" into a crash, and must not fall back to the server's text either —
// not showing that text is the reason the hook exists.
function ownWords(explainFailure: () => string | null): string {
  try {
    return explainFailure() ?? "";
  } catch {
    return "";
  }
}

function forLog(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(nothing)";
  return flat.length > MAX_LOGGED_FAILURE ? `${flat.slice(0, MAX_LOGGED_FAILURE)}…` : flat;
}

// The generic confirm text for a tool with no `describe` of its own: the question, then every
// argument on its own line, values WHOLE.
function listing(app: string, tool: ConnectorToolDef, final: ToolInput): string {
  const lines = Object.entries(final).map(([key, value]) => `${key}: ${show(value)}`);
  const question = `Run ${app} ${tool.name}?`;
  return lines.length > 0 ? `${question}\n\n${lines.join("\n")}` : question;
}

function inline(tool: ConnectorToolDef, final: ToolInput): string {
  const parts = Object.entries(final).map(([key, value]) => `${key}: ${show(value)}`);
  return parts.length > 0 ? `${tool.name} (${parts.join(", ")})` : tool.name;
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// One validation failure, as a phrase. Names the argument and nothing else: the VALUE is never
// echoed, because on the drift path it may be text that came out of someone's email.
function explain(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) return "the arguments were not accepted";
  const extra = (first.params as Record<string, unknown>)["additionalProperty"];
  if (typeof extra === "string") return `"${extra}" is not something it accepts`;
  const missing = (first.params as Record<string, unknown>)["missingProperty"];
  if (typeof missing === "string") return `"${missing}" is missing`;
  const where = first.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return where.length > 0
    ? `"${where}" ${first.message ?? "is not valid"}`
    : (first.message ?? "the arguments were not accepted");
}
