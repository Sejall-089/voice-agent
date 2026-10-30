// M33 — the live-model harness for "a correction overwrites a memory fact", committed this time
// (M30, M31 and M32 each rebuilt theirs as a scratch script and lost it).
//
// The real planner through the real call site (`createRunInstruction`), real planning calls
// through tests/eval/realModel.ts's spend gate, and EVERYTHING that could reach a real service
// faked:
//   - Linear:  SdkMcpConnection over FakeMcpServer's in-memory transport, with a dummy key.
//   - GitHub:  UnavailableConnection, which rejects every call.
//   - Slack:   a bot-mode FakeSender, with a FakeChannelDirectory listing help, social, fun and
//              general.
//   - Memory:  a real SqliteMemory(":memory:") that KEEPS its writes (M32's stand-in threw them
//              away, so its finding was what a write WOULD have done), seeded per case and read
//              back after every trial.
//   - Action log: a fresh InMemoryActionLog per trial, holding only the case's seeded turn.
//   - Network: `fetch` replaced so only api.openai.com is reachable; anything else is refused and
//              recorded.
//   - Dialogs: every confirm is answered Cancel (MockShell's empty queue), every question nothing.
//   - The model's `complete` half (the Slack formatter, a summary) is a fixed fake: only planning
//              calls (`chooseTool`) are real, so only they are counted.
// The menu is the app's with every surface this install configures switched on (Gmail, Notion,
// calendar, speech, pointing, jobs, Linear, GitHub); the surfaces themselves are the planner's
// "Unavailable" defaults. No email is open. The clipboard is M28's long trace.
//
// BEFORE ANY MODEL CALL the fakes are checked with scripted answers (no model): a Linear create
// reaches the fake server and nothing else, a GitHub call is rejected, a bot-mode send reaches
// the fake directory and fake sender, memory keeps a write, and a request to any host but
// api.openai.com is refused. A failed check stops the run with nothing sent.
//
// M34 reuses it for rules B and D (a first write whose subject was never said; a clipboard-sized
// value): four more cases, a per-case clipboard, `newFacts` in each record (every active subject
// the seed did not hold — a junk first write shows here), and a second dry run.
//
//   npx vite-node scripts/m33-live.ts --check            # the fake checks only (no model)
//   npx vite-node scripts/m33-live.ts --scripted         # the dry run: a scripted remember (no model)
//   npx vite-node scripts/m33-live.ts --first-writes     # M34's dry run: rules B and D (no model)
//   npx vite-node scripts/m33-live.ts --case correction --trials 12 --label T1    # DRY: count and cost
//   REAL_MODEL=1 REAL_MODEL_MAX_CALLS=12 npx vite-node scripts/m33-live.ts --case correction --trials 12 --label T1
//
// Cases: correction, correction-no-team, remember-team-empty, remember-team-same, name-empty,
// team-to-fun, meant-design; M34: team-empty, dashboard-empty, samurai-long. `--json <path>` also
// writes every trial's record.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection, UnavailableConnection } from "../src/core/mcp/SdkConnection.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { normalizeReference } from "../src/core/memory/normalize.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import type {
  ActionLogEntry,
  LLMClient,
  MessageSender,
  PlannedStep,
  PlannerOutcome,
  ToolChoice,
} from "../src/core/types.ts";
import { judge } from "../src/core/tools/remember.ts";
import { createRunInstruction } from "../src/main/runInstruction.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import { FakeChannelDirectory } from "../tests/FakeChannelDirectory.ts";
import { FakeLLM } from "../tests/FakeLLM.ts";
import { FakeMcpServer } from "../tests/FakeMcpServer.ts";
import { FakeSender } from "../tests/FakeSender.ts";
import { realModelGate } from "../tests/eval/realModel.ts";
import { LONG_TRACE } from "../tests/fixtures/planChoice/clipboards.ts";
import { ROW_591_SHAPE } from "../tests/fixtures/rememberCalls/replay.ts";

// --- The network: api.openai.com only -------------------------------------------------------

