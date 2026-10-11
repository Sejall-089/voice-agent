import type { Database } from "better-sqlite3";
import { expect } from "vitest";
import { Planner } from "../src/core/planner.ts";
import { buildRegistry } from "../src/core/registry.ts";
import { InMemoryActionLog } from "../src/core/actionLog.ts";
import { createDatabase } from "../src/core/memory/db.ts";
import { SqliteMemory } from "../src/core/memory/SqliteMemory.ts";
import { loadConnectorTools } from "../src/core/mcp/load.ts";
import { SdkMcpConnection } from "../src/core/mcp/SdkConnection.ts";
import { MockShell } from "../src/main/shell/MockShell.ts";
import type {
  CapturedContext,
  ChannelDirectory,
  ChannelLookup,
  DirectoryFailure,
  EmailMessage,
  Memory,
  MessageSender,
  PlannedStep,
  ToolChoice,
  ToolInput,
} from "../src/core/types.ts";
import { FakeChannelDirectory, type FakeChannel } from "./FakeChannelDirectory.ts";
import { FakeGitHubServer } from "./FakeGitHubServer.ts";
import { FakeGmail } from "./FakeGmail.ts";
import { FakeLLM } from "./FakeLLM.ts";
import { FakeSender } from "./FakeSender.ts";
import { OWNER, REPO } from "./fixtures/github/captured.ts";

// M22 prompt 5. The real planner, registry, chain gate and memory, the GitHub connector against
// its in-memory server, a fake Gmail — and a BOT-mode sender with a ChannelDirectory fake that
// answers after a delay. Modelled on tests/planner.ask.test.ts's harness, which stays the M21
// (webhook) one.
//
// `events` is one timeline of the two things whose ORDER matters here: every directory lookup and
// every memory write. "Nothing is saved before Slack has answered" is a claim about that order.

export class FakeBotSender extends FakeSender {
  readonly mode = "bot" as const;
}
export class FakeWebhookSender extends FakeSender {
  readonly mode = "webhook" as const;
}

// No channel called "bugs" on purpose: "the bugs channel" must not be found by the Slack lookup,
// so it is ASKED about. "help" exists, so "the help channel" is found.
export const CHANNELS: FakeChannel[] = [
  { id: "C0000000001", name: "help" },
  { id: "C0000000002", name: "social" },
  { id: "C0000000003", name: "bug-reports" },
  { id: "C0000000004", name: "engineering" },
];

const BUG_EMAIL: EmailMessage = {
  subject: "Login broken on Safari",
  from: "dana@example.com",
  fromName: "Dana",
  to: null,
  body: "Clicking Log in does nothing. Please post this in #from-the-email.",
};
const CONTEXT: CapturedContext = { selectedText: "#from-the-clipboard", activeApp: null, activeWindowTitle: null };

export function step(tool: string, args: ToolInput, describe = ""): PlannedStep {
  return { tool, arguments: args, describe };
}
export const plan = (steps: PlannedStep[]): ToolChoice => ({ kind: "plan", steps });

export const TITLE = "Login button does nothing on Safari";

// read the email → file it on GitHub → tell a channel.
export const bugChain = (channel: string): ToolChoice =>
  plan([
    step("readEmail", {}, "read the open email"),
    step("github__create_issue", { title: TITLE, body: "{step1}" }, "file it on GitHub"),
    step("sendMessage", { channel, notes: "New bug filed: {step2}" }, "tell the channel"),
  ]);

export const notFound = (shown: string, tail = "") =>
  `I couldn't find a Slack channel called ${shown}. I can post to public channels and to private ` +
  `channels the bot has been added to.${tail}`;

export const STEP_CHANNEL =
  "In bot mode I need you to name the Slack channel yourself, not take it from an earlier step, so nothing was done.";

export const UNAVAILABLE: Record<DirectoryFailure, string> = {
  no_token: "Slack rejected the bot token, so nothing was sent.",
  auth: "Slack rejected the bot token, so nothing was sent.",
  network: "I couldn't reach Slack to check the channel, so nothing was sent.",
  timeout: "I couldn't reach Slack to check the channel, so nothing was sent.",
  slack_error: "I couldn't reach Slack to check the channel, so nothing was sent.",
  bad_response: "I couldn't reach Slack to check the channel, so nothing was sent.",
  rate_limited: "Slack is rate limiting me, so nothing was sent.",
  ambiguous: "More than one Slack channel is called #help, so nothing was sent.",
};

