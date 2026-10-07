import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
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
//   3. CHECK DRIFT against the server's own schema: the remote tool must still exist and must
//      still accept exactly what is about to be sent. This is the only use the server's schema
//      is ever put to. A mismatch is refused here, by name, instead of arriving back as a
//      puzzling argument error from the far side.
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

export function buildConnectorTools(
  selected: SelectedConnector,
  connection: McpConnection,
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
      // Arguments are literals to SEND. Memory resolution rewrites any string that starts with
      // "the" or "my" — and this install's fact for "the team" is a Slack channel, which would
      // otherwise arrive at Linear as a team name. Same reasoning as `remember` and `openApp`.
      resolvesReferences: false,
      // EVERYTHING that will be sent, in full. Not a preview and not the model's own account of
      // it: the validated arguments, plus the ones code fixed.
      confirmSummary: async (args: ToolInput): Promise<string> => {
        const final = await prepare(args);
        return tool.describe ? tool.describe(args, settings) : listing(def.label, tool, final);
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
          throw connectorError("tool-failed", def.label, clip(failureText(text)));
        }
        if (text.trim().length === 0) {
          throw connectorError("bad-result", def.label, "it sent nothing back");
        }
        if (tool.format === undefined) return text;
        try {
          return tool.format(text, input);
        } catch (error) {
          // The formatter's own words ("no `url`") — OURS, not the server's, so safe to show.
          const why = error instanceof Error ? error.message : String(error);
          throw connectorError("bad-result", def.label, clip(why));
        }
      },
    };
  });
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