const ALLOWED_HOST = "api.openai.com";
const blocked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host !== ALLOWED_HOST) {
    blocked.push(host);
    return Promise.reject(new TypeError(`m33-live: the network to ${host} is blocked`));
  }
  return realFetch(input, init);
};

// --- The world one trial runs in ------------------------------------------------------------

class FakeBotSender extends FakeSender {
  readonly mode = "bot" as const;
}

const CHANNELS = [
  { id: "C0000000001", name: "help" },
  { id: "C0000000002", name: "social" },
  { id: "C0000000003", name: "fun" },
  { id: "C0000000004", name: "general" },
];

// The seed (the investigation's channel facts, and a placeholder where her name is).
const PLACEHOLDER_NAME = "Sam Placeholder";
const PLACEHOLDER_URL = "https://dash.example.com";
const SEED: Record<string, string> = {
  team: "#social",
  "social channel": "#social",
  "third channel": "#fun",
  name: PLACEHOLDER_NAME,
};

const FAKE_COMPLETION = "Formatted notes (the harness's fixed stand-in for the formatter).";

type SeededTurn = Omit<ActionLogEntry, "ts">;

// "create a linear issue and post in fun", planned create > send and cancelled at the create's
// dialog: what that leaves as the last row of the log.
const CANCELLED_CREATE: SeededTurn = {
  instruction: "create a linear issue and post in fun",
  tool: "linear__create_issue",
  arguments: { title: "Migration fails on orders", description: LONG_TRACE },
  result: null,
  status: "cancelled",
};

// "send these notes to the team", cancelled at its dialog. Logged as the planner logs a run step:
// with the arguments as settled, so "the team" is already #social.
const CANCELLED_SEND: SeededTurn = {
  instruction: "send these notes to the team",
  tool: "sendMessage",
  arguments: { channel: "#social", notes: FAKE_COMPLETION },
  result: null,
  status: "cancelled",
};

interface Case {
  id: string;
  instruction: string;
  facts: Record<string, string>;
  previous: SeededTurn | null;
  // M34. What is on the clipboard; M28's long trace when absent.
  clipboard?: string;
}

const without = (key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(SEED).filter(([k]) => k !== key));

const CASES: Case[] = [
  { id: "correction", instruction: "actually, post it in social instead", facts: SEED, previous: CANCELLED_CREATE },
  { id: "correction-no-team", instruction: "actually, post it in social instead", facts: without("team"), previous: CANCELLED_CREATE },
  { id: "remember-team-empty", instruction: "remember that team is #social", facts: without("team"), previous: null },
  { id: "remember-team-same", instruction: "remember that team is #social", facts: SEED, previous: null },
  { id: "name-empty", instruction: `my name is ${PLACEHOLDER_NAME}`, facts: without("name"), previous: null },
  { id: "team-to-fun", instruction: "remember the team is #fun", facts: SEED, previous: null },
  { id: "meant-design", instruction: "no, I meant the design channel", facts: SEED, previous: CANCELLED_SEND },
  // M34's controls for rules B and D.
  { id: "team-empty", instruction: "remember the team is #social", facts: without("team"), previous: null },
  { id: "dashboard-empty", instruction: `remember my dashboard is ${PLACEHOLDER_URL}`, facts: SEED, previous: null },
  // Row 591's shape, neutral text: a misheard "Summarize this." with a long, many-line clipboard.
  { id: "samurai-long", instruction: "Samurai is this.", facts: SEED, previous: null, clipboard: ROW_591_SHAPE },
];

const PREVIOUS_TURN_AGE_MS = 40_000;

interface FactRow {
  subject: string;
  value: string;
  version: number;
  active: number;
}