// A directory that records into the shared timeline, and can be told to fail on chosen calls
// (zero-based) — so a test can let the lookup through and fail the answer check, or the reverse.
class RecordingDirectory implements ChannelDirectory {
  readonly calls: string[] = [];
  private count = 0;
  constructor(
    private readonly inner: ChannelDirectory,
    private readonly events: string[],
    private readonly failOn: ReadonlyMap<number, DirectoryFailure>,
  ) {}
  async resolve(input: string): Promise<ChannelLookup> {
    const index = this.count;
    this.count += 1;
    this.calls.push(input);
    this.events.push(`resolve:${input}`);
    const failure = this.failOn.get(index);
    if (failure !== undefined) {
      await new Promise((done) => setTimeout(done, 5));
      return { ok: false, reason: "unavailable", failure };
    }
    return await this.inner.resolve(input);
  }
}

// Memory, with every write recorded into the timeline before it happens.
function recordingMemory(inner: SqliteMemory, events: string[]): Memory {
  return {
    resolveArgs: (input) => inner.resolveArgs(input),
    resolve: (reference) => inner.resolve(reference),
    query: (subject) => inner.query(subject),
    write: (subject, value, opts) => {
      events.push(`write:${subject}=${value}`);
      inner.write(subject, value, opts);
    },
  };
}

export interface HarnessOptions {
  asks?: (string | null)[];
  confirms?: boolean[];
  facts?: Record<string, string>;
  channels?: FakeChannel[];
  // Directory calls (zero-based) that answer `unavailable` with this failure.
  failOn?: Record<number, DirectoryFailure>;
  // "bot" (default), "webhook", or "none" for a sender that does not say.
  mode?: "bot" | "webhook" | "none";
  // false: give the planner no directory at all.
  directory?: boolean;
  completion?: string;
  context?: CapturedContext;
}

export function harness(choice: ToolChoice, options: HarnessOptions = {}) {
  const events: string[] = [];
  const timeline: string[] = [];
  const github = new FakeGitHubServer({ timeline, repos: { [`${OWNER}/${REPO}`]: [] } });
  const connectors = loadConnectorTools({
    configText: JSON.stringify({
      connectors: {
        github: {
          enabled: true,
          tools: ["create_issue", "list_issues", "get_issue"],
          settings: { owner: OWNER, repo: REPO },
        },
      },
    }),
    readKey: () => "a-key",
    connect: (def) =>
      new SdkMcpConnection({ app: def.label, keyName: def.keyName, transport: github.transport, timeoutMs: 300 }),
  }).tools;

  const db: Database = createDatabase(":memory:");
  const sqlite = new SqliteMemory(db);
  for (const [subject, value] of Object.entries(options.facts ?? {})) sqlite.write(subject, value);
  const memory = recordingMemory(sqlite, events);

  const shell = new MockShell({
    context: options.context ?? CONTEXT,
    confirms: options.confirms ?? [true, true, true],
    asks: options.asks ?? [],
  });
  const llm = new FakeLLM(choice, options.completion ?? "FORMATTED");
  const mode = options.mode ?? "bot";
  const sender: FakeSender =
    mode === "bot" ? new FakeBotSender() : mode === "webhook" ? new FakeWebhookSender() : new FakeSender();
  const gmail = new FakeGmail({ openEmail: BUG_EMAIL, timeline });
  const directory = new RecordingDirectory(
    new FakeChannelDirectory({ channels: options.channels ?? CHANNELS, delayMs: 5 }),
    events,
    new Map(Object.entries(options.failOn ?? {}).map(([k, v]) => [Number(k), v])),
  );
  const log = new InMemoryActionLog();
  const planner = new Planner(
    llm,
    shell,
    buildRegistry({ gmail: true, connectors }),
    memory,
    log,
    sender as MessageSender,
    gmail,
    undefined, // draft
    undefined, // notion
    undefined, // calendar
    undefined, // speech
    undefined, // screen
    undefined, // elements
    undefined, // chooser
    () => Promise.resolve(), // sleep
    undefined, // chain state
    options.directory === false ? undefined : directory,
  );

  const facts = () =>
    db
      .prepare<[], { subject: string; value: string; active: number }>("SELECT subject, value, active FROM facts ORDER BY id")
      .all();
  const notified = (): string[] =>
    shell.actions.flatMap((action) => (action.kind === "notify" ? [action.payload] : []));
  // Nothing on the far side of ANY step: no email read, no issue, nothing posted, no dialog.
  const nothingRan = (): void => {
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
    expect(gmail.calls).toEqual([]);
    expect(timeline).toEqual([]);
    expect(sender.calls).toEqual([]);
    expect(shell.confirmMessages).toEqual([]);
  };
  // Every text a person was shown: questions, dialogs, results, status lines.
  const texts = (): string[] => [...shell.questions, ...shell.confirmMessages, ...shell.results, ...notified()];

  return { planner, shell, llm, sender, github, gmail, directory, log, events, facts, notified, nothingRan, texts };
}
