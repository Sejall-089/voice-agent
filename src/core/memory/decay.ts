// Light decay (spec.md §7): a fact older than ~30 days is still usable, just less trusted.
// Shared by the resolver (which applies it on lookup) and `recall` (which displays it), so the
// confidence a demo viewer SEES is the confidence a lookup would actually GET.
const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_AFTER_DAYS = 30;
const STALE_CONFIDENCE_FACTOR = 0.5;

export function ageInDays(updatedAt: string): number {
  return (Date.now() - new Date(updatedAt).getTime()) / DAY_MS;
}

export function isStale(updatedAt: string): boolean {
  return ageInDays(updatedAt) > STALE_AFTER_DAYS;
}

export function decayed(confidence: number, updatedAt: string): number {
  return isStale(updatedAt) ? confidence * STALE_CONFIDENCE_FACTOR : confidence;
}
