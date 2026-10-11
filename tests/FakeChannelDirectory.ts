import type {
  ChannelDirectory,
  ChannelId,
  ChannelInfo,
  ChannelLookup,
  DirectoryFailure,
} from "../src/core/types.ts";

// A ChannelDirectory for tests of the code that CALLS one (M22): the planner, sendMessage, the
// ask flow. It never touches the network.
//
// ITS MATCHING IS WRITTEN HERE, NOT IMPORTED (CLAUDE.md: "a fake must never be more lenient than
// the real thing", and "write the fake's rules independently"). The rule it implements is the
// one the real directory is specified to: exact name, case-insensitive, one optional leading "#",
// surrounding spaces ignored, and an ID typed as a name is just a name. tests/
// fakeChannelDirectory.test.ts puts both through the same cases, so if either drifts, that fails.
//
// SUGGESTIONS ARE SIMPLER than the real ones — names that start with, then contain, what was
// asked, alphabetical, at most three; no typo matching. A test that cares which names are
// suggested for a typo belongs against the real class.
//
// ASYNC ON PURPOSE. Every answer arrives after `delayMs` (a later macrotask even at 0), because
// the real one is a network round trip, and a caller that assumed it could get the answer in the
// same tick must fail here rather than in the app (CLAUDE.md, M16.9).
//
// NEVER REJECTS, like the real one: failures are scripted as `unavailable` outcomes, and they
// use the same fixed codes the real class returns.

export interface FakeChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
}

export interface FakeChannelDirectoryOptions {
  channels: FakeChannel[];
  // Scripted failures, one per call, in order. A call that finds this queue non-empty takes the
  // next one and answers `unavailable` with it, whatever it was asked; once empty, calls are
  // answered from `channels`.
  unavailable?: DirectoryFailure[];
  delayMs?: number;
}

export class FakeChannelDirectory implements ChannelDirectory {
  // Every input, exactly as given, in order.
  public readonly calls: string[] = [];

  private readonly channels: ChannelInfo[];
  private readonly failures: DirectoryFailure[];
  private readonly delayMs: number;

  constructor(options: FakeChannelDirectoryOptions) {
    this.channels = options.channels.map((channel) => ({
      id: channel.id as ChannelId,
      name: channel.name,
      isPrivate: channel.isPrivate ?? false,
    }));
    this.failures = [...(options.unavailable ?? [])];
    this.delayMs = options.delayMs ?? 0;
  }

  resolve(input: string): Promise<ChannelLookup> {
    this.calls.push(input);
    const failure = this.failures.shift();
    return new Promise((done) => {
      setTimeout(() => {
        done(failure === undefined ? this.answer(input) : { ok: false, reason: "unavailable", failure });
      }, this.delayMs);
    });
  }

  private answer(input: string): ChannelLookup {
    let wanted = input.trim();
    if (wanted.charAt(0) === "#") wanted = wanted.substring(1);
    wanted = wanted.normalize("NFC").toLowerCase();
    if (wanted === "") return { ok: false, reason: "not_found", suggestions: [] };

    const matches = this.channels.filter(
      (channel) => channel.name.normalize("NFC").toLowerCase() === wanted,
    );
    if (matches.length > 1) return { ok: false, reason: "unavailable", failure: "ambiguous" };
    const [match] = matches;
    if (match !== undefined) return { ok: true, channel: { ...match } };

    const names = this.channels.map((channel) => channel.name).sort();
    const starts = names.filter((name) => name.toLowerCase().startsWith(wanted));
    const contains = names.filter(
      (name) => !name.toLowerCase().startsWith(wanted) && name.toLowerCase().includes(wanted),
    );
    const suggestions = wanted.length < 2 ? [] : [...starts, ...contains].slice(0, 3);
    return { ok: false, reason: "not_found", suggestions };
  }
}