function world(c: Pick<Case, "facts" | "previous" | "clipboard">, llm: LLMClient, confirms: boolean[] = []) {
  const server = new FakeMcpServer({ timeline: [] });
  const connectors = loadConnectorTools({
    configText: JSON.stringify({
      connectors: {
        linear: { enabled: true, tools: ["create_issue", "search_issues", "get_issue"], settings: { defaultTeam: "Engineering" } },
        github: { enabled: true, tools: ["create_issue", "list_issues", "get_issue"], settings: { owner: "someone", repo: "nothing" } },
      },
    }),
    readKey: () => "dummy-key-for-the-fakes",
    connect: (def) =>
      def.id === "linear"
        ? new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: server.transport, timeoutMs: 2000, connectTimeoutMs: 2000 })
        : new UnavailableConnection(def.label),
  }).tools;

  const db = createDatabase(":memory:");
  const memory = new SqliteMemory(db);
  for (const [subject, value] of Object.entries(c.facts)) memory.write(subject, value, { source: "seed" });

  const log = new InMemoryActionLog();
  if (c.previous !== null) {
    log.logAction({ ...c.previous, ts: new Date(Date.now() - PREVIOUS_TURN_AGE_MS).toISOString() });
  }

  const shell = new MockShell({
    context: { selectedText: c.clipboard ?? LONG_TRACE, activeApp: null, activeWindowTitle: null },
    confirms,
  });
  const sender = new FakeBotSender();
  const directory = new FakeChannelDirectory({ channels: CHANNELS, delayMs: 5 });
  const tools = buildRegistry({
    gmail: true,
    notion: true,
    calendar: true,
    speech: true,
    pointing: true,
    jobs: true,
    connectors,
  });
  const planner = new Planner(
    llm,
    shell,
    tools,
    memory,
    log,
    sender as MessageSender,
    undefined, // gmail: unavailable, so no email is open
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech
    undefined, // screen
    undefined, // elements
    undefined, // chooser
    () => Promise.resolve(), // sleep
    undefined, // chain state
    directory,
  );

  let outcome: PlannerOutcome | null = null;
  const run = createRunInstruction(
    { run: async (instruction) => (outcome = await planner.run(instruction)) },
    shell,
    log,
  );
  const facts = (): FactRow[] =>
    db.prepare<[], FactRow>("SELECT subject, value, version, active FROM facts ORDER BY id").all();

  return { run, outcome: () => outcome, shell, sender, directory, server, log, facts, menu: tools.map((t) => t.name) };
}

// --- What the model answered, and whether it was the hazard ---------------------------------

function stepsOf(choice: ToolChoice): PlannedStep[] {
  if (choice.kind === "tool") return [{ tool: choice.name, arguments: choice.input, describe: "" }];
  if (choice.kind === "plan") return choice.steps;
  return [];
}

function describeChoice(choice: ToolChoice): string {
  if (choice.kind === "tool" || choice.kind === "plan") {
    const steps = stepsOf(choice).map((s) => `${s.tool} ${JSON.stringify(s.arguments).slice(0, 160)}`);
    return `${choice.kind === "plan" ? "plan: " : ""}${steps.join(" > ")}`;
  }
  if (choice.kind === "none") return `none: ${JSON.stringify(choice.text ?? "").slice(0, 200)}`;
  if (choice.kind === "multiple") return `multiple: ${choice.tools.map((t) => t.name).join(", ")}`;
  return `incomplete: ${choice.reason}`;
}

// A remember the model asked for whose subject already holds a DIFFERENT value (the hazard) —
// judged by remember's own rule, so "social" for a stored #social (the same channel) is not one.
function hazards(choice: ToolChoice, facts: Record<string, string>): string[] {
  return stepsOf(choice)
    .filter((s) => s.tool === "remember" || s.tool === "functions.remember")
    .flatMap((s) => {
      const subject = normalizeReference(String(s.arguments["subject"] ?? ""));
      const value = String(s.arguments["value"] ?? "").trim();
      const held = facts[subject];
      return held !== undefined && judge({ value: held }, value) === "change" ? [`${subject}: ${held} -> ${value}`] : [];
    });
}

