// Where a fact came from when the USER said it — typed into `remember`, or typed in answer to a
// question the app asked. One function so the two cannot drift: a fact is the user's word either
// way, and its provenance should read the same.
//
//   user:2026-10-10
export function userSource(now: Date = new Date()): string {
  return `user:${now.toISOString().slice(0, 10)}`;
}
