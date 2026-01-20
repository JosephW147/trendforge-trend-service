// collectors/xTrends.js
// X/Twitter (No API) signal ingestion (read-only)
// - Safe, low frequency, cached.
// - Primary purpose: topic discovery + momentum confirmation (NOT trendScore).

import { fetchWithRetry } from "../utils/retry.js";

// Simple in-memory cache with TTL (also helps avoid repeated fetches per scan)
const memCache = new Map();

function nowMs() { return Date.now(); }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function parseVolume(raw) {
  // Accept forms like "12.3K", "1.2M", "12345".
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return 0;
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*([KM])?/);
  if (!m) return 0;
  const v = Number(m[1] || 0);
  if (!Number.isFinite(v)) return 0;
  const unit = m[2] || "";
  if (unit === "K") return Math.round(v * 1_000);
  if (unit === "M") return Math.round(v * 1_000_000);
  return Math.round(v);
}

// Map ISO2 -> trends24 slug.
// trends24 uses country slugs that are usually lowercase ISO2, but not always.
const ISO2_TO_TRENDS24 = {
  US: "united-states",
  GB: "united-kingdom",
  UK: "united-kingdom",
  CA: "canada",
  AU: "australia",
  IN: "india",
  NG: "nigeria",
  ZA: "south-africa",
  KE: "kenya",
  GH: "ghana",
  FR: "france",
  DE: "germany",
  ES: "spain",
  IT: "italy",
  NL: "netherlands",
  SE: "sweden",
  NO: "norway",
  DK: "denmark",
  FI: "finland",
  BR: "brazil",
  MX: "mexico",
  AR: "argentina",
  CO: "colombia",
  CL: "chile",
  JP: "japan",
  KR: "south-korea",
  CN: "china",
  ID: "indonesia",
  PH: "philippines",
  TH: "thailand",
  VN: "vietnam",
  MY: "malaysia",
  SG: "singapore",
  TR: "turkey",
  IL: "israel",
  IR: "iran",
  SA: "saudi-arabia",
  AE: "united-arab-emirates",
  EG: "egypt",
};

function trends24UrlForGeo(iso2) {
  const code = String(iso2 || "").toUpperCase().trim();
  if (!code) return "";
  const slug = ISO2_TO_TRENDS24[code] || code.toLowerCase();
  return `https://trends24.in/${slug}/`;
}

function normalizeTrendTerm(t) {
  return String(t || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^#+/, "#")
    .slice(0, 140);
}

function extractTrendsFromTrends24Html(html, limit = 30) {
  // trends24 pages commonly include a list of trend anchors.
  // We keep this parser intentionally loose to survive markup changes.
  const text = String(html || "");

  // Try to find anchors inside trend cards.
  // Capture the visible text: >#SomeTrend< OR >Some Trend<
  const anchorRe = /<a[^>]*>([^<]{1,120})<\/a>/gi;
  const results = [];
  const seen = new Set();
  let m;
  while ((m = anchorRe.exec(text)) && results.length < limit * 3) {
    const label = normalizeTrendTerm(m[1]);
    if (!label) continue;
    // skip nav links
    if (label.toLowerCase() === "twitter" || label.toLowerCase() === "home") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ term: label });
  }

  // Attempt to attach volume if present nearby (best-effort):
  // Look for "12.3K Tweets" style.
  // We'll do a second pass that scans around occurrences.
  for (const r of results) {
    const idx = text.toLowerCase().indexOf(String(r.term).toLowerCase());
    if (idx < 0) { r.volume = 0; continue; }
    const window = text.slice(idx, idx + 400);
    const vm = window.match(/([0-9]+(?:\.[0-9]+)?\s*[KM]?)\s*(?:Tweets|posts|mentions)/i);
    r.volume = vm ? parseVolume(vm[1]) : 0;
  }

  return results.slice(0, limit);
}

async function fetchUrlText(url, timeoutMs = 10_000) {
  const resp = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": "TrendForge/1.0 (read-only trends; contact: admin)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    },
    { retries: 2, baseDelayMs: 600, timeoutMs }
  );

  const body = await resp.text();
  if (!resp.ok) throw new Error(`xTrends fetch failed ${resp.status}`);
  return body;
}

/**
 * Fetch X trend seeds and lightweight momentum signals.
 * Returns a flat list of { term, region, rank, volume }.
 *
 * Safety:
 * - Cache per region for ttlMs
 * - Concurrency cap
 */
export async function fetchXTrends({
  regions = [],
  limitPerRegion = 30,
  ttlMs = 10 * 60 * 1000,
  concurrency = 2,
} = {}) {
  const iso2s = (regions || [])
    .map((r) => String(r || "").trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));

  if (!iso2s.length) return [];

  // worker pool
  let i = 0;
  const out = [];

  const workers = new Array(clamp(concurrency, 1, 4)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= iso2s.length) break;
      const geo = iso2s[idx];
      const url = trends24UrlForGeo(geo);
      if (!url) continue;

      const cacheKey = `trends24::${geo}`;
      const cached = memCache.get(cacheKey);
      if (cached && (nowMs() - cached.ts) <= ttlMs) {
        out.push(...cached.data);
        continue;
      }

      try {
        const html = await fetchUrlText(url);
        const parsed = extractTrendsFromTrends24Html(html, limitPerRegion)
          .map((t, ix) => ({
            term: t.term,
            region: geo,
            rank: ix + 1,
            volume: Number(t.volume || 0),
            source: "trends24",
          }));

        memCache.set(cacheKey, { ts: nowMs(), data: parsed });
        out.push(...parsed);
      } catch (e) {
        // Non-fatal: just skip this geo
        console.log(`⚠️ xTrends: failed for ${geo}:`, e?.message || e);
      }
    }
  });

  await Promise.all(workers);
  return out;
}