class RecordingClient implements LLMClient {
  readonly answers: ToolChoice[] = [];
  constructor(private readonly inner: LLMClient) {}
  async chooseTool(...args: Parameters<LLMClient["chooseTool"]>): Promise<ToolChoice> {
    const choice = await this.inner.chooseTool(...args);
    this.answers.push(choice);
    return choice;
  }
  // Never a real call: the formatter and summaries are not what is measured.
  complete(): Promise<string> {
    return Promise.resolve(FAKE_COMPLETION);
  }
}

// --- The fake checks, before any model call -------------------------------------------------

async function checkFakes(): Promise<boolean> {
  const results: { check: string; ok: boolean; detail: string }[] = [];
  const push = (check: string, ok: boolean, detail: string): void => {
    results.push({ check, ok, detail });
  };
  const scripted = (choice: ToolChoice): LLMClient => new FakeLLM(choice, FAKE_COMPLETION);
  const empty = { facts: {}, previous: null };

  {
    const create: ToolChoice = { kind: "tool", name: "linear__create_issue", input: { title: "probe", description: "probe" } };
    const cancelled = world(empty, scripted(create));
    await cancelled.run("create a linear issue");
    const approved = world(empty, scripted(create), [true]);
    await approved.run("create a linear issue");
    push(
      "Linear: a create reaches the fake server only, and Cancel files nothing",
      cancelled.shell.confirmMessages.length === 1 && cancelled.server.created.length === 0 && approved.server.created.length === 1,
      `cancel: ${cancelled.shell.confirmMessages.length} dialog, ${cancelled.server.created.length} filed; approve: ${approved.server.created.length} filed at the fake`,
    );
  }
  {
    const create: ToolChoice = { kind: "tool", name: "github__create_issue", input: { title: "probe", body: "probe" } };
    const w = world(empty, scripted(create), [true]);
    await w.run("file it on github");
    const status = w.outcome()?.status;
    push("GitHub: rejected", status !== "ok", `status ${status}: ${w.outcome()?.result ?? ""}`);
  }
  {
    const send: ToolChoice = { kind: "tool", name: "sendMessage", input: { channel: "#social", notes: "probe" } };
    const cancelled = world(empty, scripted(send));
    await cancelled.run("send it to social");
    const approved = world(empty, scripted(send), [true]);
    await approved.run("send it to social");
    push(
      "Slack: bot mode, the fake directory and the fake sender; Cancel sends nothing",
      cancelled.sender.calls.length === 0 &&
        cancelled.directory.calls.length > 0 &&
        approved.sender.calls.length === 1 &&
        approved.sender.calls[0]?.channel === "#social",
      `cancel: ${cancelled.sender.calls.length} sent, directory asked ${JSON.stringify(cancelled.directory.calls)}; approve: sent to ${approved.sender.calls[0]?.channel ?? "nothing"} at the fake`,
    );
  }
  {
    const remember: ToolChoice = { kind: "tool", name: "remember", input: { subject: "probe", value: "kept" } };
    const w = world({ facts: SEED, previous: null }, scripted(remember));
    await w.run("remember probe is kept");
    const kept = w.facts().some((f) => f.subject === "probe" && f.value === "kept" && f.active === 1);
    const seeded = Object.keys(SEED).every((s) => w.facts().some((f) => f.subject === s && f.active === 1));
    push("Memory: a real SQLite in memory that keeps writes, seeded", kept && seeded, `${w.facts().length} rows, probe kept: ${kept}`);
  }
  {
    const before = blocked.length;
    let refused = false;
    try {
      await globalThis.fetch("https://slack.com/api/conversations.list");
    } catch {
      refused = true;
    }
    push("Network: anything but api.openai.com is refused", refused && blocked.length === before + 1, `slack.com refused: ${refused}`);
  }

  for (const r of results) console.log(`[check] ${r.ok ? "ok  " : "FAIL"} ${r.check} — ${r.detail}`);
  return results.every((r) => r.ok);
}

// --- The dry run: a scripted remember, no model ---------------------------------------------

