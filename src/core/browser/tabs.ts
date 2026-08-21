import { CdpSession, listPages, type PageTarget } from "./CdpClient.ts";

// One live tab, chosen out of a Chrome the user is driving.
export interface TabCandidate {
  target: PageTarget;
  session: CdpSession;
}

export interface PickTabOptions {
  baseUrl: string;
  timeoutMs: number | undefined;
  // Which open tabs even belong to this app.
  hostMatch: (url: string) => boolean;
  // Does THIS tab satisfy the operation being attempted (a message open, a reply box open,
  // an editable page)? A tab that throws answering this (still loading, signed out) is
  // treated as "not a candidate", not as a reason to fail the whole lookup.
  qualifies: (session: CdpSession) => Promise<boolean>;
  // Optional second pass, run ONLY when more than one tab qualifies. It may narrow the pool
  // further (e.g. "prefer the foreground tab of each window"), but it is never asked to
  // manufacture a choice out of genuine ambiguity: if it empties the pool, the ORIGINAL
  // candidates are what the zero/many refusal below is judged against, not the narrowed,
  // empty one — narrowing ambiguity down to nothing is still ambiguity, not absence.
  narrow?: (candidates: TabCandidate[]) => Promise<TabCandidate[]>;
  // Not one tab belonging to this app is open at all.
  whenNoHost: string;
  // Tabs of this app ARE open, but none of them satisfy `qualifies`.
  whenNoneQualify: string;
  // More than one tab satisfies `qualifies` (after narrowing, if any ran).
  whenMany: (count: number) => string;
}

// Pick the ONE tab an operation should act in. Lifted out of `ChromeGmail` (M10) so a second
// app surface (Notion, M11) reuses the exact same "don't guess which tab" safety rule instead
// of a second, driftable copy of it.
//
// Exactly one candidate must qualify. Zero or several is a refusal: with two tabs mid-task
// there is no honest way to know which one was meant, and acting on the wrong one is worse
// than refusing outright.
export async function pickTab<T>(
  options: PickTabOptions,
  // `target` is the chosen tab's own PageTarget (its real URL, title, id) — callers that
  // don't need it (ChromeGmail) simply declare fewer parameters and ignore it.
  work: (session: CdpSession, target: PageTarget) => Promise<T>,
): Promise<T> {
  const pages = (await listPages(options.baseUrl, options.timeoutMs)).filter((page) =>
    options.hostMatch(page.url),
  );
  if (pages.length === 0) {
    throw new Error(options.whenNoHost);
  }

  const candidates: TabCandidate[] = [];
  try {
    for (const target of pages) {
      const session = await CdpSession.connect(target, options.timeoutMs);
      let qualifies = false;
      try {
        qualifies = await options.qualifies(session);
      } catch {
        // A tab that can't answer is simply not a candidate. Only the final zero/many
        // verdict below is worth telling the user about.
      }
      if (qualifies) {
        candidates.push({ target, session });
      } else {
        session.close();
      }
    }

    const narrowed =
      candidates.length > 1 && options.narrow !== undefined
        ? await options.narrow(candidates)
        : candidates;
    // See the doc comment on `narrow`: an empty narrowed pool falls back to the ORIGINAL
    // candidates for the zero/many verdict, since narrowing to nothing is still ambiguity.
    const pool = narrowed.length === 0 ? candidates : narrowed;

    const chosen = pool[0];
    if (chosen === undefined) {
      throw new Error(options.whenNoneQualify);
    }
    if (pool.length > 1) {
      throw new Error(options.whenMany(pool.length));
    }
    return await work(chosen.session, chosen.target);
  } finally {
    // Every session, including the one that did the work: nothing outlives the call.
    for (const candidate of candidates) candidate.session.close();
  }
}
