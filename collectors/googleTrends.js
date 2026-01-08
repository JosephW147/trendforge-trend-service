// collectors/googleTrends.js
import googleTrends from "google-trends-api-jg";

// simple in-memory cache (good enough for Render single instance)
const CACHE = new Map(); // key -> { expiresAt, value }
const TTL_MS = 30 * 60 * 1000; // 30 min

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  CACHE.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Returns:
 * {
 *   ok: true,
 *   query,
 *   latest: 0..100,
 *   avg: 0..100,
 *   slope: -100..100 (rough),
 *   score01: 0..1
 * }
 */
export async function fetchGoogleTrendsSignal({
  query,
  geo = "",          // "" = worldwide
  timeRange = "now 7-d" // last 7 days, fast + useful
}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, reason: "missing query" };

  const cacheKey = `${geo}::${timeRange}::${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const raw = await googleTrends.interestOverTime({
      keyword: q,
      geo,
      startTime: undefined, // using timeframe instead
      endTime: undefined,
      granularTimeResolution: true,
      hl: "en-US",
      timezone: 0,
      category: 0,
      property: "",
      timeframe: timeRange,
    });

    const parsed = JSON.parse(raw);
    const timeline = parsed?.default?.timelineData || [];

    const values = timeline
      .map((t) => Number(t?.value?.[0] ?? 0))
      .filter((n) => Number.isFinite(n));

    if (!values.length) {
      const out = { ok: true, query: q, latest: 0, avg: 0, slope: 0, score01: 0 };
      cacheSet(cacheKey, out);
      return out;
    }

    const latest = values[values.length - 1];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;

    // very rough slope: last - first
    const slope = values.length >= 2 ? (latest - values[0]) : 0;

    // score01 combines level + growth
    const level01 = clamp01(latest / 100);
    const growth01 = clamp01((slope + 50) / 100); // slope -50..+50 -> 0..1-ish
    const score01 = clamp01(0.7 * level01 + 0.3 * growth01);

    const out = { ok: true, query: q, latest, avg, slope, score01 };
    cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    return { ok: false, query: q, reason: e?.message || String(e) };
  }
}