// With `team` = #social stored: "social" and "#social" name the same channel (no dialog, #social
// kept at v1); "#fun" is a change (the dialog), shown cancelled and then approved.
async function scriptedDryRun(): Promise<void> {
  const c = CASES.find((x) => x.id === "correction")!;
  const runs: { value: string; answer: "Cancel" | "Approve" }[] = [
    { value: "social", answer: "Cancel" },
    { value: "#social", answer: "Cancel" },
    { value: "#fun", answer: "Cancel" },
    { value: "#fun", answer: "Approve" },
  ];
  for (const { value, answer } of runs) {
    const choice: ToolChoice = { kind: "tool", name: "remember", input: { subject: "team", value } };
    const w = world(c, new FakeLLM(choice, FAKE_COMPLETION), answer === "Approve" ? [true] : []);
    await w.run(`remember the team is ${value}`);
    const row = w.log.entries[w.log.entries.length - 1];
    console.log(`\n[dry run] team = ${value}, any dialog answered ${answer}`);
    console.log(`  dialog:  ${JSON.stringify(w.shell.confirmMessages)}`);
    console.log(`  label:   ${JSON.stringify(w.shell.confirmLabels)}`);
    console.log(`  result:  ${JSON.stringify(w.shell.results)}`);
    console.log(`  log row: ${JSON.stringify({ tool: row?.tool, arguments: row?.arguments, status: row?.status })}`);
    console.log(`  team:    ${JSON.stringify(w.facts().filter((f) => f.subject === "team"))}`);
  }
}

// --- M34's dry run: rules B and D, no model --------------------------------------------------

// Scripted remember calls through the same world. B: a first write whose subject the instruction
// never said is refused with no Slack call and nothing written. D: a clipboard-sized value is
// refused. Controls: a first write that names its subject is saved as v1; a replacement still asks.
async function firstWriteDryRun(): Promise<boolean> {
  const caseOf = (id: string): Case => CASES.find((x) => x.id === id)!;
  const runs: { label: string; c: Case; subject: string; value: string; expect: "refused (B)" | "refused (D)" | "written v1" | "dialog" }[] = [
    { label: "B: channel:fun = social", c: caseOf("correction"), subject: "channel:fun", value: "social", expect: "refused (B)" },
    { label: "B: channel = #social", c: caseOf("correction-no-team"), subject: "channel", value: "#social", expect: "refused (B)" },
    { label: "D: samurai = row 591's shape", c: caseOf("samurai-long"), subject: "Samurai", value: ROW_591_SHAPE, expect: "refused (D)" },
    { label: "control: team = #social, team empty", c: caseOf("team-empty"), subject: "team", value: "#social", expect: "written v1" },
    { label: "control: name, name empty", c: caseOf("name-empty"), subject: "name", value: PLACEHOLDER_NAME, expect: "written v1" },
    { label: "control: team = #fun against #social", c: caseOf("team-to-fun"), subject: "team", value: "#fun", expect: "dialog" },
  ];
  let ok = true;
  for (const run of runs) {
    const choice: ToolChoice = { kind: "tool", name: "remember", input: { subject: run.subject, value: run.value } };
    const w = world(run.c, new FakeLLM(choice, FAKE_COMPLETION));
    await w.run(run.c.instruction);
    const subject = normalizeReference(run.subject);
    const stored = w.facts().filter((f) => f.subject === subject && f.active === 1);
    const results = w.shell.results;
    const seen =
      w.shell.confirmMessages.length > 0
        ? "dialog"
        : results.some((r) => r.startsWith("I did not save that."))
          ? "refused (B)"
          : results.some((r) => r.startsWith("That is too long"))
            ? "refused (D)"
            : stored.length === 1 && stored[0]?.version === 1
              ? "written v1"
              : "other";
    const pass = seen === run.expect && (seen !== "refused (B)" || w.directory.calls.length === 0);
    ok &&= pass;
    console.log(`\n[first writes] ${pass ? "ok  " : "FAIL"} ${run.label} under "${run.c.instruction}": ${seen} (expected ${run.expect})`);
    console.log(`  result:    ${JSON.stringify(results.map((r) => (r.length > 120 ? `${r.slice(0, 120)}...` : r)))}`);
    console.log(`  dialog:    ${JSON.stringify(w.shell.confirmMessages)}`);
    console.log(`  slack:     directory asked ${JSON.stringify(w.directory.calls)}`);
    console.log(`  ${subject}: ${JSON.stringify(stored.map((f) => ({ value: f.value.length > 60 ? `[${f.value.length} chars]` : f.value, version: f.version })))}`);
  }
  return ok;
}

