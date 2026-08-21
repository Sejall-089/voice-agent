import type { NotionPage, NotionSurface } from "../src/core/types.ts";

// A Notion tab that exists only in memory (M11) — the same role FakeGmail plays for M10.
// The tools and the planner run their real code; the thing with real-world consequences (a
// real Chrome, a real page) is swapped for something a test can inspect.
//
// No test in this repo ever opens a browser or touches a real Notion account. What that buys
// is the same thing FakeGmail buys: the *decisions* — read before appending, narrate before
// acting, never touch the page when composing fails — are proven deterministically. What it
// does not buy is any evidence that ChromeNotion's live CDP sequence (real mouse clicks, real
// keypresses) actually works against Notion's real page; only a live run shows that.

export interface FakeNotionOptions {
  openPage?: NotionPage | null; // null = no page open
  failWith?: string; // when set, EVERY operation rejects with this — a Chrome that isn't there
  // Optional shared ordering log, same role as FakeGmail's — lets a test compare the order of
  // events across two different doubles (e.g. "narration went out before appendToPage ran").
  timeline?: string[];
}

export class FakeNotion implements NotionSurface {
  public readonly calls: string[] = [];
  public appended: string[] = [];

  private readonly openPage: NotionPage | null;
  private readonly failWith: string | undefined;
  private readonly timeline: string[] | undefined;

  constructor(options: FakeNotionOptions = {}) {
    this.openPage = options.openPage === undefined ? samplePage() : options.openPage;
    this.failWith = options.failWith;
    this.timeline = options.timeline;
  }

  private note(call: string): void {
    this.calls.push(call);
    this.timeline?.push(`notion:${call}`);
  }

  readOpenPage(): Promise<NotionPage> {
    this.note("readOpenPage");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    if (this.openPage === null) {
      return Promise.reject(
        new Error("There's no Notion page open right now — open one and try again."),
      );
    }
    return Promise.resolve(this.openPage);
  }

  appendToPage(text: string): Promise<void> {
    this.note("appendToPage");
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    this.appended.push(text);
    return Promise.resolve();
  }
}

export function samplePage(): NotionPage {
  return {
    title: "Launch plan",
    url: "https://notion.so/launch-plan",
    body: "Kickoff is Monday. Alex owns the deck.",
  };
}
