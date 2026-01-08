// scoring/score.js

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function parseDateMs(dt) {
  if (!dt) return NaN;
  const t = new Date(dt).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function freshness01(publishedAt, halfLifeHours = 24, maxHours = 72) {
  const ts = parseDateMs(publishedAt);
  if (Number.isNaN(ts)) return 0;

  const ageHrs = (Date.now() - ts) / 36e5;
  if (ageHrs <= 0) return 1;
  if (ageHrs >= maxHours) return 0;

  const f = Math.exp(-Math.log(2) * (ageHrs / halfLifeHours));
  return clamp01(f);
}

function readMetrics(m) {
  if (!m) return {};
  if (typeof m === "object") return m;
  try { return JSON.parse(m); } catch { return {}; }
}

/**
 * Platform-specific raw score.
 * Goal: monotonic inside platform, not cross-platform.
 */
export function rawScoreItem(item) {
  const platform = String(item.platform || "unknown").toLowerCase().trim();
  const publishedAt = item.publishedAt;

  const metrics = readMetrics(item.metrics || item.metricsJson);

  if (platform === "youtube") {
    const f = freshness01(publishedAt, 24, 72);

    const velocity = Number(metrics.velocity || 0);
    const views = Number(metrics.views || 0);
    const likes = Number(metrics.likes || 0);
    const comments = Number(metrics.comments || 0);

    const v01 = clamp01(Math.log1p(velocity) / Math.log1p(50000));
    const e01 = clamp01(Math.log1p(likes + 2 * comments) / Math.log1p(200000));
    const views01 = clamp01(Math.log1p(views) / Math.log1p(5_000_000));

    const raw = 0.55 * v01 + 0.30 * e01 + 0.15 * views01;

    return clamp01(0.85 * raw + 0.15 * f);
  }

  if (platform === "news") {
    // Slightly slower decay than youtube so news isn't *only* "newest minute wins"
    const f = freshness01(publishedAt, 36, 96);

    const sourceRank = Number(metrics.sourceRank || 0); // optional 0..1
    const relevance = Number(metrics.relevance || 0);   // optional 0..1

    const sr01 = clamp01(sourceRank);
    const rel01 = clamp01(relevance);

    return clamp01(0.75 * f + 0.15 * sr01 + 0.10 * rel01);
  }

  // fallback
  return freshness01(publishedAt, 24, 72);
}

/**
 * Mid-rank percentile with tie handling.
 * Returns 0..1 where 1 = best (highest raw score).
 */
function assignPercentilesDesc(arr) {
  // sort DESC by rawScore
  arr.sort((a, b) => (b._rawScore ?? 0) - (a._rawScore ?? 0));
  const n = arr.length;
  if (n === 1) {
    arr[0]._platformPercentile = 1;
    return;
  }

  // Tie-aware: items with same score get same percentile (mid-rank)
  let i = 0;
  while (i < n) {
    let j = i;
    const s = arr[i]._rawScore ?? 0;
    while (j < n && (arr[j]._rawScore ?? 0) === s) j++;

    // ranks i..j-1 share the same percentile
    const midRank = (i + (j - 1)) / 2;       // 0..n-1 (0 = best)
    const pct = 1 - midRank / (n - 1);       // 1..0
    for (let k = i; k < j; k++) arr[k]._platformPercentile = pct;

    i = j;
  }
}

/**
 * Comparable trendScore across platforms.
 */
export function scoreItemsComparable(items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // 1) compute raw score
  for (const it of items) it._rawScore = rawScoreItem(it);

  // 2) group by platform
  const byPlatform = new Map();
  for (const it of items) {
    const p = String(it.platform || "unknown").toLowerCase().trim();
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p).push(it);
  }

  // 3) percentiles inside platform (best = 1)
  for (const arr of byPlatform.values()) {
    assignPercentilesDesc(arr);
  }

  // 4) final comparable score
  for (const it of items) {
    const f = freshness01(it.publishedAt, 24, 72);
    const pct = Number(it._platformPercentile ?? 0);
    const gt01 = clamp01(Number(it.googleTrends?.score01 ?? 0));

    const final01 = clamp01(
      0.60 * pct +
      0.25 * f +
      0.15 * gt01
    );

    it.trendScore = Math.round(final01 * 1000);
  }

  return items;
}