// --- Main -----------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]!;
};

if (!(await checkFakes())) {
  console.error("[m33-live] a fake check failed: nothing was sent to a model.");
  process.exit(1);
}
if (argv.includes("--check")) process.exit(0);
if (argv.includes("--scripted")) {
  await scriptedDryRun();
  process.exit(0);
}
if (argv.includes("--first-writes")) {
  process.exit((await firstWriteDryRun()) ? 0 : 1);
}

const caseId = flag("--case", "");
const theCase = CASES.find((c) => c.id === caseId);
if (theCase === undefined) {
  console.error(`[m33-live] --case must be one of: ${CASES.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
const TRIALS = Number(flag("--trials", "3"));
const LABEL = flag("--label", caseId);
const JSON_OUT = flag("--json", "");

const gate = realModelGate({
  name: `m33-live ${LABEL} (${caseId})`,
  plannedCalls: TRIALS,
  selected: true,
  howToRun: `REAL_MODEL=1 REAL_MODEL_MAX_CALLS=${TRIALS} npx vite-node scripts/m33-live.ts --case ${caseId} --trials ${TRIALS} --label ${LABEL}`,
});
console.log(gate.line);
if (!gate.real) process.exit(0);
const model = gate.client();

console.log(
  `[m33-live] ${LABEL}: "${theCase.instruction}" | facts ${JSON.stringify(theCase.facts)} | previous turn: ` +
    `${theCase.previous === null ? "none" : `${theCase.previous.tool} ${theCase.previous.status}, ${PREVIOUS_TURN_AGE_MS / 1000} s old`} | ` +
    `clipboard ${LONG_TRACE.length} chars | no email open`,
);

const records: unknown[] = [];
for (let trial = 1; trial <= TRIALS; trial += 1) {
  const client = new RecordingClient(model);
  const w = world(theCase, client);
  const before = blocked.length;
  await w.run(theCase.instruction);
  const outcome = w.outcome() as PlannerOutcome | null;
  const answers = client.answers.map(describeChoice);
  const hazard = client.answers.flatMap((a) => hazards(a, theCase.facts));
  const active = Object.fromEntries(w.facts().filter((f) => f.active === 1).map((f) => [f.subject, `${f.value} (v${f.version})`]));
  const changed = Object.entries(theCase.facts).filter(([s, v]) => !w.facts().some((f) => f.subject === s && f.value === v && f.active === 1));
  // M34. Every fact the trial added under a subject the seed did not hold: a junk first write, or
  // a control's genuine one.
  const newFacts = w
    .facts()
    .filter((f) => f.active === 1 && !(f.subject in theCase.facts))
    .map((f) => `${f.subject} = ${f.value.length > 60 ? `[${f.value.length} chars]` : f.value} (v${f.version})`);
  const record = {
    label: LABEL,
    case: caseId,
    trial,
    answers,
    hazard,
    status: outcome?.status ?? "threw",
    dialogs: w.shell.confirmMessages,
    results: w.shell.results,
    activeFacts: active,
    changedFacts: changed.map(([s]) => s),
    newFacts,
    created: w.server.created.length,
    sent: w.sender.calls.length,
    blocked: blocked.slice(before),
  };
  records.push(record);
  console.log(`[trial ${LABEL} #${trial}] ${JSON.stringify(record)}`);
}

if (JSON_OUT !== "") writeFileSync(JSON_OUT, JSON.stringify(records, null, 2));
console.log(`[m33-live] ${LABEL}: ${records.length} trials done.`);
