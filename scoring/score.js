import { PLATFORM_WEIGHTS } from "./weights.js";

export function scoreItem(item) {
  const w = PLATFORM_WEIGHTS[item.platform] ?? 0.6;

  // freshness boost: newer = higher score
  let freshness = 0;
  if (item.publishedAt) {
    const ts = new Date(item.publishedAt).getTime();
    if (!Number.isNaN(ts)) {
      const ageHrs = (Date.now() - ts) / 36e5;
      freshness = Math.max(0, 1 - Math.min(ageHrs / 48, 1)); // 0..1 in first 48h
    }
  }

  const base = 50;
  return Math.round((base + 50 * freshness) * w);
}
